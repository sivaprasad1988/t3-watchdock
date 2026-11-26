"""Background scheduler for periodic tasks."""
import datetime
import os
import re
import sys
import threading
import urllib.parse

from .core import app_url, config, load, lock, log, now, save, save_config, stop_event
from .db import kv_get, kv_set, sched_result_set, sched_results, typo3_latest
from .alerts import notify_event
from .security import (_passed, advisories, nginx_latest, nginx_status, php_cycles, php_status, site_advisories,
                       site_packages, typo3_security_feed)
from .extensions import _vparse
from .versions import APACHE_BAD, ICONS, db_state, php_state, release_data, typo3_state, web_state
from .t3monitor import T3M_ENVS, _n, _upd_text, t3m_cfg, t3m_fetch, t3m_history_file, t3m_key
from .watcher import check_typo3
from .updates import send_update_commands


# ---------------------------------------------------------------- scheduler
NO_WATCH = "--no-watch" in sys.argv or os.environ.get("WATCHDOCK_NO_WATCH") == "1"   # set by app.py for Gunicorn
DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
sched_running = set()


def task_typo3_release():
    projects, errors = check_typo3()
    if not projects:
        return "No project with TYPO3 auto-update"
    if errors:
        raise RuntimeError(" | ".join(errors))
    latest = typo3_latest()
    return "Latest: " + ", ".join(f"TYPO3 {m}: {v}" for m, v in sorted(latest.items()))


def _grouped(rows):
    """Show site and environment only when they change, so rows of one site read as a group."""
    out, prev = [], (None, None)
    for r in rows:
        key = (r[0], r[1])
        out.append(([r[0], r[1]] if key[0] != prev[0] else ["", r[1]] if key != prev else ["", ""]) + r[2:])
        prev = key
    return out


def _explain_failure(err):
    """Plain-language problem and next step for a failed TYPO3 health check."""
    low = err.lower()
    if "encryption key" in low:
        return "The site rejects the t3monitor key", "Compare the key in the t3monitor extension with the one in T3 Watchdock"
    if "timed out" in low or "timeout" in low:
        return "The site did not answer in time", "Check that the site is online and not overloaded"
    if "web page instead" in low:
        return "The site showed a web page instead of status data", "Check the t3monitor URL and Basic auth login"
    if "empty response" in low:
        return "The site sent an empty answer", "Check that the t3monitor extension is installed and active"
    if "http 401" in low or "http 403" in low:
        return "Access denied", "Check the Basic auth login and the t3monitor key"
    if "http 404" in low:
        return "t3monitor not found at this URL", "Check the t3monitor URL"
    if "not resolve" in low or "name or service" in low or "nodename" in low:
        return "Site address not found", "Check the URL and DNS"
    return err[:150], "Open the site in T3 Watchdock and run the check again"


def task_t3monitor():
    sites = [(p, env) for p in config()["projects"] for env in T3M_ENVS
             if t3m_cfg(p, env).get("url") and t3m_key(p["id"], env)]
    if not sites:
        return "No project with t3monitor URL and key"
    failed, totals, results = [], {"err": 0, "upd": 0, "new": 0}, []
    sec_failed, sec_new, sec_status, sec_upd = [], [], [], []
    for p, env in sites:
        label = T3M_ENVS[env]["label"]
        try:
            r = t3m_fetch(p, env, alert=False)
        except Exception as e:
            failed.append(f"{p['name']} · {label}: {e}")
            problem, todo = _explain_failure(str(e))
            sec_failed.append([p["name"], label, {"text": problem, "sub": todo, "tone": "bad"}])
            continue
        results.append((p, env, r))
        d, sev = r["data"], [x.get("severity") for x in r["data"].get("status", [])]
        upd = {k: e for k, e in d["extensions"].items() if e.get("update")}
        totals["err"] += sev.count(2)
        totals["upd"] += len(upd)
        totals["new"] += len(r["new_err"]) + len(r["new_upd"])
        n_err, n_warn = sev.count(2), sev.count(1)
        sec_status.append([p["name"], label, {"text": d.get("typo3") or "?", "mono": True},
                           {"text": n_err, "num": True, "tone": "bad" if n_err else "muted"},
                           {"text": n_warn, "num": True, "tone": "warn" if n_warn else "muted"}])
        for x in r["new_err"][:5]:
            sec_new.append([p["name"], label, x["title"]])
        for k, e in upd.items():
            ext = {"text": k, "mono": True}
            if e.get("major"):
                ext.update(tag="Major")
            elif k in r["new_upd"]:
                ext.update(tag="New", tag_tone="ok")
            sec_upd.append([p["name"], label, ext, {"text": f"{str(e['version']).lstrip('v')} → "
                                                            f"{str(e['latest']).lstrip('v')}", "mono": True}])
    head = [_n(len(sites), "site"), _n(totals["err"], "error"), _n(totals["upd"], "extension update")]
    if failed:
        head.insert(1, f"{len(failed)} FAILED")
    if failed:
        headline = f"{_n(len(failed), 'site')} could not be checked"
    elif sec_new:
        headline = f"{_n(len(sec_new), 'new error')} since the last check"
    else:
        headline = f"All {_n(len(sites), 'site')} checked"
    W = ["30%", "16%"]                         # same Site / Environment column widths in every table
    notify_event("TYPO3 health check: " + " · ".join(head),
                 "Scheduled TYPO3 status check of every site with t3monitor.", [],
                 app_url(), "Open T3 Watchdock",
                 headline=headline,
                 stats=[("Sites checked", len(sites), None),
                        ("Not reachable", len(failed), "bad" if failed else "muted"),
                        ("TYPO3 errors", totals["err"], "bad" if totals["err"] else "muted"),
                        ("Updates", totals["upd"], "warn" if totals["upd"] else "muted")],
                 sections=[
                     {"title": "Could not be checked", "note": "These sites gave no usable answer.",
                      "widths": W, "cols": ["Site", "Environment", "Problem"], "rows": _grouped(sec_failed)},
                     {"title": "New errors since the last check",
                      "widths": W, "cols": ["Site", "Environment", "Error"], "rows": _grouped(sec_new)},
                     {"title": "Extension updates",
                      "note": "Major updates can change behaviour. Test them on staging first.",
                      "widths": W, "cols": ["Site", "Environment", "Extension", "Version"], "rows": _grouped(sec_upd)},
                     {"title": "Status per site", "note": "Errors and warnings from the TYPO3 system status.",
                      "widths": W, "cols": ["Site", "Environment", "TYPO3", "Errors", "Warnings"], "rows": _grouped(sec_status)}])
    try:
        send_update_commands(results)
    except Exception as e:                     # never fail the status check because of the extra message
        log(f"Update commands failed: {e}")
    if failed:
        raise RuntimeError(f"{len(sites) - len(failed)}/{len(sites)} OK. " + " | ".join(failed))
    return f"{len(sites)}/{len(sites)} site(s) checked"


ADV_TONE = {"critical": "bad", "high": "bad", "medium": "warn", "low": "muted"}
ADV_RANK = {"critical": 0, "high": 1, "important": 1, "medium": 3, "moderate": 3, "low": 4}
SEV_RANK = {"Critical": 0, "High": 1, "End of life": 1, "Unsupported": 1, "Security update": 2, "Medium": 3,
            "Not rated": 4, "Update": 5, "Low": 6}


def task_security():
    """PHP support status and security advisories of every site, from its last t3monitor snapshot.
    One summary message per run, only when there are findings not reported before."""
    sites = _monitored_sites()
    if not sites:
        return "No t3monitor data yet (run the TYPO3 health check first)"
    cycles = php_cycles()
    try:
        ngx, ngx_err = nginx_latest(), ""
    except RuntimeError as e:
        ngx, ngx_err = {}, f" · {e}"
    adv = advisories({k for _, _, d in sites for k in site_packages(d)})
    rows, n_adv, n_php, n_ngx, n_new = [], 0, 0, 0, 0
    order = {p["id"]: i for i, p in enumerate(config()["projects"])}
    for p, env, d in sites:
        php = php_status(d.get("php"), cycles) if d.get("php") else None
        found = site_advisories(site_packages(d), adv)
        keys = {f"adv:{a['id']}:{a['package']}:{a['version']}" for a in found}
        if php and php["severity"]:
            keys.add(f"php:{php['state']}:{php['version']}:{php.get('latest')}")
        ngs = nginx_status(d.get("webserver"), ngx)
        if ngs and ngs["severity"]:
            keys.add(f"nginx:{ngs['state']}:{ngs['version']}:{ngs['latest']}")
        with lock:
            hf = t3m_history_file(p["id"], env)
            h = load(hf, {"snapshots": []})
            new = keys - set((h.get("security") or {}).get("reported", []))
            h["security"] = {"checked": now(), "php": php, "advisories": found, "nginx": ngs,
                             "reported": sorted(keys)}
            save(hf, h)
        n_adv += len(found)
        n_php += bool(php and php["severity"])
        n_ngx += bool(ngs and ngs["severity"])
        n_new += len(new)
        site, label = p["name"], T3M_ENVS[env]["label"]
        _sec_row = lambda st, lb, txt, sub, sev, is_new, _k=(order[p["id"]], list(T3M_ENVS).index(env)): (
            is_new, (*_k, SEV_RANK[sev[0]]), [st, lb, {"text": txt, "sub": sub, **({"tag": "New", "tag_tone": "ok"} if is_new else {})},
                                         {"text": "", "tag": sev[0], "tag_tone": sev[1]}])
        if php and php["severity"]:
            sev = ("End of life", "bad") if php["state"] == "eol" else (
                ("Security update", "bad") if (cycles.get(".".join(str(php["version"]).split(".")[:2])) or {}).get("security")
                else ("Update", "warn"))
            rows.append(_sec_row(site, label, f"PHP {php['version']}" + (f" → {php['latest']}" if php.get("latest") else ""),
                                 php["text"].split(" · ", 1)[-1], sev, any(k.startswith("php:") for k in new)))
        if ngs and ngs["severity"]:
            sev = ("Unsupported", "bad") if ngs["state"] == "unsupported" else ("Update", "warn")
            rows.append(_sec_row(site, label, f"nginx {ngs['version']} → {ngs['latest']}", ngs["text"].split(" · ", 1)[-1], sev,
                                 any(k.startswith("nginx:") for k in new)))
        for x in found:
            r = (x.get("severity") or "").lower()
            sev = (r.capitalize(), ADV_TONE[r]) if r in ADV_TONE else ("Not rated", "warn")
            rows.append(_sec_row(site, label, x["title"], " · ".join(
                v for v in (f"{x['package']} {x['version']}", x.get("cve"), x.get("link")) if v), sev,
                f"adv:{x['id']}:{x['package']}:{x['version']}" in new))
    summary = f"{_n(len(sites), 'site')} · {n_adv} security {'advisory' if n_adv == 1 else 'advisories'} · {_n(n_php, 'PHP issue')} · {_n(n_ngx, 'nginx issue')}{ngx_err}"
    if n_new:
        new_rows = sorted((r for r in rows if r[0]), key=lambda r: r[1])
        old_rows = sorted((r for r in rows if not r[0]), key=lambda r: r[1])
        W = ["24%", "12%", "", "15%"]
        cols = ["Site", "Environment", "Finding", "Severity"]
        n_bad = sum(1 for r in new_rows if r[2][3]["tag_tone"] == "bad")
        notify_event(f"Security check: {n_new} new finding(s)", "Scheduled PHP, nginx and security advisory check.",
                     [], app_url(), "Open T3 Watchdock",
                     headline=f"{_n(n_new, 'new security finding')}",
                     stats=[("New findings", n_new, "bad" if n_new else "muted"),
                            ("High priority", n_bad, "bad" if n_bad else "muted"),
                            ("Advisories", n_adv, "bad" if n_adv else "muted"),
                            ("Sites checked", len(sites), None)],
                     sections=[
                         {"title": "New findings", "widths": W, "cols": cols,
                          "note": "Severity: rating of the security advisory (Packagist); for PHP and nginx the "
                                  "version status (security update, end of life, unsupported branch, update).",
                          "rows": _grouped([r[2] for r in new_rows])},
                         {"title": "Still open", "note": "Reported before and not fixed yet.", "widths": W,
                          "cols": cols, "rows": _grouped([r[2] for r in old_rows])}])
    return summary + (f" · {n_new} new" if n_new else "")


def _monitored_sites():
    """(project, env, newest t3monitor data) of every instance with t3monitor URL, key and at least one snapshot."""
    sites = []
    for p in config()["projects"]:
        for env in T3M_ENVS:
            if t3m_cfg(p, env).get("url") and t3m_key(p["id"], env):
                snaps = load(t3m_history_file(p["id"], env), {"snapshots": []}).get("snapshots")
                if snaps:
                    sites.append((p, env, snaps[0]["data"]))
    return sites


def task_releases():
    """New PHP releases (php.net) and nginx releases (nginx.org) on the day they come out. One message per run,
    with the sites that still run an older version. The first run only stores what is there."""
    today = datetime.date.today().isoformat()
    cycles = php_cycles()
    cur = {f"php:{k}": c["latest"] for k, c in cycles.items()
           if c.get("latest") and not _passed(c.get("eol"), today)}
    ngx = nginx_latest()
    cur.update({f"nginx:{b}": v for b, v in ngx.items()})
    with lock:
        old = kv_get("releases") or {}
        first, seen = "seen" not in old, old.get("seen", {})
        newer = lambda k: not seen.get(k) or (_vparse(cur[k]) or ((0,),))[0] > (_vparse(seen[k]) or ((0,),))[0]
        new = [] if first else [k for k in cur if newer(k)]
        kv_set("releases", {"checked": now(), "seen": {**seen, **{k: cur[k] for k in cur if newer(k)}}})
    if new:
        sites, facts = _monitored_sites(), []
        for k in new:
            kind, branch = k.split(":")
            if kind == "php":
                c = cycles.get(branch, {})
                hit = [(p, env) for p, env, d in sites if d.get("php") and str(d["php"]).startswith(branch + ".")
                       and php_status(d["php"], cycles)["severity"]]
                label = f"PHP {cur[k]}" + (" (security release)" if c.get("security") else "")
            else:
                hit = [(p, env) for p, env, d in sites
                       if (st := nginx_status(d.get("webserver"), ngx)) and st["severity"]
                       and st["state"] in (branch, "unsupported")]
                label = f"nginx {cur[k]} ({branch})"
            facts.append((label, (f"{_n(len(hit), 'site')} on an older version: " + ", ".join(
                f"{p['name']} ({T3M_ENVS[env]['label']})" for p, env in hit)) if hit else "No monitored site affected"))
            log(f"New release: {label}")
        notify_event("New release: " + " · ".join(f[0] for f in facts),
                     "New PHP or nginx versions are out (php.net, nginx.org). Listed sites run an older version; "
                     "the PHP, nginx & security advisories check lists them per site.",
                     facts, app_url(), "Open T3 Watchdock")
    if first:
        return f"{len(cur)} branches stored as baseline (messages from the next release on)"
    return " · ".join(f"{k.replace(':', ' ')} {v}" for k, v in cur.items()) + (f" · {len(new)} new" if new else "")


REPORT_COLS = [("typo3", "TYPO3"), ("php", "PHP"), ("db", "Database"), ("web", "Web server")]


def version_report():
    """TYPO3, PHP, database and web server of every site against the newest releases, plus known advisories.
    Shared by the daily email and the Versions page; the last result is kept in kv 'version_report'."""
    sites = _monitored_sites()
    if not sites:
        raise RuntimeError("No t3monitor data yet (run the TYPO3 health check first)")
    rel = release_data()
    order = {p["id"]: i for i, p in enumerate(config()["projects"])}
    envs = list(T3M_ENVS)
    out, advs, count = [], [], {t: 0 for t in ICONS}
    for p, env, d in sorted(sites, key=lambda x: (order.get(x[0]["id"], 999), envs.index(x[1]))):
        u = urllib.parse.urlsplit((t3m_cfg(p, env).get("url") or "").strip())
        base = {"project": p["id"], "name": p["name"], "env": env, "env_label": T3M_ENVS[env]["label"],
                "url": f"{u.scheme}://{u.netloc}/" if u.scheme in ("http", "https") and u.netloc else None}
        pos = (order.get(p["id"], 999), envs.index(env))   # advisories: by site, then severity
        adv = (load(t3m_history_file(p["id"], env), {"snapshots": []}).get("security") or {}).get("advisories") or []
        db, kind = db_state(d.get("db"), rel)
        web, wname, cves = web_state(d.get("webserver"), rel)
        cells = [{**typo3_state(d.get("typo3"), adv, rel), "kind": "TYPO3", "elts": bool(p.get("elts"))}, {**php_state(d.get("php"), rel), "kind": "PHP"},
                 {**db, "kind": kind}, {**web, "kind": wname}]
        for x in cells:
            count[x["tone"]] += 1
        out.append({**base, "cells": cells})
        add = lambda rank, **kw: advs.append({**base, "_k": (pos, rank), **kw})
        low = [x for x in cves if x["rating"] == "low"]
        if low:                                     # low-rated Apache CVEs: one summary row
            add(ADV_RANK["low"], title=_n(len(low), "low-rated Apache CVE"), sub=", ".join(x["cve"] for x in low),
                severity="Low", tone="muted", link=None)
        for x in (x for x in cves if x["rating"] != "low"):
            add(ADV_RANK.get(x["rating"], 2), title=f"{x['cve']}: {x['title']}",
                sub=f"Apache {web['version']} · fixed in {x['fixed']}", severity=x["rating"].capitalize(),
                tone="bad" if x["rating"] in APACHE_BAD else "warn" if x["rating"] == "moderate" else "muted",
                link=f"https://www.cve.org/CVERecord?id={x['cve']}")
        for a in {(a["package"], a["title"]): a for a in adv}.values():   # same advisory from several sources
            r = (a.get("severity") or "").lower()
            add(ADV_RANK.get(r, 2), title=a["title"],
                sub=" · ".join(x for x in (f"{a['package']} {a['version']}", a.get("cve")) if x),
                severity=r.capitalize() or "Not rated", tone=ADV_TONE.get(r, "warn"), link=a.get("link"))
    advs.sort(key=lambda x: x.pop("_k"))
    today = datetime.date.today().isoformat()
    live = lambda cy: [c["latest"] for k, c in sorted(cy.items(), key=lambda kv: _vparse(kv[0]) or ((0,), 0), reverse=True)
                       if c.get("latest") and not _passed(c.get("eol"), today)]
    newest = [["TYPO3", " · ".join(v for _, v in sorted(rel["typo3_latest"].items(), reverse=True)) or "–"],
              ["PHP", " · ".join(live(rel["php"])) or "–"],
              ["MariaDB", " · ".join(live(rel["mariadb"])[:4]) or "–"],
              ["MySQL", " · ".join(live(rel["mysql"])[:3]) or "–"],
              ["nginx", " · ".join(f"{v} ({b})" for b, v in rel["nginx"].items()) or "–"],
              ["Apache", " · ".join(live(rel["apache"])) or "–"]]
    # per instance: worst status of its 4 versions (security > update > up to date); "partial" = some not checked
    worst = lambda st: "bad" if "bad" in st else "warn" if "warn" in st else "ok"
    site_counts = {"bad": 0, "warn": 0, "ok": 0, "partial": 0}
    for x in out:
        tones = [c["tone"] for c in x["cells"]]
        x["status"] = worst(tones)
        site_counts[x["status"]] += 1
        site_counts["partial"] += x["status"] == "ok" and "muted" in tones
    rep = {"generated": now(), "sites": out, "advisories": advs, "newest": newest, "counts": count, "site_counts": site_counts,
           "cols": [c for _, c in REPORT_COLS], "legend": [[t, m] for t, (_, m) in ICONS.items()]}
    kv_set("version_report", rep)
    return rep


def task_daily_report():
    """Daily version report email (see version_report). Sent on every run, also when everything is current."""
    try:
        rep = version_report()
    except RuntimeError as e:
        return str(e)
    sc, n = rep["site_counts"], len(rep["sites"])
    cell = lambda x, kind=True: {"text": x["version"] + (" ELTS" if x.get("elts") else ""), "icon": x["tone"],
                                 "sub": f"{x['kind']} · {x['label']}" if kind else x["label"]}
    rows = [[s["name"], s["env_label"], cell(s["cells"][0], False), cell(s["cells"][1], False),
             cell(s["cells"][2]), cell(s["cells"][3])] for s in rep["sites"]]
    adv_rows = [[a["name"], a["env_label"], {"text": a["title"], "sub": a["sub"]},
                 {"text": a["severity"], "icon": a["tone"]}] for a in rep["advisories"]]
    bad, warn = sc["bad"], sc["warn"]
    headline = (f"All {_n(n, 'site')} up to date" if not bad and not warn else
                " · ".join(x for x in (bad and f"{_n(bad, 'site')} need security action",
                                       warn and f"{_n(warn, 'site')} need an update") if x))
    notify_event(f"Daily version report: {bad} security · {warn} update · {sc['ok']} up to date",
                 "TYPO3, PHP, database and web server of every site compared with the newest releases.", [],
                 app_url("#/versions"), "Open version report", headline=headline,
                 stats=[("Sites", n, None), ("Need security action", bad, "bad" if bad else "muted"),
                        ("Need an update", warn, "warn" if warn else "muted"), ("Up to date", sc["ok"], "ok" if sc["ok"] else "muted")],
                 sections=[
                     {"title": "Sites", "legend": [tuple(x) for x in rep["legend"]],
                      "widths": ["15%", "11%", "19%", "18%", "19%", "18%"],
                      "cols": ["Site", "Environment", *rep["cols"]], "rows": _grouped(rows)},
                     {"title": "Security advisories", "note": "Known advisories for TYPO3 core and the public extensions (Packagist) "
                              "and Apache httpd CVEs (httpd.apache.org) for the installed version.",
                      "widths": ["16%", "10%", "", "12%"], "cols": ["Site", "Environment", "Advisory", "Severity"],
                      "rows": _grouped(adv_rows)},
                     {"title": "Newest releases", "rows": rep["newest"]}])
    return f"{_n(n, 'site')} · {bad} need security action · {warn} need an update · {len(adv_rows)} advisories"


def task_typo3_news():
    """TYPO3 security announcements (advisories and PSA). One message per run, only for items not seen before.
    The first run only stores what is there (no message for old announcements)."""
    items = typo3_security_feed()
    if not items:
        raise RuntimeError("TYPO3 security feed contains no announcements")
    with lock:
        old = kv_get("typo3_security") or {}
        first, seen = "seen" not in old, set(old.get("seen", []))
        new = [] if first else [i for i in items if i["id"] not in seen]
        kv_set("typo3_security", {"checked": now(), "seen": ([i["id"] for i in items] + [x for x in old.get("seen", [])
                                                             if x not in {i["id"] for i in items}])[:1000],
                                  "items": items[:30]})
    for i in new:
        log(f"TYPO3 security: {i['title']} {i['link']}")
    if new:
        psa = sum(1 for i in new if i["psa"])
        notify_event(f"TYPO3 security: {_n(len(new), 'new announcement')}" + (f" ({psa} PSA)" if psa else ""),
                     "New entries in the TYPO3 security feed (news.typo3.com). Affected sites are listed by the "
                     "PHP version & security advisories check; announcements (PSA) need a manual look.",
                     [(i["ref"] or i["date"] or "–", f"{i['title']} {i['link']}") for i in new],
                     new[0]["link"], "Open announcement")
    if first:
        return f"{_n(len(items), 'announcement')} stored as baseline (messages from the next new one on)"
    return f"{_n(len(items), 'announcement')} · {len(new)} new" + (f" · latest: {items[0]['title'][:120]}")


TASKS = {
    "typo3_release": {"name": "TYPO3 release check", "run": task_typo3_release, "legacy": "check_interval_hours",
                      "description": "Checks get.typo3.org for new TYPO3 releases; on a new version the update "
                                     "pipeline of every project with TYPO3 auto-update is started."},
    "t3monitor": {"name": "TYPO3 health check (version, extensions, status)", "run": task_t3monitor, "legacy": "t3monitor_interval_hours",
                  "description": "Reads TYPO3 version, extensions and status checks of every project with "
                                 "t3monitor URL and key, and records changes in the history."},
    "releases": {"name": "PHP & nginx releases", "run": task_releases, "legacy": "releases_interval_hours",
                 "defaults": {"hours": 3.0},
                 "description": "Checks php.net and nginx.org for new releases; one message per new version with "
                                "the monitored sites that still run an older version."},
    "security": {"name": "PHP, nginx & security advisories", "run": task_security, "legacy": "security_interval_hours",
                 "defaults": {"mode": "daily", "time": "07:00"},
                 "description": "Checks the PHP version of every site against the newest release (php.net) and support "
                                "dates (endoflife.date), nginx against the current mainline and stable release (nginx.org), "
                                "and TYPO3 core and extensions against known security advisories (Packagist). "
                                "Uses the data of the last TYPO3 health check; messages only for new findings."},
    "daily_report": {"name": "Daily version report", "run": task_daily_report, "legacy": "daily_report_interval_hours",
                     "defaults": {"mode": "daily", "time": "07:30"},
                     "description": "Email with TYPO3, PHP, database (MySQL / MariaDB) and web server (nginx / Apache) of every site compared "
                                    "with the newest releases, with a severity icon per version and the known security "
                                    "advisories. Sent every run, also when everything is current."},
    "typo3_news": {"name": "TYPO3 security announcements", "run": task_typo3_news, "legacy": "typo3_news_interval_hours",
                   "defaults": {"hours": 3.0},
                   "description": "Reads the TYPO3 security feed (news.typo3.com): core and extension advisories and "
                                  "public service announcements such as security release pre-announcements. "
                                  "Messages only for new entries; the list is on the Activity page."},
}


def sched_cfg(tid):
    c = config()
    d = {"enabled": True, "mode": "interval", "hours": float(c.get(TASKS[tid]["legacy"], 6)),
         "time": "07:00", "days": list(range(7)), **TASKS[tid].get("defaults", {})}
    d.update((c.get("scheduler") or {}).get(tid) or {})
    return d


def sched_describe(c):
    if c["mode"] == "daily":
        days = "every day" if len(c["days"]) == 7 else ", ".join(DAYS[d] for d in sorted(c["days"]))
        return f"daily at {c['time']} ({days})"
    return f"every {c['hours']:g} h"


def sched_next(c, last):
    """Next due time; None = disabled. A missed run (launcher was off) is due immediately."""
    if not c["enabled"]:
        return None
    nowd = datetime.datetime.now().replace(microsecond=0)
    last = datetime.datetime.fromisoformat(last) if last else None
    if c["mode"] == "interval":
        return last + datetime.timedelta(hours=c["hours"]) if last else nowd
    h, m = map(int, c["time"].split(":"))
    base = last or nowd
    for i in range(8):
        d = (base + datetime.timedelta(days=i)).replace(hour=h, minute=m, second=0)
        if d > base and d.weekday() in c["days"]:
            return d
    return None


def save_sched(b):
    tid = b.get("id")
    if tid not in TASKS:
        raise RuntimeError(f"Unknown task: {tid}")
    mode = b.get("mode")
    if mode not in ("interval", "daily"):
        raise RuntimeError("Mode must be interval or daily")
    hours = float(b.get("hours") or 0)
    if mode == "interval" and not 0.25 <= hours <= 168:
        raise RuntimeError("Interval must be between 0.25 and 168 hours")
    t = (b.get("time") or "").strip()
    if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", t):
        raise RuntimeError("Time must be HH:MM")
    days = sorted({int(d) for d in b.get("days") or [] if 0 <= int(d) <= 6})
    if mode == "daily" and not days:
        raise RuntimeError("Select at least one weekday")
    with lock:
        cfg = config()
        cfg.setdefault("scheduler", {})[tid] = {"enabled": bool(b.get("enabled")), "mode": mode,
                                                "hours": hours or 6, "time": t, "days": days or list(range(7))}
        save_config(cfg)
    log(f"Scheduler: '{TASKS[tid]['name']}' set to {sched_describe(sched_cfg(tid))}"
        + ("" if b.get("enabled") else " (disabled)"))
    return sched_view()


def sched_run(tid):
    """Run a task now (blocking); records last run and result."""
    if tid in sched_running:
        raise RuntimeError("Task is already running")
    sched_running.add(tid)
    started, ok = now(), True
    try:
        result = TASKS[tid]["run"]()
    except Exception as e:
        ok, result = False, str(e)
        log(f"Scheduler: '{TASKS[tid]['name']}' failed: {e}")
    finally:
        sched_running.discard(tid)
    sched_result_set(tid, started, now(), ok, result[:500])
    return ok, result


def sched_view():
    st = sched_results()
    out = []
    for tid, t in TASKS.items():
        c, r = sched_cfg(tid), st.get(tid, {})
        nxt = sched_next(c, r.get("last_run"))
        out.append({"id": tid, "name": t["name"], "description": t["description"], "cfg": c,
                    "schedule": sched_describe(c), "last_run": r.get("last_run"), "ok": r.get("ok"),
                    "result": r.get("result"), "running": tid in sched_running,
                    "blocked": tid == "typo3_release" and NO_WATCH,
                    "next_run": nxt.isoformat(timespec="seconds") if nxt else None})
    return out


def scheduler():
    while not stop_event.is_set():
        st = sched_results()
        for tid in TASKS:
            if tid in sched_running or (tid == "typo3_release" and NO_WATCH):
                continue
            nxt = sched_next(sched_cfg(tid), st.get(tid, {}).get("last_run"))
            if nxt and nxt <= datetime.datetime.now():
                threading.Thread(target=sched_run, args=(tid,), daemon=True).start()
        stop_event.wait(30)
