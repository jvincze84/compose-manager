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
- **Project summary:** running/total containers, CPU, memory (incl. % of host),
  network and disk I/O, PIDs, published ports, compose file path
- **Per-service details:** state, health, image, ports, CPU and memory bars
- **Live logs** (Server-Sent Events) for a whole project or a single service,
  with tail size, follow and line-wrap options and error/warning highlighting
- Expand / collapse all, remembered filter and open cards (localStorage)
- Optional HTTP Basic auth
- Configurable app name (shown when installed on the home screen)

The UI is in Hungarian.

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
| `CMD_TIMEOUT` | `300` | Timeout (s) for start/stop/restart commands |

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
| `POST /api/projects/{name}/{start\|stop\|restart}` | Run an action, returns command output |
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
