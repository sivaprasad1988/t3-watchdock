"""TYPO3 release watcher and pipeline result mails."""
import datetime
import json
import threading
import time
import urllib.request

from .core import FINAL_STATUSES, MAIL_WATCH_POLL, MAIL_WATCH_TIMEOUT, TYPO3_API, TYPO3_RELEASES, config, log, notify, now, stop_event
from .alerts import notify_event
from .db import (kv_get, kv_set, mail_watch_add, mail_watch_done, mail_watches, typo3_announce, typo3_latest_merge,
                 typo3_seen, typo3_seen_set, user_token)
from .gitlab import as_user, find_project, gitlab, run_pipeline


def _mail_watch_done(pipeline_id):
    mail_watch_done(pipeline_id)


def watch_pipeline_mail(w):
    """Wait until an auto-triggered pipeline has finished, then send the result mail."""
    deadline = datetime.datetime.fromisoformat(w["t"]).timestamp() + MAIL_WATCH_TIMEOUT
    pl, errors = None, 0
    while not stop_event.is_set():
        try:
            project = find_project(w["project"])
        except RuntimeError:                       # project removed meanwhile
            return _mail_watch_done(w["pipeline"])
        try:
            with as_user(w.get("user")):           # the responsible person whose token started the pipeline
                pl = gitlab(project, "GET", f"/pipelines/{w['pipeline']}")
            if pl["status"] in FINAL_STATUSES:
                break
        except Exception as e:
            errors += 1
            if errors in (1, 10):
                log(f"Mail watch error for pipeline #{w['pipeline']}: {e}")
        if time.time() > deadline:
            break
        stop_event.wait(MAIL_WATCH_POLL)
    if stop_event.is_set():
        return                                     # resumed on next start (kept in state.json)
    status = pl["status"] if pl else "unknown"
    final = status in FINAL_STATUSES
    facts = [("Project", f"{project['name']} ({project['path']})"),
             ("Branch", project["ref"]),
             ("Trigger", w["trigger"]),
             ("Pipeline", f"#{w['pipeline']}"),
             ("Status", status + ("" if final else " (not finished within 24 h)")),
             ("Started", w["t"]),
             ("Finished", (pl or {}).get("finished_at") or "-")]
    title = f"TYPO3 update {project['name']}: {status.upper() if final else 'NOT FINISHED (' + status + ')'}"
    notify_event(title, "Automatic TYPO3 update pipeline on staging.", facts,
                 (pl or {}).get("web_url") or w.get("web_url"))
    _mail_watch_done(w["pipeline"])


def start_mail_watch(project, pl, trigger, user):
    w = {"project": project["id"], "pipeline": pl["id"], "web_url": pl.get("web_url"),
         "trigger": trigger, "t": now(), "user": user}
    mail_watch_add(w)
    threading.Thread(target=watch_pipeline_mail, args=(w,), daemon=True).start()


def resume_mail_watches():
    for w in mail_watches():
        threading.Thread(target=watch_pipeline_mail, args=(w,), daemon=True).start()


# ---------------------------------------------------------------- TYPO3 watcher
def latest_typo3(major):
    with urllib.request.urlopen(TYPO3_API.format(major=int(major)), timeout=30) as r:
        return json.load(r)["version"]


def elts_typo3(major):
    """{'elts': latest release is ELTS-only, 'free': newest release that is not ELTS (None if there is none)}."""
    with urllib.request.urlopen(TYPO3_RELEASES.format(major=int(major)), timeout=30) as r:
        rel = json.load(r)
    free = next((x["version"] for x in rel if not x.get("elts")), None)
    return {"elts": bool(rel and rel[0].get("elts")), "free": free}


def announce_update(due):
    """Before the staging pipelines start: one message per new version (once per project and version)."""
    new = set(typo3_announce([(p["id"], v) for p, _, v in due]))
    todo = [(p, prev, v) for p, prev, v in due if (p["id"], v) in new]
    for v in sorted({v for _, _, v in todo}):
        items = [(p, prev) for p, prev, vv in todo if vv == v]
        major = v.split(".")[0]
        notify_event(f"New TYPO3 {v} released: starting update on staging",
                     f"TYPO3 {v} has been published. The update pipeline is now started on staging for "
                     f"{len(items)} project(s). Result messages follow when the pipelines have finished.",
                     [(p["name"], f"{p['ref']} · {prev} → {v}") for p, prev in items],
                     f"https://get.typo3.org/version/{major}", "TYPO3 release info")
        log(f"Announced TYPO3 {v} update for {len(items)} project(s)")


def check_typo3():
    """Returns (projects with auto-update, list of errors). Errors make the scheduler run count as failed."""
    projects = [p for p in config()["projects"] if p.get("auto_typo3", {}).get("enabled") and p.get("ci") is not False]
    latest, errors, elts = {}, [], {}
    for major in sorted({int(p["auto_typo3"]["major"]) for p in projects}):
        try:
            latest[major] = latest_typo3(major)
        except Exception as e:
            log(f"TYPO3 {major} check failed: {e}")
            errors.append(f"TYPO3 {major} check failed: {e}")
        try:
            elts[str(major)] = elts_typo3(major)
        except Exception as e:                      # UI hint only: keep the last known value, no run error
            log(f"TYPO3 {major} ELTS check failed: {e}")

    due = []                                   # (project, previous version, new version)
    for p in projects:
        major = int(p["auto_typo3"]["major"])
        if major not in latest:
            continue
        v = latest[major]
        prev = typo3_seen().get(p["id"])
        if prev is None:
            # First run: store baseline only, do not trigger.
            typo3_seen_set(p["id"], v)
            log(f"Baseline TYPO3 {v} stored for {p['id']} (no trigger)")
        elif prev != v:
            due.append((p, prev, v))

    # Automatic runs use the token of the project's responsible person (no shared token exists).
    ready, missing = [], []
    for d in due:
        owner = d[0].get("owner")
        (ready if owner and user_token(owner) else missing).append(d)
    for p, prev, v in missing:
        # Not marked as seen -> retried on the next check once a responsible person with a token is set.
        why = "no responsible person set" if not p.get("owner") else f"{p['owner']} has no GitLab token stored"
        log(f"Auto-trigger skipped for {p['id']} (TYPO3 {v}): {why}")
        errors.append(f"Auto-trigger skipped for {p['name']} (TYPO3 {v}): {why}")
        notify_event(f"TYPO3 update {p['name']}: NOT STARTED",
                     "The automatic TYPO3 update runs with the GitLab token of the project's responsible person. "
                     "Set one in the project form (and let them save their token in Profile); it is retried on the next check.",
                     [("Project", f"{p['name']} ({p['path']})"), ("Branch", p["ref"]),
                      ("Trigger", f"TYPO3 {prev} -> {v}"), ("Reason", why)])
    announce_update(ready)
    for p, prev, v in ready:
        trigger = f"TYPO3 {prev} -> {v}"
        try:
            with as_user(p["owner"]):
                pl = run_pipeline(p, p["auto_typo3"].get("variables", {}), trigger,
                                  p["auto_typo3"].get("auto_play", []))
            typo3_seen_set(p["id"], v)
            notify("TYPO3 update started", f"{p['name']}: {v} (pipeline #{pl['id']})")
            start_mail_watch(p, pl, trigger, p["owner"])
        except Exception as e:
            # Not marked as seen -> retried on next check.
            log(f"Auto-trigger failed for {p['id']} (TYPO3 {v}): {e}")
            errors.append(f"Auto-trigger failed for {p['name']} (TYPO3 {v}): {e}")
            notify("TYPO3 auto-update FAILED", f"{p['name']}: {e}")
            notify_event(f"TYPO3 update {p['name']}: NOT STARTED",
                         "The automatic TYPO3 update pipeline could not be started. "
                         "It is retried on the next check.",
                         [("Project", f"{p['name']} ({p['path']})"), ("Branch", p["ref"]),
                          ("Trigger", trigger), ("Error", e)])

    kv_set("last_check", now())
    # keep the last known version of a major whose check failed (used for the update hint in the UI)
    typo3_latest_merge(latest)
    kv_set("typo3_elts", {**(kv_get("typo3_elts") or {}), **elts})
    return projects, errors
