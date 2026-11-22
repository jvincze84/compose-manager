"use strict";
// Editor + file browser for COMPOSE_DIR (uses the global helpers of app.js:
// $, api, esc, toast, fmtBytes, state, render, loadProjects).
//  - openFileEditor(): "Editor" button – with the file browser
//  - openEditor(project, file): card "Edit" button – with the project's files
// Before every save the server makes a backup (.compose-manager-backup); the original is kept forever.

const ed = {
  project: null,  // stack project (opened from a card) or null
  path: null,     // open file (relative to COMPOSE_DIR)
  info: null,     // /api/fs/file response
  hash: "", orig: "", eol: "lf",
  busy: false,
  backup: null,   // id of the backup loaded into the editor
  dir: localStorage.getItem("edDir") || "",
  entries: [],
};
const edText = $("#ed-text");
const cm = CodeEditor.create($("#ed-code"), edText);
cm.onCursor = (line, col) => { $("#ed-pos").textContent = `${line}:${col}`; };
const WIDE = window.matchMedia("(min-width: 900px)");
const qs = (o) => new URLSearchParams(o).toString();
const edDirty = () => ed.path !== null && !!ed.info?.editable && edText.value !== ed.orig;

$("#ed-mode").innerHTML = Object.entries(CodeEditor.MODES)
  .map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");

const fmtTime = (t) => new Date(t * 1000).toLocaleString(undefined, {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});
function fmtAgo(t) {
  const s = Date.now() / 1000 - t;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

// ------------------------------------------------------------------ state / output
function edUpdate() {
  const dirty = edDirty();
  const ro = !ed.info || !ed.info.editable;
  $("#ed-state").textContent = ed.busy ? "…" : !ed.path ? "" : ro ? "🔒 read-only"
    : ed.backup && dirty ? "🕘 previous version – not saved" : dirty ? "● modified" : "saved";
  $("#ed-state").classList.toggle("dirty", dirty);
  $("#ed-save").disabled = ed.busy || ro || !dirty;
  $("#ed-check").disabled = ed.busy || !ed.path || ro;
  $("#ed-history").disabled = !ed.path;
  $("#ed-find-btn").disabled = !ed.path;
  findRepAvailable();
  const stacks = ed.info?.stacks || [];
  $("#ed-save-up").classList.toggle("hidden", !stacks.length || ro);
  $("#ed-save-up").disabled = ed.busy;
  $("#ed-save-up").title = stacks.length ? `Save, then docker compose up -d: ${upTarget()}` : "";
}

const upTarget = () => {
  const stacks = ed.info?.stacks || [];
  return stacks.includes(ed.project) ? ed.project : stacks[0];
};

// output panel; kind: "" | ok | err | diff
function edOutput(text, kind = "", title = "", line = 0) {
  const o = $("#ed-output");
  const body = o.querySelector(".outbox-body");
  if (kind === "diff") {
    body.innerHTML = text.split("\n").map((l) => {
      const cls = /^(\+\+\+|---)/.test(l) ? "d-file" : l[0] === "+" ? "d-add" : l[0] === "-" ? "d-del" : l.startsWith("@@") ? "d-hunk" : "";
      return cls ? `<span class="${cls}">${esc(l)}</span>` : esc(l);
    }).join("\n");
  } else body.textContent = text || "";
  o.querySelector(".outbox-title").textContent = title || (kind === "err" ? "✗ Error" : kind === "ok" ? "✓ Done" : "Output");
  o.className = `outbox ed-output ${kind}${text ? "" : " hidden"}`;
  o.querySelector("[data-out=toggle]").textContent = "▾";
  cm.setError(line);
  o.dataset.line = line || "";
}

// ------------------------------------------------------------------ open / close
function showEditor() {
  if (!$("#editor").classList.contains("hidden")) return;
  $("#editor").classList.remove("hidden");
  $("#editor").setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  history.pushState({ editor: true }, "");
}

// "Editor" button: with the file browser, reopening the last dir / file
async function openFileEditor() {
  ed.project = null;
  $("#ed-title").textContent = "Editor";
  $("#ed-file").classList.add("hidden");
  showEditor();
  treeShow(true);
  await treeLoad(ed.dir);
  const last = localStorage.getItem("edFile");
  if (!ed.path && last && WIDE.matches) edOpen(last, true);
  else if (!ed.path) edEmpty();
}

// card "Edit" button: the project's files in the quick select, browser available too
async function openEditor(name, file) {
  const p = state.projects.find((x) => x.name === name);
  if (!p?.stack) return;
  ed.project = name;
  $("#ed-title").textContent = name;
  const sel = $("#ed-file");
  sel.innerHTML = p.stack.editable.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join("");
  sel.classList.remove("hidden");
  showEditor();
  treeShow(WIDE.matches);
  await edOpen(file || p.stack.editable[0]);
  const path = ed.path || "";
  treeLoad(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
}

function edEmpty() {
  ed.path = null; ed.info = null;
  $("#ed-empty").classList.remove("hidden");
  $("#ed-code").classList.add("hidden");
  $("#ed-path").textContent = "";
  findClose(false);
  edOutput("");
  edUpdate();
}

async function edOpen(path, quiet = false) {
  if (edDirty() && !confirm("Unsaved changes – discard them?")) {
    $("#ed-file").value = ed.path || "";
    return;
  }
  ed.busy = true; edUpdate();
  try {
    const r = await api(`api/fs/file?${qs({ path })}`);
    ed.path = r.path; ed.info = r; ed.hash = r.hash; ed.orig = r.content; ed.eol = r.eol; ed.backup = null;
    localStorage.setItem("edFile", r.path);
    $("#ed-empty").classList.add("hidden");
    $("#ed-code").classList.remove("hidden");
    $("#ed-backups").classList.add("hidden");
    $("#ed-path").textContent = r.abs;
    $("#ed-path").title = r.abs;
    if ([...$("#ed-file").options].some((o) => o.value === r.path)) $("#ed-file").value = r.path;
    const name = r.path.split("/").pop();
    const mode = CodeEditor.modeFor(name);
    $("#ed-mode").value = mode;
    cm.setMode(mode);
    cm.setIndent(CodeEditor.detectIndent(r.content, mode));
    cm.setReadOnly(!r.editable);
    edText.value = r.content;
    edText.scrollTop = 0; edText.scrollLeft = 0;
    cm.refresh();
    if (r.binary) edOutput("Binary file – cannot be displayed.", "", "🔒 Binary");
    else if (r.tooLarge) edOutput(`The file is too large (${fmtBytes(r.size)}) to display.`, "", "🔒 Too large");
    else if (r.encodingError) edOutput("The file is not UTF-8 encoded – read-only.", "", "🔒 Encoding");
    else if (!r.editable) edOutput("This file type is not editable by configuration (EDIT_EXTENSIONS / EDIT_FILENAMES) – read-only.", "", "🔒 Read-only");
    else edOutput("");
    if (!WIDE.matches) treeShow(false);
    treeRender();
  } catch (e) {
    if (!quiet) edOutput(`Could not open: ${e.message}`, "err");
    else edEmpty();
  } finally {
    ed.busy = false; edUpdate();
  }
}

function closeEditor(fromPopstate = false) {
  if (!fromPopstate && edDirty() && !confirm("Unsaved changes – leave without saving?")) return;
  ed.path = null; ed.info = null;
  findClose(false);
  $("#editor").classList.add("hidden");
  $("#editor").setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  if (!fromPopstate && history.state?.editor) history.back();
}

// Android "back" button (called from the popstate handler in app.js)
function editorPopstate() {
  if (!WIDE.matches && !$("#ed-tree").classList.contains("hidden") && ed.path) {
    treeShow(false);  // on phones close the file list first
    history.pushState({ editor: true }, "");
  } else if (edDirty() && !confirm("Unsaved changes – leave without saving?")) {
    history.pushState({ editor: true }, "");
  } else closeEditor(true);
}

// ------------------------------------------------------------------ file browser
function treeShow(on) {
  $("#ed-tree").classList.toggle("hidden", !on);
  $("#ed-tree-btn").classList.toggle("active", on);
}

async function treeLoad(dir) {
  const list = $("#tree-list");
  list.innerHTML = `<p class="muted pad">Loading…</p>`;
  try {
    const r = await api(`api/fs/list?${qs({ path: dir })}`);
    ed.dir = r.path;
    ed.entries = r.entries;
    ed.truncated = r.truncated;
    ed.root = r.root;
    localStorage.setItem("edDir", ed.dir);
    $("#tree-filter").value = "";
    treeRender();
  } catch (e) {
    if (dir) return treeLoad("");  // e.g. deleted directory -> root
    list.innerHTML = `<p class="muted pad">Error: ${esc(e.message)}</p>`;
  }
}

function treeRender() {
  const root = ed.root || "";
  const parts = ed.dir ? ed.dir.split("/") : [];
  $("#tree-crumbs").innerHTML = `<button data-dir="">${esc(root || "/")}</button>` +
    parts.map((p, i) => `<span>/</span><button data-dir="${esc(parts.slice(0, i + 1).join("/"))}">${esc(p)}</button>`).join("");
  const f = $("#tree-filter").value.toLowerCase();
  const onlyEdit = $("#tree-only-edit").checked;
  const rows = ed.entries.filter((e) => (!f || e.name.toLowerCase().includes(f)) && (!onlyEdit || e.type === "dir" || e.editable));
  const prefix = ed.dir ? ed.dir + "/" : "";
  let html = ed.dir ? `<button class="tr dir" data-dir="${esc(parts.slice(0, -1).join("/"))}"><span class="ic">↰</span><span class="nm">..</span></button>` : "";
  html += rows.map((e) => {
    const path = prefix + e.name;
    const icon = e.type === "dir" ? "📁" : e.editable ? "📝" : "📄";
    const meta = e.type === "dir" ? "" : e.size !== null ? fmtBytes(e.size) : "";
    const cls = `tr ${e.type} ${e.editable ? "editable" : ""} ${e.outside ? "outside" : ""} ${path === ed.path ? "active" : ""}`;
    const attr = e.outside ? "disabled title='Points outside the directory'"
      : e.type === "dir" ? `data-dir="${esc(path)}"` : `data-file="${esc(path)}"`;
    return `<button class="${cls}" ${attr}><span class="ic">${icon}</span><span class="nm">${esc(e.name)}${e.link ? " ↪" : ""}</span><span class="mt">${meta}</span></button>`;
  }).join("");
  if (!rows.length) html += `<p class="muted pad">${f ? "No matches" : "Empty directory"}</p>`;
  if (ed.truncated) html += `<p class="muted pad">Only the first ${ed.entries.length} entries are shown.</p>`;
  $("#tree-list").innerHTML = html;
}

// new file in the current directory (only whitelisted types, never overwrites)
async function newFile() {
  if (edDirty() && !confirm("Unsaved changes – discard them?")) return;
  const where = (ed.root || "") + (ed.dir ? "/" + ed.dir : "");
  const name = (prompt(`New file in ${where}\n\nFile name (e.g. docker-compose-myapp.yaml, .env-myapp, haproxy.cfg):`) || "").trim();
  if (!name) return;
  try {
    const r = await api("api/fs/new", jsonPost({ dir: ed.dir, name }));
    toast(`${name} created`);
    await treeLoad(ed.dir);
    ed.info = null;  // the dirty check was answered above
    await edOpen(r.path);
    if (/^docker-compose-.+\.ya?ml$/.test(name) && !ed.dir) loadProjects();  // new stack
  } catch (e) {
    alert(`Could not create ${name}:\n${e.message}`);
  }
}

// ------------------------------------------------------------------ save / check / up
const jsonPost = (body, method = "POST") => ({
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

async function edSave(thenUp = false, force = false) {
  if (!ed.path || ed.busy || !ed.info?.editable) return;
  const content = edText.value;
  let saved = !edDirty() && !force;
  ed.busy = true; edUpdate();
  try {
    if (!saved) {
      const r = await api("api/fs/file", jsonPost({ path: ed.path, content, hash: ed.hash, force, eol: ed.eol }, "PUT"));
      ed.orig = content; ed.hash = r.hash; ed.backup = null; saved = true;
      toast(`${ed.path.split("/").pop()} saved`);
      if (r.output) edOutput(r.output, "err", "✗ Saved – but validation reports an error", r.line);
      else edOutput("");
      if (!$("#ed-backups").classList.contains("hidden")) edBackups();
    }
  } catch (e) {
    if (e.status === 422 && e.body?.invalid) {
      edOutput(e.body.output, "err", "✗ Validation error – not saved", e.body.line);
      ed.busy = false; edUpdate();
      if (confirm("Validation reported an error (see below). Save anyway?")) return edSave(thenUp, true);
      return;
    }
    edOutput(e.status === 409 ? `${e.message}\n(Reopen the file to get the current content – your changes will be lost.)` : `Save error: ${e.message}`, "err");
  } finally {
    ed.busy = false; edUpdate();
  }
  if (saved && thenUp) await edUp();
}

async function edUp() {
  const name = upTarget();
  if (!name) return;
  ed.busy = true; edUpdate();
  state.busy[name] = "up"; render();
  edOutput(`docker compose up -d – ${name}…`, "", "⏳ up -d");
  try {
    const r = await api(`api/projects/${encodeURIComponent(name)}/up`, { method: "POST" });
    edOutput(r.output.trim() || "up -d done", "ok", `✓ ${name}: up -d done`);
    toast(`${name}: up -d done`);
  } catch (e) {
    edOutput(e.body?.output || e.message, "err", `✗ ${name}: up -d error`);
    toast(`${name}: error`, true);
  } finally {
    delete state.busy[name];
    ed.busy = false; edUpdate();
    loadProjects();
  }
}

async function edCheck() {
  if (!ed.path || ed.busy) return;
  ed.busy = true; edUpdate();
  try {
    const r = await api("api/fs/validate", jsonPost({ path: ed.path, content: edText.value }));
    if (!r.checked) edOutput("No validation for this file type (YAML, JSON and compose / env files can be checked).", "", "Check");
    else if (r.ok) edOutput(ed.info.stacks.length ? "docker compose config: OK" : "Syntax OK", "ok", "✓ Valid");
    else edOutput(r.output, "err", "✗ Invalid", r.line);
  } catch (e) {
    edOutput(e.message, "err", "✗ Validation error");
  } finally {
    ed.busy = false; edUpdate();
  }
}

// ------------------------------------------------------------------ previous versions
async function edBackups() {
  if (!ed.path) return;
  const list = $("#ed-backups-list");
  $("#ed-backups").classList.remove("hidden");
  list.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const r = await api(`api/fs/backups?${qs({ path: ed.path })}`);
    $("#ed-backups-info").textContent = `last ${r.keep} saves + the original`;
    const row = (b) => `<div class="bk-row">
        <button class="bk ${b.original ? "original" : ""} ${ed.backup === b.id ? "active" : ""}" data-bk="${esc(b.id)}"
          title="${b.original ? "Content before the first save (earliest known) – never deleted" : `Content of the file before the save at ${esc(fmtTime(b.time))}`}">
          <strong>${b.original ? "⭐ Original" : esc(fmtTime(b.time))}</strong>
          <span class="muted">${b.original ? esc(fmtTime(b.time)) + " · " : ""}${esc(fmtAgo(b.time))} · ${fmtBytes(b.size)}</span>
        </button>
        <button class="bk-diff" data-diff="${esc(b.id)}" title="Differences from the current editor content">±</button>
      </div>`;
    list.innerHTML = `<button class="bk current ${ed.backup ? "" : "active"}" data-bk="">
        <strong>Current (on disk)</strong><span class="muted">${fmtBytes(new Blob([ed.orig]).size)}</span></button>` +
      (r.backups.length ? r.backups.map(row).join("")
        : `<p class="muted">No backups yet – the original is kept on the first save.</p>`);
  } catch (e) {
    list.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`;
  }
}

async function edLoadBackup(id) {
  if (!id) {  // back to the content on disk
    if (edDirty() && !confirm("Discard the current editor content?")) return;
    ed.backup = null;
    edText.value = ed.orig;
    cm.refresh(); edUpdate(); edOutput("");
    edBackups();
    return;
  }
  if (edDirty() && !ed.backup && !confirm("Unsaved changes – discard them and load the previous version?")) return;
  try {
    const r = await api(`api/fs/backup?${qs({ path: ed.path, id })}`);
    ed.backup = id;
    edText.value = r.content;
    edText.scrollTop = 0;
    cm.setError(0); cm.refresh(); edUpdate();
    const label = id === "original" ? "The original version" : `The version from before the save at ${fmtTime(r.time)}`;
    edOutput(`${label} is loaded into the editor – the file has NOT changed yet.\n` +
      (ed.info.editable ? "Restore: Save (the current content is backed up too). Discard: the \"Current\" row." : ""),
      "", `🕘 ${id === "original" ? "Original" : fmtTime(r.time)}`);
    edBackups();
  } catch (e) {
    edOutput(e.message, "err", "✗ Could not load the backup");
  }
}

async function edDiff(id) {
  try {
    const r = await api("api/fs/diff", jsonPost({ path: ed.path, id, content: edText.value }));
    edOutput(r.diff || "No differences.", r.diff ? "diff" : "ok",
      `± ${id === "original" ? "Original" : id} → editor`);
  } catch (e) {
    edOutput(e.message, "err", "✗ Diff error");
  }
}

// ------------------------------------------------------------------ find / replace
const fnd = {
  caseSens: localStorage.getItem("edFindCase") === "1",
  regex: localStorage.getItem("edFindRegex") === "1",
};
const findIsOpen = () => !$("#ed-find").classList.contains("hidden");

function findShow(r) {
  const q = $("#find-q").value;
  const c = $("#find-count");
  c.textContent = !q ? "" : r.error ? "invalid" : !r.count ? "no results"
    : `${r.index || "–"}/${r.count}${r.capped ? "+" : ""}`;
  c.classList.toggle("none", !!q && (r.error || !r.count));
  $("#find-q").classList.toggle("err", !!r.error);
  const none = !r.count || !!r.error;
  document.querySelectorAll("#ed-find [data-find=prev],#ed-find [data-find=next],#ed-find [data-find=rep],#ed-find [data-find=repall]").forEach((b) => { b.disabled = none; });
}
cm.onSearch = (r) => { if (findIsOpen()) findShow(r); };

function findRun() {
  findShow(cm.search($("#find-q").value, { caseSens: fnd.caseSens, regex: fnd.regex }));
}

// the replace row only for editable files
function findRepAvailable() {
  const ok = !!ed.info?.editable;
  $("#find-rep-toggle").disabled = !ok;
  if (!ok) findRep(false);
}
function findRep(on) {
  $("#find-rep-row").classList.toggle("hidden", !on);
  $("#find-rep-toggle").textContent = on ? "▾" : "▸";
}

function findOpen(withReplace = false) {
  if (!ed.path || $("#ed-code").classList.contains("hidden")) return;
  $("#ed-find").classList.remove("hidden");
  $("#ed-find-btn").classList.add("active");
  if (withReplace && ed.info?.editable) findRep(true);
  // a single-line selection in the editor becomes the query
  const sel = edText.value.slice(edText.selectionStart, edText.selectionEnd);
  if (document.activeElement === edText && sel && !sel.includes("\n")) $("#find-q").value = sel;
  const input = withReplace && ed.info?.editable && $("#find-q").value ? $("#find-r") : $("#find-q");
  input.focus();
  input.select();
  findRun();
}

function findClose(focus = true) {
  if (!findIsOpen()) return;
  $("#ed-find").classList.add("hidden");
  $("#ed-find-btn").classList.remove("active");
  cm.search("");
  if (focus && ed.path) edText.focus();
}

function findOpts() {
  $("[data-find=case]").setAttribute("aria-pressed", fnd.caseSens);
  $("[data-find=regex]").setAttribute("aria-pressed", fnd.regex);
}
findOpts();

function findAct(act) {
  if (act === "next" || act === "prev") return findShow(cm.findNext(act === "next" ? 1 : -1));
  if (act === "close") return findClose();
  if (act === "case" || act === "regex") {
    if (act === "case") fnd.caseSens = !fnd.caseSens;
    else fnd.regex = !fnd.regex;
    localStorage.setItem("edFindCase", fnd.caseSens ? "1" : "0");
    localStorage.setItem("edFindRegex", fnd.regex ? "1" : "0");
    findOpts();
    return findRun();
  }
  if (act === "rep") {
    findShow(cm.replaceCurrent($("#find-r").value));
    $("#find-r").focus();
  } else if (act === "repall") {
    const n = cm.replaceAll($("#find-r").value);
    toast(`${n} replaced`);
    $("#find-r").focus();
  }
}

$("#ed-find").addEventListener("click", (e) => {
  const b = e.target.closest("[data-find]");
  if (b && !b.disabled) findAct(b.dataset.find);
});
$("#find-rep-toggle").addEventListener("click", () => {
  const on = $("#find-rep-row").classList.contains("hidden");
  findRep(on);
  if (on) $("#find-r").focus();
});
$("#ed-find-btn").addEventListener("click", () => (findIsOpen() ? findClose() : findOpen()));
$("#find-q").addEventListener("input", findRun);
$("#find-q").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); findAct(e.shiftKey ? "prev" : "next"); }
});
$("#find-r").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); if (!$("[data-find=rep]").disabled) findAct("rep"); }
});
$("#ed-find").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); findClose(); }
});

// ------------------------------------------------------------------ events
edText.addEventListener("input", edUpdate);
document.addEventListener("keydown", (e) => {
  if ($("#editor").classList.contains("hidden")) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && !e.altKey && k === "s") {
    e.preventDefault();
    edSave();
  } else if (mod && !e.altKey && !e.shiftKey && (k === "f" || k === "h") && ed.path) {
    e.preventDefault();
    findOpen(k === "h");
  } else if ((e.key === "F3" || (mod && k === "g")) && ed.path) {
    e.preventDefault();
    if (!findIsOpen()) findOpen();
    else findAct(e.shiftKey ? "prev" : "next");
  } else if (e.key === "Escape" && findIsOpen() && document.activeElement === edText) {
    findClose();
  }
});
$("#open-editor").addEventListener("click", openFileEditor);
$("#ed-close").addEventListener("click", () => closeEditor());
$("#ed-tree-btn").addEventListener("click", () => treeShow($("#ed-tree").classList.contains("hidden")));
$("#ed-file").addEventListener("change", (e) => edOpen(e.target.value));
$("#ed-save").addEventListener("click", () => edSave());
$("#ed-save-up").addEventListener("click", () => edSave(true));
$("#ed-check").addEventListener("click", edCheck);
$("#ed-mode").addEventListener("change", (e) => {
  cm.setMode(e.target.value);
  cm.setIndent(CodeEditor.detectIndent(edText.value, e.target.value));
});
$("#ed-wrap").addEventListener("change", (e) => cm.setWrap(e.target.checked));
$("#ed-history").addEventListener("click", () => {
  if ($("#ed-backups").classList.contains("hidden")) edBackups();
  else $("#ed-backups").classList.add("hidden");
});
$("#ed-backups-close").addEventListener("click", () => $("#ed-backups").classList.add("hidden"));
$("#ed-backups-list").addEventListener("click", (e) => {
  const d = e.target.closest("[data-diff]");
  if (d) return edDiff(d.dataset.diff);
  const b = e.target.closest("[data-bk]");
  if (b) edLoadBackup(b.dataset.bk);
});
$("#ed-output").addEventListener("click", (e) => {
  const b = e.target.closest("[data-out]");
  const o = $("#ed-output");
  if (b?.dataset.out === "close") edOutput("");
  else if (b?.dataset.out === "toggle" || e.target.closest(".outbox-head")) {
    o.classList.toggle("collapsed");
    o.querySelector("[data-out=toggle]").textContent = o.classList.contains("collapsed") ? "▸" : "▾";
  } else if (o.dataset.line) cm.gotoLine(+o.dataset.line);  // jump to the error line
});
$("#ed-tree").addEventListener("click", (e) => {
  const b = e.target.closest("[data-dir],[data-file]");
  if (!b || b.disabled) return;
  if (b.dataset.file !== undefined) edOpen(b.dataset.file);
  else treeLoad(b.dataset.dir);
});
$("#tree-filter").addEventListener("input", treeRender);
$("#tree-only-edit").checked = localStorage.getItem("edOnlyEdit") === "1";
$("#tree-only-edit").addEventListener("change", (e) => {
  localStorage.setItem("edOnlyEdit", e.target.checked ? "1" : "0");
  treeRender();
});
$("#tree-refresh").addEventListener("click", () => treeLoad(ed.dir));
$("#tree-new").addEventListener("click", newFile);
window.addEventListener("beforeunload", (e) => { if (edDirty()) e.preventDefault(); });
