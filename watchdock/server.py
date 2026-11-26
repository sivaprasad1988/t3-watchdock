"""Web app (Flask, served by Gunicorn: one worker, several threads; see gunicorn.conf.py)."""
import functools
import json
import os
import re
import sys
import threading
import urllib.parse

from flask import Flask, Response, g, redirect, request
from werkzeug.exceptions import HTTPException
from werkzeug.middleware.proxy_fix import ProxyFix

from .core import ALLOWED_HOSTS, BASE, BEHIND_PROXY, config, lock, log, now, save_config, stop_event
from . import auth, db
from .alerts import email_cfg, save_email, save_teams, send_mail, send_teams, smtp_password, teams_cfg, teams_url
from .extensions import ext_changelog, ext_release
from .gitlab import delete_token, find_project, gitlab, last_run_status, legacy_token_files, own_avatar, project_info, promote, require_ci, run_pipeline, run_production, save_token, search_projects, set_user, test_token, token_status
from .t3monitor import T3M_ENVS, t3m_auth_file, t3m_auth_password, t3m_env, t3m_fetch, t3m_key, t3m_key_file, t3m_summary, t3m_view
from .watcher import resume_mail_watches
from .projects import add_project, export_projects, import_projects, update_monitoring, update_project
from .updates import send_now
from .plugins import NotFound, asset as plugin_asset, assets as plugin_assets, call as plugin_call, catalog as plugin_catalog, save_plugin
from .scheduler import TASKS, save_sched, sched_run, sched_view, scheduler, version_report


STATIC = {"/": ("index.html", "text/html; charset=utf-8"),        # fixed allowlist, no path traversal
          "/style.css": ("style.css", "text/css; charset=utf-8"),
          "/app.js": ("app.js", "text/javascript; charset=utf-8"),
          "/login": ("login.html", "text/html; charset=utf-8")}
PUBLIC = {("GET", "/login"), ("GET", "/style.css"), ("POST", "/api/login")}     # reachable without a session
MAX_BODY = 10 * 1024 * 1024

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = MAX_BODY
if BEHIND_PROXY:        # scheme and client address from the last X-Forwarded-Proto / -For entry (set by Traefik)
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)


# ---------------------------------------------------------------- background work (once per process)
_started = False
_start_lock = threading.Lock()


def start_background():
    """Scheduler and pending mail watches. Gunicorn must run exactly one worker, or they run twice."""
    global _started
    with _start_lock:
        if _started:
            return
        _started = True
    legacy_token_files()                    # former shared .gitlab-token: unused, logged for deletion
    resume_mail_watches()
    threading.Thread(target=scheduler, daemon=True).start()


# ---------------------------------------------------------------- helpers
def send(code, data, ctype="application/json", cookie=None):
    body = data if isinstance(data, bytes) else json.dumps(data).encode()
    r = Response(body, status=code, content_type=ctype)
    if cookie:
        r.headers["Set-Cookie"] = cookie
    return r


def ok(data):
    return send(200, data)


def query():
    """Query string as {key: [values]} like urllib.parse.parse_qs (empty values dropped), as plugins expect."""
    return urllib.parse.parse_qs(request.query_string.decode())


def q1(key, default=None):
    """First value of a query parameter; missing and no default -> KeyError (answered with 500, as before)."""
    q = query()
    if key in q:
        return q[key][0]
    if default is None:
        raise KeyError(key)
    return default


def body():
    return json.loads(request.get_data() or b"{}")


@functools.cache
def _port():
    return int(config().get("port", 8787))


def _allowed():
    port = _port()
    hosts = {f"127.0.0.1:{port}", f"localhost:{port}"} | ALLOWED_HOSTS
    if request.headers.get("Host") not in hosts:                     # DNS rebinding
        return False
    origin = request.headers.get("Origin")
    if origin and origin.split("://", 1)[-1] not in hosts:           # cross-site requests
        return False
    return True


def _secret_ok():
    """Secrets leave the app only on a same-origin HTTPS or localhost request."""
    host = request.headers.get("Host", "")
    secure = request.scheme == "https"
    loopback = host.split(":", 1)[0] in {"127.0.0.1", "localhost"}
    return (secure or loopback) and request.headers.get("Origin") == ("https://" if secure else "http://") + host


def _cookie(value, max_age):
    secure = "; Secure" if request.scheme == "https" else ""
    return f"{auth.COOKIE}={value}; Max-Age={max_age}; Path=/; HttpOnly; SameSite=Strict{secure}"


@app.before_request
def guard():
    if not _allowed():
        return send(403, {"error": "forbidden"})
    if request.method == "POST" and not request.headers.get("Content-Type", "").startswith("application/json"):
        return send(403, {"error": "forbidden"})
    g.user = auth.session_user(request.cookies.get(auth.COOKIE))
    set_user(g.user)                         # GitLab calls of this request use this user's token
    if g.user or (request.method, request.path) in PUBLIC:
        return None
    if request.method == "GET" and not request.path.startswith(("/api/", "/plugins/")):
        return redirect("/login", 302)
    return send(401, {"error": "login required"})


@app.after_request
def no_store(r):
    r.headers["Cache-Control"] = "no-store"
    return r


@app.errorhandler(Exception)
def error(e):
    if isinstance(e, NotFound):
        return send(404, {"error": str(e)})
    if isinstance(e, HTTPException):
        msg = {404: "not found", 405: "not found", 413: "request too large"}.get(e.code, e.name)
        return send(404 if e.code == 405 else e.code, {"error": msg})
    return send(500, {"error": str(e)})


# ---------------------------------------------------------------- GET
@app.get("/")
@app.get("/style.css")
@app.get("/app.js")
@app.get("/login")
def static_file():
    name, ctype = STATIC[request.path]
    return send(200, (BASE / "static" / name).read_bytes(), ctype)


@app.get("/api/state")
def state():
    cfg = config()
    return ok({
        "user": g.user,
        "users": db.user_names(),
        "projects": cfg["projects"],
        "scheduler": sched_view(),
        "gitlab_token": token_status(g.user),
        "email": email_cfg(),
        "email_password_set": bool(smtp_password()),
        "teams": teams_cfg(),
        "teams_url_set": bool(teams_url()),
        "public_url": config().get("public_url", ""),
        "t3monitor_keys": [p["id"] for p in cfg["projects"] if t3m_key(p["id"])],
        "t3monitor_auth": [p["id"] for p in cfg["projects"] if t3m_auth_password(p["id"])],
        "t3monitor_staging_keys": [p["id"] for p in cfg["projects"] if t3m_key(p["id"], "staging")],
        "t3monitor_staging_auth": [p["id"] for p in cfg["projects"] if t3m_auth_password(p["id"], "staging")],
        "last_check": db.kv_get("last_check"),
        "typo3_latest": db.typo3_latest(),
        "typo3_elts": db.kv_get("typo3_elts") or {},
        "typo3_seen": db.typo3_seen(),
        "typo3_security": {k: (db.kv_get("typo3_security") or {}).get(k) for k in ("checked", "items")},
        "runs": db.runs_recent(30),
        "projects_with_runs": db.projects_with_runs(),
        "log": db.log_recent(50)})


@app.get("/api/project-info")
def get_project_info():
    return ok(project_info(q1("gitlab_url"), q1("path"), q1("ref", "")))


@app.get("/api/project-avatar")
def project_avatar():
    return ok({"url": gitlab(find_project(q1("project")), "GET", "").get("avatar_url")})


@app.get("/api/ext/changelog")
def get_ext_changelog():
    return ok(ext_changelog(q1("composer"), q1("version"), q1("installed", "")))


@app.get("/api/ext/release")
def get_ext_release():
    return ok(ext_release(q1("composer"), q1("version"), q1("summary", "1") != "0"))


@app.get("/api/t3monitor/summary")
def t3monitor_summary():
    return ok(t3m_summary())


@app.get("/api/t3monitor")
def t3monitor():
    return ok(t3m_view(find_project(q1("project"))["id"], q1("env", "production")))


@app.get("/api/search")
def search():
    return ok(search_projects(q1("gitlab_url"), q1("q")))


@app.get("/api/runs/status")
def runs_status():
    return ok(last_run_status())


@app.get("/api/plugins")
def plugins():
    return ok(plugin_assets())


@app.get("/api/plugin-admin")                        # Plugins page: installed plugins (on and off)
def plugin_admin():
    return ok(plugin_catalog())


@app.get("/plugins/<name>/<file>")                   # browser files of a plugin
def plugin_file(name, file):
    return send(200, *plugin_asset(name, file))


@app.get("/api/plugins/<name>/<route>")
def plugin_get(name, route):
    return ok(plugin_call("GET", name, route, query()))


@app.get("/api/pipeline")
def pipeline():
    p, pid = find_project(q1("project")), int(q1("id"))
    return ok({"pipeline": gitlab(p, "GET", f"/pipelines/{pid}"),
               "jobs": gitlab(p, "GET", f"/pipelines/{pid}/jobs?per_page=100")})


# ---------------------------------------------------------------- POST
@app.post("/api/login")
def login():
    b = body()
    try:
        token, age = auth.login(b.get("name"), b.get("password"), request.remote_addr)
    except PermissionError as e:
        return send(401, {"error": str(e)})
    log(f"Login: {b.get('name')}")
    return send(200, {"ok": True}, cookie=_cookie(token, age))


@app.post("/api/logout")
def logout():
    auth.logout(request.cookies.get(auth.COOKIE))
    log(f"Logout: {g.user}")
    return send(200, {"ok": True}, cookie=_cookie("", 0))


@app.get("/api/profile")
def profile():
    return ok(db.user_profile(g.user))


@app.get("/api/profile/avatar")
def profile_avatar():
    return ok(own_avatar(g.user))


@app.get("/api/users/avatar")                        # GitLab picture of a user (responsible person on project cards)
def user_avatar():
    name = q1("name")
    if not db.user_get(name):
        return send(404, {"error": "No such user"})
    return ok(own_avatar(name))


@app.post("/api/profile")
def profile_save():
    b = body()
    try:
        return ok(auth.update_profile(g.user, b.get("full_name"), b.get("email")))
    except ValueError as e:
        return send(400, {"error": str(e)})


@app.post("/api/profile/password")
def profile_password():
    b = body()
    try:
        auth.change_password(g.user, b.get("current"), b.get("new"), request.cookies.get(auth.COOKIE))
    except PermissionError as e:
        return send(403, {"error": str(e)})
    except ValueError as e:
        return send(400, {"error": str(e)})
    return ok({"ok": True})


@app.post("/api/run")
def run():
    b = body()
    p = find_project(b["project"])
    if b.get("mode") == "promote":
        return ok(promote(p, int(b["from"])))
    if b.get("mode") == "production":
        return ok(run_production(p))
    src = p.get("auto_typo3", {}) if b.get("mode") == "update" else p
    trig = "manual TYPO3 update" if b.get("mode") == "update" else "manual"
    return ok(run_pipeline(p, src.get("variables", {}), trig, src.get("auto_play", [])))


@app.post("/api/updates/send")
def updates_send():
    return ok({"msg": send_now(find_project(body()["project"]))})


@app.post("/api/play")
def play():
    b = body()
    p = find_project(b["project"])
    require_ci(p)
    r = gitlab(p, "POST", f"/jobs/{int(b['job'])}/play")
    log(f"Manual job '{r.get('name')}' started in {p['id']}")
    return ok(r)


@app.post("/api/token")                              # own GitLab token (Profile); the only kind of token
def token():
    b = body()
    save_token(g.user, b.get("token"), b.get("gitlab_url"))
    return ok({"msg": test_token(g.user)})


@app.post("/api/token/test")
def token_test():
    return ok({"msg": test_token(g.user)})


@app.post("/api/token/delete")
def token_delete():
    delete_token(g.user)
    return ok({"ok": True})


@app.post("/api/t3monitor/reveal-key")
def reveal_key():
    if not _secret_ok():
        return send(403, {"error": "Reveal requires a same-origin HTTPS or localhost request"})
    b = body()
    key = t3m_key(find_project(b["project"])["id"], b["env"])
    if not key:
        return send(404, {"error": "No saved key for this environment"})
    return ok({"key": key})


@app.post("/api/t3monitor/refresh")
def t3monitor_refresh():
    b = body()
    p, env = find_project(b["project"]), b.get("env") or "production"
    t3m_env(env)
    try:
        t3m_fetch(p, env)
    except RuntimeError:
        pass                                   # shown via last_error
    return ok(t3m_view(p["id"], env))


@app.post("/api/teams")
def teams():
    return ok(save_teams(body()))


@app.post("/api/teams/test")
def teams_test():
    code = send_teams("T3 Watchdock: test message", "Teams notifications of T3 Watchdock work.",
                      [("Sent", now().replace("T", " "))])
    msg = (f"Teams test message accepted by the webhook (HTTP {code}). If it does not appear in the "
           "channel, check the run history of the Workflow in Teams (Workflows → the flow → Run history).")
    log(msg)
    return ok({"msg": msg})


@app.post("/api/public-url")
def public_url():
    url = (body().get("url") or "").strip().rstrip("/")
    if url and (not re.match(r"^https?://[^\s/]+(/\S*)?$", url)):
        raise RuntimeError("Address must start with http:// or https:// and contain no spaces")
    with lock:
        cfg = config()
        cfg["public_url"] = url
        save_config(cfg)
    log(f"Public URL set to {url or '(default)'}")
    return ok({"public_url": url})


@app.post("/api/email")
def email():
    return ok(save_email(body()))


@app.post("/api/email/test")
def email_test():
    e = email_cfg()
    send_mail("[T3 Watchdock] Test email", "Email notifications of T3 Watchdock work.\n", e)
    log(f"Test email sent to {', '.join(e['to'])}")
    return ok({"msg": f"Test email sent to {', '.join(e['to'])}"})


@app.post("/api/check-now")
def check_now():
    good, result = sched_run("typo3_release")
    return send(200 if good else 500, {"ok": True} if good else {"error": result})


@app.get("/api/versions")
def versions_get():
    """Last version report (Versions page); computed once if there is none yet."""
    from .db import kv_get
    try:
        return ok(kv_get("version_report") or version_report())
    except RuntimeError as e:
        return send(409, {"error": str(e)})


@app.post("/api/versions/refresh")
def versions_refresh():
    try:
        return ok(version_report())
    except RuntimeError as e:
        return send(409, {"error": str(e)})


@app.post("/api/scheduler")
def scheduler_save():
    return ok(save_sched(body()))


@app.post("/api/scheduler/run")
def scheduler_run():
    b = body()
    if b.get("id") not in TASKS:
        raise RuntimeError("Unknown task")
    good, result = sched_run(b["id"])
    return ok({"ok": good, "result": result, "scheduler": sched_view()})


@app.post("/api/projects")
def projects_add():
    return ok(add_project(body()))


@app.post("/api/t3monitor/settings")
def t3monitor_settings():
    return ok(update_monitoring(body()))


@app.post("/api/projects/update")
def projects_update():
    return ok(update_project(body()))


@app.post("/api/projects/export")
def projects_export():
    if not _secret_ok():
        return send(403, {"error": "Export requires a same-origin HTTPS or localhost request"})
    return ok(export_projects())


@app.post("/api/projects/import")
def projects_import():
    b = body()
    return ok(import_projects(b.get("data"), bool(b.get("overwrite"))))


@app.post("/api/plugin-admin")
def plugin_admin_save():
    return ok(save_plugin(body()))


@app.post("/api/plugins/<name>/<route>")
def plugin_post(name, route):
    return ok(plugin_call("POST", name, route, body()))


@app.post("/api/projects/delete")
def projects_delete():
    b = body()
    with lock:
        cfg = config()
        proj = next((p for p in cfg["projects"] if p["id"] == b.get("id")), None)
        if not proj:
            raise RuntimeError("Project not found")
        if (b.get("confirm") or "").strip() != (proj.get("name") or proj["id"]):
            raise RuntimeError("Confirmation does not match the project name")
        cfg["projects"] = [p for p in cfg["projects"] if p["id"] != b["id"]]
        save_config(cfg)
    for env in T3M_ENVS:
        t3m_key_file(b["id"], env).unlink(missing_ok=True)
        t3m_auth_file(b["id"], env).unlink(missing_ok=True)
    log(f"Project removed: {b['id']}")
    return ok({"ok": True})


# ---------------------------------------------------------------- start
def main():
    """Replace this process with Gunicorn (settings in gunicorn.conf.py)."""
    try:
        import gunicorn  # noqa: F401
    except ImportError:
        sys.exit("Gunicorn is not installed: pip install -r requirements.txt (see README)")
    if "--no-watch" in sys.argv:
        os.environ["WATCHDOCK_NO_WATCH"] = "1"
    os.chdir(BASE)
    os.execvp(sys.executable, [sys.executable, "-m", "gunicorn", "-c", str(BASE / "gunicorn.conf.py"),
                               "watchdock.server:app"])


def stop():
    stop_event.set()
