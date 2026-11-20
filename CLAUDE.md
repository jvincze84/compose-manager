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
    localStorage keys: `open`, `stateFilter`.
  - `sw.js`: network-first for the shell, never caches `/api/`.
    **Bump `CACHE` (`compose-manager-vN`) whenever static files change.**
- `Dockerfile`: `python:3.13-slim` + docker CLI and compose plugin copied from `docker:cli`.
- `docker-compose.yml`: mounts docker.sock and `/opt`, `/home` read-only **at the same
  path** (needed for `up -d` with the original compose files). Port `${PORT:-8095}`.

## Host environment (as of 2026-11)

- Host: Debian, Docker 29.x, Compose v5.x. 12 CPUs, 16 GB RAM.
- Host ports 8080 and 8090 are taken → default 8095.
- Existing compose projects live under `/opt/...` and `/home/vinyo/...`
  (e.g. paperless, jellyfin as project `opt`, webtop, runner, reservation).
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

Useful dummy project: a busybox `web` service with a healthcheck that becomes healthy
after ~8 s, a plain `worker`, and an `init` service that exits 0 — covers the
starting → running transition and the "exited 0 is fine" rule.

Do **not** redeploy the user's running instance (`docker compose up -d --build`)
unless asked — tell them the command instead.

## Decisions & rationale

- `stop` instead of `down`: projects are discovered from container labels; after
  `down` they would vanish from the list.
- Start uses `up -d` (applies compose file changes). Open question offered to the
  user, not yet answered: switch Start to plain `compose start` and add a separate
  "Up / update" button.
- Green only when truly started: healthcheck `healthy`, or no healthcheck and running
  ≥ `START_GRACE_SEC`. Exit code 0 containers don't count as failures.
- CPU % is per core (100 % = 1 core), as `docker stats` reports it; bars are
  normalised by `ncpu`.
- App name via env (`APP_NAME`, `APP_SHORT_NAME`) rather than a UI setting.

## Ideas / possible next steps

Mentioned to the user, not requested yet: `down` button + discovering compose files
on disk (so `down`ed / never-started projects appear), pull & recreate, view compose
file / `.env`, separate "Up" button (see open question above).
