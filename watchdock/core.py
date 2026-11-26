"""Paths, settings, shared state and JSON storage."""
import datetime
import json
import os
import subprocess
import threading
from pathlib import Path


BASE = Path(__file__).resolve().parent.parent  # repo root (app.py)
DATA = Path(os.environ.get("LAUNCHER_DATA", BASE))  # config/state/token location (Docker: /data)
CONFIG = DATA / "config.json"                   # legacy: imported into watchdock.db on first start
STATE = DATA / "state.json"                     # legacy: imported into watchdock.db on first start
TOKEN_FILE = DATA / ".gitlab-token"              # legacy shared token: no longer read (logged if present)
TOKEN_FALLBACK = Path.home() / ".gitlab-token"     # legacy shared token: no longer read (logged if present)
SMTP_PASSWORD_FILE = DATA / ".smtp-password"        # stored by the app (chmod 600)
TEAMS_FILE = DATA / ".teams-webhook"                # Teams webhook URL, a secret (chmod 600)
T3M_DIR = DATA / "t3monitor"                        # t3monitor history per project
T3M_REPORTS = "internal,security,installed_extensions,system"   # system: PHP, database, OS, web server
T3M_KEEP = 300                                      # snapshots (= changes) kept per project
PACKAGIST = "https://repo.packagist.org/p2/"         # extension update check (public package metadata only)
PKG_TTL = 3600                                       # seconds a package's version list is cached
SEVERITY = {-2: "notice", -1: "info", 0: "ok", 1: "warning", 2: "error"}
HOST = os.environ.get("LAUNCHER_HOST", "127.0.0.1")  # Docker: 0.0.0.0, published on 127.0.0.1 only
# extra Host header values, e.g. "local-gitlabrunner.local" (Docker publishes it on port 80)
ALLOWED_HOSTS = {h.strip() for h in os.environ.get("LAUNCHER_ALLOWED_HOSTS", "").split(",") if h.strip()}
# behind a reverse proxy (Docker setup with Traefik): take scheme and client address from X-Forwarded-Proto / -For.
# Only safe while the app port is not reachable except through the proxy.
BEHIND_PROXY = os.environ.get("LAUNCHER_BEHIND_PROXY") == "1"


TYPO3_API = "https://get.typo3.org/api/v1/major/{major}/release/latest"
TYPO3_RELEASES = "https://get.typo3.org/api/v1/major/{major}/release/"   # all releases of a major, newest first, with 'elts'
FINAL_STATUSES = ("success", "failed", "canceled", "skipped")
MAIL_WATCH_TIMEOUT = 24 * 3600   # stop waiting for a pipeline to finish after 24 h
MAIL_WATCH_POLL = 60

lock = threading.RLock()
stop_event = threading.Event()


# ---------------------------------------------------------------- storage
def load(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def save(path, data):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def now():
    return datetime.datetime.now().isoformat(timespec="seconds")


def config():
    """Projects and settings (from watchdock.db; same shape as the former config.json)."""
    from .db import load_config             # late import: db imports core
    return load_config()


def save_config(cfg):
    from .db import save_config as _save
    _save(cfg)


def app_url(path=""):
    """Address of T3 Watchdock for links in Teams/email messages: setting "public_url", else localhost."""
    base = (config().get("public_url") or "").strip() or f"http://127.0.0.1:{int(config().get('port', 8787))}"
    return base.rstrip("/") + "/" + path.lstrip("/")


def log(msg):
    t = now()
    print(f"[{t}] {msg}", flush=True)
    from .db import log_add                 # late import: db imports core
    log_add(t, msg)


def notify(title, msg):
    """macOS notification; text passed as argv (no script injection)."""
    try:
        subprocess.run(
            ["osascript", "-e", "on run argv", "-e",
             "display notification (item 1 of argv) with title (item 2 of argv)",
             "-e", "end run", msg, title],
            check=False, timeout=10, capture_output=True)
    except Exception:
        pass


def write_secret(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(value)
    os.chmod(path, 0o600)
