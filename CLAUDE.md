# CLAUDE.md

Context for Claude Code sessions on this project. Keep it up to date when
architecture, conventions or decisions change.

## Project

Compose Manager: a mobile-first PWA, running in Docker, that manages the
`docker compose` projects on the host (list + status, start/stop/restart,
live logs, CPU/RAM stats). Single user, homelab use. See `README.md`
(English, user-facing) for features, configuration and API.

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
    ini, conf (first word = directive: nginx/Caddyfile/Dockerfile), sh, plain.
    Highlighter output must round-trip to the exact source text, or the caret drifts
    — test by stripping tags in node (`CodeEditor.highlight(mode, text)`).
    `detectIndent()` picks TAB / 2 / 4 spaces. Helpers: YAML auto-indent + list
    continuation, indent after `{[(` and HAProxy section lines, Tab/Shift+Tab block
    indent, Ctrl+/ comment (not JSON), Backspace removes one indent unit, TABs
    flagged in YAML, `setReadOnly()`. Edits go through `execCommand("insertText")` to
    keep undo. Wrap mode hides the gutter. Font 15px, 16px ≤ 720px (iOS zooms into
    inputs below 16px). Files > 300 kB are not highlighted. No CDN/library on purpose
    (offline PWA, no build step).
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
- No `node` on the host. For JS syntax checks use the locally available image
  (no pull needed):
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

Mentioned to the user, not requested yet: rename / delete / new folder in the file
browser (deliberately not implemented: every change must stay restorable from
backups — would need a trash / backup of deleted files first), editor tabs,
search/replace, `haproxy -c` validation, Up/Down/edit for projects outside
`COMPOSE_DIR` (e.g. `/docker-iac`).
