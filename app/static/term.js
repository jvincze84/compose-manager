"use strict";
// Tiny dependency-free terminal emulator (a VT100 / xterm subset) for the exec view.
// Screen = rows x cols cells rendered as one <div> per row (runs of equal attributes
// as <span>s); lines scrolled off the top go to a scrollback list above the screen.
// Supports cursor movement, erase, insert / delete, scroll regions, SGR colours
// (16 / 256 / true colour), the alternate screen (vi, less, top), DEC line drawing,
// application cursor keys and bracketed paste. Wide (CJK / emoji) characters count
// as one cell. Keyboard input goes through a hidden <textarea>, so phone keyboards
// (IME / autocorrect) work: its content is diffed and sent as keystrokes.

const Term = (() => {
  const SCROLLBACK = 2000;
  const BASE16 = ["#1f2937", "#ef4444", "#22c55e", "#eab308", "#3b82f6", "#d946ef", "#06b6d4", "#d1d5db",
    "#6b7280", "#f87171", "#4ade80", "#facc15", "#60a5fa", "#e879f9", "#22d3ee", "#ffffff"];
  const DEF_FG = "#d1d5db", DEF_BG = "#050811";
  const DEF = Object.freeze({});  // default attributes
  const LINE_DRAWING = {
    "`": "◆", a: "▒", f: "°", g: "±", j: "┘", k: "┐", l: "┌", m: "└", n: "┼", o: "⎺", p: "⎻",
    q: "─", r: "⎼", s: "⎽", t: "├", u: "┤", v: "┴", w: "┬", x: "│", y: "≤", z: "≥", "{": "π", "|": "≠", "}": "£", "~": "·",
  };
  const escH = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

  function color256(n) {
    if (n < 16) return BASE16[n];
    if (n < 232) {
      n -= 16;
      const v = (x) => (x ? x * 40 + 55 : 0);
      return `rgb(${v(Math.floor(n / 36))},${v(Math.floor(n / 6) % 6)},${v(n % 6)})`;
    }
    const g = (n - 232) * 10 + 8;
    return `rgb(${g},${g},${g})`;
  }
  const colorOf = (c) => (typeof c === "number" ? color256(c) : c);

  const styleCache = new WeakMap();
  function styleOf(a) {
    if (a === DEF) return "";
    let s = styleCache.get(a);
    if (s !== undefined) return s;
    let fg = a.fg ?? null, bg = a.bg ?? null;
    if (a.b && typeof fg === "number" && fg < 8) fg += 8;  // bold = bright, like most terminals
    if (a.inv) [fg, bg] = [bg ?? -1, fg ?? -2];
    const css = [];
    if (fg !== null) css.push(`color:${fg === -1 ? DEF_BG : colorOf(fg)}`);
    if (bg !== null) css.push(`background:${bg === -2 ? DEF_FG : colorOf(bg)}`);
    if (a.b) css.push("font-weight:700");
    if (a.d) css.push("opacity:.65");
    if (a.i) css.push("font-style:italic");
    if (a.u || a.x) css.push(`text-decoration:${[a.u && "underline", a.x && "line-through"].filter(Boolean).join(" ")}`);
    if (a.h) css.push("visibility:hidden");
    s = css.join(";");
    styleCache.set(a, s);
    return s;
  }

  class Term {
    constructor(root, { onData = () => {}, onResize = () => {}, onCtrl = () => {} } = {}) {
      this.root = root;
      this.onData = onData;
      this.onResize = onResize;
      this.onCtrl = onCtrl;  // sticky Ctrl (key bar) changed
      root.classList.add("term");
      root.innerHTML = '<div class="term-sb"></div><div class="term-screen"></div>' +
        '<textarea class="term-input" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" ' +
        'aria-label="Terminal input"></textarea><span class="term-measure" aria-hidden="true">WWWWWWWWWW</span>';
      this.sbEl = root.querySelector(".term-sb");
      this.screenEl = root.querySelector(".term-screen");
      this.input = root.querySelector(".term-input");
      this.measure = root.querySelector(".term-measure");
      this.cols = 80;
      this.rows = 24;
      this.cw = 8;
      this.ch = 17;
      this.ctrlOnce = false;
      this.raf = 0;
      this.reset();
      this.bindInput();
      new ResizeObserver(() => this.fit()).observe(root);
    }

    // ------------------------------------------------------------ state
    reset() {
      this.attr = DEF;
      this.normal = this.makeBuffer();
      this.alt = null;      // alternate screen: the normal buffer is kept aside
      this.buf = this.normal;
      this.modes = { wrap: true, appCursor: false, cursor: true, paste: false, origin: false, insert: false };
      this.charsets = [false, false];  // G0 / G1: DEC line drawing?
      this.shift = 0;
      this.parser = { st: 0, buf: "", charsetTarget: 0 };
      this.sbEl.innerHTML = "";
      this.sbCount = 0;
      this.buildScreen();
      this.dirtyAll();
      this.schedule();
    }

    makeBuffer() {
      const lines = [];
      for (let i = 0; i < this.rows; i++) lines.push(this.blankRow());
      return { lines, x: 0, y: 0, top: 0, bottom: this.rows - 1, wrapNext: false, saved: null };
    }

    blankRow(attr) {
      const a = attr && attr.bg !== undefined ? { bg: attr.bg } : DEF;
      return { c: new Array(this.cols).fill(" "), a: new Array(this.cols).fill(a) };
    }

    buildScreen() {
      this.screenEl.innerHTML = "<div></div>".repeat(this.rows);
      this.rowEls = [...this.screenEl.children];
      this.dirty = new Set();
      this.lastCur = -1;
    }

    dirtyAll() { for (let i = 0; i < this.rows; i++) this.dirty.add(i); }

    // ------------------------------------------------------------ size
    fit() {
      const r = this.measure.getBoundingClientRect();
      if (!r.width) return;  // hidden
      this.cw = r.width / 10;
      this.ch = r.height || this.ch;
      const cs = getComputedStyle(this.root);
      const w = this.root.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const h = this.root.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const cols = Math.max(10, Math.floor(w / this.cw));
      const rows = Math.max(4, Math.floor(h / this.ch));
      if (cols !== this.cols || rows !== this.rows) {
        this.resize(cols, rows);
        this.onResize(cols, rows);
      }
    }

    resize(cols, rows) {
      for (const b of [this.normal, this.alt]) {
        if (!b) continue;
        for (const row of b.lines) {
          if (cols < row.c.length) { row.c.length = cols; row.a.length = cols; }
          while (row.c.length < cols) { row.c.push(" "); row.a.push(DEF); }
        }
      }
      this.cols = cols;
      for (const b of [this.normal, this.alt]) {
        if (!b) continue;
        // fewer rows: drop lines from the top (into the scrollback) so the cursor stays visible
        let drop = Math.max(0, b.y - (rows - 1));
        while (drop-- > 0) {
          const line = b.lines.shift();
          if (b === this.normal) this.pushScrollback(line);
          b.y--;
        }
        if (b.lines.length > rows) b.lines.length = rows;
        while (b.lines.length < rows) b.lines.push(this.blankRow());
        b.top = 0;
        b.bottom = rows - 1;
        b.x = Math.min(b.x, cols - 1);
        b.y = Math.min(b.y, rows - 1);
        b.wrapNext = false;
      }
      this.rows = rows;
      this.buildScreen();
      this.dirtyAll();
      this.schedule();
    }

    // ------------------------------------------------------------ output
    write(data) {
      const p = this.parser;
      for (let i = 0; i < data.length; i++) {
        const ch = data[i];
        const code = ch.charCodeAt(0);
        switch (p.st) {
          case 0:  // ground
            if (code < 0x20 || code === 0x7f) this.control(code);
            else this.print(ch);
            break;
          case 1:  // ESC
            this.escape(ch);
            break;
          case 2:  // CSI: parameters, intermediates, final byte
            if (code >= 0x40 && code <= 0x7e) { p.st = 0; this.csi(ch, p.buf); }
            else if (code === 0x1b) { p.st = 1; }
            else if (code === 0x18 || code === 0x1a) p.st = 0;
            else if (code >= 0x20) p.buf += ch;
            else this.control(code);
            break;
          case 3:  // OSC: until BEL or ST
            if (code === 0x07) { p.st = 0; this.osc(p.buf); }
            else if (code === 0x1b) { p.st = 6; }
            else if (p.buf.length < 4096) p.buf += ch;
            break;
          case 4:  // charset designation: ESC ( X
            this.charsets[p.charsetTarget] = ch === "0";
            p.st = 0;
            break;
          case 5:  // DCS / APC / PM / SOS: ignored until ST
            if (code === 0x1b) p.st = 7;
            else if (code === 0x07) p.st = 0;
            break;
          case 6:  // OSC, after ESC
            p.st = 0;
            if (ch === "\\") this.osc(p.buf);
            else { p.st = 1; this.escape(ch); }
            break;
          case 7:  // string, after ESC
            p.st = ch === "\\" ? 0 : 5;
            break;
          case 8:  // ESC # X, ESC % X, ESC SP X: one more byte, ignored
            p.st = 0;
            break;
        }
      }
      this.schedule();
    }

    control(code) {
      const b = this.buf;
      switch (code) {
        case 0x07: break;                              // BEL
        case 0x08: if (b.x > 0) b.x--; b.wrapNext = false; break;
        case 0x09: b.x = Math.min(this.cols - 1, (Math.floor(b.x / 8) + 1) * 8); b.wrapNext = false; break;
        case 0x0a: case 0x0b: case 0x0c: this.lineFeed(); break;
        case 0x0d: b.x = 0; b.wrapNext = false; break;
        case 0x0e: this.shift = 1; break;              // SO: G1
        case 0x0f: this.shift = 0; break;              // SI: G0
        case 0x1b: this.parser.st = 1; break;
        default: break;
      }
    }

    escape(ch) {
      const p = this.parser, b = this.buf;
      p.st = 0;
      switch (ch) {
        case "[": p.st = 2; p.buf = ""; break;
        case "]": p.st = 3; p.buf = ""; break;
        case "P": case "_": case "^": case "X": p.st = 5; break;
        case "(": case ")": case "*": case "+": p.st = 4; p.charsetTarget = ch === "(" ? 0 : 1; break;
        case "#": case "%": case " ": p.st = 8; break;
        case "7": this.saveCursor(); break;
        case "8": this.restoreCursor(); break;
        case "D": this.lineFeed(); break;
        case "E": b.x = 0; this.lineFeed(); break;
        case "M":                                      // reverse index
          b.wrapNext = false;
          if (b.y === b.top) this.scrollDown(1);
          else if (b.y > 0) b.y--;
          this.dirty.add(b.y);
          break;
        case "c": this.reset(); break;
        default: break;                                // = > \ and others
      }
    }

    osc() { /* window title etc.: ignored */ }

    print(ch) {
      const b = this.buf;
      if (this.charsets[this.shift] && LINE_DRAWING[ch]) ch = LINE_DRAWING[ch];
      if (b.wrapNext) {
        b.wrapNext = false;
        if (this.modes.wrap) { b.x = 0; this.lineFeed(); }
      }
      const row = b.lines[b.y];
      if (this.modes.insert) {
        row.c.splice(b.x, 0, ch); row.c.length = this.cols;
        row.a.splice(b.x, 0, this.attr); row.a.length = this.cols;
      } else {
        row.c[b.x] = ch;
        row.a[b.x] = this.attr;
      }
      this.dirty.add(b.y);
      if (b.x >= this.cols - 1) b.wrapNext = true;
      else b.x++;
    }

    lineFeed() {
      const b = this.buf;
      b.wrapNext = false;
      if (b.y === b.bottom) this.scrollUp(1);
      else if (b.y < this.rows - 1) b.y++;
    }

    pushScrollback(row) {
      const div = document.createElement("div");
      div.innerHTML = this.rowHtml(row, -1);
      this.sbEl.appendChild(div);
      if (++this.sbCount > SCROLLBACK) { this.sbEl.firstChild.remove(); this.sbCount--; }
    }

    scrollUp(n, top = this.buf.top, toScrollback = true) {
      const b = this.buf;
      n = Math.min(n, b.bottom - top + 1);
      for (let i = 0; i < n; i++) {
        const line = b.lines.splice(top, 1)[0];
        if (toScrollback && b === this.normal && top === 0) this.pushScrollback(line);
        b.lines.splice(b.bottom, 0, this.blankRow(this.attr));
      }
      for (let i = top; i <= b.bottom; i++) this.dirty.add(i);
    }

    scrollDown(n, top = this.buf.top) {
      const b = this.buf;
      n = Math.min(n, b.bottom - top + 1);
      for (let i = 0; i < n; i++) {
        b.lines.splice(b.bottom, 1);
        b.lines.splice(top, 0, this.blankRow(this.attr));
      }
      for (let i = top; i <= b.bottom; i++) this.dirty.add(i);
    }

    erase(y, from, to) {  // cells [from, to) of row y
      const row = this.buf.lines[y];
      const a = this.attr.bg !== undefined ? { bg: this.attr.bg } : DEF;
      for (let x = Math.max(0, from); x < Math.min(to, this.cols); x++) { row.c[x] = " "; row.a[x] = a; }
      this.dirty.add(y);
    }

    saveCursor() {
      const b = this.buf;
      b.saved = { x: b.x, y: b.y, attr: this.attr, wrapNext: b.wrapNext, charsets: [...this.charsets], shift: this.shift };
    }

    restoreCursor() {
      const b = this.buf, s = b.saved;
      if (!s) { b.x = 0; b.y = 0; return; }
      b.x = Math.min(s.x, this.cols - 1);
      b.y = Math.min(s.y, this.rows - 1);
      b.wrapNext = s.wrapNext;
      this.attr = s.attr;
      this.charsets = [...s.charsets];
      this.shift = s.shift;
    }

    setAlt(on, saveCursor) {
      if (on === !!this.alt) return;
      if (on) {
        if (saveCursor) this.saveCursor();
        this.alt = this.makeBuffer();
        this.alt.x = this.normal.x;
        this.alt.y = this.normal.y;
        this.buf = this.alt;
      } else {
        this.alt = null;
        this.buf = this.normal;
        if (saveCursor) this.restoreCursor();
      }
      this.dirtyAll();
    }

    csi(final, raw) {
      const b = this.buf;
      let prefix = "";
      if (/^[?>=<]/.test(raw)) { prefix = raw[0]; raw = raw.slice(1); }
      const inter = (raw.match(/[\x20-\x2f]+$/) || [""])[0];
      if (inter) raw = raw.slice(0, -inter.length);
      const ps = raw ? raw.split(";").map((v) => parseInt(v, 10)) : [];
      const p = (i, def = 1) => (Number.isFinite(ps[i]) && ps[i] > 0 ? ps[i] : def);
      if (inter) {
        if (final === "p" && inter === "!") {        // DECSTR soft reset
          this.attr = DEF;
          Object.assign(this.modes, { wrap: true, appCursor: false, cursor: true, origin: false, insert: false });
          b.top = 0; b.bottom = this.rows - 1;
        }
        return;                                    // cursor style etc.
      }
      const clampX = () => { b.x = Math.max(0, Math.min(this.cols - 1, b.x)); };
      const clampY = () => { b.y = Math.max(0, Math.min(this.rows - 1, b.y)); };
      if (final !== "m") b.wrapNext = false;
      switch (final) {
        case "@": {                                // ICH
          const row = b.lines[b.y], n = Math.min(p(0), this.cols - b.x);
          row.c.splice(b.x, 0, ...new Array(n).fill(" ")); row.c.length = this.cols;
          row.a.splice(b.x, 0, ...new Array(n).fill(DEF)); row.a.length = this.cols;
          this.dirty.add(b.y);
          break;
        }
        case "A": b.y = b.y >= b.top ? Math.max(b.top, b.y - p(0)) : Math.max(0, b.y - p(0)); break;
        case "B": case "e": b.y = b.y <= b.bottom ? Math.min(b.bottom, b.y + p(0)) : Math.min(this.rows - 1, b.y + p(0)); break;
        case "C": case "a": b.x += p(0); clampX(); break;
        case "D": b.x -= p(0); clampX(); break;
        case "E": b.y += p(0); b.x = 0; clampY(); break;
        case "F": b.y -= p(0); b.x = 0; clampY(); break;
        case "G": case "`": b.x = p(0) - 1; clampX(); break;
        case "H": case "f":
          b.y = p(0) - 1 + (this.modes.origin ? b.top : 0);
          b.x = p(1) - 1;
          clampX(); clampY();
          break;
        case "d": b.y = p(0) - 1 + (this.modes.origin ? b.top : 0); clampY(); break;
        case "J": {
          const m = ps[0] || 0;
          if (m === 0) { this.erase(b.y, b.x, this.cols); for (let y = b.y + 1; y < this.rows; y++) this.erase(y, 0, this.cols); }
          else if (m === 1) { this.erase(b.y, 0, b.x + 1); for (let y = 0; y < b.y; y++) this.erase(y, 0, this.cols); }
          else {
            for (let y = 0; y < this.rows; y++) this.erase(y, 0, this.cols);
            if (m === 3) { this.sbEl.innerHTML = ""; this.sbCount = 0; }
          }
          break;
        }
        case "K": {
          const m = ps[0] || 0;
          if (m === 0) this.erase(b.y, b.x, this.cols);
          else if (m === 1) this.erase(b.y, 0, b.x + 1);
          else this.erase(b.y, 0, this.cols);
          break;
        }
        case "L": if (b.y >= b.top && b.y <= b.bottom) { this.scrollDown(p(0), b.y); b.x = 0; } break;
        case "M": if (b.y >= b.top && b.y <= b.bottom) { this.scrollUp(p(0), b.y, false); b.x = 0; } break;
        case "P": {                                // DCH
          const row = b.lines[b.y], n = Math.min(p(0), this.cols - b.x);
          row.c.splice(b.x, n); row.a.splice(b.x, n);
          while (row.c.length < this.cols) { row.c.push(" "); row.a.push(DEF); }
          this.dirty.add(b.y);
          break;
        }
        case "S": if (!prefix) this.scrollUp(p(0)); break;
        case "T": if (!prefix) this.scrollDown(p(0)); break;
        case "X": this.erase(b.y, b.x, b.x + p(0)); break;
        case "m": if (!prefix) this.sgr(ps); break;
        case "r":
          if (!prefix) {
            const top = p(0) - 1, bottom = Math.min(this.rows, p(1, this.rows)) - 1;
            if (top < bottom) { b.top = top; b.bottom = bottom; }
            b.x = 0; b.y = this.modes.origin ? b.top : 0;
          }
          break;
        case "s": if (!prefix) this.saveCursor(); break;
        case "u": if (!prefix) this.restoreCursor(); break;
        case "h": case "l": this.setModes(prefix, ps, final === "h"); break;
        case "n":
          if (!prefix && ps[0] === 6) this.onData(`\x1b[${b.y + 1 - (this.modes.origin ? b.top : 0)};${b.x + 1}R`);
          else if (!prefix && ps[0] === 5) this.onData("\x1b[0n");
          break;
        case "c":
          if (!prefix && !ps[0]) this.onData("\x1b[?1;2c");
          else if (prefix === ">") this.onData("\x1b[>0;10;0c");
          break;
        default: break;                            // t (window ops), q, ...
      }
      this.dirty.add(b.y);
    }

    setModes(prefix, ps, on) {
      for (const m of ps) {
        if (prefix === "?") {
          if (m === 1) this.modes.appCursor = on;
          else if (m === 6) { this.modes.origin = on; this.buf.x = 0; this.buf.y = on ? this.buf.top : 0; }
          else if (m === 7) this.modes.wrap = on;
          else if (m === 25) this.modes.cursor = on;
          else if (m === 47 || m === 1047) this.setAlt(on, false);
          else if (m === 1049) this.setAlt(on, true);
          else if (m === 1048) { if (on) this.saveCursor(); else this.restoreCursor(); }
          else if (m === 2004) this.modes.paste = on;
        } else if (!prefix && m === 4) this.modes.insert = on;
      }
    }

    sgr(ps) {
      if (!ps.length) ps = [0];
      const a = { ...this.attr };
      for (let i = 0; i < ps.length; i++) {
        const n = Number.isFinite(ps[i]) ? ps[i] : 0;
        if (n === 0) { for (const k of Object.keys(a)) delete a[k]; }
        else if (n === 1) a.b = true;
        else if (n === 2) a.d = true;
        else if (n === 3) a.i = true;
        else if (n === 4) a.u = true;
        else if (n === 7) a.inv = true;
        else if (n === 8) a.h = true;
        else if (n === 9) a.x = true;
        else if (n === 21 || n === 22) { delete a.b; delete a.d; }
        else if (n === 23) delete a.i;
        else if (n === 24) delete a.u;
        else if (n === 27) delete a.inv;
        else if (n === 28) delete a.h;
        else if (n === 29) delete a.x;
        else if (n >= 30 && n <= 37) a.fg = n - 30;
        else if (n === 39) delete a.fg;
        else if (n >= 40 && n <= 47) a.bg = n - 40;
        else if (n === 49) delete a.bg;
        else if (n >= 90 && n <= 97) a.fg = n - 90 + 8;
        else if (n >= 100 && n <= 107) a.bg = n - 100 + 8;
        else if (n === 38 || n === 48) {
          const key = n === 38 ? "fg" : "bg";
          if (ps[i + 1] === 5 && Number.isFinite(ps[i + 2])) { a[key] = ps[i + 2] & 255; i += 2; }
          else if (ps[i + 1] === 2) {
            const [r, g, bl] = [ps[i + 2], ps[i + 3], ps[i + 4]].map((v) => (Number.isFinite(v) ? v & 255 : 0));
            a[key] = `rgb(${r},${g},${bl})`;
            i += 4;
          }
        }
      }
      this.attr = Object.keys(a).length ? a : DEF;
    }

    // ------------------------------------------------------------ rendering
    rowHtml(row, curX) {
      let end = this.cols;
      if (curX < 0) while (end > 0 && row.c[end - 1] === " " && row.a[end - 1] === DEF) end--;
      let h = "", x = 0;
      while (x < end) {
        if (x === curX) {
          const st = styleOf(row.a[x]);
          h += `<span class="term-cur"${st ? ` style="${st}"` : ""}>${escH(row.c[x])}</span>`;
          x++;
          continue;
        }
        const a = row.a[x];
        let s = "";
        while (x < end && row.a[x] === a && x !== curX) s += row.c[x++];
        const st = styleOf(a);
        h += st ? `<span style="${st}">${escH(s)}</span>` : escH(s);
      }
      return h || " ";
    }

    schedule() { if (!this.raf) this.raf = requestAnimationFrame(() => this.render()); }

    render() {
      this.raf = 0;
      const root = this.root, b = this.buf;
      const stick = root.scrollHeight - root.scrollTop - root.clientHeight < this.ch * 2;
      const cur = this.modes.cursor ? b.y : -1;
      if (this.lastCur !== cur) { this.dirty.add(this.lastCur); this.dirty.add(cur); }
      if (cur >= 0) this.dirty.add(cur);
      for (const y of this.dirty) {
        if (y < 0 || y >= this.rows) continue;
        this.rowEls[y].innerHTML = this.rowHtml(b.lines[y], y === cur ? Math.min(b.x, this.cols - 1) : -1);
      }
      this.dirty.clear();
      this.lastCur = cur;
      // keep the (invisible) input at the cursor: phones scroll the focused element into view
      this.input.style.top = `${this.screenEl.offsetTop + b.y * this.ch}px`;
      this.input.style.left = `${Math.min(b.x * this.cw, root.clientWidth - 20)}px`;
      if (stick) root.scrollTop = root.scrollHeight;
    }

    scrollToBottom() { this.root.scrollTop = this.root.scrollHeight; }

    // ------------------------------------------------------------ input
    send(data) {
      if (this.ctrlOnce && data.length === 1) {
        const c = ctrlChar(data);
        if (c) data = c;
        this.setCtrl(false);
      }
      this.scrollToBottom();
      this.onData(data);
    }

    setCtrl(on) { this.ctrlOnce = on; this.onCtrl(on); }

    paste(text) {
      text = text.replace(/\r\n?/g, "\n").replace(/\n/g, "\r");
      if (this.modes.paste) text = `\x1b[200~${text}\x1b[201~`;
      this.scrollToBottom();
      this.onData(text);
    }

    // escape sequence for a special key (or null: let the textarea handle it)
    keySeq(e) {
      const mod = 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0);
      const csi = (n, fin) => (mod > 1 ? `\x1b[${n};${mod}${fin}` : n === 1 ? `\x1b[${fin}` : `\x1b[${n}${fin}`);
      const tilde = (n) => (mod > 1 ? `\x1b[${n};${mod}~` : `\x1b[${n}~`);
      const arrows = { ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D", Home: "H", End: "F" };
      if (arrows[e.key]) return mod === 1 && this.modes.appCursor ? `\x1bO${arrows[e.key]}` : csi(1, arrows[e.key]);
      switch (e.key) {
        case "Enter": return e.altKey ? "\x1b\r" : "\r";
        case "Tab": return e.shiftKey ? "\x1b[Z" : "\t";
        case "Escape": return "\x1b";
        case "Backspace": return (e.altKey ? "\x1b" : "") + (e.ctrlKey ? "\x08" : "\x7f");
        case "Insert": return tilde(2);
        case "Delete": return tilde(3);
        case "PageUp": return e.shiftKey ? null : tilde(5);
        case "PageDown": return e.shiftKey ? null : tilde(6);
        default: break;
      }
      const f = /^F(\d{1,2})$/.exec(e.key);
      if (f) {
        const n = +f[1];
        if (n <= 4) return mod > 1 ? `\x1b[1;${mod}${"PQRS"[n - 1]}` : `\x1bO${"PQRS"[n - 1]}`;
        const codes = { 5: 15, 6: 17, 7: 18, 8: 19, 9: 20, 10: 21, 11: 23, 12: 24 };
        return codes[n] ? tilde(codes[n]) : null;
      }
      const altGr = e.getModifierState?.("AltGraph") || (e.ctrlKey && e.altKey);
      if (e.key.length === 1 && !altGr && !e.metaKey) {
        if (e.ctrlKey && !e.shiftKey) {
          // Ctrl+C with selected text = copy
          if (e.key.toLowerCase() === "c" && String(window.getSelection())) return null;
          if (e.key.toLowerCase() === "v") return null;  // paste event
          return ctrlChar(e.key);
        }
        if (e.altKey && !e.ctrlKey) return `\x1b${e.key}`;
      }
      return null;
    }

    bindInput() {
      const ta = this.input;
      const SENT = "  ";  // sentinel: Backspace on an "empty" input still produces an input event
      let last = SENT, composing = false;
      const clear = () => { ta.value = SENT; last = SENT; ta.setSelectionRange(SENT.length, SENT.length); };
      clear();
      ta.addEventListener("keydown", (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        const seq = this.keySeq(e);
        if (seq == null) return;
        e.preventDefault();
        this.send(seq);
      });
      // phone keyboards: diff the textarea against what has been sent so far
      ta.addEventListener("input", () => {
        const v = ta.value;
        let i = 0;
        while (i < last.length && i < v.length && last[i] === v[i]) i++;
        const del = last.length - i;
        const ins = v.slice(i).replace(/\r?\n/g, "\r");
        if (del || ins) {
          if (del) { this.scrollToBottom(); this.onData("\x7f".repeat(del)); }
          if (ins) { if (ins.length === 1) this.send(ins); else { this.scrollToBottom(); this.onData(ins); } }
        }
        last = v;
        if (!composing && (v.length < SENT.length || !v.startsWith(SENT) || ins.includes("\r") || v.length > 64)) clear();
      });
      ta.addEventListener("compositionstart", () => { composing = true; });
      ta.addEventListener("compositionend", () => {
        composing = false;
        setTimeout(() => { if (!composing && (ta.value.length > 64 || ta.value.length < SENT.length)) clear(); });
      });
      ta.addEventListener("paste", (e) => {
        e.preventDefault();
        const text = e.clipboardData?.getData("text") || "";
        if (text) this.paste(text);
      });
      ta.addEventListener("blur", () => this.root.classList.remove("focus"));
      ta.addEventListener("focus", () => { this.root.classList.add("focus"); clear(); });
      // tap / click focuses the input, unless text is being selected (copy)
      this.root.addEventListener("mouseup", () => { if (!String(window.getSelection())) this.focus(); });
      this.root.addEventListener("touchend", () => { if (!String(window.getSelection())) this.focus(); });
    }

    focus() { this.input.focus({ preventScroll: true }); }
  }

  function ctrlChar(k) {
    const c = k.toLowerCase();
    if (c >= "a" && c <= "z") return String.fromCharCode(c.charCodeAt(0) - 96);
    return { "@": "\x00", " ": "\x00", "2": "\x00", "[": "\x1b", "3": "\x1b", "\\": "\x1c", "4": "\x1c",
      "]": "\x1d", "5": "\x1d", "^": "\x1e", "6": "\x1e", "_": "\x1f", "-": "\x1f", "/": "\x1f", "7": "\x1f",
      "?": "\x7f", "8": "\x7f" }[c] || null;
  }

  return Term;
})();
