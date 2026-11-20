"use strict";

const $ = (s) => document.querySelector(s);
const REFRESH_MS = 10000;

const state = {
  projects: [],
  open: new Set(JSON.parse(localStorage.getItem("open") || "[]")),
  services: {},   // név -> [service]
  busy: {},       // név -> művelet
  output: {},     // név -> {ok, text}
  filter: "",
  stateFilter: localStorage.getItem("stateFilter") || "all",
  stats: null,    // /api/stats válasz
};

const STATE_LABEL = {
  running: "fut", starting: "indul…", unhealthy: "unhealthy", partial: "részben fut", stopped: "leállítva",
};
const FAST_REFRESH_MS = 2000; // amíg valami indul

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 3500);
}

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  let body = null;
  try { body = await r.json(); } catch { /* nincs json */ }
  if (!r.ok) {
    const msg = body?.detail || body?.output || `HTTP ${r.status}`;
    const e = new Error(msg); e.body = body; throw e;
  }
  return body;
}

function fmtBytes(n) {
  if (!n) return "0 B";
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${u[i]}`;
}
const fmtPct = (n) => `${(n || 0).toFixed(n >= 10 ? 0 : 1)}%`;

function bar(pct, cls = "") {
  const w = Math.max(0, Math.min(100, pct || 0));
  const lvl = w > 85 ? "hi" : w > 60 ? "mid" : "";
  return `<span class="bar ${cls} ${lvl}"><span style="width:${w}%"></span></span>`;
}

// ------------------------------------------------------------------ betöltés
let statsLoading = false;
async function loadStats() {
  if (statsLoading) return;
  statsLoading = true;
  try {
    state.stats = await api("api/stats");
    render();
  } catch { /* a stat nem kritikus */ }
  finally { statsLoading = false; }
}

// Amíg egy projekt "starting" állapotban van, sűrűbben frissítünk,
// hogy a zöld jelzés a tényleges elindulás után minél hamarabb megjelenjen.
let fastTimer = null;
function scheduleFastRefresh() {
  clearTimeout(fastTimer);
  if (state.projects.some((p) => p.state === "starting") && !Object.keys(state.busy).length) {
    fastTimer = setTimeout(() => {
      if (document.visibilityState === "visible") loadProjects();
      else scheduleFastRefresh();
    }, FAST_REFRESH_MS);
  }
}

async function loadProjects() {
  const btn = $("#refresh");
  btn.classList.add("spin");
  try {
    loadStats(); // párhuzamosan, nem várjuk meg (~2 mp)
    state.projects = await api("api/projects");
    await Promise.all([...state.open].map(loadServices));
    $("#updated").textContent = new Date().toLocaleTimeString("hu-HU");
    render();
  } catch (e) {
    $("#projects").innerHTML = `<p class="muted center">Hiba: ${esc(e.message)}</p>`;
  } finally {
    btn.classList.remove("spin");
    scheduleFastRefresh();
  }
}

async function loadServices(name) {
  if (!state.projects.some((p) => p.name === name)) return;
  try {
    state.services[name] = await api(`api/projects/${encodeURIComponent(name)}/services`);
  } catch (e) {
    state.services[name] = { error: e.message };
  }
}

// ------------------------------------------------------------------ render
function serviceHtml(p) {
  const svcs = state.services[p.name];
  if (!svcs) return `<div class="services muted">Betöltés…</div>`;
  if (svcs.error) return `<div class="services muted">Hiba: ${esc(svcs.error)}</div>`;
  if (!svcs.length) return `<div class="services muted">Nincs konténer</div>`;
  return `<div class="services">${svcs.map((s) => {
    const st = s.state === "running"
      ? (s.health === "starting" ? "starting" : s.health === "unhealthy" ? "unhealthy" : "running")
      : s.state === "created" ? "starting"
      : s.state === "restarting" ? "partial" : "stopped";
    const ports = [...new Set((s.ports || []).filter((x) => x.PublishedPort)
      .map((x) => `${x.PublishedPort}→${x.TargetPort}`))].join(", ");
    return `<div class="svc">
      <span class="dot ${st}"></span>
      <div class="svc-main">
        <strong>${esc(s.service)}</strong>
        <span class="muted">${esc(s.status)}${s.health ? " · " + esc(s.health) : ""}</span>
        <span class="muted">${esc(s.image)}${ports ? " · " + esc(ports) : ""}</span>
      </div>
      <button class="small-btn" data-act="logs" data-name="${esc(p.name)}" data-svc="${esc(s.service)}">Log</button>
      ${containerStatsHtml(p.name, s.name)}
    </div>`;
  }).join("")}</div>`;
}

function containerStatsHtml(project, cname) {
  const c = state.stats?.projects?.[project]?.containers?.[cname];
  if (!c) return "";
  const ncpu = state.stats.ncpu || 1;
  const memBase = c.memLimit || state.stats.memTotal;
  return `<div class="cstats">
    <div><span class="lbl">CPU</span>${bar(c.cpu / ncpu)}<span class="val">${fmtPct(c.cpu)}</span></div>
    <div><span class="lbl">RAM</span>${bar(memBase ? (c.mem / memBase) * 100 : 0)}<span class="val">${fmtBytes(c.mem)}</span></div>
  </div>`;
}

function summaryHtml(p) {
  const st = state.stats?.projects?.[p.name];
  const svcs = Array.isArray(state.services[p.name]) ? state.services[p.name] : [];
  const ports = [...new Set(svcs.flatMap((s) => (s.ports || [])
    .filter((x) => x.PublishedPort).map((x) => `${x.PublishedPort}→${x.TargetPort}/${x.Protocol || "tcp"}`)))];
  const unhealthy = svcs.filter((s) => s.health && s.health !== "healthy").length;
  const images = [...new Set(svcs.map((s) => s.image))].length;
  if (!st) {
    return `<div class="summary muted">${state.stats ? "Nincs statisztika" : "Statisztika betöltése…"}</div>`;
  }
  const ncpu = state.stats.ncpu || 1;
  const memTotal = state.stats.memTotal || 0;
  const tile = (label, value, sub = "", extra = "") =>
    `<div class="tile"><span class="lbl">${label}</span><strong>${value}</strong>${extra}${sub ? `<span class="muted">${sub}</span>` : ""}</div>`;
  return `<div class="summary">
    <div class="tiles">
      ${tile("Konténerek", `${st.running}/${st.total}`, unhealthy ? `${unhealthy} nem healthy` : "fut")}
      ${tile("CPU", fmtPct(st.cpu), `${ncpu} magból (100% = 1 mag)`, bar(st.cpu / ncpu))}
      ${tile("RAM", fmtBytes(st.mem), memTotal ? `a host ${fmtPct((st.mem / memTotal) * 100)}-a` : "", bar(memTotal ? (st.mem / memTotal) * 100 : 0))}
      ${tile("Hálózat", `↓ ${fmtBytes(st.netRx)}`, `↑ ${fmtBytes(st.netTx)}`)}
      ${tile("Disk I/O", `R ${fmtBytes(st.blkRead)}`, `W ${fmtBytes(st.blkWrite)}`)}
      ${tile("Folyamatok", st.pids, `${images} image`)}
    </div>
    ${ports.length ? `<div class="kv"><span class="lbl">Portok</span> ${ports.map((x) => `<code>${esc(x)}</code>`).join(" ")}</div>` : ""}
    <div class="kv"><span class="lbl">Fájl</span> <code>${esc(p.configFiles.join(", "))}</code>${p.filesAvailable ? "" : ' <span class="muted">(nem elérhető a konténerből)</span>'}</div>
  </div>`;
}

function headStatsHtml(p) {
  const st = state.stats?.projects?.[p.name];
  if (!st || !st.running) return "";
  return `<span class="muted hstats">CPU ${fmtPct(st.cpu)} · RAM ${fmtBytes(st.mem)}</span>`;
}

// állapot szűrők: kulcs -> [felirat, mely projekt állapotok tartoznak bele]
const STATE_FILTERS = {
  all: ["Összes", null],
  running: ["Fut", ["running"]],
  starting: ["Indul", ["starting"]],
  problem: ["Hibás", ["unhealthy", "partial"]],
  stopped: ["Leállítva", ["stopped"]],
};

function renderChips(byName) {
  $("#chips").innerHTML = Object.entries(STATE_FILTERS).map(([key, [label, states]]) => {
    const count = states ? byName.filter((p) => states.includes(p.state)).length : byName.length;
    // az üres "Indul" / "Hibás" szűrőt elrejtjük, hacsak nem az az aktív
    if (!count && (key === "starting" || key === "problem") && state.stateFilter !== key) return "";
    return `<button class="chip ${key} ${state.stateFilter === key ? "active" : ""}" data-filter="${key}"
      role="tab" aria-selected="${state.stateFilter === key}">${label} <span>${count}</span></button>`;
  }).join("");
}

function searchedProjects() {
  const f = state.filter.toLowerCase();
  return state.projects.filter((p) => !f || p.name.toLowerCase().includes(f));
}

function visibleProjects() {
  const allowed = (STATE_FILTERS[state.stateFilter] || STATE_FILTERS.all)[1];
  return searchedProjects().filter((p) => !allowed || allowed.includes(p.state));
}

function render() {
  renderChips(searchedProjects());
  const list = visibleProjects();
  $("#expand-all").disabled = list.every((p) => state.open.has(p.name));
  $("#collapse-all").disabled = !state.projects.some((p) => state.open.has(p.name));
  if (!list.length) {
    $("#projects").innerHTML = `<p class="muted center">Nincs találat</p>`;
    return;
  }
  $("#projects").innerHTML = list.map((p) => {
    const busy = state.busy[p.name];
    const open = state.open.has(p.name);
    const out = state.output[p.name];
    const n = esc(p.name);
    const startTitle = p.filesAvailable ? "docker compose up -d" : "docker compose start (compose fájl nem elérhető)";
    return `<article class="card ${open ? "open" : ""}">
      <div class="card-head" data-act="toggle" data-name="${n}">
        <span class="dot ${busy ? "busy" : p.state}"></span>
        <div class="card-title">
          <strong>${n}${p.self ? " <span class='muted'>(ez az app)</span>" : ""}</strong>
          <span class="muted path">${esc(p.configFiles.join(", "))}</span>
          ${headStatsHtml(p)}
        </div>
        <span class="badge ${p.state}" title="${esc(p.status)}">${busy ? esc(busy) + "…" : esc(STATE_LABEL[p.state])} · ${esc(p.status.replace(/[a-z]+\((\d+)\)/g, "$1").replace(/,\s*/g, "/"))}</span>
        <span class="chev">›</span>
      </div>
      <div class="actions">
        <button class="btn start" data-act="start" data-name="${n}" title="${esc(startTitle)}" ${busy || p.state === "running" || p.state === "starting" ? "disabled" : ""}>▶ Start</button>
        <button class="btn stop" data-act="stop" data-name="${n}" ${busy || p.state === "stopped" || p.self ? "disabled" : ""}>■ Stop</button>
        <button class="btn restart" data-act="restart" data-name="${n}" ${busy || p.state === "stopped" ? "disabled" : ""}>↻ Restart</button>
        <button class="btn logs" data-act="logs" data-name="${n}">☰ Log</button>
      </div>
      ${out ? `<pre class="output ${out.ok ? "" : "err"}" data-act="clear-output" data-name="${n}">${esc(out.text)}</pre>` : ""}
      ${open ? summaryHtml(p) + serviceHtml(p) : ""}
    </article>`;
  }).join("");
}

// ------------------------------------------------------------------ műveletek
const CONFIRM = {
  stop: (n) => `Leállítod a(z) „${n}” projektet?`,
  restart: (n) => `Újraindítod a(z) „${n}” projektet?`,
};

async function doAction(name, action) {
  if (CONFIRM[action] && !confirm(CONFIRM[action](name))) return;
  state.busy[name] = action;
  delete state.output[name];
  render();
  try {
    const r = await api(`api/projects/${encodeURIComponent(name)}/${action}`, { method: "POST" });
    toast(`${name}: ${r.command} kész`);
    const text = r.output.trim();
    if (text) state.output[name] = { ok: true, text };
  } catch (e) {
    toast(`${name}: hiba`, true);
    state.output[name] = { ok: false, text: e.body?.output || e.message };
  } finally {
    delete state.busy[name];
    await loadProjects();
  }
}

function saveOpen() {
  localStorage.setItem("open", JSON.stringify([...state.open]));
}

async function expandAll() {
  const added = visibleProjects().map((p) => p.name).filter((n) => !state.open.has(n));
  added.forEach((n) => state.open.add(n));
  saveOpen();
  render();
  await Promise.all(added.map(loadServices));
  render();
}

function collapseAll() {
  state.open.clear();
  saveOpen();
  render();
}

async function toggle(name) {
  if (state.open.has(name)) state.open.delete(name);
  else { state.open.add(name); render(); await loadServices(name); }
  saveOpen();
  render();
}

// ------------------------------------------------------------------ log nézet
const log = { es: null, name: null, lines: 0, MAX: 5000 };

function colorize(line) {
  let html = esc(line);
  // "service-1  | ..." prefix kiemelése
  html = html.replace(/^([\w.-]+\s*\|)/, '<span class="lp">$1</span>');
  if (/\b(error|fatal|exception|panic|crit(ical)?)\b/i.test(line)) html = `<span class="le">${html}</span>`;
  else if (/\bwarn(ing)?\b/i.test(line)) html = `<span class="lw">${html}</span>`;
  return html;
}

function atBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

function startLogStream() {
  if (log.es) log.es.close();
  const out = $("#log-output");
  out.innerHTML = "";
  log.lines = 0;
  const params = new URLSearchParams({
    tail: $("#log-tail").value,
    follow: $("#log-follow").checked ? "true" : "false",
  });
  const svc = $("#log-service").value;
  if (svc) params.set("service", svc);
  $("#log-state").textContent = "kapcsolódás…";

  const es = new EventSource(`api/projects/${encodeURIComponent(log.name)}/logs?${params}`);
  log.es = es;
  let buf = [];
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    if (!buf.length) return;
    const stick = atBottom(out);
    out.insertAdjacentHTML("beforeend", buf.map(colorize).join("\n") + "\n");
    log.lines += buf.length;
    buf = [];
    // túl sok sor esetén a régieket eldobjuk
    if (log.lines > log.MAX) {
      const all = out.innerHTML.split("\n");
      out.innerHTML = all.slice(all.length - log.MAX).join("\n");
      log.lines = log.MAX;
    }
    if (stick) out.scrollTop = out.scrollHeight;
  };

  es.onopen = () => { $("#log-state").textContent = $("#log-follow").checked ? "élő" : ""; };
  es.onmessage = (ev) => {
    buf.push(JSON.parse(ev.data));
    if (!scheduled) { scheduled = true; requestAnimationFrame(flush); }
  };
  es.addEventListener("end", () => {
    flush();
    es.close();
    $("#log-state").textContent = "vége";
  });
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) $("#log-state").textContent = "megszakadt";
    else $("#log-state").textContent = "újrakapcsolódás…";
  };
}

async function openLogs(name, service = "") {
  log.name = name;
  $("#log-project").textContent = name;
  const sel = $("#log-service");
  sel.innerHTML = `<option value="">összes service</option>`;
  if (!state.services[name]) await loadServices(name);
  const svcs = Array.isArray(state.services[name]) ? state.services[name] : [];
  [...new Set(svcs.map((s) => s.service))].forEach((s) => {
    sel.insertAdjacentHTML("beforeend", `<option value="${esc(s)}">${esc(s)}</option>`);
  });
  sel.value = service;
  $("#logview").classList.remove("hidden");
  $("#logview").setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  history.pushState({ logs: name }, "");
  startLogStream();
}

function closeLogs(fromPopstate = false) {
  if (log.es) { log.es.close(); log.es = null; }
  $("#logview").classList.add("hidden");
  $("#logview").setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  if (!fromPopstate && history.state?.logs) history.back();
}

// ------------------------------------------------------------------ események
$("#projects").addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const { act, name, svc } = el.dataset;
  if (act === "toggle") toggle(name);
  else if (act === "logs") openLogs(name, svc || "");
  else if (act === "clear-output") { delete state.output[name]; render(); }
  else doAction(name, act);
});

$("#refresh").addEventListener("click", loadProjects);
$("#expand-all").addEventListener("click", expandAll);
$("#collapse-all").addEventListener("click", collapseAll);
$("#search").addEventListener("input", (e) => { state.filter = e.target.value; render(); });
$("#chips").addEventListener("click", (e) => {
  const b = e.target.closest("[data-filter]");
  if (!b) return;
  state.stateFilter = b.dataset.filter;
  localStorage.setItem("stateFilter", state.stateFilter);
  render();
});

$("#log-close").addEventListener("click", () => closeLogs());
$("#log-service").addEventListener("change", startLogStream);
$("#log-tail").addEventListener("change", startLogStream);
$("#log-follow").addEventListener("change", startLogStream);
$("#log-wrap").addEventListener("change", (e) => $("#log-output").classList.toggle("wrap", e.target.checked));
$("#log-output").classList.toggle("wrap", $("#log-wrap").checked);
$("#log-bottom").addEventListener("click", () => { const o = $("#log-output"); o.scrollTop = o.scrollHeight; });
// Android "vissza" gomb a log nézetet zárja be
window.addEventListener("popstate", () => {
  if (!$("#logview").classList.contains("hidden")) closeLogs(true);
});

// automatikus frissítés, csak ha látható az oldal
setInterval(() => {
  if (document.visibilityState === "visible" && $("#logview").classList.contains("hidden")
      && !Object.keys(state.busy).length) loadProjects();
}, REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") loadProjects();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

loadProjects();
