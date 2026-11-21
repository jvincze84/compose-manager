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
- UI strings: Hungarian. Code comments: Hungarian (existing style) — either is fine,
  stay consistent within a file.
- `README.md`: English. `CLAUDE.md`: English.

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
  - File editor: `/api/files/{fname}` GET/PUT, only `COMPOSE_FILE_RE` / `ENV_FILE_RE`
    names directly in `COMPOSE_DIR` (no `/`). PUT: sha256 conflict check (409),
    `docker compose config -q` with a temp copy substituted (422 unless `force`),
    `POST /api/files/{fname}/validate` = same check without saving (`checked: false`
    if no stack uses the file via `-f` / `--env-file`),
    backup to `.compose-manager-backup/`, in-place write (keeps owner/mode).
  - Backups: `backup_file()` before every PUT → `<fname>.<%Y%m%d-%H%M%S-%f>` (older
    ones without `-%f` are still recognised, `BACKUP_ID_RE`), pruned to `BACKUP_KEEP`
    (env, default 10). Timestamps in names are container time (UTC); the UI shows
    mtime. `GET /api/files/{fname}/backups[/{id}]`. Restore has no endpoint on purpose:
    the UI loads the backup into the editor and the normal Save writes it (so the
    current version gets backed up, conflict check + validation still apply).
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
    Editor overlay (`#editor`, `ed` object) reuses the log view layout; back button /
    `popstate` closes overlays, unsaved changes are confirmed.
    Action output (card and editor) = `.outbox`: collapsible (▾) and closable (✕).
  - `editor.js`: `CodeEditor.create(root, textarea)` — dependency-free code editor:
    transparent `<textarea>` over a highlighted `<pre>` + line-number gutter, synced by
    `transform` on scroll. Line-based YAML / .env highlighters (`highlightYaml`,
    `highlightEnv`; output must round-trip to the exact source text, or the caret
    drifts — test by stripping tags in node). YAML helpers: auto-indent after `key:`,
    list continuation, Tab/Shift+Tab block indent, Ctrl+/ comment, Backspace removes
    2-space indent, TAB chars marked. Edits go through `execCommand("insertText")` to
    keep undo. Wrap mode hides the gutter. Font 15px, 16px ≤ 720px (iOS zooms
    into inputs below 16px). 🕘 button → backup list panel (`#ed-backups`, `ed.backup`). No CDN/library on purpose (offline PWA,
    no build step).
  - `sw.js`: network-first for the shell, never caches `/api/`.
    **Bump `CACHE` (`compose-manager-vN`) whenever static files change.**
- `Dockerfile`: `python:3.13-slim` + docker CLI and compose plugin copied from `docker:cli`.
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

Mentioned to the user, not requested yet: creating a new stack /
new `.env-*` file from the UI, Up/Down/edit for projects outside `COMPOSE_DIR`
(e.g. `/docker-iac`), search/replace in the editor.
