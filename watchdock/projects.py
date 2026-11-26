"""Create / update project entries in config.json."""
import re

from .core import config, lock, log, now, save_config
from .db import typo3_seen_reset, user_get
from .t3monitor import T3M_ENVS, _t3m_url, t3m_env, _t3m_user, save_t3m_key, t3m_auth_password, t3m_key, t3m_key_file

EXPORT_FORMAT = "t3-watchdock-projects"


def _jobs(v):
    if isinstance(v, list):
        return [s.strip() for s in v if str(s).strip()]
    return [s.strip() for s in (v or "").split(",") if s.strip()]


def build_project(b, pid=None):
    path = (b.get("path") or "").strip().strip("/")
    ref = (b.get("ref") or "").strip()
    name = (b.get("name") or "").strip()
    ci = b.get("ci", True) is not False          # False = no GitLab CI/CD: monitoring (t3monitor) only
    if ci and (not path or not ref):
        raise RuntimeError("Path and branch are required")
    if not ci and not (name or path):
        raise RuntimeError("Name or project path is required")
    owner = (b.get("owner") or "").strip()      # responsible person: a Watchdock user name (shown on the card)
    if owner and not user_get(owner):
        raise RuntimeError(f"Unknown user: {owner}")
    if not pid:
        pid = (path + "-" + ref).replace("/", "-") if path and ref else re.sub(r"[^a-z0-9]+", "-", (name or path).lower()).strip("-")
        if not pid:
            raise RuntimeError("Name must contain letters or digits")
    return {
        "id": pid,
        "name": name or path,
        "owner": owner,
        "ci": ci,
        "elts": bool(b.get("elts")),             # site runs TYPO3 ELTS: ELTS releases count as TYPO3 updates in the UI
        "gitlab_url": (b.get("gitlab_url") or "https://gitlab.gingco.de").strip().rstrip("/"),
        "path": path,
        "ref": ref,
        "variables": b.get("variables") or {},
        "auto_play": _jobs(b.get("auto_play")),
        "auto_typo3": {
            "enabled": ci and bool(b.get("auto_enabled")),
            "major": int(b.get("major") or 13),
            "variables": b.get("auto_variables") or {},
            "auto_play": _jobs(b.get("auto_typo3_play"))},
        "production": {
            "ref": (b.get("prod_ref") or "").strip(),
            "variables": b.get("prod_variables") or {},
            "auto_play": _jobs(b.get("prod_play"))},
        **{e["cfg"]: {"url": _t3m_url(b.get(e["form"] + "url")), "auth_user": _t3m_user(b.get(e["form"] + "auth_user"))}
           for e in T3M_ENVS.values()}}


def update_project(b):
    pid = b["id"]                       # id stays stable (state/runs reference it)
    with lock:
        cfg = config()
        for i, old in enumerate(cfg["projects"]):
            if old["id"] == pid:
                new = build_project(b, pid)
                save_t3m_key(pid, b)
                cfg["projects"][i] = new
                save_config(cfg)
                break
        else:
            raise RuntimeError(f"Unknown project: {pid}")
        if old.get("auto_typo3", {}).get("major") != new["auto_typo3"]["major"]:
            typo3_seen_reset([pid])     # new major -> fresh baseline, no instant trigger
    log(f"Project updated: {pid}")
    return new


def update_monitoring(b):
    """Save the t3monitor settings of ONE instance (URL, key, basic auth); all other project settings stay as they are."""
    pid, env = b["id"], b.get("env") or "production"
    t3m_env(env)
    e = T3M_ENVS[env]
    entry = {"url": _t3m_url(b.get(e["form"] + "url")), "auth_user": _t3m_user(b.get(e["form"] + "auth_user"))}
    with lock:
        cfg = config()
        p = next((x for x in cfg["projects"] if x["id"] == pid), None)
        if not p:
            raise RuntimeError(f"Unknown project: {pid}")
        save_t3m_key(pid, b, [env])
        p[e["cfg"]] = entry
        save_config(cfg)
    log(f"t3monitor settings updated: {pid} ({env})")
    return p


def add_project(b):
    project = build_project(b)
    pid = project["id"]
    with lock:
        cfg = config()
        if any(p["id"] == pid for p in cfg["projects"]):
            raise RuntimeError(f"Project already exists: {pid}")
        save_t3m_key(pid, b)
        cfg["projects"].append(project)
        save_config(cfg)
    log(f"Project added: {pid}")
    return project


# ---------------------------------------------------------------- export / import
def export_projects():
    """All projects with their t3monitor keys and Basic auth passwords. The GitLab token is never part of it."""
    out = []
    for p in config()["projects"]:
        secrets = {}
        for env in T3M_ENVS:
            s = {"key": t3m_key(p["id"], env), "auth_password": t3m_auth_password(p["id"], env)}
            if any(s.values()):
                secrets[env] = {k: v for k, v in s.items() if v}
        out.append({"project": p, "secrets": secrets})
    log(f"Projects exported: {len(out)} (including t3monitor keys)")
    return {"format": EXPORT_FORMAT, "version": 1, "exported": now(), "projects": out}


def _str_map(v, what):
    if not isinstance(v or {}, dict) or any(not isinstance(x, (str, int, float)) or isinstance(x, bool) for x in (v or {}).values()):
        raise RuntimeError(f"{what} must be a map of names to values")
    return {str(k): str(x) for k, x in (v or {}).items()}


def _import_entry(entry):
    """Exported entry -> (normalised project, form body for save_t3m_key). Validates everything, writes nothing."""
    if not isinstance(entry, dict) or not isinstance(entry.get("project"), dict):
        raise RuntimeError("Entry without project data")
    p, secrets = entry["project"], entry.get("secrets") or {}
    pid = p.get("id")
    if not isinstance(pid, str) or not pid:
        raise RuntimeError("Project without id")
    t3m_key_file(pid)                                    # validates the id (it becomes part of file names)
    auto, prod = p.get("auto_typo3") or {}, p.get("production") or {}
    if not all(isinstance(x, dict) for x in (auto, prod, secrets)):
        raise RuntimeError(f"{pid}: invalid project data")
    b = {"name": p.get("name"), "path": p.get("path"), "ref": p.get("ref"), "ci": p.get("ci", True), "elts": p.get("elts", False),
         "gitlab_url": p.get("gitlab_url"), "variables": _str_map(p.get("variables"), f"{pid}: variables"),
         "auto_play": p.get("auto_play"), "auto_enabled": auto.get("enabled"), "major": auto.get("major"),
         "auto_variables": _str_map(auto.get("variables"), f"{pid}: TYPO3 update variables"),
         "auto_typo3_play": auto.get("auto_play"), "prod_ref": prod.get("ref"),
         "prod_variables": _str_map(prod.get("variables"), f"{pid}: production variables"), "prod_play": prod.get("auto_play"),
         # user names are per installation: kept only if that user exists here
         "owner": p.get("owner") if isinstance(p.get("owner"), str) and user_get(p["owner"]) else ""}
    for k in ("name", "path", "ref", "gitlab_url", "prod_ref"):
        if not isinstance(b[k] or "", str):
            raise RuntimeError(f"{pid}: {k} must be text")
    for k in ("auto_play", "auto_typo3_play", "prod_play"):
        if not isinstance(b[k] or [], list) or any(not isinstance(x, str) for x in b[k] or []):
            raise RuntimeError(f"{pid}: {k} must be a list of job names")
    for env, e in T3M_ENVS.items():
        c, s = p.get(e["cfg"]) or {}, secrets.get(env) or {}
        if not isinstance(c, dict) or not isinstance(s, dict) or any(not isinstance(x, str) for x in s.values()):
            raise RuntimeError(f"{pid}: invalid t3monitor data ({e['label']})")
        key, pw = s.get("key", "").strip(), s.get("auth_password", "")
        b.update({e["form"] + "url": c.get("url"), e["form"] + "auth_user": c.get("auth_user"),
                  e["form"] + "key": key, e["form"] + "key_clear": not key,          # the file is the full truth:
                  e["form"] + "auth_password": pw, e["form"] + "auth_clear": not pw})  # nothing in it = nothing stored
    try:
        project = build_project(b, pid)
        if not re.match(r"https?://[^\s/]+$", project["gitlab_url"]):
            raise RuntimeError("GitLab URL must look like https://host")
        for env, e in T3M_ENVS.items():
            k = b[e["form"] + "key"]
            if k and (len(k) != 64 or any(ch.isspace() for ch in k)):
                raise RuntimeError(f"t3monitor key ({e['label']}) must be exactly 64 characters")
    except (RuntimeError, TypeError, ValueError) as err:
        raise RuntimeError(f"{pid}: {err}") from None
    return project, b


def import_projects(data, overwrite=False):
    """Add the projects of an export file. Existing ids are skipped unless overwrite is set."""
    if not isinstance(data, dict) or data.get("format") != EXPORT_FORMAT or not isinstance(data.get("projects"), list):
        raise RuntimeError("Not a T3 Watchdock project export file")
    if data.get("version") != 1:
        raise RuntimeError(f"Unsupported export file version: {data.get('version')}")
    entries = [_import_entry(e) for e in data["projects"]]          # validate all before writing anything
    ids = [p["id"] for p, _ in entries]
    if len(set(ids)) != len(ids):
        raise RuntimeError("Export file contains the same project id more than once")
    res = {"added": [], "updated": [], "skipped": []}
    with lock:
        cfg = config()
        pos = {p["id"]: i for i, p in enumerate(cfg["projects"])}
        reset = []
        for project, b in entries:
            pid = project["id"]
            if pid in pos and not overwrite:
                res["skipped"].append(pid)
                continue
            save_t3m_key(pid, b)
            if pid in pos:
                if cfg["projects"][pos[pid]].get("auto_typo3", {}).get("major") != project["auto_typo3"]["major"]:
                    reset.append(pid)           # new major -> fresh baseline, no instant trigger
                cfg["projects"][pos[pid]] = project
                res["updated"].append(pid)
            else:
                cfg["projects"].append(project)
                res["added"].append(pid)
        save_config(cfg)
        if reset:
            typo3_seen_reset(reset)
    log(f"Projects imported: {len(res['added'])} added, {len(res['updated'])} updated, {len(res['skipped'])} skipped")
    return res
