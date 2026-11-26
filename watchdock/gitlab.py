"""GitLab API: tokens (one per user, encrypted), pipelines, manual jobs, project lookup."""
import contextlib
import contextvars
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from . import crypto, db
from .core import FINAL_STATUSES, TOKEN_FALLBACK, TOKEN_FILE, config, log, now, stop_event
from .db import last_pipelines, run_add


# ---------------------------------------------------------------- GitLab tokens
# Only signed-in people use GitLab: every call runs with the token of one user, never with a shared token.
# Browser requests: the signed-in user. Background work (TYPO3 auto-update, its mail watch and auto-play):
# the responsible person of the project, set with as_user(). No user or no token -> the call is refused.
_user = contextvars.ContextVar("gitlab_user", default=None)


def set_user(name):
    """Called for every browser request (None for requests without a session)."""
    _user.set(name)


@contextlib.contextmanager
def as_user(name):
    """GitLab calls inside this block (and threads started from it with a copied context) use name's token."""
    t = _user.set(name)
    try:
        yield
    finally:
        _user.reset(t)


def _clean(value):
    value = (value or "").strip()
    if not value or any(c.isspace() for c in value):
        raise RuntimeError("Token is empty or contains whitespace")
    return value


def _clean_url(value):
    """GitLab base URL entered in the Profile: https only, no user/password, query or fragment."""
    url = (value or "").strip().rstrip("/")
    u = urllib.parse.urlsplit(url)
    if u.scheme != "https" or not u.hostname or u.username or u.password or u.query or u.fragment:
        raise RuntimeError("GitLab URL must look like https://gitlab.example.com (https, no user, query or fragment)")
    return url


def token_status(user):
    return {"own": bool(user and db.user_token(user)), "url": db.user_gitlab_url(user) if user else None}


def token():
    user = _user.get()
    if not user:
        raise RuntimeError("GitLab call without a user: only signed-in people (or a project's responsible person "
                           "for automatic runs) may use GitLab")
    return stored_token(user)


def save_token(user, value, gitlab_url=None):
    """Save token and/or GitLab URL. An empty token keeps the stored one (only the URL changes)."""
    url = _clean_url(gitlab_url) if gitlab_url is not None else None
    new_token = (value or "").strip()
    if not new_token and not db.user_token(user):
        raise RuntimeError("Token is empty or contains whitespace")
    if new_token:
        db.user_token_set(user, crypto.encrypt(_clean(value)))
    if url is not None:
        db.user_gitlab_url_set(user, url)
    _avatars.pop(user, None)
    log(f"Personal GitLab {'token' if new_token else 'URL'} saved: {user}" + (f" ({url})" if url else ""))


def delete_token(user):
    db.user_token_set(user, None)
    db.user_gitlab_url_set(user, None)
    _avatars.pop(user, None)
    log(f"Personal GitLab token removed: {user}")


def stored_token(user):
    enc = db.user_token(user)
    if not enc:
        raise RuntimeError(f"No personal GitLab token stored for {user}. Add it under Profile → GitLab token.")
    return crypto.decrypt(enc)


def legacy_token_files():
    """Former shared plaintext token files: no longer read. Logged so they can be deleted."""
    for f in (TOKEN_FILE, TOKEN_FALLBACK):
        if f.exists():
            log(f"{f} is no longer used (every user has an own token in Profile); delete it")


DEFAULT_GITLAB = "https://gitlab.gingco.de"      # same default as the GitLab URL field in the Profile


def _main_host(user=None):
    """Where a user's token is tested and the profile is read: the GitLab URL from the user's Profile,
    else the default (what the Profile field shows when nothing is saved)."""
    own = user and db.user_gitlab_url(user)
    return (own or DEFAULT_GITLAB).rstrip("/")


AVATAR_TTL = 3600
_avatars = {}                                   # user -> (fetched at, {"url", "gitlab"})


def own_avatar(user):
    """Avatar URL of the user's own GitLab account (read with that user's own token)."""
    hit = _avatars.get(user)
    if hit and time.time() - hit[0] < AVATAR_TTL:
        return hit[1]
    url, avatar = _main_host(user), None
    if db.user_token(user):
        try:
            req = urllib.request.Request(url + "/api/v4/user", headers={"PRIVATE-TOKEN": stored_token(user)})
            with urllib.request.urlopen(req, timeout=15) as r:
                avatar = json.load(r).get("avatar_url")
        except Exception:
            pass                                # initials are shown instead
    out = {"url": avatar, "gitlab": url}
    _avatars[user] = (time.time(), out)
    return out


def test_token(user):
    """Check the user's own token against the user's GitLab URL (see _main_host)."""
    url = _main_host(user)
    req = urllib.request.Request(url + "/api/v4/user", headers={"PRIVATE-TOKEN": stored_token(user)})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return f"Token valid for user '{json.load(r).get('username')}' on {url}"
    except urllib.error.HTTPError as e:
        return f"Token rejected by {url} (HTTP {e.code})"
    except urllib.error.URLError as e:
        return f"GitLab not reachable ({e.reason}); token saved but not verified"


def gitlab(project, method, path, body=None):
    url = (project["gitlab_url"].rstrip("/") + "/api/v4/projects/"
           + urllib.parse.quote(project["path"], safe="") + path)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "PRIVATE-TOKEN": token(), "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise RuntimeError(
                "GitLab denied access. Connect to your VPN and try again. "
                "If you’re already connected, check your GitLab token in your Profile."
            ) from None
        detail = e.read().decode(errors="replace")[:500]
        if detail.lstrip().startswith("<"):          # HTML error page (proxy/auth) -> status only
            detail = e.reason
        raise RuntimeError(f"GitLab HTTP {e.code}: {detail}") from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"GitLab not reachable: {e.reason}") from None


def find_project(pid):
    for p in config()["projects"]:
        if p["id"] == pid:
            return p
    raise RuntimeError(f"Unknown project: {pid}")


def auto_play(project, pipeline_id, job_names, timeout=7200):
    """Poll pipeline; play listed manual jobs once they become playable."""
    names = set(job_names)
    deadline = time.time() + timeout
    while names and time.time() < deadline and not stop_event.is_set():
        try:
            pl = gitlab(project, "GET", f"/pipelines/{pipeline_id}")
            for j in gitlab(project, "GET", f"/pipelines/{pipeline_id}/jobs?per_page=100"):
                if j["name"] in names and j["status"] == "manual":
                    gitlab(project, "POST", f"/jobs/{j['id']}/play")
                    names.discard(j["name"])
                    log(f"Auto-play: '{j['name']}' started in pipeline #{pipeline_id} ({project['id']})")
            if pl["status"] in ("success", "failed", "canceled", "skipped"):
                break
        except Exception as e:
            log(f"Auto-play error in pipeline #{pipeline_id}: {e}")
        stop_event.wait(15)
    if names:
        log(f"Auto-play: not started in pipeline #{pipeline_id}: {', '.join(sorted(names))}")


def require_ci(project):
    if project.get("ci") is False:
        raise RuntimeError(f"CI/CD is off for {project.get('name') or project['id']}: no pipelines")


def run_pipeline(project, variables, trigger, play_jobs=(), ref=None):
    require_ci(project)
    ref = ref or project["ref"]
    body = {"ref": ref,
            "variables": [{"key": k, "value": str(v)} for k, v in variables.items()]}
    p = gitlab(project, "POST", "/pipeline", body)
    run_add({"t": now(), "project": project["id"], "pipeline": p["id"],
             "web_url": p.get("web_url"), "trigger": trigger, "ref": ref})
    who = f" by {_user.get()}" if _user.get() else ""
    log(f"Pipeline #{p['id']} started: {project['path']} @ {ref} ({trigger}){who}")
    if play_jobs:
        ctx = contextvars.copy_context()           # manual jobs are played with the same user's token
        threading.Thread(target=ctx.run, args=(auto_play, project, p["id"], list(play_jobs)), daemon=True).start()
    ctx = contextvars.copy_context()               # the pipeline is polled with the same user's token
    threading.Thread(target=ctx.run, args=(scan_after_pipeline, project, p["id"], ref), daemon=True).start()
    return p


def scan_after_pipeline(project, pipeline_id, ref, timeout=7200):
    """Wait until the pipeline has finished, then run the TYPO3 health check (t3monitor) of the deployed instance:
    the production branch -> Production, any other branch -> Staging. Skipped if that instance is not set up."""
    from .t3monitor import t3m_cfg, t3m_fetch, t3m_key   # lazy: t3monitor is not needed for plain GitLab calls
    env = "production" if ref == (project.get("production") or {}).get("ref") else "staging"
    if not (t3m_cfg(project, env).get("url") and t3m_key(project["id"], env)):
        return
    deadline, status = time.time() + timeout, None
    while time.time() < deadline and not stop_event.is_set():
        try:
            status = gitlab(project, "GET", f"/pipelines/{pipeline_id}").get("status")
            if status in FINAL_STATUSES:
                break
        except Exception as e:
            log(f"Scan watch error in pipeline #{pipeline_id}: {e}")
        stop_event.wait(30)
    if status not in FINAL_STATUSES or status in ("canceled", "skipped"):
        return                                     # nothing was deployed (or still running after the timeout)
    log(f"Pipeline #{pipeline_id} {status}: TYPO3 health check of {project['id']} ({env})")
    try:
        t3m_fetch(project, env)                    # alert=True: message on failure / new errors / new updates
    except RuntimeError:
        pass                                       # stored as last_error and already logged / notified


def known_host(gitlab_url):
    """Only known GitLab hosts -- the token must not be sent anywhere else."""
    url = (gitlab_url or "").strip().rstrip("/")
    known = {p["gitlab_url"].rstrip("/") for p in config()["projects"]} | {"https://gitlab.gingco.de"}
    if url not in known:
        raise RuntimeError(f"Unknown GitLab host: {url}")
    return url


def gitlab_get(url, path):
    req = urllib.request.Request(url + "/api/v4" + path, headers={"PRIVATE-TOKEN": token()})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def search_projects(gitlab_url, q):
    url = known_host(gitlab_url)
    res = gitlab_get(url, "/projects?membership=true&simple=true&per_page=20&order_by=last_activity_at&search="
                     + urllib.parse.quote(q))
    return [{"path": x["path_with_namespace"], "name": x["name"]} for x in res]


def manual_jobs(project, ref):
    """Manual jobs of the CI config on ref (GitLab CI lint dry run)."""
    try:
        r = gitlab(project, "GET", "/ci/lint?dry_run=true&include_jobs=true&ref=" + urllib.parse.quote(ref, safe=""))
        return [j["name"] for j in r.get("jobs", []) if j.get("when") == "manual"]
    except Exception:
        return []


def typo3_major(project, ref):
    """Most frequent major of "typo3/cms-core" constraints in the repo (blob search), or None."""
    try:
        hits = gitlab(project, "GET", "/search?scope=blobs&search=" + urllib.parse.quote("typo3/cms-core")
                      + "&ref=" + urllib.parse.quote(ref, safe=""))
    except Exception:
        return None
    majors = [int(m) for h in hits for m in re.findall(r'"typo3/cms-core"\s*:\s*"[^0-9"]*(\d+)', h.get("data", ""))]
    return max(set(majors), key=majors.count) if majors else None


def project_info(gitlab_url, path, ref=""):
    """Everything the project form can pre-fill, read from GitLab."""
    p = {"gitlab_url": known_host(gitlab_url), "path": path.strip().strip("/")}
    info = gitlab(p, "GET", "")
    branches = [b["name"] for b in gitlab(p, "GET", "/repository/branches?per_page=100")]
    default = info.get("default_branch")
    ref = ref.strip() or ("staging" if "staging" in branches else default)
    prod = "production" if "production" in branches else (default if default != ref else "")
    return {"name": info.get("name"), "default": default, "branches": branches, "ref": ref,
            "auto_play": manual_jobs(p, ref), "prod_ref": prod,
            "prod_play": manual_jobs(p, prod) if prod else [], "major": typo3_major(p, ref)}


def run_production(project):
    """Run the production pipeline directly (independent of any staging pipeline)."""
    require_ci(project)
    prod = project.get("production") or {}
    if not prod.get("ref"):
        raise RuntimeError("No production branch configured for this project")
    return run_pipeline(project, prod.get("variables", {}), f"manual -> {prod['ref']}",
                        prod.get("auto_play", []), ref=prod["ref"])


def promote(project, source_id):
    """Run the production pipeline, only after a successful staging pipeline."""
    require_ci(project)
    prod = project.get("production") or {}
    if not prod.get("ref"):
        raise RuntimeError("No production branch configured for this project")
    src = gitlab(project, "GET", f"/pipelines/{source_id}")
    if src.get("ref") != project["ref"] or src.get("status") != "success":
        raise RuntimeError(f"Pipeline #{source_id} is not a successful '{project['ref']}' pipeline "
                           f"(ref '{src.get('ref')}', status '{src.get('status')}')")
    return run_pipeline(project, prod.get("variables", {}), f"promote #{source_id} -> {prod['ref']}",
                        prod.get("auto_play", []), ref=prod["ref"])


# ---------------------------------------------------------------- last run status (project cards)
RUN_TTL_ACTIVE, RUN_TTL_WAIT, RUN_TTL_FINAL = 8, 30, 300   # seconds a status is cached (busy / manual / finished)
_run_cache = {}                                 # (project id, pipeline id) -> (fetched at, status dict)


def _run_status(project, pipeline_id):
    key = (project["id"], pipeline_id)
    hit = _run_cache.get(key)
    ttl = (RUN_TTL_FINAL if hit and hit[1].get("status") in FINAL_STATUSES
           else RUN_TTL_WAIT if hit and hit[1].get("status") in ("manual", "scheduled") else RUN_TTL_ACTIVE)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    try:
        pl = gitlab(project, "GET", f"/pipelines/{pipeline_id}")
        out = {"status": pl.get("status"), "started": pl.get("started_at") or pl.get("created_at"),
               "finished": pl.get("finished_at")}
        if out["status"] not in FINAL_STATUSES:           # name the job that is running / waiting
            jobs = gitlab(project, "GET", f"/pipelines/{pipeline_id}/jobs?per_page=100")
            for st in ("running", "pending", "manual"):
                names = [j.get("name") for j in jobs if j.get("status") == st]
                if names:
                    out["job"], out["job_status"] = ", ".join(names[:3]), st
                    break
    except Exception as e:
        out = {"status": None, "error": str(e)[:200]}
    _run_cache[key] = (time.time(), out)
    return out


def last_run_status():
    """{project id: {pipeline, status, started, finished, job?, job_status?, error?}} for the last run of each project."""
    projects = {p["id"]: p for p in config()["projects"] if p.get("ci", True) is not False}
    last = {pid: int(pl) for pid, pl in last_pipelines().items() if pid in projects}
    for k in [k for k in _run_cache if (k[0], k[1]) not in last.items()]:
        _run_cache.pop(k, None)                         # forget older runs
    if not last:
        return {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        # each task gets a copy of this request's context: the signed-in user's token is used
        futs = {pid: ex.submit(contextvars.copy_context().run, _run_status, projects[pid], last[pid]) for pid in last}
        res = {pid: f.result() for pid, f in futs.items()}
    return {pid: {"pipeline": last[pid], **res[pid]} for pid in last}
