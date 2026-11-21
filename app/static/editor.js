"use strict";
// Tiny dependency-free code editor: <textarea> over a highlighted <pre> + line numbers.
// Highlighting for YAML, JSON, .env, HAProxy, INI, configs and shell; YAML-friendly editing:
// auto-indent, list continuation, Tab / Shift+Tab block indent, Ctrl+/ comment,
// Backspace removes one indent unit, TAB characters are flagged in YAML.

const CodeEditor = (() => {
  const INDENT = "  ";
  const escH = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const span = (cls, s) => (s ? `<span class="t-${cls}">${escH(s)}</span>` : "");

  // highlight ${VAR}, ${VAR:-default}, $VAR in (not yet escaped) text
  function withVars(cls, s) {
    let out = "", last = 0;
    const re = /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g;
    let m;
    while ((m = re.exec(s))) {
      out += span(cls, s.slice(last, m.index)) + span("var", m[0]);
      last = m.index + m[0].length;
    }
    return out + span(cls, s.slice(last));
  }

  // position of the first " #" outside quotes (or a # at line start)
  function commentStart(s) {
    let q = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === q && s[i - 1] !== "\\") q = null; continue; }
      if (c === '"' || c === "'") { if (i === 0 || /[\s:[{,-]/.test(s[i - 1])) q = c; continue; }
      if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return i;
    }
    return -1;
  }

  // YAML scalar / flow value
  function yamlValue(v) {
    if (!v) return "";
    const lead = v.match(/^\s*/)[0];
    const body = v.slice(lead.length);
    const trail = body.match(/\s*$/)[0];
    const core = body.slice(0, body.length - trail.length);
    let h;
    if (/^(["']).*\1$/.test(core)) h = withVars("str", core);
    else if (/^[|>][-+0-9]*$/.test(core)) h = span("punct", core);
    else if (/^[-+]?(\d[\d_]*(\.\d*)?([eE][-+]?\d+)?|0x[\da-fA-F]+|0o[0-7]+|\.inf|\.nan)$/.test(core)) h = span("num", core);
    else if (/^(true|false|yes|no|on|off|True|False|TRUE|FALSE|null|Null|NULL|~)$/.test(core)) h = span("bool", core);
    else if (/^[&*][^\s]+$/.test(core)) h = span("anchor", core);
    else if (/^!/.test(core)) {
      const [, tag, rest] = core.match(/^(!\S*)(.*)$/);
      h = span("tag", tag) + yamlValue(rest);
    } else if (/^[[{]/.test(core)) {
      h = core.split(/([[\]{},])/).map((p) => (/^[[\]{},]$/.test(p) ? span("punct", p) : /^\s*$/.test(p) ? escH(p) : yamlValue(p))).join("");
    } else h = withVars("plain", core);
    return escH(lead) + h + escH(trail);
  }

  function markTabs(s) {
    const m = s.match(/^[ \t]*/)[0];
    if (!m.includes("\t")) return escH(m);
    return m.replace(/\t/g, "\u0001").split("").map((c) => (c === "\u0001" ? '<span class="t-tab">\t</span>' : c)).join("");
  }

  function highlightYaml(text) {
    const lines = text.split("\n");
    let block = -1; // indent of the block scalar (| or >) parent, -1 = none
    return lines.map((line) => {
      const indent = line.match(/^[ \t]*/)[0].length;
      if (block >= 0) {
        if (!line.trim() || indent > block) return escH(line.slice(0, indent)) + span("str", line.slice(indent));
        block = -1;
      }
      const ci = commentStart(line);
      const code = ci >= 0 ? line.slice(0, ci) : line;
      const comment = ci >= 0 ? line.slice(ci) : "";
      let rest = code.slice(indent);
      let h = markTabs(line);
      if (/^(---|\.\.\.)\s*$/.test(rest)) return h + span("doc", rest) + span("comment", comment);
      // list item(s): "- " / "- - "
      let m, dashed = false;
      while ((m = rest.match(/^-(\s+|$)/))) {
        h += span("dash", "-") + escH(m[1]);
        rest = rest.slice(m[0].length);
        dashed = true;
      }
      // environment list: "- KEY=value"
      if (dashed && (m = rest.match(/^([A-Za-z_][A-Za-z0-9_.]*)(=)(.*)$/))) {
        return h + span("key", m[1]) + span("punct", m[2]) + withVars("str", m[3]) + span("comment", comment);
      }
      // key: value
      m = rest.match(/^("(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'#][^#]*?)(\s*)(:)(\s|$)/);
      if (m && !/^[[{]/.test(rest)) {
        const key = m[1];
        h += span(key === "<<" ? "anchor" : "key", key) + escH(m[2]) + span("punct", ":");
        const val = rest.slice(m[0].length - m[4].length);
        if (/^\s*[|>][-+0-9]*\s*$/.test(val)) block = indent;
        h += yamlValue(val);
      } else {
        if (/^\s*[|>][-+0-9]*\s*$/.test(rest)) block = indent;
        h += yamlValue(rest);
      }
      return h + span("comment", comment);
    }).join("\n");
  }

  function highlightEnv(text) {
    return text.split("\n").map((line) => {
      if (/^\s*#/.test(line)) return span("comment", line);
      const m = line.match(/^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)(\s*=)(.*)$/);
      if (!m) return line.trim() ? span("err", line) : escH(line);
      let val = m[5], comment = "";
      if (!/^\s*["']/.test(val)) {
        const ci = val.search(/\s#/);
        if (ci >= 0) { comment = val.slice(ci); val = val.slice(0, ci); }
      }
      return escH(m[1]) + span("kw", m[2] || "") + span("key", m[3]) + span("punct", m[4]) +
        withVars("str", val) + span("comment", comment);
    }).join("\n");
  }

  // JSON: token based
  function highlightJson(text) {
    const re = /("(?:[^"\\\n]|\\.)*"?)(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)|\b(true|false|null)\b|([{}[\],:])/g;
    let out = "", last = 0, m;
    while ((m = re.exec(text))) {
      out += escH(text.slice(last, m.index));
      if (m[1]) out += m[2] ? span("key", m[1]) + span("punct", m[2]) : withVars("str", m[1]);
      else if (m[3]) out += span("num", m[3]);
      else if (m[4]) out += span("bool", m[4]);
      else out += span("punct", m[5]);
      last = re.lastIndex;
    }
    return out + escH(text.slice(last));
  }

  // the "rest" of a line: quoted strings, variables, numbers, keywords
  const SH_KW = new Set("if then else elif fi for while until do done case esac in function return local export exit set unset source shift break continue".split(" "));
  const HA_KW = new Set(["if", "unless", "or", "!"]);
  function words(s, kw) {
    const re = /("(?:[^"\\]|\\.)*"?|'[^']*'?)|(\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|%\[[^\]]*\]?)|(\b\d+(?:\.\d+)*(?:ms|us|s|m|h|d|k|K|M|G|%)?\b)|([A-Za-z_!][\w.-]*)/g;
    let out = "", last = 0, m;
    while ((m = re.exec(s))) {
      out += escH(s.slice(last, m.index));
      if (m[1]) out += withVars("str", m[1]);
      else if (m[2]) out += span("var", m[2]);
      else if (m[3]) out += span("num", m[3]);
      else out += kw && kw.has(m[4]) ? span("kw", m[4]) : escH(m[4]);
      last = re.lastIndex;
    }
    return out + escH(s.slice(last));
  }

  const HA_SECTIONS = /^(global|defaults|frontend|backend|listen|resolvers|peers|userlist|mailers|program|http-errors|ring|cache|crt-store|traces)\b/;

  // haproxy / ini / conf / sh: line based "key + rest" highlighting
  function highlightConf(text, mode) {
    return text.split("\n").map((line) => {
      const ind = line.match(/^[ \t]*/)[0];
      const body = line.slice(ind.length);
      if (!body) return escH(line);
      if (body[0] === "#" || (mode === "ini" && body[0] === ";")) return escH(ind) + span("comment", body);
      const ci = commentStart(body);
      const code = ci >= 0 ? body.slice(0, ci) : body;
      const comment = ci >= 0 ? body.slice(ci) : "";
      let h;
      let m;
      if (mode === "haproxy" && !ind && (m = code.match(HA_SECTIONS))) {
        h = span("section", m[0]) + span("str", code.slice(m[0].length));
      } else if ((mode === "ini" || mode === "conf") && (m = code.match(/^(\[[^\]]*\]?)(.*)$/))) {
        h = span("section", m[1]) + escH(m[2]);
      } else if ((mode === "ini" || mode === "conf") && (m = code.match(/^([\w.\-/@ ]*?[\w.\-/@])(\s*[=:]\s?)(.*)$/))) {
        h = span("key", m[1]) + span("punct", m[2]) + words(m[3]);
      } else if (mode === "sh") {
        h = (m = code.match(/^([A-Za-z_][A-Za-z0-9_]*)(=)(.*)$/))
          ? span("key", m[1]) + span("punct", m[2]) + words(m[3], SH_KW)
          : words(code, SH_KW);
      } else if ((m = code.match(/^([^\s{};]+)(.*)$/))) {
        // first word = directive (haproxy, nginx, Dockerfile, Caddyfile, ...)
        h = span("key", m[1]) + words(m[2], mode === "haproxy" ? HA_KW : null);
      } else h = words(code);
      return escH(ind) + h + span("comment", comment);
    }).join("\n");
  }

  const HIGHLIGHT = {
    yaml: highlightYaml, env: highlightEnv, json: highlightJson,
    haproxy: (t) => highlightConf(t, "haproxy"), ini: (t) => highlightConf(t, "ini"),
    conf: (t) => highlightConf(t, "conf"), sh: (t) => highlightConf(t, "sh"),
    plain: (t) => escH(t),
  };
  const MODES = { yaml: "YAML", json: "JSON", env: ".env", haproxy: "HAProxy", ini: "INI / TOML", conf: "Config", sh: "Shell", plain: "Plain text" };

  // file name -> mode
  function modeFor(name) {
    const n = name.toLowerCase();
    const ext = n.includes(".", 1) ? n.slice(n.lastIndexOf(".") + 1) : "";
    if (ext === "yaml" || ext === "yml") return "yaml";
    if (ext === "json") return "json";
    if (n.startsWith(".env") || ext === "env") return "env";
    if (n.includes("haproxy") && /^(cfg|conf)$/.test(ext)) return "haproxy";
    if (/^(ini|toml|cfg|cnf|properties|service|timer|socket|mount|desktop)$/.test(ext)) return "ini";
    if (/^(sh|bash|zsh|cmd|bat)$/.test(ext)) return "sh";
    if (ext === "conf" || n === "caddyfile" || n === "dockerfile" || n === "makefile" || n === "crontab") return "conf";
    return "plain";
  }

  // detect the indent: TAB, or the most common space step (2 / 4)
  function detectIndent(text, mode) {
    const lines = text.split("\n").filter((l) => /^[ \t]+\S/.test(l));
    const tabs = lines.filter((l) => l[0] === "\t").length;
    if (mode !== "yaml" && tabs > lines.length / 2) return "\t";
    const counts = { 2: 0, 4: 0 };
    let prev = 0;
    for (const l of text.split("\n")) {
      if (!l.trim()) continue;
      const n = l.match(/^ */)[0].length;
      const d = Math.abs(n - prev);
      if (d === 2 || d === 4) counts[d]++;
      prev = n;
    }
    if (counts[2] || counts[4]) return counts[4] > counts[2] * 2 ? "    " : "  ";
    return mode === "yaml" || mode === "json" ? "  " : "    ";
  }

  function create(root, ta) {
    const gutter = root.querySelector(".code-gutter");
    const pre = root.querySelector(".code-hl");
    const ed = { mode: "yaml", indent: INDENT, errLine: 0, onCursor: null, readOnly: false };
    let raf = 0;

    function paint() {
      raf = 0;
      const text = ta.value;
      pre.innerHTML = (text.length > 300000 ? escH(text) : (HIGHLIGHT[ed.mode] || HIGHLIGHT.plain)(text)) + "\n ";
      const lines = text.split("\n");
      let g = "";
      for (let i = 0; i < lines.length; i++) {
        const cls = i + 1 === ed.errLine ? "err" : ed.mode === "yaml" && /^ *\t/.test(lines[i]) ? "warn" : "";
        g += `<div${cls ? ` class="${cls}"` : ""}>${i + 1}</div>`;
      }
      gutter.innerHTML = g;
      sync();
    }
    function sync() {
      pre.style.width = root.classList.contains("wrap") ? `${ta.clientWidth}px` : "";
      pre.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
      gutter.style.transform = `translateY(${-ta.scrollTop}px)`;
    }
    const refresh = () => { if (!raf) raf = requestAnimationFrame(paint); };

    function cursor() {
      if (!ed.onCursor) return;
      const before = ta.value.slice(0, ta.selectionStart);
      const line = before.split("\n").length;
      ed.onCursor(line, before.length - before.lastIndexOf("\n"));
    }

    // replace text so that undo (Ctrl+Z) keeps working
    function replace(start, end, text, selStart, selEnd) {
      ta.focus();
      ta.setSelectionRange(start, end);
      if (!document.execCommand("insertText", false, text)) ta.setRangeText(text, start, end, "end");
      if (selStart !== undefined) ta.setSelectionRange(selStart, selEnd ?? selStart);
      refresh();
      ta.dispatchEvent(new Event("input"));
    }

    // the full lines touched by the selection
    function selLines() {
      const v = ta.value;
      const s = v.lastIndexOf("\n", ta.selectionStart - 1) + 1;
      let e = ta.selectionEnd;
      if (e > ta.selectionStart && v[e - 1] === "\n") e--;
      const nl = v.indexOf("\n", e);
      e = nl < 0 ? v.length : nl;
      return { s, e, lines: v.slice(s, e).split("\n") };
    }

    function mapLines(fn) {
      const { s, e, lines } = selLines();
      const out = lines.map(fn).join("\n");
      replace(s, e, out, s, s + out.length);
    }

    function onKey(e) {
      if (ed.readOnly) return;
      const v = ta.value, a = ta.selectionStart, b = ta.selectionEnd;
      const unit = ed.indent;
      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        const out = new RegExp(unit === "\t" ? "^(\\t| {1,4})" : `^ {1,${unit.length}}|^\\t`);
        if (e.shiftKey) mapLines((l) => l.replace(out, ""));
        else if (v.slice(a, b).includes("\n")) mapLines((l) => (l ? unit + l : l));
        else replace(a, b, unit);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "/" || e.code === "Slash")) {
        e.preventDefault();
        if (ed.mode === "json") return;  // JSON has no comments
        const { lines } = selLines();
        const all = lines.filter((l) => l.trim()).every((l) => /^\s*#/.test(l));
        mapLines((l) => (!l.trim() ? l : all ? l.replace(/^(\s*)# ?/, "$1") : l.replace(/^(\s*)/, "$1# ")));
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing) {
        e.preventDefault();
        const ls = v.lastIndexOf("\n", a - 1) + 1;
        const line = v.slice(ls, a);
        let ind = line.match(/^[ \t]*/)[0];
        if (ed.mode === "yaml") {
          const ci = commentStart(line);
          const code = (ci >= 0 ? line.slice(0, ci) : line).trimEnd();
          const dash = code.match(/^(\s*)-(\s+)/);
          if (dash && code.trim() === "-") {
            // empty list item + Enter -> end of list, one level out
            const out = dash[1].slice(0, Math.max(0, dash[1].length - unit.length));
            replace(ls, a, out, ls + out.length);
            return;
          }
          const keyCol = dash ? dash[1] + " ".repeat(1 + dash[2].length) : ind;
          if (/:$/.test(code) || /[:-]\s*[|>][-+0-9]*$/.test(code)) {
            ind = keyCol + unit;                         // indent after "key:"
          } else if (dash && /^\s*-\s+("[^"]*"|'[^']*'|[^\s"'#][^#]*?)\s*:(\s|$)/.test(code)) {
            ind = keyCol;                                // after "- key: value": align with the key
          } else if (dash) {
            ind = dash[1] + "-" + dash[2];               // continue the list
          }
        } else if (ed.mode === "haproxy" && !ind && HA_SECTIONS.test(line)) {
          ind = unit;                                    // indent after "backend x"
        } else if (/[{[(]\s*$/.test(line)) {
          ind += unit;                                   // indent after an opening bracket
        }
        replace(a, b, "\n" + ind);
        return;
      }
      if (e.key === "Backspace" && a === b && a > 0) {
        const ls = v.lastIndexOf("\n", a - 1) + 1;
        const before = v.slice(ls, a);
        const w = unit === "\t" ? 0 : unit.length;
        if (w > 1 && before.length >= 2 && /^ +$/.test(before)) {
          e.preventDefault();
          const n = before.length % w || w;
          replace(a - n, a, "", a - n);
        }
      }
    }

    ta.addEventListener("input", refresh);
    ta.addEventListener("scroll", sync);
    ta.addEventListener("keydown", onKey);
    ["keyup", "click", "select", "input"].forEach((ev) => ta.addEventListener(ev, cursor));
    new ResizeObserver(sync).observe(ta);

    return Object.assign(ed, {
      setMode(m) { ed.mode = HIGHLIGHT[m] ? m : "plain"; refresh(); },
      setIndent(u) { ed.indent = u || INDENT; },
      setReadOnly(on) { ed.readOnly = on; ta.readOnly = on; root.classList.toggle("readonly", on); },
      setError(line) { ed.errLine = line || 0; refresh(); },
      setWrap(on) { root.classList.toggle("wrap", on); refresh(); },
      gotoLine(n) {
        const lines = ta.value.split("\n");
        const pos = lines.slice(0, n - 1).reduce((s, l) => s + l.length + 1, 0);
        ta.focus();
        ta.setSelectionRange(pos, pos + (lines[n - 1] || "").length);
        const lh = parseFloat(getComputedStyle(ta).lineHeight) || 19;
        ta.scrollTop = Math.max(0, (n - 4) * lh);
        cursor();
      },
      refresh: paint,
    });
  }

  return { create, modeFor, detectIndent, MODES, highlight: (mode, t) => (HIGHLIGHT[mode] || HIGHLIGHT.plain)(t) };
})();
