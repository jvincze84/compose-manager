# CLAUDE.md

Context for Claude Code sessions on this project. Keep it up to date when
architecture, conventions or decisions change.

## Project

Compose Manager: a mobile-first PWA, running in Docker, that manages the
`docker compose` projects on the host (list + status, start/stop/restart,
live logs, CPU/RAM stats, per-container restart and shell). Single user,
homelab use. See `README.md` (English, user-facing) for features,
configuration and API.

## Language conventions

- **Talk to the user in Hungarian.**
- Everything in the repo is **English**: UI strings, backend error messages, code
  comments, config file comments, `README.md`, `CLAUDE.md` (switched from Hungarian
  in 2026-11 at the user's request — don't reintroduce Hungarian text).
- Dates/times in the UI use the browser locale (`toLocaleString(undefined, …)`).

## Architecture

- `app/main.py` — FastAPI, single file. No database, no state on disk: everything is
  derived from the docker / docker compose CLI (`asyncio.create_subprocess_exec`,
  never a shell; args are always lists).
  - `list_projects()` → `docker compose ls -a --format json`
  - `project_containers()` → `docker ps -aq` + one `docker inspect` with a Go template
    → `project_state()` / `container_phase()` compute the project state
    (`running | starting | unhealthy | partial | stopped`). Falls back to parsing
    `compose ls` status (`summarize_status`) if inspect fails.
  - `collect_stats()` → one `docker ps` + one `docker stats --no-stream` (~2 s) for all
    containers, grouped by compose label, cached `STATS_CACHE_SEC` behind an asyncio lock.
  - Actions: `start` = `up -d --remove-orphans` with `-f` files if all config files are
    readable in the container, else `compose start`. `stop`/`restart` = plain compose.
    Stopping `SELF_PROJECT` is refused.
  - `COMPOSE_DIR` stacks (`discover_stacks()`, re-scanned per request): every
    `docker-compose-<key>.yaml` → one stack; `run-*.cmd` is parsed with `shlex`
    (never executed) for `-p/-f/--project-directory/--env-file/--profile`, matched
    via its `-f`. `stack_args()` builds the compose args. Stacks are merged into
    `/api/projects` by project name (`stack` field); stacks without containers get
    state `absent`. `up`/`down` only for stacks; Start on a stack = plain `start`.
  - Pull (stacks only, not `SELF_PROJECT`): `pull_job()` runs pull → down → up as an
    `asyncio` task (`_pull_jobs`, one per project, 409 otherwise) feeding a queue;
    `POST /api/projects/{name}/pull` streams it as NDJSON (+ `{"ping"}` every 15 s).
    The task survives client disconnect on purpose. Pull failure → stop, nothing is
    taken down; down failure → up is still attempted. `PULL_TIMEOUT` (1800 s) for
    the pull step. The generic `/{action}` route is registered first, so it
    forwards `pull` to `api_pull`. Frontend: `doPull()` reads the stream with
    `fetch` + reader into `state.output[name]` (`running` flag keeps the outbox
    scrolled to the bottom across re-renders).
  - File editor (`/api/fs/*`, paths relative to `COMPOSE_DIR`): `resolve_rel()` refuses
    `..`, NUL, symlinks resolving outside the root and the backup dir. Listing shows
    everything (max `LIST_LIMIT` = 2000 per dir, hides `.cm-tmp-*` and the backup dir);
    writing only if `is_editable_name()` (`EDIT_EXTENSIONS` + `EDIT_FILENAMES` globs;
    empty env value = default). Read returns `binary` / `tooLarge` / `encodingError`
    (→ read-only), `eol` (CRLF is converted to LF for the textarea and back on save),
    `stacks` (projects using the file). `validate_content()`: stack files/env files →
    `docker compose config -q` with a temp copy substituted; other YAML → PyYAML;
    JSON → `json`; returns `line` for the UI. PUT: sha256 conflict check (409),
    validation (422 unless `force`), no-op if unchanged, backup, in-place write.
    `POST /api/fs/new {dir, name}`: plain name only, whitelisted types only, `O_EXCL`
    (never overwrites; a symlink with that name is refused), chowned to the parent
    dir's owner; a top-level `docker-compose-*.yaml` gets `NEW_FILE_TEMPLATES["compose"]`.
    No rename / delete on purpose (every change must stay restorable from backups).
  - Backups: `COMPOSE_DIR/.compose-manager-backup/<rel path>.<id>`; `<file>.original`
    = content before the first save (or the oldest pre-existing timestamped backup
    is renamed to it) and is **never pruned**; `<file>.<%Y%m%d-%H%M%S-%f>` before
    every save, pruned to `BACKUP_KEEP`. Root dir forced to 0700. Restore has no
    endpoint on purpose: the UI loads the backup and the normal Save writes it.
    `POST /api/fs/diff` = difflib unified diff backup → editor content.
  - Single containers (`/api/projects/{name}/containers/{container}/…`):
    `project_container()` checks `CONTAINER_RE` and that the container's
    `com.docker.compose.project` label equals the project (via `docker inspect`,
    commands then use the container ID). `restart` = `docker restart`.
  - Exec (shell): `POST …/containers/{c}/exec {cols, rows, shell, root}` (`EXEC_SHELLS`:
    auto = bash if present else sh, bash, sh; `root` → `-u 0`) → `ExecSession` in
    `_exec_sessions` (max `EXEC_MAX_SESSIONS` = 8). `docker exec -it` runs on a
    `pty.openpty()` pair (the docker CLI is a session leader with the pty as
    controlling tty via `preexec_fn` → `TIOCSWINSZ` on the master delivers SIGWINCH
    = resize). `--detach-keys ctrl-^,ctrl-@` so Ctrl+P works in the shell.
    Master fd read with `loop.add_reader` → incremental UTF-8 decoder → queue;
    reader paused above 256 queued chunks (backpressure). `GET /api/exec/{id}/stream`
    = SSE (JSON strings, coalesced; `event: end` + exit code), `POST /input {data}`,
    `/resize`, `/close` (POST so `sendBeacon` can use it). Session is killed after
    `EXEC_IDLE_SEC` (60) with no stream attached. **Killing `docker exec` does not
    stop the process in the container** (verified), so each shell gets
    `CM_EXEC=<random marker>` (not the session id) and `close()` runs `EXEC_KILL`
    via `docker exec` **as the shell's user** (`-u 0` only for root shells: without
    CAP_SYS_PTRACE even root can't read another uid's `/proc/*/environ` — verified):
    HUP, then KILL every process whose environ has the marker. SSE + POST instead of
    WebSocket on purpose: the basic auth middleware is HTTP-only, uvicorn would need
    `websockets`, proxies need no setup.
  - Logs: SSE (`StreamingResponse`), JSON-encoded lines, `event: end` when the process
    exits, `: ping` keep-alive every 15 s; subprocess is killed on client disconnect.
  - Validation: project names `^[a-z0-9][a-z0-9_-]*$`, must exist in `compose ls`;
    service names `SERVICE_RE`.
  - Basic auth middleware (only when `AUTH_USER` and `AUTH_PASSWORD` are both set).
  - `/` and `/manifest.webmanifest` are rendered by the backend to inject
    `APP_NAME` / `APP_SHORT_NAME` (`{{APP_NAME}}` placeholders in `index.html`,
    HTML-escaped). Everything else in `app/static` is served by `StaticFiles`.
- `app/static/` — plain HTML/CSS/JS, no framework, no build step.
  - `app.js`: one global `state` object, `render()` rebuilds the project list with
    template strings (always `esc()` user/docker data!). Event delegation via
    `data-act` attributes. `loadStats()` runs in parallel with `loadProjects()`.
    Refresh every 10 s; every 2 s while any project is `starting`.
    localStorage keys: `open`, `stateFilter`. Single-column card list.
    Filter chips = `STATE_FILTERS` (key -> [label, predicate]); single-select. State
    filters + `withfile` / `nofile` (has / lacks a `COMPOSE_DIR` stack, `p.stack`);
    `starting` / `problem` are hidden while empty, the file filters while no stacks exist.
    The editor UI lives in `files.js` (loaded after `app.js`, uses its globals).
    Action output (card and editor) = `.outbox`: collapsible (▾) and closable (✕).
    Container rows: ↻ (`crestart`, `state.busyCtr`), `>_` (`exec`, running only), Log.
  - `files.js`: editor overlay (`#editor`, global `ed` object) = file browser
    (`#ed-tree`: side panel ≥ 900 px, overlay on phones) + code editor + backups panel
    (`#ed-backups`) + output (`#ed-output`). `openFileEditor()` (✎ Editor button, reopens
    last dir/file from localStorage `edDir` / `edFile`; `edOnlyEdit` filter) and
    `openEditor(project, file)` (card button; stack files in the `#ed-file` quick
    select). Back button / `popstate` → `editorPopstate()` (closes tree first on
    phones); unsaved changes are confirmed.
  - `editor.js`: `CodeEditor` — dependency-free code editor: transparent `<textarea>`
    over a highlighted `<pre>` + line-number gutter, synced by `transform` on scroll.
    Modes (`modeFor(filename)`, overridable in the footer): yaml, json, env, haproxy,
    ini, conf (first word = directive: nginx/Caddyfile/Dockerfile), sh, bind
    (`named.conf*`, token based incl. `/* */`), zone (`db.*`, `*.zone`; tracks `( )`
    across lines), plain. `LINE_COMMENT` = per-mode Ctrl+/ marker.
    Highlighter output must round-trip to the exact source text, or the caret drifts
    — test by stripping tags in node (`CodeEditor.highlight(mode, text)`).
    `detectIndent()` picks TAB / 2 / 4 spaces. Helpers: YAML auto-indent + list
    continuation, indent after `{[(` and HAProxy section lines, Tab/Shift+Tab block
    indent, Ctrl+/ comment (not JSON), Backspace removes one indent unit, TABs
    flagged in YAML, `setReadOnly()`. Edits go through `execCommand("insertText")` to
    keep undo. Wrap mode hides the gutter.
    Selected word: `sel` / `selUpdate()` (rAF-debounced on select, keyup, mouseup,
    touchend and `selectionchange`) → all occurrences painted as `mark.sel` in the
    same `.code-marks` layer, only while no search is open; whole-word match if the
    selection is a whole word, substring otherwise, case-sensitive, single line,
    ≤ 200 chars; `onSelMatches(n)` → `#ed-occ` button in the footer.
    Multi-edit (`multiEdit()` toggle = `#ed-occ` click, or Ctrl+Shift+L; explicit on
    purpose — the user chose it over "always", so a single occurrence can still be
    retyped normally): `multi.ranges` (positions, copied from `sel.matches`),
    `primary` = the one holding the caret. `beforeinput` (insertText / paste /
    delete*) is cancelled and recomputed as "new word" → `multiApply()` writes it into
    every range with ONE `replace()` over the span first..last (one undo step; scroll
    restored). Non-cancelable / IME composition: native change, then `multiFromDiff()`
    (at `compositionend` / `input`) copies the primary's new text to the others, or
    stops if text outside the primary changed. `multi.text` = expected value; any other
    change (file load in `paint()`), caret outside all ranges (`selUpdate`), Esc, Enter,
    Tab, Ctrl+/, undo/redo, search → `multiStop()`. Painted as `mark.multi`.
    Tested in node with a fake textarea + `execCommand` stub.
    Search: `search(query, {caseSens, regex})` / `findNext(dir)` / `replaceCurrent()` /
    `replaceAll()` (one `insertText` = one undo step); matches are painted as `<mark>`s
    in `.code-marks`, a transparent copy of the text under `.code-hl` (same transform),
    current match scrolled into view via its `offsetTop/Left`; `onSearch` callback.
    Find bar UI (`#ed-find`) + Ctrl+F / Ctrl+H / F3 / Esc live in `files.js`;
    localStorage `edFindCase`, `edFindRegex`. Font 15px, 16px ≤ 720px (iOS zooms into
    inputs below 16px). Files > 300 kB are not highlighted. No CDN/library on purpose
    (offline PWA, no build step).
  - `term.js`: `Term` — dependency-free terminal emulator (VT100/xterm subset):
    buffer of rows (`{c: chars[], a: attrs[]}`, attrs = shared frozen objects, `DEF`
    = default), one `<div>` per screen row re-rendered when dirty (rAF), scrolled-off
    lines appended to `.term-sb` (max 2000). Parser states: ground / ESC / CSI / OSC /
    charset / ignored strings. CSI @ A–H J K L M P S T X d f m r s u h l n c,
    DEC modes 1 (app cursor), 6, 7, 25, 47/1047/1049 (alt screen), 2004 (bracketed
    paste); DEC line drawing (`ESC ( 0`, SO/SI). Wide chars = 1 cell (known
    limitation). Input: hidden `.term-input` textarea kept at the cursor (phones
    scroll it into view); `keySeq()` for special keys / Ctrl / Alt (AltGr = plain
    char, Hungarian layout!), printable text via the `input` event **diffed against
    a 2-space sentinel** (works with IME / autocorrect / Backspace on phone
    keyboards). Test logic in node with DOM stubs (feed `write()`, dump `buf.lines`).
  - `exec.js`: the `#termview` overlay (`openExec` / `closeExec`, back button via
    `history.state.exec`), SSE + ordered/coalesced input POSTs, resize debounce,
    key bar (`#term-keys`, pointerdown cancelled to keep the keyboard open; sticky
    Ctrl; Paste via `navigator.clipboard`), view sized to `visualViewport` (on-screen
    keyboard), font size A−/A+ in the key bar (localStorage `termFont`), shell select +
    root toggle in the header (`termShell`, `termRoot`; change = reconnect),
    `sendBeacon` close on pagehide. Uses `jsonPost()` from `files.js`.
  - **All scripts share one global scope** (classic `<script>`s): a top-level
    `const`/`let`/`class` declared in two files is a SyntaxError that silently kills
    the whole later file (happened with `jsonPost` → the exec button did nothing).
    Check for duplicates and load all files into one `vm` context in node (stub DOM).
  - `sw.js`: network-first for the shell, never caches `/api/`.
    **Bump `CACHE` (`compose-manager-vN`) whenever static files change.**
- `Dockerfile`: `python:3.13-slim` + docker CLI and compose plugin copied from `docker:cli`.
  Python deps: fastapi (0.165.x), uvicorn, PyYAML (editor validation); `starlette>=1.3.1`
  is pinned explicitly because older versions have known CVEs (checked with pip-audit).
- `docker-compose.yml`: mounts docker.sock and `/opt`, `/home` read-only **at the same
  path** (needed for `up -d` with the original compose files). Port `${PORT:-8095}`.
  `${COMPOSE_DIR:-/docker-compose}` is mounted **read-write**, same path.

## Host environment (as of 2026-11)

- Host: Debian, Docker 29.x, Compose v5.x.
- Host ports 8080 and 8090 are taken → default 8095.
- Existing compose projects: `/docker-compose/docker-compose-*.yaml` started via
  `run-*.cmd` (frigate, immich-app, gitea-runner, scp-server; immich's YAML says
  `name: immich` but runs as `-p immich-app`), `/docker-iac/<name>/docker-compose.yaml`
  (forgejo, haproxy, openbao, semaphore, vaultwarden, directory-list),
  this app at `/opt/compose-manager`. `.env-*` files contain secrets — don't print them.
- **Never stop/restart the user's real projects for testing.**
- No `node` on the host. For JS syntax checks use this image (pulled 2026-11-24;
  ~GBs, now cached locally):
  `docker run --rm --network none -v "$PWD/app/static/app.js:/tmp/app.js:ro" docker.gitea.com/runner-images:ubuntu-latest node --check /tmp/app.js`
- No headless browser is set up. A Playwright container run was declined once —
  ask before pulling large images. UI changes so far were not visually tested;
  say so honestly when reporting.

## Testing workflow

There are no automated tests. Manual procedure used so far:

```bash
docker build -q -t compose-manager:latest .
docker run -d --name cm-test -p 127.0.0.1:18099:8080 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /tmp/claude-1000:/tmp/claude-1000:ro compose-manager:latest
curl -s localhost:18099/api/projects | python3 -m json.tool
# dummy compose project in the session scratchpad for start/stop/restart tests
docker rm -f cm-test        # always clean up
docker compose -p cmtest down
```

For `COMPOSE_DIR` tests: put a `docker-compose-cmtest.yaml`, `run-cmtest.cmd` and
`.env-cmtest` into a scratchpad dir and run the test container with
`-e COMPOSE_DIR=<dir> -v <dir>:<dir>`. Real `/docker-compose` may be mounted `:ro`
for read-only discovery checks (GET only).

Useful dummy project: a busybox `web` service with a healthcheck that becomes healthy
after ~8 s, a plain `worker`, and an `init` service that exits 0 — covers the
starting → running transition and the "exited 0 is fine" rule.

Do **not** redeploy the user's running instance (`docker compose up -d --build`)
unless asked — tell them the command instead.

## Decisions & rationale

- `stop` instead of `down`: projects are discovered from container labels; after
  `down` they would vanish from the list.
- Pull order is pull → down → up (user asked for down → pull → up; changed for
  shorter downtime and safety on pull failure — explained to the user).
- Start uses `up -d` (applies compose file changes) for projects outside
  `COMPOSE_DIR`; for `COMPOSE_DIR` stacks there is a separate Up button, so Start is
  plain `compose start` there.
- Green only when truly started: healthcheck `healthy`, or no healthcheck and running
  ≥ `START_GRACE_SEC`. Exit code 0 containers don't count as failures.
- CPU % is per core (100 % = 1 core), as `docker stats` reports it; bars are
  normalised by `ncpu`.
- App name via env (`APP_NAME`, `APP_SHORT_NAME`) rather than a UI setting.

## Ideas / possible next steps

Mentioned to the user, not requested yet: wide-character support in `term.js`,
rename / delete / new folder in the file browser (deliberately not implemented: every change must stay restorable from
backups — would need a trash / backup of deleted files first), editor tabs,
`haproxy -c` / `named-checkconf` validation, Up/Down/edit for projects outside
`COMPOSE_DIR` (e.g. `/docker-iac`).
