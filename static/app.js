const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
// Icon from the inline sprite in index.html (Lucide, ISC); decorative, the button carries title + aria-label
const ic = (name, cls = "") => `<svg class="ic${cls ? " " + cls : ""}" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;
// Icon-only button: tooltip and accessible name from one text
const icBtn = (name, label, attrs = "", cls = "btn sec icon") => `<button type="button" class="${cls}" title="${esc(label)}" aria-label="${esc(label)}" ${attrs}>${ic(name)}</button>`;
const ACTIVE = ["created","waiting_for_resource","preparing","pending","running","manual","scheduled"];
let S = null, pollT = {};

async function api(path, body) {
  const r = await fetch(path, body ? {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)} : {});
  if (r.status === 401) { location.replace("/login"); throw new Error("login required"); }  // session expired
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || r.status);
  return d;
}
// Flash message top right: success 6 s, error 12 s; click closes it
const closeAfter = ev => ev.submitter?.dataset.close ? (location.hash = "#/", true) : false;  // "Save & close" -> Projects
function toast(msg, err) {
  const t = $("#toast");
  t.innerHTML = `<span class="ico">${err ? "⚠" : "✓"}</span><span class="tmsg">${esc(msg)}</span><span class="x">✕</span>`;
  t.className = "show" + (err ? " err" : ""); t.onclick = () => t.className = t.className.replace("show", "").trim();
  clearTimeout(toast.t); toast.t = setTimeout(() => t.className = "", err ? 12000 : 6000);
}
const varsStr = o => Object.entries(o || {}).map(([k, v]) => `${k}=${v}`).join(", ");
const parseVars = s => Object.fromEntries((s || "").split(",").map(x => x.trim()).filter(x => x.includes("="))
  .map(x => { const i = x.indexOf("="); return [x.slice(0, i).trim(), x.slice(i + 1).trim()]; }).filter(([k]) => k));
const proj = id => S.projects.find(p => p.id === id);
const pUrl = p => `#/p/${encodeURIComponent(p.id)}`;

/* ---------------- plugins (plugins/<name>, switched on in config.json) ---------------- */
// A plugin script calls watchdock.register({projectPage(p, view), settingsPage(stack)}); hooks run after each render.
const PLUGINS = [];
window.watchdock = {register: hooks => PLUGINS.push(hooks), api, esc, toast, ic, proj: id => proj(id), state: () => S};
const pluginHook = (name, ...args) => PLUGINS.forEach(h => { try { h[name]?.(...args); } catch (e) { console.error(e); } });
async function loadPlugins() {
  let list; try { list = await api("/api/plugins"); } catch { return; }
  for (const pl of list) {
    pl.css.forEach(href => document.head.append(Object.assign(document.createElement("link"), {rel: "stylesheet", href})));
    await Promise.all(pl.js.map(src => new Promise(res =>
      document.body.append(Object.assign(document.createElement("script"), {src, onload: res, onerror: res})))));
  }
}
const glUrl = p => `${p.gitlab_url}/${p.path}/-/pipelines`;
const hasCI = p => p.ci !== false;                 // projects without GitLab CI/CD: monitoring only
// "11.5.2-MariaDB-ubu2404" -> "MariaDB 11.5.2", "8.0.36" -> "MySQL 8.0.36" (full value stays in the tooltip)
const dbShort = v => { const m = String(v || "").match(/(\d+\.\d+(?:\.\d+)?)/); if (!m) return v || "";
  return (/mariadb/i.test(v) ? "MariaDB " : "MySQL ") + m[1]; };
const fmt = t => t ? t.replace("T", " ") : "–";

// Theme (Auto = system → Light → Dark) and style, chosen on the Profile page; saved per browser.
// The saved values are applied by the inline script in index.html before the page renders.
const THEMES = [{id:"auto", label:"Auto (system)"}, {id:"light", label:"Light"}, {id:"dark", label:"Dark"}];
function setTheme(id, save) {
  const root = document.documentElement, t = THEMES.find(x => x.id === id) || THEMES[0];
  if (t.id === "auto") delete root.dataset.theme; else root.dataset.theme = t.id;
  if (save) try { t.id === "auto" ? localStorage.removeItem("theme") : localStorage.setItem("theme", t.id); } catch (e) {}
}
$("#logoutBtn").innerHTML = ic("logout");
$("#logoutBtn").onclick = () => api("/api/logout", {}).then(() => location.replace("/login"), e => toast(e.message, true));

const STYLES = [{id:"default", label:"Default"}, {id:"focus", label:"Focus"}, {id:"terminal", label:"Terminal"},
  {id:"turbo", label:"Turbo C++"}];
const focusAvatars = new Map();
function setStyle(id, save) {
  const root = document.documentElement, st = STYLES.some(x => x.id === id) ? id : "default";
  if (st === "default") delete root.dataset.style; else root.dataset.style = st;
  if (save) try { st === "default" ? localStorage.removeItem("style") : localStorage.setItem("style", st); } catch (e) {}
}

// GitHub-style confirmation for destructive actions: the button is enabled only once the exact name is typed.
// Resolves true (confirmed) or false (cancelled / Escape).
function confirmByName(title, bodyHtml, name, action) {
  return new Promise(resolve => {
    const d = document.createElement("dialog");
    d.className = "confirm-dlg";
    d.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2>${bodyHtml}
      <label>To confirm, type <b>${esc(name)}</b> below:</label>
      <input autocomplete="off" spellcheck="false" aria-label="Project name">
      <div class="actions"><button type="button" class="btn sec">Cancel</button>
        <button class="btn danger" value="ok" disabled>${esc(action)}</button></div></form>`;
    const inp = d.querySelector("input"), ok = d.querySelector('[value="ok"]');
    inp.oninput = () => ok.disabled = inp.value.trim() !== name;
    d.querySelector(".btn.sec").onclick = () => d.close();
    d.onclose = () => { resolve(d.returnValue === "ok" && inp.value.trim() === name); d.remove(); };
    document.body.append(d); d.showModal(); inp.focus();
  });
}

async function refresh() {
  S = await api("/api/state");
  const lo = $("#logoutBtn"); lo.title = `Sign out ${S.user}`; lo.setAttribute("aria-label", lo.title);
  const pb = $("#profileBtn"); pb.title = `Profile: ${S.user}`; pb.setAttribute("aria-label", pb.title);
  const pill = $("#tokenPill");
  const tk = S.gitlab_token || {};
  pill.textContent = tk.own ? "Token ✓" : "No token";
  pill.className = "pill" + (tk.own ? "" : " bad");
  pill.title = tk.own ? "Your GitLab token is stored" : "No personal GitLab token: add it in your Profile (needed for everything GitLab)";
}

/* ---------------- router ---------------- */
async function render() {
  Object.values(pollT).forEach(clearTimeout);
  delete $("#view").dataset.pview;
  if (!S) await refresh();
  const [a, b, c, d] = (location.hash.slice(1) || "/").split("/").filter(Boolean);
  const navKey = !a || a === "p" || a === "new" ? "projects" : a;
  document.querySelectorAll("[data-nav]").forEach(n => n.classList.toggle("on", n.dataset.nav === navKey));
  if (!a) return viewProjects();
  if (a === "new") return viewForm();
  if (a === "activity") return viewActivity();
  if (a === "settings") return viewSettings();
  if (a === "plugins") return viewPlugins();
  if (a === "profile") return viewProfile();
  if (a === "scheduler") return viewScheduler();
  if (a === "versions") return viewVersions();
  if (a === "p" && b) {
    const p = proj(decodeURIComponent(b));
    if (!p) return $("#view").innerHTML = `<p class="empty">Project not found. <a href="#/">Back</a></p>`;
    return c === "edit" ? viewForm(p) : viewProject(p, c === "pl" ? Number(d) : null);
  }
  $("#view").innerHTML = `<p class="empty">Page not found. <a href="#/">Back</a></p>`;
}

/* ---------------- views ---------------- */
function loadFocusAvatars() {
  document.querySelectorAll(".focus-avatar").forEach(badge => {
    const {project, gitlab} = badge.dataset;
    if (badge.querySelector("img")) return;
    if (!focusAvatars.has(project)) {
      focusAvatars.set(project, api(`/api/project-avatar?project=${encodeURIComponent(project)}`)
        .then(({url}) => {
          if (!url) return null;
          const base = new URL(gitlab), avatar = new URL(url, base);
          return avatar.protocol === "https:" && avatar.origin === base.origin && !avatar.username && !avatar.password
            ? avatar.href : null;
        }).catch(() => null));
    }
    focusAvatars.get(project).then(url => {
      if (!url || !badge.isConnected || badge.querySelector("img")) return;
      const image = new Image();
      image.alt = "";
      image.referrerPolicy = "no-referrer";
      image.onload = () => { if (!badge.querySelector("img")) badge.append(image); };
      image.src = url;
    });
  });
}

// Status of each project's last pipeline on the project cards; refreshed every 8 s while one is busy
// (manual / scheduled = waiting for a person or a time: shown, but refreshed only with the normal 30 s poll)
let RUNST = {};
const BUSY = ACTIVE.filter(s => s !== "manual" && s !== "scheduled");
const RUN_LABEL = {created:"Created", waiting_for_resource:"Waiting for runner", preparing:"Preparing", pending:"Pending",
  running:"Running", manual:"Waiting for manual job", scheduled:"Scheduled", success:"Passed", failed:"Failed",
  canceled:"Canceled", skipped:"Skipped"};
const since = t => { const m = Math.max(0, Math.round((Date.now() - Date.parse(t)) / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
// card = project card: a waiting manual job also gets an info button (message in a tooltip); the style decides which one shows
function runStatusHtml(pid, card) {
  const r = RUNST[pid];
  if (!r) return "";
  if (!r.status) return `<span class="runst" title="${esc(r.error || "")}">status unknown</span>`;
  const active = BUSY.includes(r.status);
  const job = r.job ? ` · ${r.job_status === "manual" ? "▶ " : ""}${esc(r.job)}` : "";
  const html = `<span class="runst st s-${esc(r.status)}${active ? " active" : ""}">${active ? `<span class="dot" aria-hidden="true"></span>` : ""}${esc(RUN_LABEL[r.status] || r.status)}${job}${active && r.started ? ` · ${esc(since(r.started))}` : ""}</span>`;
  if (!card || r.status !== "manual") return html;
  const tip = `${RUN_LABEL.manual}${r.job ? ` · ▶ ${r.job}` : ""}`;
  return `<span class="runst-full">${html}</span><button type="button" class="runst-info" data-act="runtip" aria-label="${esc(tip)}" aria-expanded="false">${ic("info", "sm")}<span class="runst-tip" role="tooltip">${esc(tip)}</span></button>`;
}
function paintRunStatus() {
  document.querySelectorAll("[data-runst]").forEach(el => {
    const r = RUNST[el.dataset.runst];
    const html = runStatusHtml(el.dataset.runst, !!el.closest(".focus-project-run"));
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }   // unchanged: keep an open tooltip open
    const card = el.closest(".pcard");
    if (card) card.classList.toggle("run-active", !!r && BUSY.includes(r.status));
  });
}
async function loadRunStatus() {
  clearTimeout(loadRunStatus.t);
  try { RUNST = await api("/api/runs/status"); } catch { return; }
  if ((location.hash.slice(1) || "/") !== "/") return;
  paintRunStatus();
  if (Object.values(RUNST).some(r => BUSY.includes(r.status))) loadRunStatus.t = setTimeout(loadRunStatus, 8000);
}

// Projects page: technology filter (two steps: technology → version), data from the last TYPO3 health check (T3SUM).
// Versions are grouped: TYPO3 by major, the rest by product + major.minor. A project matches if production OR staging matches.
const mm = v => (String(v || "").match(/\d+\.\d+/) || [""])[0];
const TECH = {
  typo3: {label: "TYPO3", get: x => { const m = String(x.typo3 || "").match(/^(\d+)\./); return m ? `TYPO3 ${m[1]}` : ""; }},
  php: {label: "PHP", get: x => mm(x.php) && `PHP ${mm(x.php)}`},
  db: {label: "Database", get: x => x.db ? `${/mariadb/i.test(x.db) ? "MariaDB" : "MySQL"} ${mm(x.db)}`.trim() : ""},
  web: {label: "Web server", get: x => { const m = String(x.webserver || "").match(/^([A-Za-z][\w-]*)(?:\/(\d+\.\d+))?/);
    return m ? `${m[1]}${m[2] ? " " + m[2] : " (version hidden)"}` : ""; }},
  os: {label: "OS", get: x => { const m = String(x.os || "").match(/^([A-Za-z]+)\s+(\d+\.\d+)?/); return m ? `${m[1]}${m[2] ? " " + m[2] : ""}` : ""; }},
};
let techFilter = {tech: "typo3", val: "", open: false};
const techVals = (pid, tech) => { const x = T3SUM?.[pid] || {};
  return [...new Set(T3M_ENVS.map(e => x[e.env]).filter(y => y?.has_data).map(TECH[tech].get).filter(Boolean))]; };
const verDesc = (a, b) => { const n = s => (s.match(/[\d.]+$/) || ["0"])[0].split(".").map(Number), A = n(a), B = n(b);
  const pa = a.replace(/[\d.]+$/, ""), pb = b.replace(/[\d.]+$/, "");
  return pa !== pb ? pa.localeCompare(pb) : (B[0] - A[0]) || ((B[1] || 0) - (A[1] || 0)); };
function paintTechFilter() {   // tabs = technology, chips = "All" + versions with project counts
  const box = $("#tfChips"); if (!box) return;
  document.querySelectorAll("[data-act=tftab]").forEach(b => { const on = b.dataset.tech === techFilter.tech;
    b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; });
  const count = new Map();
  S.projects.forEach(p => techVals(p.id, techFilter.tech).forEach(k => count.set(k, (count.get(k) || 0) + 1)));
  if (techFilter.val && !count.has(techFilter.val)) techFilter.val = "";
  // TYPO3 / PHP: the tab already names the product, so the chip shows the version only
  // TYPO3 chips get a "v" prefix: v13
  const short = k => techFilter.tech === "typo3" ? "v" + k.replace(/^\S+ /, "")
    : techFilter.tech === "php" ? k.replace(/^\S+ /, "") : k;
  const chip = (v, label, n) => `<button type="button" class="tchip" data-act="tfval" data-v="${esc(v)}" aria-pressed="${techFilter.val === v}"
    title="${esc(v ? `${v}: ${n} project${n === 1 ? "" : "s"}` : "All projects")}">${esc(label)}${v ? `<span class="tcount">${n}</span>` : ""}</button>`;
  box.innerHTML = chip("", "All") + [...count.keys()].sort(verDesc).map(k => chip(k, short(k), count.get(k))).join("")
    + (count.size ? "" : `<span class="sub tchips-empty">${T3SUM ? "No data" : "Loading…"}</span>`);
  applyTechFilter();
}
function applyTechFilter() {
  const {tech, val} = techFilter, on = !!(tech && val);
  const show = new Set(on ? S.projects.filter(p => techVals(p.id, tech).includes(val)).map(p => p.id) : []);
  document.querySelectorAll("#view [data-pid]").forEach(el => { el.hidden = on && !show.has(el.dataset.pid); });
  if ($("#tfCount")) $("#tfCount").textContent = on ? `${show.size} of ${S.projects.length} projects` : "";
}

// Refresh buttons with a progress fill (bottom → top). Progress lives here, keyed per button purpose, not in the
// element: views re-render while a refresh runs (30 s poll, loadT3m), and every render draws the button from this state.
// Fill = finished tasks + a creep for every task in flight (eases out towards 90 % of its slice), so even a single
// request rises steadily; the real jump to its slice happens when it finishes. The creep is an estimate, not a measure.
const PROG = {};                                     // key -> {done, total, failed, running: Map(task index -> start)}
const progPct = key => { const s = PROG[key]; if (!s) return 0; const now = Date.now();
  const creep = [...s.running.values()].reduce((a, t0) => a + 0.9 * (1 - Math.exp(-(now - t0) / 2000)), 0);
  return Math.min(100, Math.round((s.done + creep) / s.total * 100)); };
function progBtn(key, label, attrs, cls = "btn sec icon") {
  const on = !!PROG[key];
  return `<button type="button" class="${cls}${on ? " busy fill" : ""}" data-prog="${esc(key)}" data-tip="${esc(label)}" style="--p:${progPct(key)}%"
    title="${esc(label)}" aria-label="${esc(label)}" ${attrs}${on ? " disabled" : ""}>${ic("refresh")}</button>`;
}
function progPaint(key) {
  const s = PROG[key];
  document.querySelectorAll(`[data-prog="${CSS.escape(key)}"]`).forEach(b => {
    const t = s ? `Refreshing… ${s.done}/${s.total}` : b.dataset.tip;
    b.disabled = !!s; b.classList.toggle("busy", !!s); b.classList.toggle("fill", !!s);
    b.style.setProperty("--p", `${progPct(key)}%`); b.title = t; b.setAttribute("aria-label", t);
  });
}
async function runProg(key, tasks, conc = 4) {        // tasks: async functions; returns {total, failed} or null if already running
  if (PROG[key] || !tasks.length) return null;
  const st = PROG[key] = {done: 0, total: tasks.length, failed: 0, running: new Map()};
  progPaint(key);
  const tick = setInterval(() => progPaint(key), 200);
  let i = 0;
  const worker = async () => { while (i < tasks.length) { const n = i++; st.running.set(n, Date.now());
    try { await tasks[n](); } catch (e) { st.failed++; }
    st.running.delete(n); st.done++; progPaint(key); } };
  await Promise.all(Array.from({length: Math.min(conc, tasks.length)}, worker));
  clearInterval(tick);
  await new Promise(r => setTimeout(r, 350));        // let the fill reach the top before it resets
  delete PROG[key]; progPaint(key);
  return {total: st.total, failed: st.failed};
}

// Projects page: grid (cards) or list (TYPO3 status table); choice remembered per browser
const projView = () => { try { return localStorage.getItem("projectsView") === "list" ? "list" : "grid"; } catch (e) { return "grid"; } };
function viewProjects(fresh) {   // fresh = T3SUM was just fetched, no reload needed
  const projectsWithRuns = new Set(S.projects_with_runs || []);
  // Terminal style: monitored projects (at least one instance with URL + key) first, alphabetically; the rest below
  const list = document.documentElement.dataset.style !== "terminal" ? S.projects : [...S.projects].sort((a, b) => {
    const ca = T3M_ENVS.some(e => t3mOn(a, e)), cb = T3M_ENVS.some(e => t3mOn(b, e));
    return ca !== cb ? (ca ? -1 : 1) : a.name.localeCompare(b.name, undefined, {sensitivity: "base"});
  });
  const cards = list.map(p => {
    const last = S.runs.find(r => r.project === p.id);
    const monitoring = T3M_ENVS.filter(e => p[e.cfg]?.url).map(e => {
      const ready = t3mOn(p, e);
      return `<span class="focus-monitor ${ready ? "is-configured" : "is-pending"}">
        ${envLbl(e)}${ready ? "" : " · Key missing"}
      </span>`;
    }).join("");
    const owner = p.owner && (S.users || []).find(u => u.name === p.owner);
    const ownerName = owner ? owner.full_name || owner.name : "";
    return `<article class="pcard focus-project" data-pid="${esc(p.id)}">
      ${owner ? `<span class="owner-av" data-user="${esc(owner.name)}" title="Responsible: ${esc(ownerName)}" role="img" aria-label="Responsible: ${esc(ownerName)}">${esc(initialsOf(ownerName))}</span>` : ""}
      <a class="focus-project-link name" href="${pUrl(p)}">
        ${projectsWithRuns.has(p.id) ? `<span class="focus-avatar" data-project="${esc(p.id)}" data-gitlab="${esc(p.gitlab_url)}" aria-hidden="true">${esc(p.name.trim().split(/\s+/u, 2).map(word => Array.from(word)[0] || "").join("").toLocaleUpperCase())}</span>` : ""}
        <span class="focus-project-name" title="${esc(p.name)}">${esc(p.name)}</span><span class="focus-project-arrow" aria-hidden="true">›</span>
      </a>
      <div class="focus-monitoring" role="group" aria-label="TYPO3 monitoring">
        ${monitoring || `<span class="focus-monitor">Monitoring not configured</span>`}
      </div>
      ${T3M_ENVS.some(e => t3mOn(p, e)) ? `<div class="focus-updates" data-upd="${esc(p.id)}" role="group" aria-label="Pending updates">${cardUpdatesHtml(p)}</div>` : ""}
      <div class="focus-project-run" role="group" aria-label="GitLab CI/CD">
        ${!hasCI(p) ? `<span class="focus-monitor focus-ci is-disabled">CI/CD · Disabled</span>` : last
          ? `<a class="focus-monitor focus-ci is-configured" href="${pUrl(p)}/pl/${Number(last.pipeline)}" aria-label="Open latest CI/CD run #${esc(last.pipeline)}">CI/CD · #${esc(last.pipeline)}</a> <span data-runst="${esc(p.id)}">${runStatusHtml(p.id, true)}</span>`
          : `<span class="focus-monitor focus-ci is-pending">CI/CD · No runs yet</span>`}
      </div>
    </article>`;
  }).join("");
  $("#view").innerHTML = `
    <div class="head"><div><h1>Projects</h1><div class="sub" data-secondary-copy>${S.projects.length} project(s) · <span class="srvlegend"><span class="upd">↑</span> TYPO3 update available · <span class="diff">≠</span> staging differs from production</span></div></div>
      <div class="actions">
        ${S.projects.length ? `<div class="seg" role="group" aria-label="Projects view">${[["grid", "Grid view: project cards"], ["list", "List view: TYPO3 status table"]]
          .map(([v, t]) => `<button type="button" class="seg-b" data-act="pview" data-v="${v}" title="${t}" aria-label="${t}" aria-pressed="${projView() === v}">${ic(v)}</button>`).join("")}</div>` : ""}
        ${S.projects.length ? `<button type="button" class="btn sec icon${techFilter.open ? " on" : ""}" data-act="tftoggle" title="Filter by technology" aria-label="Filter by technology" aria-expanded="${!!techFilter.open}" aria-controls="tfBar">${ic("filter")}</button>` : ""}
        ${S.projects.some(p => T3M_ENVS.some(e => t3mOn(p, e))) ? progBtn("home", "Refresh TYPO3 status of all monitored projects", `data-act="t3mrefreshhome"`) : ""}
        ${S.projects.some(hasCI) ? icBtn("play", "Run all: start the main pipeline (not production) of every CI/CD project", `data-act="runall"`, "btn icon") : ""}
        <a class="btn sec icon" href="#/new" title="New project" aria-label="New project">${ic("plus")}</a></div></div>
    ${S.projects.length ? `<div class="tfilter" id="tfBar" role="search" aria-label="Filter projects by technology"${techFilter.open ? "" : " hidden"}>
      <div class="ttabs" role="tablist" aria-label="Technology">${Object.entries(TECH).map(([k, t]) =>
        `<button type="button" class="ttab" role="tab" data-act="tftab" data-tech="${k}" aria-controls="tfChips" aria-selected="${techFilter.tech === k}"${techFilter.tech === k ? "" : ' tabindex="-1"'}>${t.label}</button>`).join("")}</div>
      <div class="tchips-row"><div class="tchips" id="tfChips" role="tabpanel" aria-label="Version"></div>
        <span class="sub" id="tfCount" aria-live="polite"></span></div></div>` : ""}
    ${cards ? `<div class="grid">${cards}</div>` : `<div class="card empty">No projects yet. <a href="#/new">Create one</a>.</div>`}
    ${S.projects.length ? `<div class="card full" id="t3sum" style="margin-top:18px"><h2>TYPO3 status – Production &amp; Staging</h2><p class="empty">Loading…</p></div>` : ""}`;
  $("#view").dataset.pview = projView();
  paintTechFilter();
  loadFocusAvatars();
  loadOwnerAvatars();
  paintRunStatus();
  if (S.runs.length) loadRunStatus();          // server caches it (8 s active, 5 min finished)
  if (!S.projects.length) return;
  if (!T3SUM) return loadT3mSummary();               // first visit: fetch once
  loadT3mSummary(T3SUM);                             // cached data at once (synchronous, no flash) ...
  if (!fresh) loadT3mSummary();                      // ... then update in the background
}

// Project card (shown by the Terminal style): pending updates per monitored instance as icons, from the last health check (T3SUM)
function cardUpdatesHtml(p) {
  const s = T3SUM?.[p.id];
  if (!s) return `<span class="sub">${T3SUM ? "No data yet" : "Loading…"}</span>`;
  return T3M_ENVS.filter(e => t3mOn(p, e)).map(e => {
    const x = s[e.env];
    const head = `<span class="upd-env">${esc(e.short)}</span>`;
    if (!x?.has_data) return `<div class="upd-row">${head}<span class="sub">${x?.last_error ? "check failed" : "no data yet"}</span></div>`;
    // icon only; the full text is in the tooltip / aria-label (extensions also show their count)
    const chip = (cls, icon, tip, n) => `<span class="upd-chip ${cls}" title="${esc(tip)}" role="img" aria-label="${esc(tip)}">${ic(icon)}${n ? `<b>${n}</b>` : ""}</span>`;
    const t3u = t3Update(x.typo3, p);
    const chips = [
      t3u.target && chip("sev-1", "t3", `TYPO3 ${x.typo3} · update to ${t3u.target}${t3u.targetElts ? " ELTS" : ""} available`),
      x.ext_updates && chip(x.ext_major ? "sev-2" : "sev-1", "puzzle", extUpdTitle(x), x.ext_updates),
      x.php_check?.severity > 0 && chip(`sev-${x.php_check.severity}`, "php", x.php_check.text),
      x.nginx_check?.severity > 0 && chip(`sev-${x.nginx_check.severity}`, "nginx", x.nginx_check.text),
    ].filter(Boolean);
    return `<div class="upd-row">${head}${chips.join("") || chip("sev0", "ok", "Up to date: no pending TYPO3, extension, PHP or nginx updates")}</div>`;
  }).join("");
}
function paintCardUpdates() {
  document.querySelectorAll("[data-upd]").forEach(el => { const p = proj(el.dataset.upd); if (p) el.innerHTML = cardUpdatesHtml(p); });
}

// Instance with pending extension updates: tinted background (accent = updates, orange = at least one major update)
const extUpdCls = x => x?.ext_updates ? (x.ext_major ? "extupd major" : "extupd") : "";
const extUpdTitle = x => x?.ext_updates ? `${x.ext_updates} extension update${x.ext_updates === 1 ? "" : "s"} pending${x.ext_major ? ` (${x.ext_major} major)` : ""}` : "";

// Overview table on the home page: TYPO3 version + errors/warnings per instance (data from the last TYPO3 health check)
let T3SUM = null;                  // last /api/t3monitor/summary response (reused on re-render: no "Loading…" flash)
const overviewOptions = {sort:"original"};
async function loadT3mSummary(pre) {
  let d;
  try { d = pre ?? await api("/api/t3monitor/summary"); T3SUM = d; }
  catch (err) { if ($("#t3sum")) $("#t3sum").innerHTML = `<h2>TYPO3 status</h2><p class="empty">Error: ${esc(err.message)}</p>`; return; }
  paintCardUpdates();
  const box = $("#t3sum"); if (!box) return;
  // labelled server values; ref = production instance: staging values that differ get ≠ (orange)
  const srvTags = (x, ref) => [["PHP", "php", x.php, x.php], ["DB", "db", dbShort(x.db), x.db], ["Web", "webserver", x.webserver, x.webserver]]
    .filter(([, , txt]) => txt).map(([lbl, k, txt, full]) => {
      const diff = ref && ref[k] && x[k] && ref[k] !== x[k];
      return `<span class="srvtag${diff ? " diff" : ""}" title="${esc(full)}${diff ? ` (production: ${esc(ref[k])})` : ""}"><span class="h">${lbl}</span> ${diff ? "≠ " : ""}${esc(txt)}</span>`;
    }).join("");
  const ver = (x, ref, p) => {
    if (!x) return `<span class="sub">–</span>`;
    if (!x.has_data) return x.last_error ? `<span class="sev-2" title="${esc(x.last_error)}">check failed</span>` : `<span class="sub">no data yet</span>`;
    const t3u = t3Update(x.typo3, p), upd = t3u.target;
    const srv = srvTags(x, ref?.has_data ? ref : null);
    return `<b>${esc(x.typo3 || "?")}</b>${eltsTag(p)}${upd ? ` <span class="sev-1" title="Latest: ${esc(t3u.latest)}${t3u.targetElts ? " ELTS" : ""}">↑ ${esc(upd)}</span>` : ""}
      ${srv ? `<div class="srvtags">${srv}</div>` : ""}
      ${x.last_error ? ` <span class="sev-2" title="${esc(x.last_error)}">⚠ last check failed</span>` : ""}`;
  };
  // health of one instance: icon chips (errors, warnings, security advisories, PHP version check); OK when nothing to report
  const hc = (icon, cls, txt, tip) => `<span class="hchip ${cls}" title="${esc(tip)}" aria-label="${esc(tip)}">${ic(icon)}<b>${esc(txt)}</b></span>`;
  const pl = (n, w, ws = w + "s") => `${n} ${n === 1 ? w : ws}`;
  const ew = x => {
    if (!x?.has_data) return `<span class="sub">–</span>`;
    const chips = [x.errors && hc("err", "sev-2", x.errors, pl(x.errors, "error")),
      x.warnings && hc("warn", "sev-1", x.warnings, pl(x.warnings, "warning")),
      x.advisories && hc("shield", "sev-2", x.advisories, `${pl(x.advisories, "security advisory", "security advisories")} affect this instance`),
      x.php_check?.severity && hc("clock", `sev-${x.php_check.severity}`, "PHP", x.php_check.text),
      x.nginx_check?.severity && hc("clock", `sev-${x.nginx_check.severity}`, "nginx", x.nginx_check.text)].filter(Boolean);
    return chips.join("") || hc("ok", "sev0", "OK", "No errors, warnings or security advisories");
  };
  const projects = S.projects.map(p => {
    const s = d[p.id] || {}, a = s.production, b = s.staging;
    const checked = [a?.last_check, b?.last_check].filter(Boolean).sort()[0];
    return {p, a, b, checked};
  });
  const focusProjects = [...projects];
  if (overviewOptions.sort === "name") focusProjects.sort((a, b) => a.p.name.localeCompare(b.p.name));
  if (overviewOptions.sort === "checked") focusProjects.sort((a, b) => (b.checked || "").localeCompare(a.checked || ""));
  const ranks = new Map(focusProjects.map(({p}, index) => [p.id, index + 1]));
  const rows = projects.map(({p, a, b, checked}) => {
    const diff = a?.typo3 && b?.typo3 && a.typo3 !== b.typo3;
    const pdiff = a?.php && b?.php && a.php !== b.php;
    return `<tr data-pid="${esc(p.id)}" data-rank="${ranks.get(p.id)}"><td class="focus-row-number">${ranks.get(p.id)}</td><td><a href="${pUrl(p)}">${esc(p.name)}</a>${diff ? ` <span class="chip sev-1" title="Production and staging run different TYPO3 versions">versions differ</span>` : ""}${pdiff ? ` <span class="chip sev-1" title="Production and staging run different PHP versions">PHP differs</span>` : ""}</td>
      ${[[a, ver(a, null, p)], [b, ver(b, a, p)]].map(([x, version]) => `<td class="${extUpdCls(x)}" title="${esc(extUpdTitle(x))}">${version}
        ${x?.has_data ? `<div class="focus-env-health">${ew(x)}</div>` : ""}</td>`).join("")}
      <td class="sub">${checked ? esc(fmt(checked)) : "–"}</td></tr>`;
  }).join("");
  box.innerHTML = `<div class="head" style="margin-bottom:8px"><div><h2 style="margin:0">TYPO3 status – Production &amp; Staging</h2>
      <div class="sub" data-secondary-copy>From the last TYPO3 health check · <a href="#/scheduler">Scheduler</a> · “–” = not configured</div></div>
      <div class="overview-options">
        <select name="overview-sort" aria-label="Sort projects">
          ${[["original", "Project order"], ["name", "Project name"], ["checked", "Newest check"]].map(([value, label]) =>
            `<option value="${value}" ${overviewOptions.sort === value ? "selected" : ""}>${label}</option>`).join("")}
        </select>
      </div></div>
    <div class="wrap"><table class="typo3-overview"><thead><tr><th scope="col" class="focus-row-number" aria-label="Row number">#</th><th scope="col">Project</th>
      <th scope="col">${envLbl(T3M_ENVS[0])}</th>
      <th scope="col">${envLbl(T3M_ENVS[1])}</th>
      <th title="Oldest check of the configured instances">Last check</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  updateOverviewOrder();
  paintTechFilter();
  box.querySelector(".overview-options").onchange = ({target}) => {
    overviewOptions.sort = target.value;
    loadT3mSummary(d);
    box.querySelector(`[name="${target.name}"]`).focus();
  };
}

function updateOverviewOrder() {
  const body = $("#t3sum tbody");
  if (!body) return;
  body.append(...[...body.rows].sort((a, b) => Number(a.dataset.rank) - Number(b.dataset.rank)));
}

// "System overview" card (Production / Staging tiles); filled by loadT3m via #system-<env>
const systemOverviewCard = p => `
    <section class="card system-overview">
      <div class="system-overview-heading">
        <h2>System overview</h2>
      </div>
      <div class="system-environments">
        ${T3M_ENVS.map(e => `<section>
          <div class="system-env-head"><h3>${esc(e.label)}</h3>
            <div class="system-env-actions">
              ${t3mOn(p, e) ? progBtn(`t3m:${p.id}:${e.env}`, `Refresh ${e.label} status now`, `data-act="t3mrefresh" data-env="${e.env}"`, "btn sec sm icon") : ""}
              ${icBtn("edit", `Edit ${e.label} monitoring settings`, `data-act="t3medit" data-env="${e.env}"`, "btn sec sm icon")}
              ${icBtn("details", `${e.label}: TYPO3 status details`, `data-act="t3mopen" data-env="${e.env}"`, "btn sec sm icon")}</div></div>
          <div class="system-details" id="system-${e.env}" aria-live="polite">Loading…</div>
        </section>`).join("")}
      </div>
    </section>
    ${T3M_ENVS.map(e => `<dialog class="t3dlg" id="t3dlg-${e.env}" aria-label="TYPO3 status – ${esc(e.label)}" tabindex="-1" autofocus>
      <div id="t3m-${e.env}" class="t3m"><div class="t3h"><div><div class="t3h-k">TYPO3 status</div><h2 class="t3h-t">${esc(e.label)}</h2></div>
        <div class="t3h-a">${icBtn("close", "Close", `data-act="t3mclose"`, "btn sec icon t3sq")}</div></div><p class="empty">Loading…</p></div></dialog>`).join("")}`;

// Long date "17 Nov 2026", time "17:14", schedule "Runs Mon–Fri at 15:17" (from "daily at 15:17 (Mon, Tue, Wed, Thu, Fri)")
const dlong = t => { const x = new Date(t); return Number.isNaN(x.getTime()) ? fmt(t)
  : x.toLocaleDateString("en-GB", {day: "numeric", month: "short", year: "numeric"}); };
const hm = t => fmt(t).slice(11, 16);
function runsTxt(sch) {
  const m = /^daily at (\d\d:\d\d) \((.+)\)$/.exec(sch || "");
  if (!m) return sch ? `Runs ${sch}` : "No schedule";
  if (m[2] === "every day") return `Runs daily at ${m[1]}`;
  const D = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], ds = m[2].split(", "), ix = ds.map(x => D.indexOf(x));
  const range = ds.length > 2 && ix.every((v, i) => v >= 0 && (i === 0 || v === ix[i - 1] + 1));
  return `Runs ${range ? `${ds[0]}–${ds[ds.length - 1]}` : ds.join(", ")} at ${m[1]}`;
}
// "Recent runs" row: environment tag, pipeline number, trigger (icon + short text), relative time (exact time in tooltip)
const ago = t => { const m = Math.max(0, Math.round((Date.now() - Date.parse(t)) / 60000));
  if (Number.isNaN(m)) return fmt(t);
  if (m < 1) return "just now"; if (m < 60) return `${m} min ago`; if (m < 1440) return `${Math.floor(m / 60)} h ago`;
  const d = Math.floor(m / 1440); return d === 1 ? "yesterday" : d < 7 ? `${d} days ago` : fmt(t).slice(0, 10); };
function runTrigger(t = "") {
  let m;
  if ((m = t.match(/^promote #(\d+) -> /))) return ["play", `from #${m[1]}`, `Promoted from staging pipeline #${m[1]}`];
  if ((m = t.match(/^TYPO3 (\S+) -> (\S+)$/))) return ["update", `TYPO3 ${m[1]} → ${m[2]}`, `Automatic TYPO3 update ${m[1]} → ${m[2]}`];
  if (t === "manual TYPO3 update") return ["update", "TYPO3 update", "TYPO3 update, started by hand"];
  if (/^manual( -> |$)/.test(t)) return ["play", "manual", "Started by hand"];
  return ["play", t, t];
}
function runRow(p, r, prod, on) {
  const [icon, txt, tip] = runTrigger(r.trigger);
  return `<a href="${pUrl(p)}/pl/${Number(r.pipeline)}" class="run-row${on ? " on" : ""}" title="${esc(tip)} · ${esc(fmt(r.t))}">
    <span class="env-tag ${prod ? "prod" : "stg"}">${prod ? "PROD" : "STG"}</span>
    <code class="run-id">#${esc(r.pipeline)}</code>
    <span class="run-trig">${ic(icon, "sm")}${esc(txt)}</span>
    <time class="sub" datetime="${esc(r.t)}">${esc(ago(r.t))}</time></a>`;
}

function viewProject(p, pipelineId) {
  if (!hasCI(p)) return viewProjectNoCI(p);
  const a = p.auto_typo3 || {};
  const runs = S.runs.filter(r => r.project === p.id);
  // one pipeline card per environment; a run selected in "Recent runs" replaces the latest run of its environment
  const prodRef = p.production?.ref || "";
  const isProd = r => prodRef && (r.ref ? r.ref === prodRef : / -> /.test(r.trigger || ""));
  const sel = pipelineId && runs.find(r => r.pipeline === pipelineId);
  const pick = prod => (sel && !!isProd(sel) === prod ? sel : runs.find(r => !!isProd(r) === prod))?.pipeline
    || (pipelineId && !sel && !prod ? pipelineId : null);
  const envs = [{slot: "stg", label: "Staging", ref: p.ref, mode: "normal", pid: pick(false)}];
  if (prodRef) envs.push({slot: "prod", label: "Production", ref: prodRef, mode: "production", pid: pick(true)});
  const pid = pipelineId || (runs[0] && runs[0].pipeline);
  $("#view").innerHTML = `
    <div class="crumb"><a href="#/">Projects</a> / ${esc(p.name)}</div>
    <div class="head">
      <div><h1>${esc(p.name)}</h1>
        <div class="sub">${esc(p.path)} · <code>${esc(p.ref)}</code> · <a href="${esc(glUrl(p))}" target="_blank" rel="noopener">GitLab ${ic("ext", "sm")}</a></div></div>
      <div class="actions">
        ${T3M_ENVS.some(e => t3mOn(p, e)) ? progBtn(`proj:${p.id}`, "Refresh TYPO3 status of all monitored environments", `data-act="t3mrefreshall"`) : ""}
        ${a.enabled ? icBtn("update", "Run TYPO3 update (staging pipeline)", `data-act="run" data-mode="update"`) : ""}
        ${icBtn("send", "Send update commands: ready-to-run commands for pending extension updates via Teams / email", `data-act="updsend"`)}
        <a class="btn sec icon" href="${pUrl(p)}/edit" title="Edit project" aria-label="Edit project">${ic("edit")}</a>
      </div>
    </div>
    ${systemOverviewCard(p)}
    <div class="two">
      <div class="stack">
        ${envs.map(e => `<div class="card pipe-env pipe-${e.slot}">
          <div class="pipe-head"><h2 title="Branch: ${esc(e.ref)}"><span class="env-l">${e.label}</span>${e.ref.toLowerCase() !== e.label.toLowerCase() ? ` <code>${esc(e.ref)}</code>` : ""}</h2>
            ${icBtn("play", `Run ${e.label.toLowerCase()}`, `data-act="run" data-mode="${e.mode}"`, `btn icon${e.slot === "prod" ? " prod" : ""}`)}</div>
          <div class="pipe-title" id="pipeTitle-${e.slot}">${e.pid ? "Pipeline #" + esc(e.pid) : ""}</div>
          <div id="pipe-${e.slot}">${e.pid ? `<p class="empty">Loading…</p>` : `<p class="empty">No ${e.label.toLowerCase()} pipeline started from the launcher yet.</p>`}</div></div>`).join("")}
        <div class="card"><h2>Recent runs</h2><div class="runs">
          ${runs.map(r => runRow(p, r, !!isProd(r), r.pipeline === pid)).join("")
            || `<p class="empty">No runs yet.</p>`}
        </div></div>
      </div>
      <div class="stack">
        <div class="card project-config"><h2>Configuration</h2>
          <section>
            <h3>Pipeline <code>${esc(p.ref)}</code></h3>
            ${pipelineConfigDetails(p)}
          </section>
          ${p.production?.ref ? `<section>
            <h3>Production <code>${esc(p.production.ref)}</code></h3>
            ${pipelineConfigDetails(p.production)}
          </section>` : ""}
          <section>
            <h3>Automatic TYPO3 updates <span class="config-status ${a.enabled ? "sev0" : "sub"}">${a.enabled ? "On" : "Off"}</span></h3>
            ${a.enabled ? `<dl>
              <dt>Major version</dt><dd>${esc(a.major)}</dd>
              ${S.typo3_seen[p.id] ? `<dt>Last seen</dt><dd>${esc(S.typo3_seen[p.id])}</dd>` : ""}
              ${varsStr(a.variables) ? `<dt>Variables</dt><dd><code>${esc(varsStr(a.variables))}</code></dd>` : ""}
            </dl>` : ""}
          </section>
        </div>
        <div class="card danger-zone"><h2>Danger zone</h2>
          <p class="sub" style="margin:0 0 10px">Removes the project from the launcher only. Nothing changes in GitLab.</p>
          <button class="btn danger sm" data-act="del">Remove project</button></div>
      </div>
    </div>
`;
  $("#view").dataset.project = p.id;
  envs.forEach(e => e.pid && loadPipeline(p, e.pid, e.slot));
  T3M_ENVS.forEach(e => loadT3m(p, e));
  pluginHook("projectPage", p, $("#view"));
}

function pipelineConfigDetails(config) {
  const variables = varsStr(config.variables), jobs = (config.auto_play || []).join(", ");
  if (!variables && !jobs) return "";
  return `<dl>
    ${variables ? `<dt>Variables</dt><dd><code>${esc(variables)}</code></dd>` : ""}
    ${jobs ? `<dt>Auto-play</dt><dd><code>${esc(jobs)}</code></dd>` : ""}
  </dl>`;
}

// Project without GitLab CI/CD: no pipelines, only TYPO3 status (t3monitor) and extension update messages
function viewProjectNoCI(p) {
  $("#view").innerHTML = `
    <div class="crumb"><a href="#/">Projects</a> / ${esc(p.name)}</div>
    <div class="head">
      <div><h1>${esc(p.name)}</h1>
        <div class="sub"><span class="chip">no CI/CD</span>${p.path ? ` · ${esc(p.path)}` : ""}${p.ref ? ` · <code>${esc(p.ref)}</code>` : ""}</div></div>
      <div class="actions">
        ${T3M_ENVS.some(e => t3mOn(p, e)) ? progBtn(`proj:${p.id}`, "Refresh TYPO3 status of all monitored environments", `data-act="t3mrefreshall"`) : ""}
        ${icBtn("send", `Send update list: pending extension updates via Teams / email${p.ref ? " (with ready-to-run commands)" : ""}`, `data-act="updsend"`)}
        <a class="btn sec icon" href="${pUrl(p)}/edit" title="Edit project" aria-label="Edit project">${ic("edit")}</a>
      </div>
    </div>
    ${systemOverviewCard(p)}

    <div class="card danger-zone" style="margin-top:18px"><h2>Danger zone</h2>
      <p class="sub" style="margin:0 0 10px">Removes the project from the launcher only.</p>
      <button class="btn danger sm" data-act="del">Remove project</button></div>`;
  $("#view").dataset.project = p.id;
  T3M_ENVS.forEach(e => loadT3m(p, e));
  pluginHook("projectPage", p, $("#view"));
}

const SEV = {"-2":"notice", "-1":"info", "0":"ok", "1":"warning", "2":"error"};
const sevBadge = n => `<span class="badge ${Number(n) === 0 ? "sev0" : "sev-" + Number(n)}">${esc(SEV[n] || n)}</span>`;  // CSS: sev-2 error, sev-1 warning, sev0 ok, sev--1/--2 info
const verCmp = (a, b) => { const x = String(a).split("."), y = String(b).split(".");
  for (let i = 0; i < 3; i++) { const d = (parseInt(x[i]) || 0) - (parseInt(y[i]) || 0); if (d) return d; } return 0; };
// "ELTS" badge next to a TYPO3 version of a project marked "Runs TYPO3 ELTS" in its settings
const eltsTag = p => p?.elts ? ` <span class="chip elts" title="Runs TYPO3 ELTS (extended long term support)">ELTS</span>` : "";
// TYPO3 core update for an installed version of project p. ELTS releases (paid, extended support) count as an update
// only for a project marked "ELTS" in its settings (p.elts); others get the newest free release, the ELTS one is only a hint.
// -> {latest, target: version to update to or null, targetElts: target is an ELTS release, eltsHint: ELTS release or null}
function t3Update(v, p) {
  const latest = S.typo3_latest?.[String(v || "").split(".")[0]], e = S.typo3_elts?.[String(v || "").split(".")[0]];
  if (!latest || !v) return {latest, target: null, targetElts: false, eltsHint: null};
  const onElts = !!p?.elts || !e?.free, eltsLatest = !!e?.elts;
  const target = eltsLatest && !onElts ? e.free : latest;
  return {latest, target: verCmp(target, v) > 0 ? target : null, targetElts: eltsLatest && onElts,
          eltsHint: eltsLatest && !onElts && verCmp(latest, v) > 0 ? latest : null};
}

// Security section of an instance (result of the scheduled "PHP, nginx & security advisories" task)
function secBody(sec) {
  const adv = sec.advisories || [], php = sec.php, ngx = sec.nginx;
  return `<p class="sub" style="margin:0 0 8px">${php ? esc(php.text) : "PHP version unknown"}${ngx ? ` · ${esc(ngx.text)}` : ""} · checked ${esc(fmt(sec.checked))}</p>
    ${adv.length ? `<div class="wrap"><table class="checks"><thead><tr><th>Severity</th><th>Package</th><th>Installed</th><th>Advisory</th><th>Affected</th></tr></thead><tbody>
      ${adv.map(a => `<tr><td><span class="badge ${a.severity === "low" ? "sev-1" : "sev-2"}">${esc(a.severity || "?")}</span></td><td><code>${esc(a.package)}</code></td>
        <td>${esc(a.version)}</td><td>${/^https?:\/\//.test(a.link || "") ? `<a href="${esc(a.link)}" target="_blank" rel="noopener">${esc(a.title)} ${ic("ext", "sm")}</a>` : esc(a.title)}${a.cve ? ` <span class="sub">${esc(a.cve)}</span>` : ""}</td>
        <td class="sub">${esc(a.affected)}</td></tr>`).join("")}</tbody></table></div>`
      : `<p class="empty">No known security advisories for TYPO3 core and the public extensions.</p>`}`;
}

async function loadT3m(p, e, refreshNow) {
  const id = "#t3m-" + e.env, box = $(id); if (!box) return;
  const overview = $("#system-" + e.env);
  const url = p[e.cfg]?.url;
  // Modal content (dialog opened from the System overview tile): header (site, env, meta line, refresh/close), then body
  const set = (meta, body, title) => box.innerHTML = `<div class="t3h"><div>
      <div class="t3h-k">TYPO3 status</div>
      <h2 class="t3h-t">${esc(title || p.name)} <span class="t3pill">${esc(e.label)}</span></h2>
      ${meta ? `<div class="t3h-m">${meta}</div>` : ""}</div>
    <div class="t3h-a">${t3mOn(p, e) ? progBtn(`t3m:${p.id}:${e.env}`, `Refresh ${e.label} status now`, `data-act="t3mrefresh" data-env="${e.env}"`, "btn sec icon t3sq") : ""}
      ${icBtn("close", "Close", `data-act="t3mclose"`, "btn sec icon t3sq")}</div></div>
    <div class="t3body">${body}</div>`;
  if (!t3mOn(p, e)) {
    if (overview) overview.textContent = "Monitoring not configured";
    set("", `<p class="empty">Add the ${esc(e.label)} t3monitor URL and key under
      <a href="${pUrl(p)}/edit">Edit</a> to see TYPO3 version, extensions, status checks and their history.</p>`);
    return;
  }
  let d;
  try { d = refreshNow ? await api("/api/t3monitor/refresh", {project:p.id, env:e.env})
                       : await api(`/api/t3monitor?project=${encodeURIComponent(p.id)}&env=${e.env}`); }
  catch (err) {
    if (overview) overview.textContent = "System status unavailable";
    set("", `<div class="t3alert err"><span class="t3dot"></span><div><b>Status unavailable</b><div class="sub">${esc(err.message)}</div></div></div>`);
    return;
  }
  if ($(id) !== box || $("#view").dataset.project !== p.id) return;
  const c = d.current;
  const sch = S.scheduler.find(t => t.id === "t3monitor");
  let host = url; try { host = new URL(url).host.replace(/^www\./, ""); } catch {}
  const meta = [`<a href="${esc(url)}" target="_blank" rel="noopener">${esc(host)} ${ic("ext", "sm")}</a>`,
    d.last_check ? `<span title="${esc(fmt(d.last_check))}">Checked ${esc(dlong(d.last_check))}, ${esc(hm(d.last_check))}</span>` : "Not checked yet",
    `<a href="#/scheduler" class="t3h-sch">${esc(sch?.cfg.enabled === false ? "Schedule off" : runsTxt(sch?.schedule))}</a>`].join(`<span class="t3sep">·</span>`);
  const title = c?.site_name || `${p.name} – ${e.label}`;
  const failedAlert = d.last_error ? `<div class="t3alert err"><span class="t3dot"></span><div><b>Last check failed</b>
    <div class="sub">${esc(d.last_error)}${c ? " · showing the last successful check" : ""}</div></div></div>` : "";
  if (overview) overview.innerHTML = systemOverview(d, e.env, p);
  if (!c) { set(meta, failedAlert + `<p class="empty">No data yet. Click the refresh button.</p>`, title); return; }
  const counts = {}; c.status.forEach(x => counts[x.severity] = (counts[x.severity] || 0) + 1);
  const t3u = t3Update(c.typo3, p), latest = t3u.latest, upd = t3u.target;
  const updTxt3 = upd ? `Update available: ${esc(upd)}${t3u.targetElts ? " ELTS" : ""}${t3u.eltsHint ? ` · ${esc(t3u.eltsHint)} ELTS` : ""}`
    : t3u.eltsHint ? `Update available: ${esc(t3u.eltsHint)} ELTS` : "Latest version";
  const problems = c.status.filter(x => x.severity >= 1).sort((a, b) => b.severity - a.severity);
  const exts = Object.entries(c.extensions).filter(([, e]) => !e.local), local = Object.entries(c.extensions).filter(([, e]) => e.local);
  // Extension updates (Packagist, newest stable release compatible with this site's TYPO3 version)
  const updExt = exts.filter(([, x]) => x.update), majExt = updExt.filter(([, x]) => x.major);
  const updTxt = updExt.length ? `${updExt.length} update${updExt.length === 1 ? "" : "s"}${majExt.length ? ` (${majExt.length} major)` : ""}` : "";
  const latestCell = x => x.local ? `<span class="sub">–</span>`
    : x.update ? `<span class="upd-v">↑ ${esc(x.latest)}</span>${x.major ? ` <span class="chip major" title="Major update: may contain breaking changes">major</span>` : ""}`
    : x.latest_error ? `<span class="sub" title="${esc(x.latest_error)}">unknown</span>`
    : !("latest" in x) ? `<span class="sub">not checked yet</span>`
    : x.latest === null ? `<span class="sub" title="Package not found on Packagist">not on Packagist</span>`
    : x.latest === "" ? `<span class="sub">no compatible release</span>` : `<span class="sub">up to date</span>`;
  const nn = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const errs = counts[2] || 0, warns = counts[1] || 0, pass = counts[0] || 0, total = c.status.length;
  const tone = errs ? "err" : warns ? "warn" : "ok";
  const alert = failedAlert || (errs || warns
    ? `<div class="t3alert ${tone}"><span class="t3dot"></span><div><b>${[errs && nn(errs, "error"), warns && nn(warns, "warning")].filter(Boolean).join(" and ")} need${errs + warns === 1 ? "s" : ""} attention</b>
        <div class="sub">${pass} of ${total} checks passing</div></div>
        <button type="button" class="t3alert-b" data-act="t3review">Review problems</button></div>`
    : `<div class="t3alert ok"><span class="t3dot"></span><div><b>All checks passing</b><div class="sub">${pass} of ${total} checks passing</div></div></div>`);
  // security (scheduled task): stat + optional row with the advisories
  const sec = d.security, adv = sec?.advisories || [], php = sec?.php;
  const secStat = !sec ? ["–", "Not checked yet", "sub"]
    : adv.length ? ["At risk", nn(adv.length, "advisory").replace("advisorys", "advisories"), "sev-2"]
    : php?.severity ? ["Clean", php.text, `sev-${php.severity}`]
    : sec.nginx?.severity ? ["Clean", sec.nginx.text, `sev-${sec.nginx.severity}`] : ["Clean", "No advisories", "sev0"];
  const stat = (k, v, sub, cls = "sub") => `<div class="t3stat"><div class="t3stat-k">${k}</div><div class="t3stat-v">${v}</div><div class="${cls}">${sub}</div></div>`;
  const [dbN, ...dbV] = dbShort(c.db).split(" "), [webN, webV] = String(c.webserver || "").split("/"), [osN, ...osV] = String(c.os || "").split(" ");
  const chip = (n, v, full) => n ? `<span class="t3chip" title="${esc(full || "")}">${esc(n)} <b>${esc(v || "")}</b></span>` : "";
  const row = (cls, dot, label, rmeta, body) => `<details class="t3row ${cls}"><summary><span class="t3dot ${dot}"></span><span class="t3row-l">${label}</span>
      <span class="t3row-m">${rmeta}</span>${ic("chev", "t3chev")}</summary><div class="t3row-b">${body}</div></details>`;
  const trow = x => `<tr><td>${sevBadge(x.severity)}</td><td>${esc(x.group)}</td><td><b>${esc(x.title)}</b>
      ${x.message ? `<div class="msg">${esc(x.message)}</div>` : ""}</td><td>${esc(x.value)}</td></tr>`;
  const checksTable = list => `<div class="wrap"><table class="checks"><thead><tr><th>Severity</th><th>Area</th><th>Check</th><th>Value</th></tr></thead>
      <tbody>${list.map(trow).join("")}</tbody></table></div>`;
  const updRows = d.updates || [];
  set(meta, `${alert}
    <div class="t3stats">
      ${stat("TYPO3", esc(c.typo3 || "?") + eltsTag(p), latest ? updTxt3 : "Latest unknown", latest ? (upd ? "sev-1" : t3u.eltsHint ? "sub" : "sev0") : "sub")}
      ${stat("Security", secStat[0], esc(secStat[1]), secStat[2])}
      ${stat("Extensions", exts.length, updExt.length ? esc(updTxt) : local.length ? `+ ${local.length} local, hidden` : "No updates", updExt.length ? "sev-1" : "sub")}
      ${stat("Unchanged since", d.since ? esc(hm(d.since)) : "–", d.since ? esc(dlong(d.since)) : "", "sub")}
    </div>
    <div class="t3chips">${chip("PHP", c.php, c.php)}${chip(dbN, dbV.join(" "), c.db)}${chip(webN, webV, c.webserver)}${chip(osN, osV.join(" "), c.os)}</div>
    <div class="t3rows">
      ${row("t3-problems", problems.length ? tone : "", "Problems", problems.length ? [errs && nn(errs, "error"), warns && nn(warns, "warning")].filter(Boolean).join(" · ") : "None",
        problems.length ? checksTable(problems) : `<p class="empty">No errors or warnings.</p>`)}
      ${sec && (adv.length || php?.severity) ? row("", adv.length ? "err" : `sev${php.severity}`, "Security", adv.length ? secStat[1] : esc(php.text), secBody(sec)) : ""}
      ${row("", "", "All status checks", total, checksTable(c.status.slice().sort((a, b) => b.severity - a.severity)))}
      ${row("t3-exts", updExt.length ? "warn" : "", "Extensions", `${exts.length}${updTxt ? ` <span class="hchip upd${majExt.length ? " major" : ""}">${ic("update")}<b>${esc(updTxt)}</b></span>` : ""}`, `
      ${local.length ? `<label class="check" style="margin-bottom:8px"><input type="checkbox" class="showLocal"> Show local extensions (${local.length}): ${esc(local.map(([k]) => k).join(", "))}</label>` : ""}
      <div class="wrap"><table>
      <thead><tr><th>Extension</th><th>Title</th><th>Version</th><th>Latest</th><th>Composer package</th></tr></thead><tbody>
      ${[...exts, ...local].map(([k, e]) => `<tr class="${e.local ? "local" : ""} ${e.update ? "upd" + (e.major ? " major" : "") : ""}" ${e.local ? "hidden" : ""}
        ${!e.local && e.composer ? `data-ext="${esc(k)}" data-composer="${esc(e.composer)}" data-version="${esc(e.update ? e.latest : e.version)}"
          data-installed="${esc(e.version)}" data-major="${e.update && e.major ? 1 : ""}" title="Click to show the changelog${e.update ? " of " + esc(e.latest) : ""}"` : ""}>
        <td>${!e.local && e.composer ? `<span class="tw">▸</span>` : ""}<code>${esc(k)}</code>${e.local ? ` <span class="chip">local</span>` : ""}</td>
        <td>${esc(e.title)}</td><td>${esc(e.version)}</td><td>${latestCell(e)}</td><td>${esc(e.composer)}</td></tr>`).join("")}
      </tbody></table></div>`)}
      ${row("upd-hist", "", "Update history", updRows.length ? nn(updRows.length, "update") : "None yet", updHistoryBody(updRows))}
      ${row("", "", "Change history", nn(d.history.length, "change"), `<ul class="tl">
      ${d.history.map(h => `<li><div class="when">${esc(fmt(h.t))}${h.last !== h.t ? ` – seen until ${esc(fmt(h.last))}` : ""} · TYPO3 ${esc(h.typo3 || "?")}</div>
        <ul>${h.changes.map(x => `<li>${esc(x)}</li>`).join("")}</ul></li>`).join("")}
    </ul>`)}
    </div>`, title);
  box.querySelectorAll("tr[data-ext]").forEach(tr => tr.onclick = () => toggleChangelog(tr));
  const uh = box.querySelector("details.upd-hist");
  if (uh) uh.ontoggle = () => uh.open && loadReleaseInfo(uh);
  const sl = box.querySelector(".showLocal");
  if (sl) sl.onchange = () => box.querySelectorAll("tr.local").forEach(r => r.hidden = !sl.checked);
}

function systemOverview({current, last_check, last_error}, env, p) {
  const check = last_error ? `<span class="sev-2" title="${esc(last_error)}">Last check failed</span>`
    : last_check ? `Checked ${esc(fmt(last_check))}` : "";
  if (!current) return check || "No checks yet";
  const versions = [["TYPO3", current.typo3], ["PHP", current.php],
    ["Database", dbShort(current.db)], ["Web server", current.webserver]];
  const errors = current.status.filter(item => item.severity === 2).length;
  const warnings = current.status.filter(item => item.severity === 1).length;
  // pending extension updates (non-local extensions with a newer compatible release): chip opens the Extensions row
  const upd = Object.values(current.extensions || {}).filter(x => !x.local && x.update), major = upd.filter(x => x.major).length;
  const updT = upd.length ? `${upd.length} extension update${upd.length === 1 ? "" : "s"}${major ? ` (${major} major)` : ""} – show details` : "";
  const updChip = upd.length ? `<button type="button" class="hchip upd${major ? " major" : ""}" data-act="t3mopen" data-env="${env}" data-row="t3-exts"
      title="${updT}" aria-label="${updT}">${ic("update")}<b>${upd.length}</b></button>` : "";
  return `<dl>${versions.map(([label, value]) => `<div><dt>${label}</dt><dd>${esc(value || "–")}${label === "TYPO3" && value ? eltsTag(p) : ""}</dd></div>`).join("")}</dl>
    <div class="system-health">${errors || warnings
      ? [["err", "sev-2", errors, "error"], ["warn", "sev-1", warnings, "warning"]].map(([i, cls, n, w]) => {
          const t = `${n} ${w}${n === 1 ? "" : "s"}${n ? " – show details" : ""}`;
          return `<button type="button" class="hchip ${n ? cls : "zero"}" data-act="t3mopen" data-env="${env}" title="${t}" aria-label="${t}">${ic(i)}<b>${n}</b></button>`;
        }).join("")
      : `<span class="hchip sev0" title="No errors or warnings">${ic("ok")}<b>OK</b></span>`}${updChip}
    </div>
    ${check ? `<div class="system-check sub">${check}</div>` : ""}`;
}

// Minimal Markdown -> HTML (everything escaped; only http(s) links, relative ones resolved against the file)
function mdRender(md, base) {
  const txt = s => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  const link = (t, u) => { let h; try { h = new URL(u, base || undefined).href; } catch { return txt(t); }
    return /^https?:/.test(h) ? `<a href="${esc(h)}" target="_blank" rel="noopener">${txt(t)}</a>` : txt(t); };
  const inline = raw => { let out = "", last = 0, m; const re = /\[([^\]]+)\]\(([^)\s]+)\)/g;
    while ((m = re.exec(raw))) { out += txt(raw.slice(last, m.index)) + link(m[1], m[2]); last = re.lastIndex; }
    return out + txt(raw.slice(last)); };
  let html = "", list = null, code = null;
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const ln of md.replace(/\r/g, "").split("\n")) {
    if (/^\s*```/.test(ln)) { if (code === null) { close(); code = []; } else { html += `<pre>${esc(code.join("\n"))}</pre>`; code = null; } continue; }
    if (code !== null) { code.push(ln); continue; }
    let m;
    if ((m = ln.match(/^#{1,6}\s+(.*)/))) { close(); html += `<div class="md-h">${inline(m[1].replace(/#+\s*$/, ""))}</div>`; }
    else if ((m = ln.match(/^\s*([-*+]|\d+[.)])\s+(.*)/))) { const t = /\d/.test(m[1]) ? "ol" : "ul";
      if (list !== t) { close(); html += `<${t}>`; list = t; } html += `<li>${inline(m[2])}</li>`; }
    else if (!ln.trim()) close();
    else { close(); html += `<p>${inline(ln)}</p>`; }
  }
  if (code !== null) html += `<pre>${esc(code.join("\n"))}</pre>`;
  close(); return html;
}

// Update history: TYPO3 / extension version changes between t3monitor snapshots (newest first)
const dmy = s => s ? s.slice(0, 10).split("-").reverse().join(".") : "";
const UPD_ICON = {updated: ["↻", "updated"], added: ["+", "added"], removed: ["✖", "removed"]};
function updHistoryBody(rows) {
  if (!rows.length) return `<p class="empty">No version changes recorded since the first check.</p>`;
  return `<div class="wrap"><table class="upd-table">
    <thead><tr><th>Last change</th><th>Old version</th><th></th><th>Inst. version</th><th>Extension key</th><th>Name</th><th>Available since</th><th>Description</th></tr></thead><tbody>
    ${rows.map(r => { const [ic, lbl] = UPD_ICON[r.action]; const ver = r.new || r.old;
      return `<tr class="${r.core ? "core" : ""} ${r.action}" ${r.composer && ver ? `data-composer="${esc(r.composer)}" data-version="${esc(ver)}" data-core="${r.core ? 1 : ""}"` : ""}>
      <td>${esc(dmy(r.t))}</td><td>${esc(r.old || "–")}</td><td class="act" title="${lbl}">${ic}</td><td>${esc(r.new || "–")}</td>
      <td><code>${esc(r.key)}</code></td><td>${esc(r.title)}</td><td class="rel-time"></td><td class="rel-sum"></td></tr>`; }).join("")}
    </tbody></table></div><p class="sub" style="margin:6px 0 0">Recorded from TYPO3 health checks. Available since = release date of the installed version (removed: of the old version) on Packagist; description = first changelog line (GitHub/GitLab).</p>`;
}
async function loadReleaseInfo(det) {
  if (det.dataset.loaded) return;
  det.dataset.loaded = "1";
  const cache = {};
  for (const tr of det.querySelectorAll("tr[data-composer]")) {      // one at a time: Packagist/GitHub rate limits
    const x = tr.dataset, k = x.composer + "@" + x.version;
    tr.querySelector(".rel-time").textContent = "…";
    try {
      cache[k] = cache[k] || await api(`/api/ext/release?composer=${encodeURIComponent(x.composer)}&version=${encodeURIComponent(x.version)}&summary=${x.core ? 0 : 1}`);
      tr.querySelector(".rel-time").textContent = dmy(cache[k].time) || "–";
      const s = tr.querySelector(".rel-sum"); s.textContent = cache[k].summary; s.title = cache[k].summary;
    } catch { tr.querySelector(".rel-time").textContent = "–"; }
  }
}

// Extension row click: show/hide the changelog of the latest version (update) or of the installed version
async function toggleChangelog(tr) {
  const open = tr.nextElementSibling?.classList.contains("cl-row");
  tr.querySelector(".tw").textContent = open ? "▸" : "▾";
  if (open) return tr.nextElementSibling.remove();
  const x = tr.dataset, row = document.createElement("tr");
  row.className = "cl-row";
  const upd = x.version !== x.installed;
  row.innerHTML = `<td colspan="5"><div class="cl-box ${x.major ? "major" : ""}"><p class="empty">Loading changelog…</p></div></td>`;
  tr.after(row);
  const box = row.querySelector(".cl-box");
  try {
    const d = await api(`/api/ext/changelog?composer=${encodeURIComponent(x.composer)}&version=${encodeURIComponent(x.version)}&installed=${encodeURIComponent(x.installed)}`);
    const links = [d.url && `<a href="${esc(d.url)}" target="_blank" rel="noopener">Open source ↗</a>`,
      d.compare && `<a href="${esc(d.compare)}" target="_blank" rel="noopener">Full list of changes ${esc(x.installed)} → ${esc(d.version)} ↗</a>`,
      d.repo && `<a href="${esc(d.repo)}" target="_blank" rel="noopener">Repository ↗</a>`].filter(Boolean).join(" · ");
    box.innerHTML = `<div class="cl-head"><b>Changelog ${esc(x.ext)} ${esc(d.version)}</b>
        ${upd ? `<span class="${x.major ? "chip major" : "upd-v"}">${x.major ? "major update" : "update"} from ${esc(x.installed)}</span>` : `<span class="sub">installed version</span>`}
        ${d.found_in ? `<span class="sub">from ${esc(d.found_in)}</span>` : ""}<span class="sub">${links}</span></div>
      ${d.text ? `<div class="cl-body">${mdRender(d.text, d.base)}</div>`
        : `<p class="empty">No changelog found for ${esc(d.version)} (no release notes, no CHANGELOG.md entry). Use the links above.</p>`}`;
  } catch (e) { box.innerHTML = `<p class="empty">Changelog not available: ${esc(e.message)}</p>`; }
}

// Pipeline progress: one step per stage (in run order), with spinner while running
const STEP_ICON = {success: "✓", failed: "✕", canceled: "✕", manual: "▶", skipped: "–", pending: ""};
function stageState(list) {
  const has = s => list.some(j => j.status === s);
  if (has("failed")) return "failed";
  if (list.some(j => ["running", "preparing"].includes(j.status))) return "running";
  if (has("canceled")) return "canceled";
  if (list.every(j => ["success", "skipped"].includes(j.status))) return list.every(j => j.status === "skipped") ? "skipped" : "success";
  if (has("manual")) return "manual";
  if (has("success")) return "running";   // partly done, rest waiting
  return "pending";
}
function pipeStepper(jobs) {
  if (!jobs.length) return "";
  const stages = [];
  jobs.forEach(j => { let st = stages.find(x => x.name === j.stage); if (!st) stages.push(st = {name: j.stage, jobs: []}); st.jobs.push(j); });
  return `<ol class="psteps">${stages.map(st => {
      const s = stageState(st.jobs), ok = st.jobs.filter(j => j.status === "success").length;
      const m = s === "manual" && st.jobs.find(j => j.status === "manual");   // manual stage: icon plays its (first) manual job
      return `<li class="pstep p-${s}" title="${esc(st.jobs.map(j => `${j.name}: ${j.status}`).join("\n"))}">
        ${m ? `<button class="pico pplay" data-act="play" data-job="${Number(m.id)}" data-name="${esc(m.name)}" title="Play ${esc(m.name)}" aria-label="Play ${esc(m.name)}">${ic("play")}</button>`
          : `<span class="pico" aria-hidden="true">${s === "running" ? `<span class="spin"></span>` : STEP_ICON[s] ?? ""}</span>`}
        <span class="pname">${esc(st.name)}</span><span class="sub">${ok}/${st.jobs.length}</span></li>`;
    }).join("")}</ol>`;
}

async function loadPipeline(p, pid, slot) {
  clearTimeout(pollT[slot]);
  const box = $(`#pipe-${slot}`);
  try {
    const d = await api(`/api/pipeline?project=${encodeURIComponent(p.id)}&id=${pid}`);
    if (!$(`#pipe-${slot}`) || $("#view").dataset.project !== p.id) return;
    $(`#pipeTitle-${slot}`).innerHTML = `Pipeline #${esc(pid)} · <span class="st s-${esc(d.pipeline.status)}">${esc(d.pipeline.status)}</span>
      · <a href="${esc(d.pipeline.web_url)}" target="_blank" rel="noopener" title="Open pipeline in GitLab" aria-label="Open pipeline in GitLab">${ic("ext", "sm")}</a>`;
    const jobs = d.jobs.slice().reverse();
    const det = $(`#pipeJobs-${slot}`);
    const detOpen = det ? det.open : jobs.some(j => j.status === "failed");
    $(`#pipe-${slot}`).innerHTML = `${pipeStepper(jobs)}
      <details class="pipe-jobs" id="pipeJobs-${slot}"${detOpen ? " open" : ""}><summary>Job details (${jobs.length})</summary><div class="wrap"><table><thead><tr><th>Stage</th><th>Job</th><th>Status</th><th></th></tr></thead><tbody>
      ${jobs.map(j => `<tr><td>${esc(j.stage)}</td><td>${esc(j.name)}</td>
        <td><span class="st s-${esc(j.status)}">${esc(j.status)}</span></td>
        <td>${j.status === "manual" ? `<button class="btn sm" data-act="play" data-job="${Number(j.id)}" data-name="${esc(j.name)}" title="Play ${esc(j.name)}" aria-label="Play ${esc(j.name)}">${ic("play")}</button>` : ""}</td></tr>`).join("")
        || `<tr><td colspan="4" class="empty">No jobs.</td></tr>`}
      </tbody></table></div></details>`;
    if (ACTIVE.includes(d.pipeline.status)) pollT[slot] = setTimeout(() => loadPipeline(p, pid, slot), 5000);
  } catch (e) { if (box && $(`#pipe-${slot}`)) $(`#pipe-${slot}`).innerHTML = `<p class="empty">Error: ${esc(e.message)}</p>`; }
}

// Branch select options: staging/production + GitLab branches + current value
function branchOpts(list, cur, allowNone, noneLabel = "– none (no promote) –") {
  const names = [...new Set(["staging", "production", ...list, ...(cur ? [cur] : [])])];
  return (allowNone ? `<option value="" ${cur ? "" : "selected"}>${esc(noneLabel)}</option>` : "")
    + names.map(b => `<option value="${esc(b)}" ${b === cur ? "selected" : ""}>${esc(b)}</option>`).join("");
}

// Defaults for a new project (work without GitLab; GitLab lookup may refine them)
const DEFAULTS = {gitlab_url:"https://gitlab.gingco.de", ref:"staging", variables:{}, auto_play:["build:main"],
  auto_typo3:{enabled:true, major:13, variables:{TARGET_TASK_NAME:"shup01"}, auto_play:[]},
  production:{ref:"production", variables:{}, auto_play:["build:main"]}};

// t3monitor instances per project (cfg = config key, f = form field prefix, keys/auth = lists in /api/state)
const T3M_ENVS = [
  {env:"production", label:"Production", short:"PRD", cfg:"t3monitor", f:"t3m_", keys:"t3monitor_keys", auth:"t3monitor_auth",
   ph:"https://www.example.com/", hint:"Live TYPO3 site with the t3monitor extension installed."},
  {env:"staging", label:"Staging", short:"STG", cfg:"t3monitor_staging", f:"t3ms_", keys:"t3monitor_staging_keys", auth:"t3monitor_staging_auth",
   ph:"https://staging.example.com/", hint:"Staging instance with the t3monitor extension installed (own key)."}];
// Environment name: full label, plus a short code (PRD / STG) that a style can show instead (Terminal does)
const envLbl = e => `<span class="env-l">${esc(e.label)}</span><span class="env-s">${esc(e.short)}</span>`;
const t3mOn = (p, e) => !!(p[e.cfg]?.url && S[e.keys]?.includes(p.id));

function t3mFields(e, p) {
  const c = (p || {})[e.cfg] || {}, hasKey = p && S[e.keys]?.includes(p.id), hasAuth = p && S[e.auth]?.includes(p.id);
  return `<section class="card monitor-form"><div class="monitor-form-heading"><h3 class="sec-title">${esc(e.label)}</h3><span class="focus-monitor ${hasKey ? "is-configured" : "is-pending"}">${hasKey ? "Key saved" : "Key missing"}</span></div><div class="monitor-fields">
        <div><label for="${e.f}url">Site URL</label><input id="${e.f}url" name="${e.f}url" value="${esc(c.url)}" placeholder="${esc(e.ph)}">
          <div class="hint">${esc(e.hint)}</div></div>
        ${hasKey ? `<div class="monitor-saved-key">
          <div class="actions">
            <button type="button" class="btn sec sm" data-reveal="${e.f}key" data-saved-env="${esc(e.env)}" aria-controls="${e.f}saved-key" aria-expanded="false">Reveal saved key</button>
            <button type="button" class="btn sec sm" data-copy="${e.f}key" data-saved-copy hidden>Copy saved key</button>
          </div>
          <input id="${e.f}saved-key" type="text" aria-label="Saved ${esc(e.label)} key" readonly hidden spellcheck="false" autocomplete="off">
        </div>` : ""}
        <details class="monitor-key-field"${hasKey ? "" : " open"}>
          <summary>${hasKey ? "Replace key" : "Set up key"}</summary>
          <label for="${e.f}key">t3monitor key (64 characters)</label><input id="${e.f}key" name="${e.f}key" type="password" autocomplete="new-password" spellcheck="false" minlength="64" maxlength="64" pattern="[^\\s]{64}"
          title="Enter 64 characters without spaces" placeholder="64 characters">
          <div class="hint">Extension configuration → t3monitor → encryption_key.</div>
          <div class="actions monitor-key-actions">
            <button type="button" class="btn sec sm" data-gen="${e.f}key">Generate key</button>
            <button type="button" class="btn sec sm" data-reveal="${e.f}key" aria-controls="${e.f}key">Reveal</button>
            <button type="button" class="btn sec sm" data-copy="${e.f}key">Copy</button>
          </div>
          <p class="hint" data-key-draft="${e.f}key" hidden>Unsaved key. Set the same key on the ${esc(e.label.toLowerCase())} site before saving.</p>
          ${hasKey ? `<label class="check" style="margin-top:6px"><input type="checkbox" name="${e.f}key_clear"> Remove stored key</label>` : ""}</details>
        <details class="monitor-auth"${hasAuth || c.auth_user ? " open" : ""}><summary>Site authentication</summary>
        <div><label>Basic auth user (optional)</label><input name="${e.f}auth_user" value="${esc(c.auth_user)}" autocomplete="off" placeholder="only if the site is password-protected">
          <div class="hint" data-secondary-copy>Empty = no basic auth.</div></div>
        <div><label>Basic auth password</label><input name="${e.f}auth_password" type="password" autocomplete="new-password"
          placeholder="${hasAuth ? "stored – leave empty to keep" : "not stored"}">
          ${hasAuth ? `<label class="check" style="margin-top:6px"><input type="checkbox" name="${e.f}auth_clear"> Remove stored password</label>` : ""}</div>
        </details>
      </div></section>`;
}

// Key tools of the t3monitor fields (t3mFields): generate / reveal / copy, reveal saved key. Used by the project form
// and the per-environment settings modal.
function keyTools(fm, p) {
  const E = fm.elements;
  // Generate a 64-char t3monitor key locally (32 random bytes → hex).
  // Non-destructive: nothing is stored until "Save changes"; the SAME value must be set as the site's encryption_key.
  fm.addEventListener("click", async ev => {
    const b = ev.target.closest("[data-gen], [data-reveal]"); if (!b) return;
    const name = b.dataset.gen || b.dataset.reveal, inp = E[name];
    if (b.dataset.savedEnv) {
      const saved = fm.querySelector(`#${name.replace(/key$/, "saved-key")}`);
      const copy = fm.querySelector(`[data-saved-copy][data-copy="${name}"]`);
      if (!saved.hidden) {
        saved.hidden = copy.hidden = true;
        saved.value = "";
        b.textContent = "Reveal saved key";
        b.setAttribute("aria-expanded", "false");
        return;
      }
      b.disabled = true;
      try {
        const {key} = await api("/api/t3monitor/reveal-key", {project:p.id, env:b.dataset.savedEnv});
        if (!fm.isConnected) return;
        saved.value = key;
        saved.hidden = copy.hidden = false;
        b.textContent = "Hide saved key";
        b.setAttribute("aria-expanded", "true");
      } catch (e) { toast(e.message, true); }
      finally { b.disabled = false; }
      return;
    }
    if (b.dataset.reveal) {
      if (!inp.value) { toast("Generate or enter a key first", true); return; }
      inp.type = inp.type === "password" ? "text" : "password";
      b.textContent = inp.type === "text" ? "Hide" : "Reveal";
      return;
    }
    inp.value = [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, "0")).join("");
    inp.type = "password";
    fm.querySelector(`[data-reveal="${name}"]:not([data-saved-env])`).textContent = "Reveal";
    inp.dispatchEvent(new Event("input", {bubbles:true}));
  });
  // Copy the current key field value to the clipboard (clipboard API, with a legacy fallback for insecure contexts).
  fm.addEventListener("click", async ev => {
    const b = ev.target.closest("[data-copy]"); if (!b) return;
    ev.preventDefault();
    const saved = fm.querySelector(`#${b.dataset.copy.replace(/key$/, "saved-key")}`);
    const inp = b.hasAttribute("data-saved-copy") ? saved : E[b.dataset.copy], val = inp.value.trim();
    if (!val) { toast("Nothing to copy — generate or enter a key first", true); return; }
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(val);
      else {
        inp.focus(); inp.select();
        if (!document.execCommand("copy")) throw new Error("Clipboard unavailable");
      }
      toast("Key copied to clipboard");
    } catch (e) { toast("Copy failed. Reveal the key to copy it manually.", true); }
  });
}

function viewForm(p) {
  const v = p || DEFAULTS, a = v.auto_typo3 || DEFAULTS.auto_typo3;
  $("#view").innerHTML = `
    <div class="crumb"><a href="#/">Projects</a> / ${p ? `<a href="${pUrl(p)}">${esc(p.name)}</a> / Edit` : "New project"}</div>
    <div class="head"><h1>${p ? "Edit " + esc(p.name) : "New project"}</h1></div>
    <form id="pform" class="stack">
      <div class="card"><div class="sec-title">Basics</div>
        <div class="fields">
        <div><label>Name<span data-noci> *</span></label><input name="name" value="${esc(p?.name)}" placeholder="WVG Online"></div>
        <div><label for="pf-owner">Responsible person</label><select id="pf-owner" name="owner"><option value="">– none –</option>
          ${(S.users || []).map(u => `<option value="${esc(u.name)}" ${p?.owner === u.name ? "selected" : ""}>${esc(u.full_name ? `${u.full_name} (${u.name})` : u.name)}</option>`).join("")}</select>
          <div class="hint">Shown with their GitLab picture on the project card. Automatic TYPO3 updates run with their GitLab token.</div></div>
        <div><label>GitLab URL</label><input name="gitlab_url" value="${esc(v.gitlab_url || DEFAULTS.gitlab_url)}"></div>
        <div><label>Project path<span data-ci> *</span></label><input name="path" value="${esc(p?.path)}" placeholder="type to search GitLab…" list="projlist" autocomplete="off" required>
          <div class="hint" id="pinfo"></div></div>
        <datalist id="projlist"></datalist>
        <div><label>Branch<span data-ci> *</span></label><select name="ref" required>${branchOpts([], v.ref, true, "– none –")}</select></div>
      </div></div>
      <section class="project-monitoring" aria-labelledby="project-monitoring-title">
        <h2 id="project-monitoring-title">TYPO3 monitoring</h2>
        <div class="project-monitoring-grid">${T3M_ENVS.map(e => t3mFields(e, p)).join("")}</div>
      </section>
      <div class="card"><h2 class="sec-title">TYPO3 ELTS</h2>
        <label class="check" style="margin-bottom:12px"><input type="checkbox" name="elts" ${v.elts ? "checked" : ""}> Runs TYPO3 ELTS (extended long term support)</label>
        <div class="hint" style="margin:-6px 0 0">Off = ELTS releases are not shown as TYPO3 updates on the card, only as a note in the TYPO3 status.</div>
      </div>
      <div class="card"><h2 class="sec-title">GitLab pipelines</h2>
        <label class="check" style="margin-bottom:12px"><input type="checkbox" name="ci" ${v.ci !== false ? "checked" : ""}> Uses GitLab CI/CD (pipelines)</label>
        <div class="hint" data-noci style="margin:-6px 0 12px">Off = TYPO3 monitoring only: no pipelines, no TYPO3 auto-update. Path and branch are optional
          (with a branch, extension update messages contain ready-to-run git/composer commands).</div>
      </div>
      <div class="card" data-ci><div class="sec-title">Run pipeline</div><div class="fields">
        <div><label>Variables</label><input name="variables" value="${esc(varsStr(v.variables))}" placeholder="KEY=VALUE, KEY2=VALUE2"></div>
        <div><label>Auto-play manual jobs</label><input name="auto_play" value="${esc((v.auto_play || []).join(", "))}" placeholder="build:main">
          <div class="hint" data-secondary-copy>These manual jobs are started automatically when ready.</div></div>
      </div></div>
      <div class="card" data-ci><div class="sec-title">TYPO3 auto-update</div>
        <label class="check"><input type="checkbox" name="auto_enabled" ${a.enabled ? "checked" : ""}> Start update pipeline when a new TYPO3 release appears</label>
        <div class="fields" style="margin-top:12px">
          <div><label>TYPO3 major</label><select name="major">${[...new Set([12, 13, 14, Number(a.major)])].filter(Boolean).sort((x, y) => x - y)
            .map(m => `<option value="${m}" ${m === Number(a.major) ? "selected" : ""}>${m}</option>`).join("")}</select></div>
          <div><label>Update variables</label><input name="auto_variables" value="${esc(varsStr(a.variables))}"></div>
          <div><label>Auto-play jobs (update)</label><input name="auto_typo3_play" value="${esc((a.auto_play || []).join(", "))}"></div>
        </div></div>
      <div class="card" data-ci><div class="sec-title">Production (promote)</div><div class="fields">
        <div><label>Production branch</label><select name="prod_ref">${branchOpts([], v.production?.ref || "", true)}</select>
          <div class="hint">Empty = no promote. Button appears after a successful pipeline on the branch above.</div></div>
        <div><label>Variables</label><input name="prod_variables" value="${esc(varsStr(v.production?.variables))}" placeholder="KEY=VALUE"></div>
        <div><label>Auto-play manual jobs</label><input name="prod_play" value="${esc((v.production ? v.production.auto_play || [] : v.auto_play || []).join(", "))}">
          <div class="hint" data-secondary-copy>Pre-filled from the jobs above; edit to differ.</div></div>
      </div></div>
      <div class="actions project-form-actions"><span class="sub" role="status" data-form-dirty hidden>Unsaved changes</span><button class="btn" type="submit">${p ? "Save changes" : "Create project"}</button>
        <a class="btn sec" href="${p ? pUrl(p) : "#/"}">Cancel</a></div>
    </form>`;
  const fm = $("#pform"), E = fm.elements, sp = E.auto_play, pp = E.prod_play;
  const syncCI = () => {                         // show/hide CI-only parts; path, branch required only with CI
    const on = E.ci.checked;
    fm.querySelectorAll("[data-ci]").forEach(el => el.hidden = !on);
    fm.querySelectorAll("[data-noci]").forEach(el => el.hidden = on);
    E.path.required = E.ref.required = on; E.name.required = !on;
  };
  E.ci.addEventListener("change", syncCI); syncCI();
  fm.addEventListener("invalid", ({target}) => {
    const details = target.closest("details");
    if (details) details.open = true;
  }, true);
  keyTools(fm, p);
  // Pre-fill from GitLab: only fields the user has not typed in; when editing, only empty ones.
  const touched = new Set();
  fm.addEventListener("input", ({target}) => {
    touched.add(target.name);
    fm.querySelector("[data-form-dirty]").hidden = false;
    const draft = fm.querySelector(`[data-key-draft="${target.name}"]`);
    if (draft) draft.hidden = !target.value;
  });
  const fill = (name, val) => {
    const el = E[name];
    if (val == null || val === "" || touched.has(name) || (p && el.value.trim())) return;
    if (el.tagName === "SELECT" && ![...el.options].some(o => o.value === String(val))) el.add(new Option(val, val));
    el.value = Array.isArray(val) ? val.join(", ") : val;
  };
  let searchT;
  E.path.addEventListener("input", () => {        // project search suggestions
    clearTimeout(searchT);
    const q = E.path.value.trim();
    if (q.length < 2) return;
    searchT = setTimeout(async () => {
      try {
        const r = await api(`/api/search?gitlab_url=${encodeURIComponent(E.gitlab_url.value.trim())}&q=${encodeURIComponent(q)}`);
        $("#projlist").innerHTML = r.map(x => `<option value="${esc(x.path)}">${esc(x.name)}</option>`).join("");
      } catch (e) { /* suggestions are optional */ }
    }, 300);
  });
  async function loadInfo() {
    const url = E.gitlab_url.value.trim(), path = E.path.value.trim();
    if (!url || !path.includes("/")) return;
    $("#pinfo").textContent = "Reading project from GitLab…";
    try {
      const d = await api(`/api/project-info?gitlab_url=${encodeURIComponent(url)}&path=${encodeURIComponent(path)}&ref=${encodeURIComponent(E.ref.value.trim())}`);
      E.ref.innerHTML = branchOpts(d.branches, E.ref.value, true, "– none –");
      E.prod_ref.innerHTML = branchOpts(d.branches, E.prod_ref.value, true);
      fill("name", d.name); fill("ref", d.ref); fill("auto_play", d.auto_play);
      fill("prod_ref", d.prod_ref); fill("prod_play", d.prod_play); fill("major", d.major);
      synced = pp.value === sp.value;
      $("#pinfo").textContent = `Pre-filled from GitLab (default branch: ${d.default}${d.major ? `, TYPO3 ${d.major}` : ""})`;
    } catch (e) { $("#pinfo").textContent = `GitLab lookup failed: ${e.message}`; }
  }
  E.path.addEventListener("change", loadInfo);
  E.ref.addEventListener("change", loadInfo);
  E.gitlab_url.addEventListener("change", loadInfo);
  let synced = pp.value === sp.value;            // mirror staging jobs until prod field is edited by hand
  sp.addEventListener("input", () => { if (synced) pp.value = sp.value; });
  pp.addEventListener("input", () => { synced = pp.value === sp.value; });
  loadInfo();
  $("#pform").onsubmit = async ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const body = {ci:f.get("ci") === "on", elts:f.get("elts") === "on", name:f.get("name"), owner:f.get("owner"), gitlab_url:f.get("gitlab_url"), path:f.get("path"), ref:f.get("ref"),
      variables:parseVars(f.get("variables")), auto_play:f.get("auto_play"),
      auto_enabled:f.get("auto_enabled") === "on", major:f.get("major"),
      auto_variables:parseVars(f.get("auto_variables")), auto_typo3_play:f.get("auto_typo3_play"),
      prod_ref:f.get("prod_ref"), prod_variables:parseVars(f.get("prod_variables")), prod_play:f.get("prod_play"),
      ...Object.fromEntries(T3M_ENVS.flatMap(e => [["url", f.get(e.f + "url")], ["key", f.get(e.f + "key")],
        ["key_clear", f.get(e.f + "key_clear") === "on"], ["auth_user", f.get(e.f + "auth_user")],
        ["auth_password", f.get(e.f + "auth_password")], ["auth_clear", f.get(e.f + "auth_clear") === "on"]]
        .map(([k, val]) => [e.f + k, val])))};
    try {
      const saved = p ? await api("/api/projects/update", {...body, id:p.id}) : await api("/api/projects", body);
      await refresh(); toast(p ? "Project saved" : "Project created"); location.hash = pUrl(saved);
    } catch (e) { toast(e.message, true); }
  };
}

function viewActivity() {
  const sec = S.typo3_security || {};
  $("#view").innerHTML = `
    <div class="head"><h1>Activity</h1></div>
    <div class="stack">
      <div class="card"><h2>TYPO3 security announcements</h2>
        <p class="sub" style="margin:0 0 12px">Source: news.typo3.com · last check: ${esc(fmt(sec.checked))} · <a href="#/scheduler">Scheduler</a></p>
        <div class="wrap"><table><tbody>
        ${(sec.items || []).slice(0, 15).map(i => `<tr><td class="sub" style="white-space:nowrap">${esc(i.date || "–")}</td>
          <td>${i.psa ? `<span class="badge sev-2">PSA</span> ` : ""}<a
            href="${/^https:\/\//.test(i.link) ? esc(i.link) : "#"}" target="_blank" rel="noopener noreferrer">${esc(i.title)}</a></td></tr>`).join("")
          || `<tr><td class="empty">Not checked yet.</td></tr>`}
        </tbody></table></div></div>
      <div class="card"><h2>Pipeline runs</h2><div class="wrap"><table>
        <thead><tr><th>Time</th><th>Project</th><th>Pipeline</th><th>Trigger</th></tr></thead><tbody>
        ${S.runs.map(r => { const p = proj(r.project); return `<tr><td>${esc(fmt(r.t))}</td>
          <td>${p ? `<a href="${pUrl(p)}">${esc(p.name)}</a>` : esc(r.project)}</td>
          <td>${p ? `<a href="${pUrl(p)}/pl/${Number(r.pipeline)}">#${esc(r.pipeline)}</a>` : "#" + esc(r.pipeline)}</td>
          <td>${esc(r.trigger)}</td></tr>`; }).join("") || `<tr><td colspan="4" class="empty">No runs yet.</td></tr>`}
        </tbody></table></div></div>
      <div class="card"><h2>Log</h2><div class="wrap"><table><tbody>
        ${S.log.map(l => `<tr><td class="sub" style="white-space:nowrap">${esc(fmt(l.t))}</td><td>${esc(l.msg)}</td></tr>`).join("")
          || `<tr><td class="empty">Empty.</td></tr>`}
      </tbody></table></div></div>
    </div>`;
}

function viewSettings() {
  const m = S.email;
  const rel = S.scheduler.find(t => t.id === "typo3_release");
  const latest = Object.entries(S.typo3_latest || {}).sort((x, y) => Number(y[0]) - Number(x[0]));
  $("#view").innerHTML = `
    <div class="profile stack">
      <h1 class="pf-title">Settings</h1>
      ${pfSec("ext", "Address", "Where T3 Watchdock is reached. Used for the links in Teams and email messages.", `
        <form id="urlform" class="pf-form">
          <div class="full"><label for="pu-url">Public URL</label>
            <input id="pu-url" name="url" type="url" value="${esc(S.public_url || "")}" placeholder="https://local-gitlabrunner.local">
            <p class="pf-note">Empty: links point to http://127.0.0.1:8787 and only work on the computer running T3 Watchdock.</p></div>
          <div class="actions"><span class="pf-spacer"></span><button class="btn" type="submit">Save</button></div>
        </form>`)}
      ${pfSec("chat", "Microsoft Teams", "Notifications via incoming webhook", `
        <form id="msform" class="pf-form">
          <label class="pf-toggle full"><span>Send Teams messages</span><input type="checkbox" class="switch" role="switch" name="enabled" ${S.teams.enabled ? "checked" : ""}></label>
          <div class="full"><label for="ms-url">Webhook URL</label>
            <div class="${S.teams_url_set ? "pf-field-dot" : ""}">${S.teams_url_set ? `<span class="pf-dot" aria-hidden="true"></span>` : ""}<input id="ms-url" name="url" type="password" autocomplete="off"
              placeholder="${S.teams_url_set ? "Stored. Paste a new URL to replace it." : "https://…"}"></div>
            ${!S.teams_url_set ? `<p class="pf-note">Create it in Teams: channel → ⋯ → Workflows → “Post to a channel when a webhook request is received”.</p>` : ""}</div>
          <div class="actions">${S.teams_url_set ? `<button class="pf-link danger" type="button" data-act="teamsdel">Remove URL</button>` : ""}
            <span class="pf-spacer"></span>
            <button class="btn sec" type="button" data-act="teamstest" title="Saves, then sends a test message">Send test message</button>
            <button class="btn" type="submit">Save</button></div>
        </form>`)}
      ${pfSec("mail", "Email", "Notifications via your SMTP server", `
        <form id="eform" class="pf-form">
          <label class="pf-toggle full"><span>Send email notifications</span><input type="checkbox" class="switch" role="switch" name="enabled" ${m.enabled ? "checked" : ""}></label>
          <div class="pf-subhead full">Server</div>
          <div class="pf-row r3 full">
            <div><label for="em-host">SMTP host</label><input id="em-host" name="host" value="${esc(m.host)}" placeholder="smtp.example.com"></div>
            <div><label for="em-port">Port</label><input id="em-port" name="port" type="number" min="1" max="65535" value="${esc(m.port)}"></div>
            <div><label for="em-sec">Security</label><select id="em-sec" name="security">${[["starttls", "STARTTLS"], ["ssl", "SSL/TLS"], ["none", "None"]]
              .map(([k, l]) => `<option value="${k}" ${m.security === k ? "selected" : ""}>${l}</option>`).join("")}</select></div>
          </div>
          <div class="pf-row r2 full">
            <div><label for="em-user">Username</label><input id="em-user" name="user" value="${esc(m.user)}" autocomplete="off"></div>
            <div><label for="em-pw">Password</label><input id="em-pw" name="password" type="password" autocomplete="new-password"
              placeholder="${S.email_password_set ? "Stored. Leave empty to keep it." : "Not stored"}"></div>
          </div>
          <p class="pf-note full">Leave username empty if the server needs no login.</p>
          <div class="pf-subhead full">Messages</div>
          <div class="full"><label for="em-from">Sender</label><input id="em-from" name="from" value="${esc(m.from)}" placeholder="launcher@example.com"></div>
          <div class="full"><label for="em-to">Recipients</label><input id="em-to" name="to" value="${esc(m.to.join(", "))}" placeholder="a@example.com, b@example.com">
            <p class="pf-note">Separate addresses with commas.</p></div>
          <div class="actions">${S.email_password_set ? `<button class="pf-link danger" type="button" data-act="mailpwdel">Remove password</button>` : ""}
            <span class="pf-spacer"></span>
            <button class="btn sec" type="button" data-act="mailtest" title="Saves, then sends a test email">Send test email</button>
            <button class="btn" type="submit">Save</button></div>
        </form>`)}
      ${pfSec("archive", "Projects", "Export and import all projects", `
        <div class="pf-form">
          <div class="pf-split full">
            <div><div class="pf-label">Export</div><p class="pf-desc">Download every project as one file. It contains t3monitor keys and Basic auth passwords in plain text; the GitLab token, Teams webhook and SMTP password are never exported.</p></div>
            <button class="btn sec" type="button" data-act="projexport">${ic("download", "sm")} Export projects</button>
          </div>
          <hr class="pf-hr full">
          <div class="full"><div class="pf-label">Import</div>
            <label class="pf-drop" id="impDrop">${ic("upload")}<input id="impFile" type="file" accept=".json,application/json">
              <b id="impTitle">Choose an export file</b><span id="impName">or drop it here</span></label></div>
          <label class="pf-check full"><input type="checkbox" id="impOverwrite"> <span><b>Overwrite existing projects</b> (otherwise they are skipped)</span></label>
          <div class="actions"><button class="btn" type="button" data-act="projimport">Import projects</button></div>
        </div>`)}
      ${pfSec("tag", "TYPO3 release check", "Latest versions to compare against", `
        <div class="pf-form">
          <div class="pf-tiles full">${latest.map(([maj, v]) => `<div class="pf-tile"><span>TYPO3 ${esc(maj)}</span><b>${esc(v)}</b></div>`).join("") || `<p class="pf-desc">No versions known yet.</p>`}</div>
          <div class="pf-split full">
            <p class="pf-desc">Checked ${esc(fmt(S.last_check))}${rel ? ` · ${esc(rel.schedule)}` : ""} · <a href="#/scheduler">Change in Scheduler</a></p>
            <button class="btn sec" type="button" data-act="check">${ic("refresh", "sm")} Check now</button>
          </div>
        </div>`)}
    </div>`;
  const drop = $("#impDrop"), file = $("#impFile");
  file.onchange = () => {
    const f = file.files[0];
    $("#impTitle").textContent = f ? f.name : "Choose an export file";
    $("#impName").textContent = f ? "Click to choose another file" : "or drop it here";
    drop.classList.toggle("has-file", !!f);
  };
  drop.ondragover = ev => { ev.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = ev => {
    ev.preventDefault(); drop.classList.remove("over");
    if (ev.dataTransfer?.files?.length) { file.files = ev.dataTransfer.files; file.onchange(); }
  };
  $("#msform").onsubmit = async ev => {
    ev.preventDefault();
    try { await saveTeams(); toast("Teams settings saved"); closeAfter(ev); } catch (e) { toast(e.message, true); }
  };
  $("#urlform").onsubmit = async ev => {
    ev.preventDefault();
    try { await api("/api/public-url", {url: ev.target.url.value}); await refresh(); viewSettings(); toast("Address saved"); }
    catch (e) { toast(e.message, true); }
  };
  $("#eform").onsubmit = async ev => {
    ev.preventDefault();
    try { await saveEmail(); toast("Email settings saved"); closeAfter(ev); } catch (e) { toast(e.message, true); }
  };
  pluginHook("settingsPage", $("#view > .stack"));
}
// Plugins page: plugins installed in plugins/<name>/, switch on/off, settings as JSON. Adding plugin code stays a
// file + rebuild step on purpose: a plugin is Python that runs in the app (no upload without a login).
// Profile: change the own password (current password required; other sessions are signed out)
// GitLab picture of a Watchdock user (read with that user's own token); initials stay when there is none.
// Only an https URL on the GitLab host itself is loaded (same rule as the project avatars). Cached per page load.
const userAvatars = new Map();
function userAvatarUrl(name, own) {
  const key = own ? "\u0000me" : name;
  if (!userAvatars.has(key)) userAvatars.set(key,
    api(own ? "/api/profile/avatar" : `/api/users/avatar?name=${encodeURIComponent(name)}`).then(d => {
      if (!d.url) return null;
      const base = new URL(d.gitlab), avatar = new URL(d.url, base);
      return avatar.protocol === "https:" && avatar.origin === base.origin && !avatar.username && !avatar.password ? avatar.href : null;
    }).catch(() => null));
  return userAvatars.get(key);
}
function paintAvatar(box, url) {
  if (!url || !box?.isConnected || box.querySelector("img")) return;
  const image = new Image();
  image.alt = "";
  image.referrerPolicy = "no-referrer";
  image.onload = () => { if (box.isConnected && !box.querySelector("img")) box.replaceChildren(image); };
  image.src = url;
}
const initialsOf = s => (s || "").split(/[\s._@-]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "?";
async function loadProfileAvatar() {
  const box = $(".pf-avatar");
  paintAvatar(box, await userAvatarUrl(null, true));
}
function loadOwnerAvatars() {
  document.querySelectorAll(".owner-av[data-user]").forEach(async box => paintAvatar(box, await userAvatarUrl(box.dataset.user)));
}
// Profile: one column of sections (title + short description left, fields right).
const pfSec = (icon, title, desc, body) => `<section class="pf-sec">
    <div class="pf-sec-head"><span class="pf-sec-ic">${ic(icon)}</span><div><h2>${title}</h2><p>${desc}</p></div></div>
    <div class="pf-sec-body">${body}</div></section>`;
const pfTokenInput = () => `<input id="gt-token" name="token" type="password" autocomplete="off" placeholder="glpat-…" required>`;
async function viewProfile() {
  let me;
  try { me = await api("/api/profile"); } catch (e) { return toast(e.message, true); }
  const shown = me.full_name || me.name;
  const initials = shown.split(/[\s._@-]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "?";
  const since = me.created ? new Date(me.created).toLocaleDateString("en-GB", {day: "numeric", month: "short", year: "numeric"}) : "";
  const tk = S.gitlab_token || {};
  $("#view").innerHTML = `
    <div class="profile">
      <div class="pf-hero">
        <div class="pf-avatar" aria-hidden="true">${esc(initials)}</div>
        <div><h1 id="pf-shown">${esc(shown)}</h1>
          <p class="sub">${me.full_name ? `@${esc(me.name)} · ` : ""}Member since ${esc(since)}</p></div>
      </div>
      ${pfSec("user", "Profile", "Your name and email address.", `
        <form id="pfform" class="pf-form">
          <div class="full"><label for="pf-full">Full name</label><input id="pf-full" name="full_name" maxlength="100" autocomplete="name" value="${esc(me.full_name)}" placeholder="First and last name"></div>
          <div class="full"><label for="pf-mail">Email</label><input id="pf-mail" name="email" type="email" maxlength="254" autocomplete="email" value="${esc(me.email)}" placeholder="name@example.com"></div>
          <div class="actions"><button class="btn" type="submit">Save</button></div>
        </form>`)}
      ${pfSec("palette", "Appearance", "How T3 Watchdock looks for you. Saved in this browser only.", `
        <form id="apform" class="pf-form">
          <div><label for="ap-theme">Theme</label><select id="ap-theme" name="theme">
            ${THEMES.map(t => `<option value="${t.id}" ${(document.documentElement.dataset.theme || "auto") === t.id ? "selected" : ""}>${esc(t.label)}</option>`).join("")}</select></div>
          <div><label for="ap-style">Style</label><select id="ap-style" name="style">
            ${STYLES.map(x => `<option value="${x.id}" ${(document.documentElement.dataset.style || "default") === x.id ? "selected" : ""}>${esc(x.label)}</option>`).join("")}</select></div>
        </form>`)}
      ${pfSec("lock", "Password", "Enter your current password to set a new one. At least 12 characters; other sessions are signed out.", `
        <form id="pwform" class="pf-form">
          <input type="text" name="username" value="${esc(me.name)}" autocomplete="username" style="display:none">
          <div class="full"><label for="pw-cur">Current password</label><input id="pw-cur" name="current" type="password" autocomplete="current-password" required></div>
          <div><label for="pw-new">New password</label><input id="pw-new" name="new" type="password" autocomplete="new-password" minlength="12" required></div>
          <div><label for="pw-rep">Repeat new password</label><input id="pw-rep" name="repeat" type="password" autocomplete="new-password" minlength="12" required></div>
          <div class="actions"><button class="btn sec" type="submit">Update password</button></div>
        </form>`)}
      ${pfSec("key", "GitLab", "Personal access token (scope: api) for your GitLab instance. GitLab actions here run as you.", `
        <form id="gtform" class="pf-form">
          <input type="text" name="username" value="${esc(me.name)}" autocomplete="username" style="display:none">
          <div class="full"><label for="gt-url">GitLab URL</label><input id="gt-url" name="gitlab_url" type="url" autocomplete="off" value="${esc(tk.url || DEFAULTS.gitlab_url)}" placeholder="https://gitlab.example.com" pattern="https://.+" required></div>
          <div class="full"><label for="gt-token">Personal access token</label>
            <div id="gt-slot">${tk.own ? `<div class="pf-secret"><span class="pf-dot" aria-hidden="true"></span>
              <span class="pf-mask" aria-label="Token saved, hidden">••••••••••••••••••••••</span>
              <span class="pf-saved">Saved</span><button class="pf-replace" type="button" id="gt-replace">Replace</button></div>` : pfTokenInput()}</div></div>
          <div class="actions pf-actions">${tk.own ? `<button class="pf-link danger" type="button" data-act="tokendel">Remove token</button>` : ""}
            <span class="pf-spacer"></span>
            <button class="btn sec" type="button" data-act="tokentest"${tk.own ? "" : " disabled"}>Test connection</button>
            <button class="btn" type="submit">Save</button></div>
        </form>`)}
    </div>`;
  $("#gt-replace")?.addEventListener("click", () => { $("#gt-slot").innerHTML = pfTokenInput(); $("#gt-token").focus(); });
  $("#gtform").onsubmit = async ev => {
    ev.preventDefault();
    try { const d = await api("/api/token", {token: ev.target.token?.value || "", gitlab_url: ev.target.gitlab_url.value.trim()}); ev.target.reset(); await refresh(); toast(d.msg); viewProfile(); }
    catch (e) { toast(e.message, true); }
  };
  loadProfileAvatar();
  $("#ap-theme").onchange = ev => setTheme(ev.target.value, true);
  $("#ap-style").onchange = ev => setStyle(ev.target.value, true);
  $("#pfform").onsubmit = async ev => {
    ev.preventDefault();
    const f = ev.target;
    try {
      const r = await api("/api/profile", {full_name: f.full_name.value, email: f.email.value});
      $("#pf-shown").textContent = r.full_name || r.name; toast("Profile saved");
    }
    catch (e) { toast(e.message, true); }
  };
  $("#pwform").onsubmit = async ev => {
    ev.preventDefault();
    const f = ev.target;
    if (f.new.value !== f.repeat.value) return toast("New passwords do not match", true);
    try {
      await api("/api/profile/password", {current: f.current.value, new: f.new.value});
      f.reset(); toast("Password changed. Other sessions were signed out.");
    } catch (e) { f.current.value = ""; toast(e.message, true); }
  };
}

async function viewPlugins() {
  $("#view").innerHTML = `<div class="head"><h1>Plugins</h1></div><p class="empty">Loading…</p>`;
  let list;
  try { list = await api("/api/plugin-admin"); } catch (e) { $("#view .empty").textContent = e.message; return; }
  if (location.hash !== "#/plugins") return;
  // collapsed row: name (title up to the first ":") + On/Off; click opens the details and the form
  const card = pl => {
    const [name, ...rest] = (pl.title || pl.name).split(": "), summary = rest.join(": ");
    return `<details class="card plugin-card"><summary class="plugin-head">
        <span class="plugin-name">${esc(name.replace(/\.$/, ""))}</span>
        <span class="focus-monitor ${pl.enabled ? "is-configured" : "is-disabled"}">${pl.enabled ? "On" : "Off"}</span>
        ${ic("chev", "plugin-chev")}</summary>
      <form class="plugin-body" data-plugin="${esc(pl.name)}">
        ${summary ? `<p class="plugin-desc">${esc(summary[0].toUpperCase() + summary.slice(1))}</p>` : ""}
        ${pl.description ? `<p class="sub plugin-desc">${esc(pl.description)}</p>` : ""}
        <p class="sub plugin-desc">Folder: <code>plugins/${esc(pl.name)}/</code>${pl.readme ? ` · documentation in <code>README.md</code>` : ""}</p>
        <label class="check"><input type="checkbox" name="enabled" ${pl.enabled ? "checked" : ""}> Switched on</label>
        <label for="pl-${esc(pl.name)}">Settings (JSON)</label>
        <textarea id="pl-${esc(pl.name)}" name="settings" rows="4" spellcheck="false">${esc(JSON.stringify(pl.settings, null, 2))}</textarea>
        <div class="hint"><code>{}</code> = defaults.</div>
        <div class="actions"><button class="btn" type="submit">Save</button></div>
      </form></details>`;
  };
  $("#view").innerHTML = `<div class="head"><div><h1>Plugins</h1>
      <div class="sub">Optional features, off until switched on here. Saving reloads the page so the plugin's browser part loads.</div></div></div>
    <div class="stack">
      ${list.length ? list.map(card).join("") : `<div class="card empty">No plugins installed.</div>`}
      <div class="card"><h2>Add a plugin</h2><ol class="plugin-steps">
        <li>Copy the plugin folder to <code>plugins/&lt;name&gt;/</code> in the app folder (it contains <code>plugin.py</code>).</li>
        <li>Rebuild: <code>docker compose up -d --build</code> (without Docker: restart <code>python3 app.py</code>).</li>
        <li>Reload this page and switch the plugin on.</li></ol>
        <p class="sub" style="margin:8px 0 0">Plugins run as code inside the app, so they cannot be uploaded in the browser. Only install plugins you trust.</p></div>
    </div>`;
  document.querySelectorAll(".plugin-body").forEach(fm => fm.onsubmit = async ev => {
    ev.preventDefault();
    let settings;
    try { settings = JSON.parse(fm.settings.value.trim() || "{}"); } catch (e) { toast(`Settings are not valid JSON: ${e.message}`, true); return; }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) { toast("Settings must be a JSON object, e.g. {}", true); return; }
    const btn = fm.querySelector('[type="submit"]'); btn.disabled = true;
    try {
      await api("/api/plugin-admin", {name:fm.dataset.plugin, enabled:fm.enabled.checked, settings});
      location.reload();
    } catch (e) { toast(e.message, true); btn.disabled = false; }
  });
}
async function saveTeams(extra) {
  const f = $("#msform");
  await api("/api/teams", {enabled:f.enabled.checked, url:f.url.value, ...extra});
  await refresh(); viewSettings();
}
async function saveEmail(extra) {
  const f = $("#eform");
  await api("/api/email", {enabled:f.enabled.checked, host:f.host.value, port:f.port.value, security:f.security.value,
    user:f.user.value, password:f.password.value, from:f.from.value, to:f.to.value, ...extra});
  await refresh(); viewSettings();
}

// Scheduler: one row per task (status, on/off, run now); the chevron opens last result + schedule.
const SCHED_ICONS = {typo3_release: "tag", t3monitor: "activity", security: "shield", typo3_news: "bell", releases: "tag", daily_report: "mail"};
const schedOpen = new Set();
function relTime(iso) {   // "today 12:06", "yesterday 16:22", "tomorrow 07:00", else "18 Nov 16:22"
  if (!iso) return "–";
  const d = new Date(iso); if (isNaN(d)) return fmt(iso);
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date())) / 864e5);
  const hm = d.toLocaleTimeString("en-GB", {hour: "2-digit", minute: "2-digit"});
  const word = {"-1": "yesterday", 0: "today", 1: "tomorrow"}[diff];
  return `${word || d.toLocaleDateString("en-GB", {day: "numeric", month: "short"})} ${hm}`;
}
function schedResult(r) {   // "21/24 OK. A: msg | B: msg" -> summary + one row per failure; other results as text
  if (!r) return "";
  const cut = m => /<(!doctype|html|head|body)\b/i.test(m) ? m.replace(/:?\s*<[\s\S]*$/, "") + " (HTML page instead of data)" : m.length > 240 ? m.slice(0, 240) + "…" : m;
  const x = /^(\d+)\/(\d+) OK\.?\s*([\s\S]*)$/.exec(r);
  if (!x) return `<p class="sched-sum">${esc(cut(r))}</p>`;
  const rows = x[3] ? x[3].split(" | ").map(it => { const i = it.indexOf(": ");
    return i < 0 ? `<li>${esc(cut(it))}</li>` : `<li><b>${esc(it.slice(0, i))}</b> <span>${esc(cut(it.slice(i + 2)))}</span></li>`; }) : [];
  return `<p class="sched-sum">${x[1]} of ${x[2]} projects OK</p>${rows.length ? `<ul class="sched-fails">${rows.join("")}</ul>` : ""}`;
}
// Versions page: TYPO3, PHP, database and web server of every site against the newest releases (same data as the
// daily version report email). GET shows the last report; the refresh button computes a new one.
const VR_TONE = {bad: ["err", "Security issue or end of life"], warn: ["update", "Update available"],
                 ok: ["ok", "Current"], muted: ["info", "Not checked"]};
const vrIc = t => `<span class="vr-ic vr-${t}" title="${esc(VR_TONE[t][1])}">${ic(VR_TONE[t][0])}</span>`;
let vrFilter = "all";
async function viewVersions(rep) {
  const v = $("#view");
  v.dataset.pview = "versions";
  if (!rep) {
    v.innerHTML = `<div class="sched"><div class="sched-head"><h1>Versions</h1><p>Loading…</p></div></div>`;
    try { rep = await api("/api/versions"); }
    catch (e) { v.innerHTML = `<div class="sched"><div class="sched-head"><h1>Versions</h1></div><p class="empty">${esc(e.message)}</p></div>`; return; }
    if (v.dataset.pview !== "versions") return;
  }
  const c = rep.site_counts || {bad: 0, warn: 0, ok: 0, partial: 0}, need = s => s.cells.some(x => x.tone === "bad" || x.tone === "warn");
  const sites = rep.sites.filter(s => vrFilter === "all" || (vrFilter === "bad" ? s.cells.some(x => x.tone === "bad") : need(s)));
  const stat = (k, n, sub, cls) => `<div class="t3stat"><div class="t3stat-k">${k}</div><div class="t3stat-v ${cls}">${n}</div><div class="sub">${sub}</div></div>`;
  let prev = null;
  const span = {}; sites.forEach(s => span[s.project] = (span[s.project] || 0) + 1);   // environments per site
  const rows = sites.map(s => { const first = s.project !== prev; prev = s.project;
    return `<tr class="${first ? "vr-first" : ""}">${first ? `<td class="vr-site" rowspan="${span[s.project]}"><a href="#/p/${encodeURIComponent(s.project)}">${esc(s.name)}</a></td>` : ""}
      <td class="sub">${s.url ? `<a class="vr-site-link" href="${esc(s.url)}" target="_blank" rel="noopener" title="Open ${esc(s.url)}">${esc(s.env_label)} ${ic("ext", "sm")}</a>` : esc(s.env_label)}</td>
      ${s.cells.map((x, i) => `<td><div class="vr-cell">${vrIc(x.tone)}<div><b>${esc(x.version)}</b>${x.elts ? eltsTag({elts: true}) : ""}
        <div class="sub">${i > 1 && x.kind ? esc(x.kind) + " · " : ""}${esc(x.label)}</div></div></div></td>`).join("")}</tr>`; }).join("");
  // advisories: one collapsible row per site and environment, summary = count per severity
  const SEV_ORDER = ["Critical", "High", "Important", "Medium", "Moderate", "Not rated", "Low"];
  const groups = new Map();
  rep.advisories.filter(a => vrFilter !== "bad" || a.tone === "bad").forEach(a => {
    const k = a.project + "|" + a.env;
    if (!groups.has(k)) groups.set(k, {a, items: []});
    groups.get(k).items.push(a);
  });
  const advs = [...groups.values()].map(({a, items}) => {
    const by = {}; items.forEach(x => (by[x.severity] ||= {n: 0, tone: x.tone}).n++);
    const sev = Object.keys(by).sort((x, y) => (SEV_ORDER.indexOf(x) + 99) % 99 - (SEV_ORDER.indexOf(y) + 99) % 99);
    const worst = items.some(x => x.tone === "bad") ? "bad" : items.some(x => x.tone === "warn") ? "warn" : "muted";
    return `<details class="vr-adv"><summary>${vrIc(worst)}<span class="vr-adv-site"><b>${esc(a.name)}</b> <span class="sub">${esc(a.env_label)}</span></span>
        <span class="vr-adv-sum">${sev.map(k => `<span class="vr-chip vr-${by[k].tone}">${by[k].n} ${esc(k.toLowerCase())}</span>`).join("")}</span>${ic("chev", "vr-chev")}</summary>
      <ul>${items.map(x => `<li>${vrIc(x.tone)}<div>${/^https?:\/\//.test(x.link || "") ? `<a href="${esc(x.link)}" target="_blank" rel="noopener">${esc(x.title)}</a>` : esc(x.title)}
        <div class="sub">${esc(x.severity)} · ${esc(x.sub)}</div></div></li>`).join("")}</ul></details>`;
  }).join("");
  v.innerHTML = `<div class="sched vr">
    <div class="sched-head vr-head"><div><h1>Versions</h1>
      <p>TYPO3, PHP, database and web server of every site compared with the newest releases · updated ${esc(relTime(rep.generated))} · daily email in <a href="#/scheduler">Scheduler</a></p></div>
      ${progBtn("versions", "Refresh versions now", `data-act="vrrefresh"`)}</div>
    <div class="t3stats vr-stats">
      ${stat("Sites", rep.sites.length, "Production and staging counted separately", "")}
      ${stat("Need security action", c.bad, "At least one red version", c.bad ? "sev-2" : "")}
      ${stat("Need an update", c.warn, "At least one orange version, no red", c.warn ? "sev-1" : "")}
      ${stat("Up to date", c.ok, c.partial ? `${c.partial} with parts not checked` : "Everything green", c.ok ? "sev0" : "")}</div>
    <div class="vr-bar"><div class="vr-legend">${Object.keys(VR_TONE).map(t => `<span>${vrIc(t)}${esc(VR_TONE[t][1])}</span>`).join("")}</div>
      <select name="vr-filter" aria-label="Filter sites">${[["all", "All sites"], ["need", "Needs action"], ["bad", "Security / end of life only"]]
        .map(([k, l]) => `<option value="${k}" ${vrFilter === k ? "selected" : ""}>${l}</option>`).join("")}</select></div>
    <div class="wrap"><table class="typo3-overview vr-table"><thead><tr><th>Site</th><th>Environment</th>${rep.cols.map(x => `<th>${esc(x)}</th>`).join("")}</tr></thead>
      <tbody>${rows || `<tr><td colspan="6" class="empty">Nothing to show for this filter.</td></tr>`}</tbody></table></div>
    <h2 class="vr-h2">Security advisories <span class="sub">${rep.advisories.length} on ${groups.size} ${groups.size === 1 ? "instance" : "instances"}</span></h2>
    <p class="sub vr-note">TYPO3 core and public extensions (Packagist) and Apache httpd CVEs (httpd.apache.org) for the installed version. Click a site for the list.</p>
    ${advs ? `<div class="vr-advs">${advs}</div>` : `<p class="empty">No known security advisories.</p>`}
    <h2 class="vr-h2">Newest releases</h2>
    <div class="vr-newest">${rep.newest.map(([k, x]) => `<div><span class="sub">${esc(k)}</span><b>${esc(x)}</b></div>`).join("")}</div>
  </div>`;
  v.querySelector("[name=vr-filter]").onchange = e => { vrFilter = e.target.value; viewVersions(rep); };
  v.querySelector("[data-act=vrrefresh]").onclick = async () => {
    let fresh = null, err = null;
    await runProg("versions", [async () => { try { fresh = await api("/api/versions/refresh", {}); } catch (e) { err = e; throw e; } }], 1);
    if (v.dataset.pview !== "versions") return;
    if (err) return toast(err.message, true);
    viewVersions(fresh);
  };
}

function viewScheduler() {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  $("#view").innerHTML = `
    <div class="sched">
      <div class="sched-head"><h1>Scheduler</h1><p>Tasks run while the launcher runs. A run missed while it was off starts right after the next start.</p></div>
      ${S.scheduler.map(t => { const c = t.cfg, id = esc(t.id), open = schedOpen.has(t.id);
        const st = t.blocked ? `<span class="sched-dot warn"></span>Paused (started with --no-watch)`
          : !t.last_run ? `<span class="sched-dot"></span>Never run`
          : `<span class="sched-dot ${t.ok ? "ok" : "err"}"></span><span class="${t.ok ? "" : "sched-err"}">${t.ok ? "OK" : "Failed"} · ${esc(relTime(t.last_run))}</span>`;
        return `
      <form class="sched-task" data-task="${id}">
        <div class="sched-row">
          <span class="pf-sec-ic">${ic(SCHED_ICONS[t.id] || "clock")}</span>
          <div class="sched-name"><h2>${esc(t.name)}</h2><p title="${esc(t.description)}">${esc(t.description)}</p></div>
          <div class="sched-status"><div>${st}</div><div class="sched-next">${c.enabled && !t.blocked && t.next_run ? `Next ${esc(relTime(t.next_run))}` : c.enabled ? "–" : "Off"}</div></div>
          <input type="checkbox" class="switch" role="switch" name="enabled" aria-label="${esc(t.name)} on/off" ${c.enabled ? "checked" : ""}>
          <button class="btn sec sched-run" type="button" data-act="schedrun" data-id="${id}" ${t.running ? "disabled" : ""}>${t.running ? "Running…" : `${ic("play", "sm")} Run now`}</button>
          <button class="sched-chev" type="button" aria-expanded="${open}" aria-controls="sp-${id}" aria-label="Details and schedule">${ic("chev")}</button>
        </div>
        <div class="sched-panel" id="sp-${id}" ${open ? "" : "hidden"}>
          ${t.result ? `<div class="pf-subhead">Last result</div>${schedResult(t.result)}<hr class="pf-hr">` : ""}
          <div class="pf-subhead">Schedule</div>
          <div class="sched-mode">
            <div class="sched-seg" role="radiogroup" aria-label="Schedule type">
              <label><input type="radio" name="mode" value="interval" ${c.mode === "interval" ? "checked" : ""}><span>Every N hours</span></label>
              <label><input type="radio" name="mode" value="daily" ${c.mode === "daily" ? "checked" : ""}><span>Daily</span></label></div>
            <label class="sched-inline" data-for="interval">every <input name="hours" type="number" min="0.25" max="168" step="0.25" value="${esc(c.hours)}" aria-label="Hours"> h</label>
            <label class="sched-inline" data-for="daily">at <input name="time" type="time" value="${esc(c.time)}" aria-label="Time"></label>
          </div>
          <div class="sched-days" data-for="daily" role="group" aria-label="Weekdays">
            ${days.map((d, i) => `<label title="${d}"><input type="checkbox" name="day" value="${i}" ${c.days.includes(i) ? "checked" : ""}><span>${d[0]}</span></label>`).join("")}</div>
          <div class="actions"><button class="btn" type="submit">Save</button></div>
        </div>
      </form>`; }).join("")}
    </div>`;
  viewScheduler.dirty = false;
  document.querySelectorAll("form[data-task]").forEach(f => {
    const save = async (msg) => {
      try {
        await api("/api/scheduler", {id:f.dataset.task, enabled:f.enabled.checked, mode:f.mode.value, hours:f.hours.value,
          time:f.time.value, days:[...f.querySelectorAll("[name=day]:checked")].map(x => Number(x.value))});
        await refresh(); toast(msg); viewScheduler();
      } catch (e) { toast(e.message, true); }
    };
    f.oninput = () => viewScheduler.dirty = true;
    const sync = () => f.querySelectorAll("[data-for]").forEach(el => el.hidden = el.dataset.for !== f.mode.value);
    f.querySelectorAll("[name=mode]").forEach(r => r.onchange = sync); sync();
    f.enabled.onchange = () => save(f.enabled.checked ? "Task switched on" : "Task switched off");
    f.querySelector(".sched-chev").onclick = ev => {
      const b = ev.currentTarget, panel = f.querySelector(".sched-panel"), open = panel.hidden;
      panel.hidden = !open; b.setAttribute("aria-expanded", String(open));
      open ? schedOpen.add(f.dataset.task) : schedOpen.delete(f.dataset.task);
    };
    f.onsubmit = ev => { ev.preventDefault(); save("Schedule saved"); };
  });
}

/* ---------------- actions ---------------- */
const actions = {
  tftab(el) { techFilter = {...techFilter, tech: el.dataset.tech, val: ""}; paintTechFilter(); el.focus(); },
  tfval(el) { techFilter.val = el.dataset.v; document.querySelectorAll("[data-act=tfval]").forEach(b => b.setAttribute("aria-pressed", String(b === el))); applyTechFilter(); },
  tftoggle(el) {   // off = hide the bar and clear the filter
    const open = !techFilter.open; techFilter = open ? {...techFilter, open} : {tech: "typo3", val: "", open};
    $("#tfBar").hidden = !open; el.classList.toggle("on", open); el.setAttribute("aria-expanded", String(open));
    if (open) $("[data-act=tftab][aria-selected=true]")?.focus(); else paintTechFilter();
  },
  pview(el) {
    const v = el.dataset.v; try { localStorage.setItem("projectsView", v); } catch (e) {}
    $("#view").dataset.pview = v;
    document.querySelectorAll("[data-act=pview]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === v)));
  },
  t3review(el) {   // open the Problems row and bring it into view
    const r = el.closest(".t3m")?.querySelector("details.t3-problems"); if (!r) return;
    r.open = true; r.scrollIntoView({block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"});
  },
  t3mopen(el) {   // open the status modal; data-row: also expand that row (e.g. t3-exts) and bring it into view
    const d = $(`#t3dlg-${el.dataset.env}`); if (!d) return; d.showModal(); d.focus();
    const r = el.dataset.row && d.querySelector(`details.${el.dataset.row}`);
    if (r) { r.open = true; r.scrollIntoView({block: "start"}); }
  },
  runtip(el) {   // info button of a waiting manual job: click toggles the tooltip (hover / keyboard focus show it too)
    const open = !el.classList.contains("open");
    document.querySelectorAll(".runst-info.open").forEach(b => { b.classList.remove("open"); b.setAttribute("aria-expanded", "false"); });
    el.classList.toggle("open", open); el.setAttribute("aria-expanded", String(open));
  },
  t3mclose(el) { el.closest("dialog")?.close(); },
  // Monitoring settings of one environment (same fields as the project form); saves only this instance
  t3medit(el) {
    const p = proj($("#view").dataset.project), e = T3M_ENVS.find(x => x.env === el.dataset.env);
    const d = document.createElement("dialog");
    d.className = "t3dlg t3edit";
    d.setAttribute("aria-label", `${e.label} monitoring settings`);
    d.innerHTML = `<form class="t3edit-form">${t3mFields(e, p)}
      <div class="actions project-form-actions"><button class="btn" type="submit">Save changes</button>
        <button type="button" class="btn sec" data-cancel>Cancel</button></div></form>`;
    const fm = d.querySelector("form");
    keyTools(fm, p);
    fm.addEventListener("input", ({target}) => {
      const draft = fm.querySelector(`[data-key-draft="${target.name}"]`);
      if (draft) draft.hidden = !target.value;
    });
    fm.addEventListener("invalid", ({target}) => { const x = target.closest("details"); if (x) x.open = true; }, true);
    fm.querySelector("[data-cancel]").onclick = () => d.close();
    d.onclose = () => d.remove();
    fm.onsubmit = async ev => {
      ev.preventDefault();
      const f = new FormData(fm), btn = fm.querySelector('[type="submit"]');
      const body = {id:p.id, env:e.env,
        ...Object.fromEntries(["url", "key", "auth_user", "auth_password"].map(k => [e.f + k, f.get(e.f + k) || ""])),
        [e.f + "key_clear"]:f.get(e.f + "key_clear") === "on", [e.f + "auth_clear"]:f.get(e.f + "auth_clear") === "on"};
      btn.disabled = true;
      try {
        await api("/api/t3monitor/settings", body);
        await refresh(); d.close(); toast(`${e.label} monitoring saved`); render();
      } catch (err) { toast(err.message, true); btn.disabled = false; }
    };
    document.body.append(d); d.showModal();
  },
  async run(el) {
    const p = proj($("#view").dataset.project), upd = el.dataset.mode === "update", prod = el.dataset.mode === "production";
    const msg = prod
      ? `PRODUCTION: start pipeline for ${p.name} on "${p.production.ref}"?\n\nThis runs independently of staging. Make sure "${p.production.ref}" contains the intended changes (merged in GitLab) — the launcher does not merge.`
      : `Start ${upd ? "TYPO3 update pipeline" : "staging pipeline"} for ${p.name} (${p.ref})?`;
    if (!confirm(msg)) return;
    el.disabled = true;
    try { const r = await api("/api/run", {project:p.id, mode:el.dataset.mode}); await refresh();
      toast(`${prod ? "Production pipeline" : "Pipeline"} #${r.id} started`); location.hash = `${pUrl(p)}/pl/${r.id}`; }
    catch (e) { toast(e.message, true); el.disabled = false; }
  },
  async runall(el) {
    const ps = S.projects.filter(hasCI);
    if (!confirm(`Start pipelines for all ${ps.length} project(s) at once?\n\n` + ps.map(p => `• ${p.name} (${p.ref})`).join("\n"))) return;
    el.disabled = true;
    const res = await Promise.allSettled(ps.map(p => api("/api/run", {project:p.id, mode:"normal"})));
    const failed = res.map((r, i) => r.status === "rejected" ? `${ps[i].name}: ${r.reason.message}` : null).filter(Boolean);
    await refresh(); viewProjects();
    if (failed.length) toast(`${ps.length - failed.length}/${ps.length} started. Failed: ${failed.join(" | ")}`, true);
    else toast(`${ps.length} pipeline(s) started`);
  },
  async promote(el) {
    const p = proj($("#view").dataset.project), from = Number(el.dataset.from), ref = p.production.ref;
    if (!confirm(`PRODUCTION: start pipeline for ${p.name} on "${ref}"?\n\nStaging pipeline #${from} succeeded.\nMake sure "${ref}" already contains the staging changes (merged in GitLab) — the launcher does not merge.`)) return;
    el.disabled = true;
    try { const r = await api("/api/run", {project:p.id, mode:"promote", from}); await refresh();
      toast(`Production pipeline #${r.id} started`); location.hash = `${pUrl(p)}/pl/${r.id}`; }
    catch (e) { toast(e.message, true); el.disabled = false; }
  },
  async play(el) {
    const p = proj($("#view").dataset.project);
    if (!confirm(`Start manual job "${el.dataset.name}"?`)) return;
    el.disabled = true;
    try { await api("/api/play", {project:p.id, job:Number(el.dataset.job)}); toast(`${el.dataset.name} started`); render(); }
    catch (e) { toast(e.message, true); el.disabled = false; }
  },
  async del() {
    const p = proj($("#view").dataset.project);
    const name = p.name || p.id;
    if (!await confirmByName(`Remove ${name}?`,
      `<p>This removes the project from the launcher, including its stored t3monitor keys and Basic-auth passwords
       (production and staging). <b>This cannot be undone.</b> GitLab and the website itself are not touched.</p>`,
      name, "Remove this project")) return;
    try { await api("/api/projects/delete", {id:p.id, confirm:name}); await refresh(); toast("Project removed"); location.hash = "#/"; }
    catch (e) { toast(e.message, true); }
  },
  async check(el) {
    el.disabled = true;
    try { await api("/api/check-now", {}); await refresh(); viewSettings(); toast("TYPO3 check done"); }
    catch (e) { toast(e.message, true); el.disabled = false; }
  },
  async teamstest(el) {
    el.disabled = true;
    try { await saveTeams(); toast((await api("/api/teams/test", {})).msg); }
    catch (e) { toast(e.message, true); el.disabled = false; }
  },
  async teamsdel() {
    if (!confirm("Remove the stored Teams webhook URL? Teams messages are switched off.")) return;
    try { await saveTeams({enabled:false, url:"", clear_url:true}); toast("Webhook URL removed"); } catch (e) { toast(e.message, true); }
  },
  async mailtest(el) {
    el.disabled = true;
    try { await saveEmail(); toast((await api("/api/email/test", {})).msg); }
    catch (e) { toast(e.message, true); el.disabled = false; }
  },
  async mailpwdel() {
    if (!confirm("Remove the stored SMTP password?")) return;
    try { await saveEmail({password:"", clear_password:true}); toast("SMTP password removed"); } catch (e) { toast(e.message, true); }
  },
  async schedrun(el) {
    el.disabled = true; el.textContent = "Running…";
    try { const r = await api("/api/scheduler/run", {id:el.dataset.id}); await refresh(); viewScheduler(); toast(r.result, !r.ok); }
    catch (e) { toast(e.message, true); el.disabled = false; el.innerHTML = `${ic("play", "sm")} Run now`; }
  },
  async updsend(el) {
    el.disabled = true;
    try { toast((await api("/api/updates/send", {project:$("#view").dataset.project})).msg); }
    catch (e) { toast(e.message, true); }
    el.disabled = false;
  },
  async t3mrefreshhome() {   // every monitored site (project × environment), 4 at a time; then reload the overview
    const sites = S.projects.flatMap(p => T3M_ENVS.filter(e => t3mOn(p, e)).map(e => ({p, e})));
    const r = await runProg("home", sites.map(({p, e}) => () => api("/api/t3monitor/refresh", {project:p.id, env:e.env})));
    if (!r) return;
    if (location.hash.replace(/^#\/?$/, "") === "") { T3SUM = null; viewProjects(); }
    toast(`${r.total - r.failed}/${r.total} site(s) refreshed${r.failed ? ` · ${r.failed} failed` : ""}`, !!r.failed);
  },
  async t3mrefreshall() {
    const p = proj($("#view").dataset.project), envs = T3M_ENVS.filter(e => t3mOn(p, e));
    const r = await runProg(`proj:${p.id}`, envs.map(e => () => loadT3m(p, e, true)));
    if (r) toast(`Status refreshed: ${envs.map(e => e.label).join(" + ")}`);
  },
  async t3mrefresh(el) {
    const p = proj($("#view").dataset.project), e = T3M_ENVS.find(x => x.env === el.dataset.env);
    await runProg(`t3m:${p.id}:${e.env}`, [() => loadT3m(p, e, true)]);
  },
  async projexport(el) {
    el.disabled = true;
    try {
      const d = await api("/api/projects/export", {}), n = new Date(), z = x => String(x).padStart(2, "0");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], {type:"application/json"}));
      a.download = `t3-watchdock-projects-${n.getFullYear()}${z(n.getMonth() + 1)}${z(n.getDate())}.json`;
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast(`${d.projects.length} projects exported (file contains keys and passwords)`);
    } catch (e) { toast(e.message, true); }
    el.disabled = false;
  },
  async projimport(el) {
    const file = $("#impFile").files[0], overwrite = $("#impOverwrite").checked;
    if (!file) return toast("Choose an export file first", true);
    let data;
    try { data = JSON.parse(await file.text()); } catch { return toast("The file is not valid JSON", true); }
    const list = Array.isArray(data?.projects) ? data.projects : [];
    const hosts = [...new Set(list.map(x => x?.project?.gitlab_url).filter(Boolean))];   // the GitLab token is sent to these hosts
    if (!confirm(`Import ${list.length} projects${overwrite ? " and overwrite existing ones" : ""}?\n\nGitLab hosts in this file (GitLab tokens are sent to them):\n${hosts.join("\n") || "–"}`)) return;
    el.disabled = true;
    try {
      const r = await api("/api/projects/import", {data, overwrite});
      await refresh(); viewSettings();
      toast(`Import: ${r.added.length} added, ${r.updated.length} updated, ${r.skipped.length} skipped`);
    } catch (e) { toast(e.message, true); el.disabled = false; }
  },
  async tokentest() { try { toast((await api("/api/token/test", {})).msg); } catch (e) { toast(e.message, true); } },
  async tokendel() {
    if (!confirm("Remove your GitLab token? You cannot use GitLab in Watchdock until you save a new one, "
                 + "and automatic TYPO3 updates of projects you are responsible for stop.")) return;
    try { await api("/api/token/delete", {}); await refresh(); viewProfile(); toast("Token removed"); } catch (e) { toast(e.message, true); }
  },
};
document.addEventListener("keydown", e => {
  const t = e.target.closest?.("[data-act=tftab]"); if (!t || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  const tabs = [...document.querySelectorAll("[data-act=tftab]")], i = tabs.indexOf(t);
  const n = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  e.preventDefault(); actions.tftab(tabs[n]);
});
document.addEventListener("click", e => {
  // click on the modal backdrop (outside the dialog box) closes it
  if (e.target.matches("dialog.t3dlg")) { const r = e.target.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return e.target.close(); }
  if (!e.target.closest(".runst-info")) document.querySelectorAll(".runst-info.open").forEach(b => { b.classList.remove("open"); b.setAttribute("aria-expanded", "false"); });
  const el = e.target.closest("[data-act]");
  if (el && actions[el.dataset.act]) { e.preventDefault(); actions[el.dataset.act](el); }
});

/* ---------------- guided tour ----------------
   Step = {route?, el?, title, text}. route: hash to open first (string or function); el: CSS selector or function.
   Steps whose element is missing (e.g. no projects, no admin) are skipped. Keys: → / Enter next, ← back, Esc end.
   Progress is kept per browser: an unfinished tour resumes after a reload, a finished one does not start again. */
const firstProject = () => S.projects[0] ? pUrl(S.projects[0]) : null;
const cardWith = sel => () => document.querySelector(sel)?.closest(".card, .pf-sec");
const cardTitled = t => () => [...document.querySelectorAll("#view .card h2")].find(h => h.textContent.includes(t))?.closest(".card");
const TOUR = [
  {title: "Welcome to T3 Watchdock", text: "This tour shows the main parts in about a minute. Use the buttons or → / ←; Esc ends it. Restart it any time with the ⓘ button at the top."},
  {el: "header nav", title: "Navigation", text: "Projects, Activity (runs and log), Scheduler (automatic tasks), Settings and Plugins."},
  {el: "#tokenPill", title: "Your GitLab token", text: "Shows ✓ when your own token is stored. Everything you do with GitLab here runs as you; without a token, GitLab features do not work."},
  {el: "#profileBtn", title: "Profile", text: "Name, email, password, your GitLab token and the appearance (theme and style)."},
  {route: "#/", el: ".grid .pcard", title: "Project card", text: "Monitoring per environment, the last CI/CD pipeline and its result. The picture at the bottom right is the responsible person. Click the card for details."},
  {route: "#/", el: "#view .seg", title: "Cards or table", text: "Switch between project cards and the TYPO3 status table."},
  {route: "#/", el: "[data-act=tftoggle]", title: "Filter", text: "Filter the projects by technology and version."},
  {route: "#/", el: "[data-act=runall]", title: "Run all", text: "Starts the main pipeline (not production) of every CI/CD project."},
  {route: "#/", el: '#view a[href="#/new"]', title: "New project", text: "Add a GitLab project. Name, branches and manual jobs are pre-filled from GitLab."},
  {route: "#/", el: "#t3sum", title: "TYPO3 status", text: "TYPO3 version, errors and warnings of every monitored instance from the last TYPO3 health check. ↑ = TYPO3 update available, ≠ = staging differs from production."},
  {route: firstProject, el: "#view .pipe-env", title: "Pipelines", text: "Start a pipeline per environment with ▶. The current pipeline and its jobs appear here; production can be promoted after a successful staging pipeline."},
  {route: firstProject, el: '#view .head a[href$="/edit"]', title: "Edit project", text: "Branches, variables, auto-play jobs, TYPO3 auto-update, monitoring, and the responsible person shown on the card."},
  {route: "#/activity", el: "#view .card", title: "Activity", text: "All pipeline runs started from Watchdock and the activity log."},
  {route: "#/scheduler", el: "#view .sched-task", title: "Scheduler", text: "Automatic tasks such as the TYPO3 release check: interval or daily time, or run now. Automatic TYPO3 update pipelines run with the token of each project's responsible person."},
  {route: "#/settings", el: cardTitled("Microsoft Teams"), title: "Settings", text: "Teams and email notifications, project export / import and the TYPO3 release check."},
  {route: "#/profile", el: cardWith("#gtform"), title: "Your GitLab token", text: "Save your personal access token (scope api) here. It is stored encrypted and never shown again."},
  {route: "#/profile", el: cardWith("#apform"), title: "Appearance", text: "Theme and style, saved in this browser."},
  {route: "#/", title: "That's it", text: "Restart the tour any time with the ⓘ button at the top."},
];
const tour = {i: -1, el: null, dir: 1};
const tourStore = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} };
const tourRead = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const tourFind = s => typeof s.el === "function" ? s.el() : s.el ? document.querySelector(s.el) : null;

function tourStart(at = 0) {
  if (!$("#tourUi")) document.body.insertAdjacentHTML("beforeend", `<div id="tourUi">
    <div class="tour-block"></div><div class="tour-hole" hidden></div>
    <div class="tour-pop" role="dialog" aria-modal="true" aria-labelledby="tourTitle" aria-describedby="tourText">
      <div class="tour-top"><span class="tour-count" id="tourCount"></span>
        <button type="button" class="tour-x" data-tour="end" title="End tour" aria-label="End tour">${ic("close")}</button></div>
      <div class="tour-bar"><span id="tourBar"></span></div>
      <h2 id="tourTitle"></h2><p id="tourText"></p>
      <div class="tour-actions"><button type="button" class="btn sec" data-tour="back">Back</button>
        <button type="button" class="btn" data-tour="next">Next</button></div></div></div>`);
  $("#tourUi").hidden = false;
  tourShow(at, 1);
}

function tourEnd() {
  tour.i = -1; tour.el = null;
  tourStore("tour_step", null); tourStore("tour_done", "1");
  if ($("#tourUi")) $("#tourUi").hidden = true;
  $("#tourBtn").focus();
}

async function tourShow(i, dir) {
  if (i < 0) i = 0;
  if (i >= TOUR.length) return tourEnd();
  tour.i = i; tour.dir = dir; tourStore("tour_step", i);
  const s = TOUR[i], route = typeof s.route === "function" ? s.route() : s.route;
  if (s.route && !route) return tourShow(i + dir, dir);               // e.g. no project for the project steps
  if (route && (location.hash || "#/") !== route) { location.hash = route; await new Promise(r => setTimeout(r, 60)); }
  let el = null;
  for (let n = 0; s.el && n < 30 && !(el = tourFind(s)); n++) await new Promise(r => setTimeout(r, 100));
  if (tour.i !== i) return;                                           // moved on meanwhile
  if (s.el && !el) return tourShow(i + dir, dir);                     // element not on this page: skip
  tour.el = el;
  if (el) el.scrollIntoView({block: "center", behavior: "instant"});
  $("#tourCount").textContent = `${i + 1} / ${TOUR.length}`;
  $("#tourBar").style.width = `${Math.round((i + 1) / TOUR.length * 100)}%`;
  $("#tourTitle").textContent = s.title;
  $("#tourText").textContent = s.text;
  $("[data-tour=back]").disabled = i === 0;
  $("[data-tour=next]").textContent = i === TOUR.length - 1 ? "Finish" : "Next";
  tourPlace();
  $("[data-tour=next]").focus();
}

function tourPlace() {
  if (tour.i < 0) return;
  if (tour.el && !tour.el.isConnected) tour.el = tourFind(TOUR[tour.i]);   // view was re-rendered
  const hole = $(".tour-hole"), pop = $(".tour-pop"), pad = 6, gap = 12, m = 16;
  const vw = document.documentElement.clientWidth, vh = window.innerHeight;
  hole.hidden = !tour.el;
  $(".tour-block").classList.toggle("dim", !tour.el);
  pop.style.maxWidth = `${Math.min(360, vw - 2 * m)}px`;
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  if (!tour.el) { pop.style.left = `${(vw - pw) / 2}px`; pop.style.top = `${Math.max(m, (vh - ph) / 2)}px`; return; }
  const r = tour.el.getBoundingClientRect();
  Object.assign(hole.style, {left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px`});
  let top = r.bottom + pad + gap;                                     // below; above if it does not fit; else inside the view
  if (top + ph > vh - m) top = r.top - pad - gap - ph >= m ? r.top - pad - gap - ph : Math.max(m, vh - m - ph);
  const left = Math.min(Math.max(m, r.left + r.width / 2 - pw / 2), vw - m - pw);
  pop.style.left = `${left}px`; pop.style.top = `${top}px`;
}

document.addEventListener("click", e => {
  const b = e.target.closest("[data-tour]");
  if (!b) return;
  const a = b.dataset.tour;
  if (a === "end") tourEnd();
  else if (a === "next") tourShow(tour.i + 1, 1);
  else if (a === "back") tourShow(tour.i - 1, -1);
});
document.addEventListener("keydown", e => {
  if (tour.i < 0) return;
  if (e.key === "Escape") { e.preventDefault(); tourEnd(); }
  else if (e.key === "ArrowRight" || (e.key === "Enter" && !e.target.closest("button"))) { e.preventDefault(); tourShow(tour.i + 1, 1); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); tourShow(tour.i - 1, -1); }
  else if (e.key === "Tab") {                                         // keep focus inside the popup
    const f = [...document.querySelectorAll(".tour-pop button:not(:disabled)")], k = f.indexOf(document.activeElement);
    e.preventDefault(); f[(k + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
  }
}, true);
window.addEventListener("resize", tourPlace);
window.addEventListener("scroll", tourPlace, true);
$("#tourBtn").onclick = () => tourStart(0);

window.addEventListener("hashchange", render);
loadPlugins().finally(async () => {
  await render();
  const step = tourRead("tour_step");                // unfinished tour resumes; first visit starts it once
  if (step != null) tourStart(Number(step) || 0);
  else if (!tourRead("tour_done")) tourStart(0);
});
setInterval(async () => {          // refresh list views only when their data changed; never interrupt forms or pipeline view
  if (document.hidden || tour.i >= 0) return;     // background tab or guided tour: no polling
  const h = location.hash.slice(1) || "/", prevS = JSON.stringify(S), prevSum = JSON.stringify(T3SUM);
  await refresh();
  const changed = JSON.stringify(S) !== prevS;
  if (h === "/" && S.projects.length) {
    let sum; try { sum = await api("/api/t3monitor/summary"); } catch { return; }
    if (changed || JSON.stringify(sum) !== prevSum) { T3SUM = sum; viewProjects(true); }
  } else if (!changed) return;
  else if (h === "/") viewProjects();
  else if (h === "/activity") viewActivity();
  else if (h === "/scheduler" && !viewScheduler.dirty) viewScheduler();
}, 30000);
