# Compose Manager

A small, mobile-first web app (installable as a PWA) for managing the
`docker compose` projects running on a Docker host — from your phone or tablet.

It runs as a container itself and talks to the host's Docker daemon through the
Docker socket.

## Features

- **Project list** with live status, based on `docker compose ls -a`
  (auto-refresh every 10 s, search box, state filter chips)
- **Accurate status:** a project only turns green once *every* container is
  really up — healthchecks must report `healthy`, containers without a
  healthcheck must have been running for a few seconds
- **Start / Stop / Restart** per project (with confirmation for stop/restart)
- **Compose file directory** (`COMPOSE_DIR`, default `/docker-compose`):
  `docker-compose-*.yaml` files there get **Up / Down / Pull** buttons —
  projects appear even when they have no containers (after `down`)
- **Editor with file browser** for the whole `COMPOSE_DIR`: YAML, JSON,
  HAProxy, INI/TOML, nginx-style configs, shell, `.env`… with syntax
  highlighting, validation and **automatic backups of every change** (the
  original is always kept)
- **Project summary:** running/total containers, CPU, memory (incl. % of host),
  network and disk I/O, PIDs, published ports, compose file path
- **Per-service details:** state, health, image, ports, CPU and memory bars
- **Live logs** (Server-Sent Events) for a whole project or a single service,
  with tail size, follow and line-wrap options and error/warning highlighting
- Expand / collapse all, remembered filter and open cards (localStorage)
- Optional HTTP Basic auth
- Configurable app name (shown when installed on the home screen)

## Quick start

```bash
git clone <this-repo> compose-manager
cd compose-manager
cp .env.example .env      # set AUTH_USER / AUTH_PASSWORD!
docker compose up -d --build
```

Open `http://<host>:8095`.

## Configuration

All settings are environment variables (put them in `.env`, which
`docker-compose.yml` loads automatically).

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8095` | Host port (used by `docker-compose.yml`) |
| `AUTH_USER` / `AUTH_PASSWORD` | *(empty)* | Enables HTTP Basic auth when both are set. **Strongly recommended.** |
| `APP_NAME` | `Compose Manager` | Page title, header and PWA name |
| `APP_SHORT_NAME` | `APP_NAME` (or `Compose`) | Name under the home-screen icon (~12 chars fit) |
| `SELF_PROJECT` | `compose-manager` | Compose project of this app; it cannot be stopped from the UI |
| `START_GRACE_SEC` | `5` | A container without a healthcheck counts as "started" after running this long |
| `STATS_CACHE_SEC` | `4` | How long `docker stats` results are cached |
| `CMD_TIMEOUT` | `300` | Timeout (s) for start/stop/restart/up/down commands |
| `PULL_TIMEOUT` | `1800` | Timeout (s) for the `pull` step of **Pull** |
| `BACKUP_KEEP` | `10` | Previous versions kept per edited file (see *Backups*) |
| `EDIT_EXTENSIONS` | `yaml,yml,json,conf,cfg,cnf,ini,toml,env,txt,md,sh,cmd,bat,xml,properties,service,timer,lua,py,js,css,html,j2,tmpl,template` | Extensions the editor may **write** (everything can be viewed) |
| `EDIT_FILENAMES` | `.env,.env-*,.env.*,Caddyfile,Dockerfile,Makefile,crontab` | Additional editable file names (glob patterns) |
| `COMPOSE_DIR` | `/docker-compose` | Directory of `docker-compose-*.yaml` / `run-*.cmd` / `.env-*` files (see below) |

### Mounting compose files

`docker-compose.yml` mounts `/opt` and `/home` **read-only at the same path**
as on the host. This matters for **Start**:

- If all compose files of a project are readable inside the container, Start
  runs `docker compose -p <name> -f <files…> up -d --remove-orphans`
  (so changes to the compose file are applied).
- Otherwise it falls back to `docker compose -p <name> start`, which only works
  if the containers still exist.

If your compose projects live elsewhere, add those directories to `volumes`
(same path inside and outside, `:ro` is enough). Relative bind mounts and
`.env` files next to the compose file keep working because the paths are
identical. Variables exported only in your host shell are **not** visible
to the container.

### Compose file directory (`COMPOSE_DIR`)

Mount it **read-write at the same path** as on the host (relative bind mounts
such as `./data/...` are resolved by the Docker daemon on the host).

| File | Meaning |
|---|---|
| `docker-compose-<key>.yaml` / `.yml` | one project ("stack") each |
| `run-<key>.cmd` / `.sh` *(optional)* | the command you used to run it, e.g. `docker-compose -p immich-app -f /docker-compose/docker-compose-immich.yaml --project-directory /docker-compose --env-file=/docker-compose/.env-immich up -d`. It is **never executed** — only `-p`, `-f`, `--project-directory`, `--env-file` and `--profile` are read from it (matched to the YAML through `-f`). |
| `.env-<key>`, `.env-<key>-*` | editable env files of the stack |

Without a `run-*.cmd`: project name = the YAML's top-level `name:` or `<key>`,
project directory = `COMPOSE_DIR`, `--env-file .env-<key>` if it exists.

For these projects:

- **Up** = `docker compose <args> up -d --remove-orphans`,
  **Down** = `… down --remove-orphans` (volumes are kept),
  **Start** = plain `compose start` (use Up to apply file changes).
- **Pull** = `pull` → `down --remove-orphans` → `up -d --remove-orphans`, with
  live output on the card. Images are pulled *before* the project is taken
  down, so downtime is short and a failed pull (registry down, bad tag) leaves
  the project running untouched. The job runs server-side: closing the page or
  losing the connection does not leave the project stopped half-way. Not
  available for the app's own project.
- **Edit** (✎ on the card) opens the editor with the project's YAML and
  `.env-*` files; see *Editor* below.

### Editor (`✎ Editor` button)

A full-screen editor with a **file browser** for the whole `COMPOSE_DIR`
(on phones the file list slides over the editor; 📁 toggles it).

- **Everything is shown, only whitelisted files are editable**
  (`EDIT_EXTENSIONS`, `EDIT_FILENAMES`). Other text files open read-only;
  binary, non-UTF-8 and >1 MiB files are not displayed. Symlinks pointing
  outside `COMPOSE_DIR`, `..` and the backup directory are refused.
- Dependency-free code editor (no CDN, works offline as a PWA): syntax
  highlighting for **YAML, JSON, `.env`, HAProxy, INI/TOML/systemd,
  nginx/Caddyfile/Dockerfile-style configs and shell**, detected from the file
  name (can be overridden in the footer); line numbers; auto-indent (YAML
  `key:` / list continuation, after `{ [ (`, after HAProxy section lines);
  the indent unit (2/4 spaces or TAB) is detected from the file;
  Tab / Shift+Tab block indent, Ctrl+/ comment toggle, Ctrl+S save; TABs are
  flagged in YAML. CRLF line endings are preserved.
- **✓ Check** validates without saving: `docker compose config -q` for files
  used by a stack (`-f` / `--env-file`), YAML parse for other `.yaml/.yml`,
  JSON parse for `.json`. Errors mark and jump to the offending line. Saving
  runs the same check and asks before writing an invalid file. A concurrent
  change on disk is detected (HTTP 409).
- **Save + Up** appears for files used by a stack.
- Files are rewritten in place, so owner and permissions are preserved.

### Backups

Every save backs up the previous content first, in
`COMPOSE_DIR/.compose-manager-backup/<same relative path>`:

- `<file>.original` — the content before the **first** save through this app
  (or the oldest backup that already existed). **Never pruned.**
- `<file>.<YYYYmmdd-HHMMSS-µs>` — the content before each later save; the last
  `BACKUP_KEEP` (default 10) are kept per file.
- The directory is root-only (`0700`), since `.env` files hold secrets.
  Saving identical content creates no backup.

In the editor, **🕘** lists them (⭐ = original). Tapping one loads it into the
editor *without* touching the file — **Save** restores it (backing up the
current version first), "Current" discards it. **±** shows a unified diff
between that backup and the editor's current content.

## How it works

- Projects are discovered from Docker container labels
  (`com.docker.compose.project`, `…config_files`, …) via `docker compose ls -a`.
  The app stores no state of its own.
- **Stop** uses `docker compose stop`, not `down`: containers are kept, so the
  project stays in the list and can be started again. After a `down` a project
  disappears, because its containers (and their labels) are gone.
- Status comes from `docker inspect` of every compose container:

  | State | Meaning |
  |---|---|
  | 🟢 running | all containers up (healthy / past the grace period) |
  | 🔵 starting | a container is `created`, `health: starting` or within the grace period |
  | 🟡 unhealthy | running, but a healthcheck reports `unhealthy` |
  | 🟡 partial | a container exited with a non-zero code, is restarting, dead or paused |
  | 🔴 stopped | nothing is running |

  Containers that exited with code 0 (init/migration jobs) don't spoil
  a green status. One-off `docker compose run` containers are ignored.

### API

| Method & path | Description |
|---|---|
| `GET /api/projects` | Projects with state |
| `GET /api/projects/{name}/services` | Containers of a project (`compose ps -a`) |
| `POST /api/projects/{name}/{start\|stop\|restart\|up\|down}` | Run an action, returns command output (`up`/`down` only for `COMPOSE_DIR` stacks) |
| `POST /api/projects/{name}/pull` | pull → down → up; NDJSON stream of `{"step"}`, `{"line"}`, final `{"done", "ok"}` (409 if already running) |
| `GET /api/fs/list?path=` | Directory listing (paths are relative to `COMPOSE_DIR`), `editable` per entry |
| `GET /api/fs/file?path=` | File content + `hash`, `editable`, `binary`, `eol`, `stacks` using it |
| `PUT /api/fs/file` | Save `{path, content, hash, force, eol}`; 422 if validation fails, 409 on conflict, 403 if not whitelisted |
| `POST /api/fs/validate` | Validate `{path, content}` without saving (`ok`, `checked`, `output`, `line`) |
| `GET /api/fs/backups?path=` | Backups, newest first, `original` last |
| `GET /api/fs/backup?path=&id=` | Content of one backup (`id` = timestamp or `original`) |
| `POST /api/fs/diff` | Unified diff of `{path, id}` backup vs. `{content}` |
| `GET /api/projects/{name}/logs?tail=200&follow=true&service=` | Log stream (SSE) |
| `GET /api/stats` | CPU / memory / IO per project and container |

## PWA / installing on a phone

"Add to Home Screen" and the service worker require **HTTPS** (or
`localhost`), so put the app behind a reverse proxy (Traefik, Caddy,
Nginx Proxy Manager, …). Disable response buffering for the log stream
(nginx: `proxy_buffering off;` — the app also sends `X-Accel-Buffering: no`).

The app name is captured at install time; after changing `APP_NAME`
reinstall the app (Chrome on Android may also update it by itself later).

## Security

Access to `/var/run/docker.sock` is effectively **root on the host**.
Always set `AUTH_USER` / `AUTH_PASSWORD` and do not expose the app directly to
the internet — use a VPN (WireGuard, Tailscale, …) or an authenticating
reverse proxy.

## Development

```
app/main.py            FastAPI backend (wraps the docker / docker compose CLI)
app/static/            Frontend: plain HTML/CSS/JS, no build step
  index.html           {{APP_NAME}} placeholders are filled in by the backend
  app.js, style.css
  sw.js                service worker (bump CACHE when static files change)
  manifest.webmanifest name/short_name are overridden by the backend
Dockerfile             python:slim + docker CLI & compose plugin from docker:cli
docker-compose.yml     deployment
```

Rebuild and redeploy:

```bash
docker compose up -d --build
```
