"use strict";
// Exec view: a shell in a container (docker exec -it) on the Term emulator (term.js).
// Output: SSE /api/exec/{id}/stream; keystrokes: POST /api/exec/{id}/input (ordered,
// coalesced while a request is in flight). Uses the globals of app.js ($, api, esc, toast).

const ex = {
  term: null, sid: null, es: null, project: null, container: null,
  out: "", sending: false, resizeTimer: 0,
};
const TERM_FONT_KEY = "termFont";
const TERM_SHELL_KEY = "termShell";  // auto | bash | sh
const TERM_ROOT_KEY = "termRoot";    // "1" = docker exec -u 0
const TERM_FONTS = [11, 12, 13, 14, 15, 16, 18];

function execTerm() {
  if (ex.term) return ex.term;
  const size = +localStorage.getItem(TERM_FONT_KEY) || (matchMedia("(max-width: 720px)").matches ? 12 : 14);
  $("#term").style.setProperty("--term-size", `${size}px`);
  ex.term = new Term($("#term"), {
    onData: execSend,
    onResize: (cols, rows) => {
      clearTimeout(ex.resizeTimer);
      ex.resizeTimer = setTimeout(() => {
        if (ex.sid) fetch(`api/exec/${ex.sid}/resize`, jsonPost({ cols, rows })).catch(() => {});
      }, 150);
    },
    onCtrl: (on) => $("#term-keys [data-key=ctrl]").classList.toggle("active", on),
  });
  return ex.term;
}

// jsonPost() comes from files.js (all scripts share one global scope: never redeclare!)

function execState(text) { $("#term-state").textContent = text; }

async function openExec(project, container) {
  ex.project = project;
  ex.container = container;
  $("#term-title").textContent = container;
  $("#term-project").textContent = project;
  const view = $("#termview");
  view.classList.remove("hidden");
  view.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  if (!history.state?.exec) history.pushState({ exec: true }, "");
  execViewport();
  const term = execTerm();
  term.fit();
  await execConnect();
}

async function execConnect() {
  const term = execTerm();
  execDisconnect();
  term.reset();
  term.fit();
  $("#term-reconnect").classList.add("hidden");
  execState("connecting…");
  let r;
  try {
    r = await api(`api/projects/${encodeURIComponent(ex.project)}/containers/${encodeURIComponent(ex.container)}/exec`,
      jsonPost({ cols: term.cols, rows: term.rows, shell: $("#term-shell").value, root: execRoot() }));
  } catch (e) {
    term.write(`\x1b[31m${e.message}\x1b[0m\r\n`);
    execState("error");
    $("#term-reconnect").classList.remove("hidden");
    return;
  }
  ex.sid = r.id;
  $("#term-title").textContent = `${r.container}${r.root ? " (root)" : ""}`;
  const es = new EventSource(`api/exec/${r.id}/stream`);
  ex.es = es;
  es.onopen = () => execState("connected");
  es.onmessage = (ev) => term.write(JSON.parse(ev.data));
  es.addEventListener("end", (ev) => {
    es.close();
    if (ex.es !== es) return;
    const code = JSON.parse(ev.data || "null");
    term.write(`\r\n\x1b[2m[shell exited${code !== null ? ` with code ${code}` : ""}]\x1b[0m\r\n`);
    execState("exited");
    ex.sid = null;
    ex.es = null;
    $("#term-reconnect").classList.remove("hidden");
  });
  es.onerror = () => {
    if (ex.es !== es) return;
    if (es.readyState === EventSource.CLOSED) {
      execState("disconnected");
      ex.sid = null;
      $("#term-reconnect").classList.remove("hidden");
    } else execState("reconnecting…");
  };
  term.focus();
}

function execDisconnect() {
  if (ex.es) { ex.es.close(); ex.es = null; }
  if (ex.sid) { fetch(`api/exec/${ex.sid}/close`, { method: "POST" }).catch(() => {}); ex.sid = null; }
  ex.out = "";
}

function execSend(data) {
  if (!ex.sid) return;
  ex.out += data;
  execFlush();
}

async function execFlush() {
  if (ex.sending || !ex.out || !ex.sid) return;
  ex.sending = true;
  const data = ex.out;
  ex.out = "";
  try {
    const r = await fetch(`api/exec/${ex.sid}/input`, jsonPost({ data }));
    if (r.status === 404) execState("session closed");
  } catch {
    execState("send failed");
  } finally {
    ex.sending = false;
    if (ex.out) execFlush();
  }
}

function closeExec(fromPopstate = false) {
  execDisconnect();
  const view = $("#termview");
  view.classList.add("hidden");
  view.setAttribute("aria-hidden", "true");
  view.style.height = "";
  view.style.top = "";
  document.body.style.overflow = "";
  if (!fromPopstate && history.state?.exec) history.back();
}

// phones: the on-screen keyboard only shrinks the visual viewport -> size the view to it
function execViewport() {
  const vv = window.visualViewport;
  const view = $("#termview");
  if (!vv || view.classList.contains("hidden")) return;
  view.style.height = `${vv.height}px`;
  view.style.top = `${vv.offsetTop}px`;
}
window.visualViewport?.addEventListener("resize", execViewport);
window.visualViewport?.addEventListener("scroll", execViewport);

// key bar (phones): keys the on-screen keyboard lacks. pointerdown is cancelled so the
// input keeps the focus (and the keyboard stays open).
const TERM_KEYS = {
  esc: "\x1b", tab: "\t", up: ["\x1b[A", "\x1bOA"], down: ["\x1b[B", "\x1bOB"],
  right: ["\x1b[C", "\x1bOC"], left: ["\x1b[D", "\x1bOD"], "ctrl-c": "\x03", "ctrl-d": "\x04",
  pipe: "|", tilde: "~", slash: "/", dash: "-",
};
$("#term-keys").addEventListener("pointerdown", (e) => { if (e.target.closest("[data-key]")) e.preventDefault(); });
$("#term-keys").addEventListener("click", (e) => {
  const b = e.target.closest("[data-key]");
  if (!b || !ex.term) return;
  const k = b.dataset.key;
  if (k === "ctrl") ex.term.setCtrl(!ex.term.ctrlOnce);
  else if (k === "font-down" || k === "font-up") execFont(k === "font-up" ? 1 : -1);
  else if (k === "paste") {
    // needs a secure context (HTTPS / localhost) and the user's permission
    navigator.clipboard?.readText().then((t) => { if (t) ex.term.paste(t); })
      .catch(() => toast("Clipboard not available (HTTPS + permission needed)", true));
    if (!navigator.clipboard) toast("Clipboard not available (HTTPS needed)", true);
  } else {
    const seq = TERM_KEYS[k];
    ex.term.send(Array.isArray(seq) ? seq[ex.term.modes.appCursor ? 1 : 0] : seq);
  }
  ex.term.focus();
});

function execFont(step) {
  const term = execTerm();
  const cur = parseInt(getComputedStyle($("#term")).getPropertyValue("--term-size"), 10) || 13;
  const i = TERM_FONTS.findIndex((f) => f >= cur);
  const next = TERM_FONTS[Math.max(0, Math.min(TERM_FONTS.length - 1, (i < 0 ? TERM_FONTS.length - 1 : i) + step))];
  $("#term").style.setProperty("--term-size", `${next}px`);
  localStorage.setItem(TERM_FONT_KEY, next);
  requestAnimationFrame(() => term.fit());
}

const execRoot = () => $("#term-root").getAttribute("aria-pressed") === "true";
function execSetRoot(on) {
  $("#term-root").setAttribute("aria-pressed", String(on));
  $("#term-root").classList.toggle("active", on);
}
$("#term-shell").value = localStorage.getItem(TERM_SHELL_KEY) || "auto";
execSetRoot(localStorage.getItem(TERM_ROOT_KEY) === "1");
$("#term-shell").addEventListener("change", (e) => {
  localStorage.setItem(TERM_SHELL_KEY, e.target.value);
  execConnect();
});
$("#term-root").addEventListener("click", () => {
  execSetRoot(!execRoot());
  localStorage.setItem(TERM_ROOT_KEY, execRoot() ? "1" : "");
  execConnect();
});
$("#term-close").addEventListener("click", () => closeExec());
$("#term-reconnect").addEventListener("click", () => execConnect());
// closing the tab / app: end the shell right away (otherwise after EXEC_IDLE_SEC)
window.addEventListener("pagehide", () => {
  if (ex.sid) navigator.sendBeacon(`api/exec/${ex.sid}/close`);
});
