"use strict";
// Pici, függőség nélküli kódszerkesztő: <textarea> + alatta kiemelt <pre> + sorszámok.
// YAML (docker-compose) és .env szintaxis kiemelés, YAML-barát szerkesztés:
// automatikus behúzás, lista folytatás, Tab / Shift+Tab blokk behúzás, Ctrl+/ megjegyzés,
// Backspace a behúzásban 2 szóközt töröl, TAB karakterek jelölése.

const CodeEditor = (() => {
  const INDENT = "  ";
  const escH = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const span = (cls, s) => (s ? `<span class="t-${cls}">${escH(s)}</span>` : "");

  // ${VAR}, ${VAR:-default}, $VAR kiemelése egy (már nem escape-elt) szövegben
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

  // az első, idézőjelen kívüli " #" (vagy sor eleji #) pozíciója
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

  // YAML skalár / flow érték
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
    let block = -1; // block scalar (| vagy >) szülő behúzása, -1 = nincs
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
      // lista elem(ek): "- " / "- - "
      let m, dashed = false;
      while ((m = rest.match(/^-(\s+|$)/))) {
        h += span("dash", "-") + escH(m[1]);
        rest = rest.slice(m[0].length);
        dashed = true;
      }
      // environment lista: "- KEY=value"
      if (dashed && (m = rest.match(/^([A-Za-z_][A-Za-z0-9_.]*)(=)(.*)$/))) {
        return h + span("key", m[1]) + span("punct", m[2]) + withVars("str", m[3]) + span("comment", comment);
      }
      // kulcs: érték
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

  function create(root, ta) {
    const gutter = root.querySelector(".code-gutter");
    const pre = root.querySelector(".code-hl");
    const ed = { mode: "yaml", errLine: 0, onCursor: null };
    let raf = 0;

    function paint() {
      raf = 0;
      const text = ta.value;
      pre.innerHTML = (ed.mode === "env" ? highlightEnv(text) : highlightYaml(text)) + "\n ";
      const lines = text.split("\n");
      let g = "";
      for (let i = 0; i < lines.length; i++) {
        const cls = i + 1 === ed.errLine ? "err" : /^ *\t/.test(lines[i]) ? "warn" : "";
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

    // szöveg csere úgy, hogy a visszavonás (Ctrl+Z) működjön
    function replace(start, end, text, selStart, selEnd) {
      ta.focus();
      ta.setSelectionRange(start, end);
      if (!document.execCommand("insertText", false, text)) ta.setRangeText(text, start, end, "end");
      if (selStart !== undefined) ta.setSelectionRange(selStart, selEnd ?? selStart);
      refresh();
      ta.dispatchEvent(new Event("input"));
    }

    // a kijelölés által érintett teljes sorok
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
      const v = ta.value, a = ta.selectionStart, b = ta.selectionEnd;
      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (e.shiftKey) mapLines((l) => l.replace(/^ {1,2}|^\t/, ""));
        else if (v.slice(a, b).includes("\n")) mapLines((l) => (l ? INDENT + l : l));
        else replace(a, b, INDENT);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "/" || e.code === "Slash")) {
        e.preventDefault();
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
            // üres lista elem + Enter -> lista vége, egy szinttel kijjebb
            const out = dash[1].slice(0, Math.max(0, dash[1].length - INDENT.length));
            replace(ls, a, out, ls + out.length);
            return;
          }
          const keyCol = dash ? dash[1] + " ".repeat(1 + dash[2].length) : ind;
          if (/:$/.test(code) || /[:-]\s*[|>][-+0-9]*$/.test(code)) {
            ind = keyCol + INDENT;                       // "key:" után beljebb
          } else if (dash && /^\s*-\s+("[^"]*"|'[^']*'|[^\s"'#][^#]*?)\s*:(\s|$)/.test(code)) {
            ind = keyCol;                                // "- key: value" után a kulcs oszlopába
          } else if (dash) {
            ind = dash[1] + "-" + dash[2];               // lista folytatása
          }
        }
        replace(a, b, "\n" + ind);
        return;
      }
      if (e.key === "Backspace" && a === b && a > 0) {
        const ls = v.lastIndexOf("\n", a - 1) + 1;
        const before = v.slice(ls, a);
        if (before.length >= 2 && /^ +$/.test(before)) {
          e.preventDefault();
          const n = before.length % 2 || 2;
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
      setMode(m) { ed.mode = m; refresh(); },
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

  return { create, highlightYaml, highlightEnv };
})();
