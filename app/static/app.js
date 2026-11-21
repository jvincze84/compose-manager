"use strict";

const $ = (s) => document.querySelector(s);
const REFRESH_MS = 10000;

const state = {
  projects: [],
  open: new Set(JSON.parse(localStorage.getItem("open") || "[]")),
  services: {},   // name -> [service]
  busy: {},       // name -> action
  output: {},     // name -> {ok, text}
  filter: "",
  stateFilter: localStorage.getItem("stateFilter") || "all",
  stats: null,    // /api/stats response
};

const STATE_LABEL = {
  running: "running", starting: "starting…", unhealthy: "unhealthy", partial: "partial", stopped: "stopped",
  absent: "no containers",
};
const FAST_REFRESH_MS = 2000; // while something is starting

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
  try { body = await r.json(); } catch { /* no json */ }
  if (!r.ok) {
    const msg = body?.detail || body?.output || `HTTP ${r.status}`;
    const e = new Error(msg); e.body = body; e.status = r.status; throw e;
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

// ------------------------------------------------------------------ loading
let statsLoading = false;
async function loadStats() {
  if (statsLoading) return;
  statsLoading = true;
  try {
    state.stats = await api("api/stats");
    render();
  } catch { /* stats are not critical */ }
  finally { statsLoading = false; }
}

// While a project is "starting", refresh more often so that the green
// status shows up as soon as it has really started.
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
    loadStats(); // in parallel, not awaited (~2 s)
    state.projects = await api("api/projects");
    await Promise.all([...state.open].map(loadServices));
    $("#updated").textContent = new Date().toLocaleTimeString();
    render();
  } catch (e) {
    $("#projects").innerHTML = `<p class="muted center">Error: ${esc(e.message)}</p>`;
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
  if (!svcs) return `<div class="services muted">Loading…</div>`;
  if (svcs.error) return `<div class="services muted">Error: ${esc(svcs.error)}</div>`;
  if (!svcs.length) return `<div class="services muted">No containers</div>`;
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

function stackInfoHtml(p) {
  const s = p.stack;
  const files = s.editable.map((f) =>
    `<button class="file-link" data-act="edit" data-name="${esc(p.name)}" data-file="${esc(f)}">✎ ${esc(f)}</button>`).join(" ");
  return `<div class="kv"><span class="lbl">Command</span> <code>docker ${esc(s.command)}</code></div>
    <div class="kv"><span class="lbl">Files</span> ${files}</div>
    <div class="kv"><span class="lbl">Source</span> ${s.runFile
      ? `<code>${esc(s.runFile)}</code>`
      : '<span class="muted">no run-*.cmd – default settings</span>'}</div>`;
}

function summaryHtml(p) {
  if (p.state === "absent") {
    return `<div class="summary"><p class="muted">The project has no containers (after down, or never started). Start it with ⬆ Up.</p>${stackInfoHtml(p)}</div>`;
  }
  const st = state.stats?.projects?.[p.name];
  const svcs = Array.isArray(state.services[p.name]) ? state.services[p.name] : [];
  const ports = [...new Set(svcs.flatMap((s) => (s.ports || [])
    .filter((x) => x.PublishedPort).map((x) => `${x.PublishedPort}→${x.TargetPort}/${x.Protocol || "tcp"}`)))];
  const unhealthy = svcs.filter((s) => s.health && s.health !== "healthy").length;
  const images = [...new Set(svcs.map((s) => s.image))].length;
  if (!st) {
    return `<div class="summary"><p class="muted">${state.stats ? "No statistics" : "Loading statistics…"}</p>${p.stack ? stackInfoHtml(p) : ""}</div>`;
  }
  const ncpu = state.stats.ncpu || 1;
  const memTotal = state.stats.memTotal || 0;
  const tile = (label, value, sub = "", extra = "") =>
    `<div class="tile"><span class="lbl">${label}</span><strong>${value}</strong>${extra}${sub ? `<span class="muted">${sub}</span>` : ""}</div>`;
  return `<div class="summary">
    <div class="tiles">
      ${tile("Containers", `${st.running}/${st.total}`, unhealthy ? `${unhealthy} not healthy` : "running")}
      ${tile("CPU", fmtPct(st.cpu), `of ${ncpu} cores (100% = 1 core)`, bar(st.cpu / ncpu))}
      ${tile("RAM", fmtBytes(st.mem), memTotal ? `${fmtPct((st.mem / memTotal) * 100)} of host` : "", bar(memTotal ? (st.mem / memTotal) * 100 : 0))}
      ${tile("Network", `↓ ${fmtBytes(st.netRx)}`, `↑ ${fmtBytes(st.netTx)}`)}
      ${tile("Disk I/O", `R ${fmtBytes(st.blkRead)}`, `W ${fmtBytes(st.blkWrite)}`)}
      ${tile("Processes", st.pids, `${images} image${images === 1 ? "" : "s"}`)}
    </div>
    ${ports.length ? `<div class="kv"><span class="lbl">Ports</span> ${ports.map((x) => `<code>${esc(x)}</code>`).join(" ")}</div>` : ""}
    ${p.stack ? stackInfoHtml(p) : `<div class="kv"><span class="lbl">File</span> <code>${esc(p.configFiles.join(", "))}</code>${p.filesAvailable ? "" : ' <span class="muted">(not reachable from the container)</span>'}</div>`}
  </div>`;
}

function headStatsHtml(p) {
  const st = state.stats?.projects?.[p.name];
  if (!st || !st.running) return "";
  return `<span class="muted hstats">CPU ${fmtPct(st.cpu)} · RAM ${fmtBytes(st.mem)}</span>`;
}

// state filters: key -> [label, project states it includes]
const STATE_FILTERS = {
  all: ["All", null],
  running: ["Running", ["running"]],
  starting: ["Starting", ["starting"]],
  problem: ["Problem", ["unhealthy", "partial"]],
  stopped: ["Stopped", ["stopped", "absent"]],
};

function renderChips(byName) {
  $("#chips").innerHTML = Object.entries(STATE_FILTERS).map(([key, [label, states]]) => {
    const count = states ? byName.filter((p) => states.includes(p.state)).length : byName.length;
    // hide the empty "Starting" / "Problem" filters unless active
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
    $("#projects").innerHTML = `<p class="muted center">No matches</p>`;
    return;
  }
  const scroll = {};  // running output: keep scroll position / stick to the bottom
  document.querySelectorAll(".outbox.running .outbox-body").forEach((el) => {
    scroll[el.dataset.name] = atBottom(el) ? -1 : el.scrollTop;
  });
  requestAnimationFrame(() => document.querySelectorAll(".outbox.running .outbox-body").forEach((el) => {
    const s = scroll[el.dataset.name];
    el.scrollTop = s === undefined || s === -1 ? el.scrollHeight : s;
  }));
  $("#projects").innerHTML = list.map((p) => {
    const busy = state.busy[p.name];
    const open = state.open.has(p.name);
    const out = state.output[p.name];
    const n = esc(p.name);
    const absent = p.state === "absent";
    const startTitle = p.stack ? "docker compose start"
      : p.filesAvailable ? "docker compose up -d" : "docker compose start (compose file not reachable)";
    const badgeCount = p.status ? " · " + esc(p.status.replace(/[a-z]+\((\d+)\)/g, "$1").replace(/,\s*/g, "/")) : "";
    return `<article class="card ${open ? "open" : ""}">
      <div class="card-head" data-act="toggle" data-name="${n}">
        <span class="dot ${busy ? "busy" : p.state}"></span>
        <div class="card-title">
          <strong>${n}${p.self ? " <span class='muted'>(this app)</span>" : ""}</strong>
          <span class="muted path">${esc(p.configFiles.join(", "))}</span>
          ${headStatsHtml(p)}
        </div>
        <span class="badge ${p.state}" title="${esc(p.status)}">${busy ? esc(busy) + "…" : esc(STATE_LABEL[p.state])}${badgeCount}</span>
        <span class="chev">›</span>
      </div>
      <div class="actions">
        <button class="btn start" data-act="start" data-name="${n}" title="${esc(startTitle)}" ${busy || absent || p.state === "running" || p.state === "starting" ? "disabled" : ""}>▶ Start</button>
        <button class="btn stop" data-act="stop" data-name="${n}" ${busy || absent || p.state === "stopped" || p.self ? "disabled" : ""}>■ Stop</button>
        <button class="btn restart" data-act="restart" data-name="${n}" ${busy || absent || p.state === "stopped" ? "disabled" : ""}>↻ Restart</button>
        <button class="btn logs" data-act="logs" data-name="${n}" ${absent ? "disabled" : ""}>☰ Log</button>
      </div>
      ${p.stack ? `<div class="actions stack-actions">
        <button class="btn up" data-act="up" data-name="${n}" title="${esc("docker " + p.stack.command + " up -d --remove-orphans")}" ${busy ? "disabled" : ""}>⬆ Up</button>
        <button class="btn down" data-act="down" data-name="${n}" title="${esc("docker " + p.stack.command + " down --remove-orphans")}" ${busy || absent || p.self ? "disabled" : ""}>⬇ Down</button>
        <button class="btn pull" data-act="pull" data-name="${n}" title="docker compose pull, then down + up -d" ${busy || p.self ? "disabled" : ""}>⤓ Pull</button>
        <button class="btn edit" data-act="edit" data-name="${n}">✎ Edit</button>
      </div>` : ""}
      ${out ? `<div class="outbox ${out.running ? "running" : out.ok ? "ok" : "err"} ${out.collapsed ? "collapsed" : ""}">
        <div class="outbox-head" data-act="out-toggle" data-name="${n}">
          <span class="outbox-title">${out.running ? "⏳" : out.ok ? "✓" : "✗"} ${esc(out.title || "output")}</span>
          <button class="outbox-btn" data-act="out-toggle" data-name="${n}" title="Collapse / expand">${out.collapsed ? "▸" : "▾"}</button>
          <button class="outbox-btn" data-act="clear-output" data-name="${n}" title="Close" aria-label="Close">✕</button>
        </div>
        <pre class="outbox-body" data-name="${n}">${esc(out.text)}</pre>
      </div>` : ""}
      ${open ? summaryHtml(p) + serviceHtml(p) : ""}
    </article>`;
  }).join("");
}

// ------------------------------------------------------------------ actions
const CONFIRM = {
  stop: (n) => `Stop project "${n}"?`,
  restart: (n) => `Restart project "${n}"?`,
  pull: (n) => `Pull: download new images for "${n}", then down + up -d.\nThe service is briefly down (it keeps running during the download).`,
  down: (n) => `docker compose down: stop and REMOVE the containers and networks of "${n}"?\n(Volumes and the ./data directory are kept.)`,
};

async function doAction(name, action) {
  if (CONFIRM[action] && !confirm(CONFIRM[action](name))) return;
  if (action === "pull") return doPull(name);
  state.busy[name] = action;
  delete state.output[name];
  render();
  try {
    const r = await api(`api/projects/${encodeURIComponent(name)}/${action}`, { method: "POST" });
    toast(`${name}: ${r.command} done`);
    const text = r.output.trim();
    if (text) state.output[name] = { ok: true, text, title: r.command };
  } catch (e) {
    toast(`${name}: error`, true);
    state.output[name] = { ok: false, text: e.body?.output || e.message, title: `${action}: error` };
  } finally {
    delete state.busy[name];
    await loadProjects();
  }
}

// pull -> down -> up: NDJSON stream, live output on the card
async function doPull(name) {
  state.busy[name] = "pull";
  const out = state.output[name] = { ok: true, running: true, title: "pull → down → up -d", text: "" };
  const lines = [];
  let raf = 0;
  const push = (l) => {
    lines.push(l);
    if (lines.length > 400) lines.splice(0, lines.length - 400);
    out.text = lines.join("\n");
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); });
  };
  render();
  let done = null;
  try {
    const r = await fetch(`api/projects/${encodeURIComponent(name)}/pull`, { method: "POST" });
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { msg = (await r.json()).detail || msg; } catch { /* no json */ }
      throw new Error(msg);
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!raw.trim()) continue;
        const m = JSON.parse(raw);
        if (m.step) { out.title = `pull → down → up -d · ${m.step}…`; push(`── ${m.step} ──`); }
        else if (m.line !== undefined) push(m.line);
        else if (m.done) done = m;
      }
    }
    if (!done) throw new Error("Connection lost – the job keeps running on the server, refresh later.");
    out.ok = done.ok;
    out.title = done.ok ? "pull → down → up -d done" : "pull → down → up -d: error";
    toast(`${name}: pull ${done.ok ? "done" : "error"}`, !done.ok);
  } catch (e) {
    out.ok = false;
    out.title = "pull: error";
    push(e.message);
    toast(`${name}: pull error`, true);
  } finally {
    out.running = false;
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

// ------------------------------------------------------------------ log view
const log = { es: null, name: null, lines: 0, MAX: 5000 };

function colorize(line) {
  let html = esc(line);
  // highlight the "service-1  | ..." prefix
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
  $("#log-state").textContent = "connecting…";

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
    // drop old lines when there are too many
    if (log.lines > log.MAX) {
      const all = out.innerHTML.split("\n");
      out.innerHTML = all.slice(all.length - log.MAX).join("\n");
      log.lines = log.MAX;
    }
    if (stick) out.scrollTop = out.scrollHeight;
  };

  es.onopen = () => { $("#log-state").textContent = $("#log-follow").checked ? "live" : ""; };
  es.onmessage = (ev) => {
    buf.push(JSON.parse(ev.data));
    if (!scheduled) { scheduled = true; requestAnimationFrame(flush); }
  };
  es.addEventListener("end", () => {
    flush();
    es.close();
    $("#log-state").textContent = "ended";
  });
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) $("#log-state").textContent = "disconnected";
    else $("#log-state").textContent = "reconnecting…";
  };
}

async function openLogs(name, service = "") {
  log.name = name;
  $("#log-project").textContent = name;
  const sel = $("#log-service");
  sel.innerHTML = `<option value="">all services</option>`;
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


// The editor (openEditor, openFileEditor, ...) lives in files.js.

// ------------------------------------------------------------------ events
$("#projects").addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  if (el.disabled) return;
  const { act, name, svc, file } = el.dataset;
  if (act === "toggle") toggle(name);
  else if (act === "edit") openEditor(name, file);
  else if (act === "logs") openLogs(name, svc || "");
  else if (act === "clear-output") { delete state.output[name]; render(); }
  else if (act === "out-toggle") {
    if (state.output[name]) state.output[name].collapsed = !state.output[name].collapsed;
    render();
  }
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
// the Android "back" button closes the log view / editor
window.addEventListener("popstate", () => {
  if (!$("#logview").classList.contains("hidden")) closeLogs(true);
  else if (!$("#editor").classList.contains("hidden")) editorPopstate();
});

// auto refresh, only while the page is visible
setInterval(() => {
  if (document.visibilityState === "visible" && $("#logview").classList.contains("hidden")
      && $("#editor").classList.contains("hidden") && !Object.keys(state.busy).length) loadProjects();
}, REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") loadProjects();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

loadProjects();
