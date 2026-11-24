"""Compose Manager - manage the host's docker compose projects from a browser."""

import asyncio
import base64
import codecs
import difflib
import fcntl
import fnmatch
import hashlib
import html
import json
import os
import pty
import re
import secrets
import shlex
import struct
import termios
import time
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import yaml

STATIC_DIR = Path(__file__).parent / "static"
AUTH_USER = os.environ.get("AUTH_USER", "")
AUTH_PASSWORD = os.environ.get("AUTH_PASSWORD", "")
SELF_PROJECT = os.environ.get("SELF_PROJECT", "")
APP_NAME = os.environ.get("APP_NAME", "").strip() or "Compose Manager"
# shown under the home-screen icon on phones (about 12 characters fit)
APP_SHORT_NAME = os.environ.get("APP_SHORT_NAME", "").strip() or (
    "Compose" if APP_NAME == "Compose Manager" else APP_NAME)
CMD_TIMEOUT = int(os.environ.get("CMD_TIMEOUT", "300"))
# timeout of `docker compose pull` (large images on a slow line)
PULL_TIMEOUT = int(os.environ.get("PULL_TIMEOUT", "1800"))
STATS_CACHE_SEC = float(os.environ.get("STATS_CACHE_SEC", "4"))
# a container without a healthcheck counts as "really started" after running this long
START_GRACE_SEC = float(os.environ.get("START_GRACE_SEC", "5"))

# directory of compose files (mounted read-write at the same path as on the host)
COMPOSE_DIR = os.environ.get("COMPOSE_DIR", "/docker-compose").rstrip("/") or "/docker-compose"
MAX_FILE_SIZE = 1024 * 1024
# previous versions kept per file (COMPOSE_DIR/.compose-manager-backup)
BACKUP_KEEP = max(1, int(os.environ.get("BACKUP_KEEP", "10")))
BACKUP_DIR_NAME = ".compose-manager-backup"

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
SERVICE_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]*$")
CONTAINER_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]*$")
COMPOSE_FILE_RE = re.compile(r"^docker-compose-([A-Za-z0-9][A-Za-z0-9_.-]*?)\.ya?ml$")
ENV_FILE_RE = re.compile(r"^\.env(-[A-Za-z0-9][A-Za-z0-9_.-]*)?$")
RUN_FILE_RE = re.compile(r"^run-[A-Za-z0-9][A-Za-z0-9_.-]*\.(cmd|sh)$")

app = FastAPI(title="Compose Manager", docs_url=None, redoc_url=None)


# --------------------------------------------------------------------------- auth
@app.middleware("http")
async def basic_auth(request: Request, call_next):
    if AUTH_USER and AUTH_PASSWORD:
        ok = False
        header = request.headers.get("authorization", "")
        if header.lower().startswith("basic "):
            try:
                user, _, pwd = base64.b64decode(header[6:]).decode().partition(":")
                ok = secrets.compare_digest(user, AUTH_USER) and secrets.compare_digest(
                    pwd, AUTH_PASSWORD
                )
            except Exception:
                ok = False
        if not ok:
            return Response(
                status_code=401,
                headers={"WWW-Authenticate": 'Basic realm="Compose Manager"'},
            )
    return await call_next(request)


# ------------------------------------------------------------------------ helpers
async def run(*args: str, timeout: int = CMD_TIMEOUT) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return 124, f"Timed out ({timeout}s)"
    return proc.returncode, out.decode(errors="replace")


def parse_json_lines(text: str) -> list:
    """`docker compose ps --format json` returns an array or NDJSON depending on the version."""
    text = text.strip()
    if not text:
        return []
    if text.startswith("["):
        return json.loads(text)
    return [json.loads(line) for line in text.splitlines() if line.strip()]


async def list_projects() -> list[dict]:
    code, out = await run("docker", "compose", "ls", "-a", "--format", "json", timeout=30)
    if code != 0:
        raise HTTPException(500, out)
    return parse_json_lines(out)


async def get_project(name: str) -> dict:
    if not NAME_RE.match(name):
        raise HTTPException(400, "Invalid project name")
    for p in await list_projects():
        if p["Name"] == name:
            return p
    st = find_stack(name)
    if st:  # compose file exists but no containers (after down / never started)
        return {"Name": name, "Status": "", "ConfigFiles": ",".join(st["files"]), "absent": True}
    raise HTTPException(404, "No such project")


def config_files(project: dict) -> list[str]:
    return [f for f in (project.get("ConfigFiles") or "").split(",") if f]


def files_available(files: list[str]) -> bool:
    return bool(files) and all(os.path.isfile(f) for f in files)


def summarize_status(status: str) -> str:
    """Fallback if inspect fails: 'running(2), exited(1)' -> state."""
    s = status.lower()
    if "running" in s:
        return "partial" if re.search(r"exited|dead|created|paused|restarting", s) else "running"
    return "stopped"


def parse_docker_time(ts: str) -> float | None:
    """'2026-11-06T15:25:25.123456789Z' -> unix timestamp"""
    if not ts or ts.startswith("0001-"):
        return None
    ts = re.sub(r"\.(\d{6})\d*", r".\1", ts).replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(ts).timestamp()
    except ValueError:
        return None


def container_phase(c: dict, now: float) -> str:
    """One container: ok | starting | unhealthy | error | done | stopped"""
    st, health = c["status"], c["health"]
    if st == "running":
        if health == "starting":
            return "starting"
        if health == "unhealthy":
            return "unhealthy"
        if not health:
            started = parse_docker_time(c["startedAt"])
            if started and now - started < START_GRACE_SEC:
                return "starting"
        return "ok"
    if st == "created":
        return "starting"
    if st in ("restarting", "dead", "paused"):
        return "error"
    # exited
    return "done" if c["exitCode"] == 0 else "stopped"


def project_state(containers: list[dict]) -> str:
    """running | starting | unhealthy | partial | stopped"""
    now = time.time()
    phases = [container_phase(c, now) for c in containers]
    if not any(ph in ("ok", "starting", "unhealthy") for ph in phases):
        return "stopped"
    if "starting" in phases:
        return "starting"
    if "error" in phases or "stopped" in phases:
        return "partial"
    if "unhealthy" in phases:
        return "unhealthy"
    # containers that exited with code 0 (init / migration jobs) are not failures
    return "running"


async def project_containers() -> dict[str, list[dict]] | None:
    code, ids = await run("docker", "ps", "-aq", "--filter", "label=com.docker.compose.project", timeout=30)
    if code != 0:
        return None
    ids = ids.split()
    if not ids:
        return {}
    tmpl = ('{{index .Config.Labels "com.docker.compose.project"}}\t'
            '{{index .Config.Labels "com.docker.compose.oneoff"}}\t{{.Name}}\t'
            '{{.State.Status}}\t{{if .State.Health}}{{.State.Health.Status}}{{end}}\t'
            '{{.State.StartedAt}}\t{{.State.ExitCode}}')
    code, out = await run("docker", "inspect", "--format", tmpl, *ids, timeout=30)
    # a container may vanish between the two calls -> partial output is fine
    result: dict[str, list[dict]] = {}
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        project, oneoff, name, status, health, started, exit_code = parts[:7]
        if oneoff == "True":  # `docker compose run` containers
            continue
        result.setdefault(project, []).append({
            "name": name.lstrip("/"), "status": status, "health": health,
            "startedAt": started, "exitCode": int(exit_code) if exit_code.lstrip("-").isdigit() else 0,
        })
    return result


# ------------------------------------------------------------- compose files
# In COMPOSE_DIR: docker-compose-<key>.yaml, optionally run-<key>.cmd
# (e.g. `docker-compose -p immich-app -f ... --env-file=... up -d`) and .env-* files.
# run-*.cmd is NEVER executed, only the compose options are read from it.
VALUE_OPTS = {
    "-p": "project", "--project-name": "project",
    "-f": "files", "--file": "files",
    "--project-directory": "projectDir",
    "--env-file": "envFiles",
    "--profile": "profiles",
}


def compose_dir_ok() -> bool:
    return os.path.isdir(COMPOSE_DIR)


def abs_in_dir(path: str, base: str) -> str:
    return os.path.normpath(path if os.path.isabs(path) else os.path.join(base, path))


def parse_run_cmd(path: Path) -> dict | None:
    """The -p / -f / --env-file / ... options of the first compose command in run-*.cmd."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    text = re.sub(r"[\\^]\r?\n", " ", text)  # line continuation (sh: \, cmd: ^)
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith(("#", "::")) or line.lower().startswith("rem "):
            continue
        try:
            tokens = shlex.split(line)
        except ValueError:
            continue
        # "docker-compose ..." or "docker compose ..." (possibly after sudo / a full path)
        idx = None
        for i, t in enumerate(tokens):
            base = os.path.basename(t)
            if base in ("docker-compose", "docker-compose.exe"):
                idx = i + 1
                break
            if base in ("docker", "docker.exe") and i + 1 < len(tokens) and tokens[i + 1] == "compose":
                idx = i + 2
                break
        if idx is None:
            continue
        res: dict = {"project": None, "files": [], "projectDir": None, "envFiles": [], "profiles": []}
        it = iter(tokens[idx:])
        for t in it:
            if not t.startswith("-"):
                break  # subcommand (up, start, ...)
            opt, eq, val = t.partition("=")
            key = VALUE_OPTS.get(opt)
            if not key:
                continue  # other option (assumed to take no value)
            if not eq:
                val = next(it, "")
            if isinstance(res[key], list):
                res[key].append(val)
            else:
                res[key] = val
        return res
    return None


def yaml_name(path: Path) -> str | None:
    """Top-level `name:` of a compose file (simple regex, no YAML parser)."""
    try:
        m = re.search(r"^name:\s*['\"]?([A-Za-z0-9_-]+)['\"]?\s*(#.*)?$",
                      path.read_text(encoding="utf-8", errors="replace"), re.M)
    except OSError:
        return None
    return m.group(1).lower() if m else None


def discover_stacks() -> list[dict]:
    """"Stacks" built from the compose files in COMPOSE_DIR (one per project)."""
    if not compose_dir_ok():
        return []
    base = Path(COMPOSE_DIR)
    try:
        names = sorted(os.listdir(base))
    except OSError:
        return []
    env_names = [n for n in names if ENV_FILE_RE.match(n) and (base / n).is_file()]

    # run-*.cmd -> mapped to the files it passes with -f
    runs_by_file: dict[str, tuple[str, dict]] = {}
    for n in names:
        if RUN_FILE_RE.match(n):
            parsed = parse_run_cmd(base / n)
            if parsed:
                for f in parsed["files"]:
                    runs_by_file.setdefault(abs_in_dir(f, COMPOSE_DIR), (n, parsed))

    stacks: dict[str, dict] = {}
    for n in names:
        m = COMPOSE_FILE_RE.match(n)
        if not m or not (base / n).is_file():
            continue
        key = m.group(1)
        path = str(base / n)
        run_file, parsed = runs_by_file.get(path, (None, None))
        if parsed:
            project_dir = abs_in_dir(parsed["projectDir"] or COMPOSE_DIR, COMPOSE_DIR)
            files = [abs_in_dir(f, COMPOSE_DIR) for f in parsed["files"]]
            env_files = [abs_in_dir(e, COMPOSE_DIR) for e in parsed["envFiles"]]
            profiles = parsed["profiles"]
            project = (parsed["project"] or "").lower() or None
        else:
            project_dir, files, env_files, profiles, project = COMPOSE_DIR, [path], [], [], None
            if f".env-{key}" in env_names:
                env_files = [str(base / f".env-{key}")]
        if not project:
            project = yaml_name(base / n) or re.sub(r"[^a-z0-9_-]", "-", key.lower()).strip("-_")
        if not NAME_RE.match(project or "") or project in stacks:
            continue  # invalid, or another file already uses this project name

        # editable files: the stack's compose files + referenced and .env-<key>* env files
        editable = [os.path.basename(f) for f in files
                    if os.path.dirname(f) == COMPOSE_DIR and COMPOSE_FILE_RE.match(os.path.basename(f))]
        envs = [os.path.basename(e) for e in env_files if os.path.dirname(e) == COMPOSE_DIR]
        envs += [e for e in env_names if e == f".env-{key}" or e.startswith(f".env-{key}-")]
        if not env_files and ".env" in env_names and project_dir == COMPOSE_DIR:
            envs.append(".env")  # without --env-file compose reads .env
        editable += [e for e in dict.fromkeys(envs) if ENV_FILE_RE.match(e)]

        st = {"key": key, "project": project, "files": files, "projectDir": project_dir,
              "envFiles": env_files, "profiles": profiles, "runFile": run_file,
              "editable": list(dict.fromkeys(editable))}
        st["command"] = shlex.join(stack_args(st)[1:])
        stacks[project] = st
    return list(stacks.values())


def stack_args(st: dict, replace: dict[str, str] | None = None) -> list[str]:
    """`docker compose -p .. -f .. --project-directory .. --env-file ..` (replace: swap files)."""
    rep = replace or {}
    args = ["docker", "compose", "-p", st["project"]]
    for f in st["files"]:
        args += ["-f", rep.get(f, f)]
    args += ["--project-directory", st["projectDir"]]
    for e in st["envFiles"]:
        args += ["--env-file", rep.get(e, e)]
    for pr in st["profiles"]:
        args += ["--profile", pr]
    return args


def find_stack(name: str) -> dict | None:
    return next((s for s in discover_stacks() if s["project"] == name), None)


def public_stack(st: dict) -> dict:
    return {k: st[k] for k in ("key", "files", "envFiles", "projectDir", "profiles",
                               "runFile", "editable", "command")}


# --------------------------------------------------------------------------- API
@app.get("/api/projects")
async def api_projects():
    projects, containers = await asyncio.gather(list_projects(), project_containers())
    stacks = {s["project"]: s for s in discover_stacks()}
    result = []
    for p in projects:
        files = config_files(p)
        cs = (containers or {}).get(p["Name"])
        st = stacks.pop(p["Name"], None)
        result.append(
            {
                "name": p["Name"],
                "status": p.get("Status", ""),
                "state": project_state(cs) if cs else summarize_status(p.get("Status", "")),
                "configFiles": files,
                "filesAvailable": files_available(files),
                "self": p["Name"] == SELF_PROJECT,
                "stack": public_stack(st) if st else None,
            }
        )
    # compose file but no containers -> "absent"
    for st in stacks.values():
        result.append(
            {
                "name": st["project"],
                "status": "",
                "state": "absent",
                "configFiles": st["files"],
                "filesAvailable": files_available(st["files"]),
                "self": st["project"] == SELF_PROJECT,
                "stack": public_stack(st),
            }
        )
    result.sort(key=lambda x: x["name"])
    return result


@app.get("/api/projects/{name}/services")
async def api_services(name: str):
    if (await get_project(name)).get("absent"):
        return []
    code, out = await run("docker", "compose", "-p", name, "ps", "-a", "--format", "json", timeout=30)
    if code != 0:
        raise HTTPException(500, out)
    services = []
    for c in parse_json_lines(out):
        services.append(
            {
                "service": c.get("Service"),
                "name": c.get("Name"),
                "state": c.get("State"),
                "status": c.get("Status"),
                "health": c.get("Health", ""),
                "image": c.get("Image"),
                "ports": c.get("Publishers") or [],
            }
        )
    services.sort(key=lambda s: s["service"] or "")
    return services


@app.post("/api/projects/{name}/{action}")
async def api_action(name: str, action: str):
    if action == "pull":  # this route matches before the /pull route below
        return await api_pull(name)
    if action not in ("start", "stop", "restart", "up", "down"):
        raise HTTPException(400, "Unknown action")
    project = await get_project(name)
    if project["Name"] == SELF_PROJECT and action in ("stop", "down"):
        raise HTTPException(400, "Compose Manager cannot stop itself")

    stack = find_stack(name)
    files = config_files(project)
    if action in ("up", "down"):
        if not stack:
            raise HTTPException(400, f"No {COMPOSE_DIR}/docker-compose-*.yaml for this project")
        if not files_available(stack["files"]):
            raise HTTPException(400, "The compose file is not readable from the container")
        args = stack_args(stack) + (["up", "-d", "--remove-orphans"] if action == "up"
                                    else ["down", "--remove-orphans"])
        cmd = "up -d" if action == "up" else "down"
    elif project.get("absent"):
        raise HTTPException(400, "The project has no containers – use Up")
    elif stack:
        # for COMPOSE_DIR stacks Start is a plain `start` (file changes: Up button)
        args = stack_args(stack) + [action]
        cmd = action
    elif action == "start" and files_available(files):
        # `up -d` from the compose file: also creates missing containers
        args = ["docker", "compose", "-p", name]
        for f in files:
            args += ["-f", f]
        args += ["up", "-d", "--remove-orphans"]
        cmd = "up -d"
    else:
        # works without the compose file too (based on container labels)
        args = ["docker", "compose", "-p", name, action]
        cmd = action

    code, out = await run(*args)
    return JSONResponse(
        {"ok": code == 0, "command": cmd, "output": out},
        status_code=200 if code == 0 else 500,
    )


# ------------------------------------------------------------- pull (+ down + up)
_pull_jobs: dict[str, asyncio.Task] = {}  # project -> running pull task


async def run_stream(args: list[str], emit, timeout: int) -> int:
    """Run a command, passing its output line by line to emit()."""
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
    )

    async def pump() -> int:
        async for raw in proc.stdout:
            for part in raw.decode(errors="replace").replace("\r", "\n").split("\n"):
                if part.strip():
                    emit(part.rstrip())
        return await proc.wait()

    try:
        return await asyncio.wait_for(pump(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        emit(f"Timed out ({timeout}s)")
        return 124


async def pull_job(stack: dict, q: asyncio.Queue) -> None:
    """pull -> down -> up. If the pull fails nothing is taken down;
    if down fails, up is still attempted (so the project ends up running)."""
    base = stack_args(stack)
    steps = [
        ("pull", base + ["pull"], PULL_TIMEOUT),
        ("down", base + ["down", "--remove-orphans"], CMD_TIMEOUT),
        ("up -d", base + ["up", "-d", "--remove-orphans"], CMD_TIMEOUT),
    ]
    ok = True
    try:
        for label, args, timeout in steps:
            q.put_nowait({"step": label})
            code = await run_stream(args, lambda line: q.put_nowait({"line": line}), timeout)
            if code != 0:
                ok = False
                q.put_nowait({"line": f"✗ {label} failed (exit code: {code})"})
                if label == "pull":
                    q.put_nowait({"line": "The project was not stopped."})
                    break
    except Exception as e:  # pragma: no cover - unexpected error
        ok = False
        q.put_nowait({"line": f"Error: {e}"})
    q.put_nowait({"done": True, "ok": ok})


@app.post("/api/projects/{name}/pull")
async def api_pull(name: str):
    """Pull new images, then down + up. Output is an NDJSON stream:
    {"step": ..} / {"line": ..} / {"done": true, "ok": bool}. The job keeps running
    after the client disconnects (otherwise the project could be left stopped)."""
    await get_project(name)
    if name == SELF_PROJECT:
        raise HTTPException(400, "Compose Manager cannot recreate itself (down)")
    stack = find_stack(name)
    if not stack:
        raise HTTPException(400, f"No {COMPOSE_DIR}/docker-compose-*.yaml for this project")
    if not files_available(stack["files"]):
        raise HTTPException(400, "The compose file is not readable from the container")
    if name in _pull_jobs:
        raise HTTPException(409, "A pull is already running for this project")

    q: asyncio.Queue = asyncio.Queue()
    task = asyncio.create_task(pull_job(stack, q))
    _pull_jobs[name] = task
    task.add_done_callback(lambda _t: _pull_jobs.pop(name, None))

    async def stream():
        while True:
            try:
                item = await asyncio.wait_for(q.get(), 15)
            except asyncio.TimeoutError:
                yield json.dumps({"ping": True}) + "\n"  # keep-alive (for proxies)
                continue
            yield json.dumps(item, ensure_ascii=False) + "\n"
            if item.get("done"):
                break

    return StreamingResponse(stream(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# --------------------------------------------------------- single containers
async def project_container(name: str, container: str) -> dict:
    """A container of the project (checked by its compose label) -> {id, name, status}."""
    if not NAME_RE.match(name):
        raise HTTPException(400, "Invalid project name")
    if not CONTAINER_RE.match(container):
        raise HTTPException(400, "Invalid container name")
    code, out = await run(
        "docker", "inspect", "--type", "container", "--format",
        '{{.Id}}\t{{.Name}}\t{{index .Config.Labels "com.docker.compose.project"}}\t{{.State.Status}}',
        container, timeout=30)
    parts = out.strip().split("\t")
    if code != 0 or len(parts) < 4 or parts[2] != name:
        raise HTTPException(404, "No such container in this project")
    return {"id": parts[0], "name": parts[1].lstrip("/"), "status": parts[3]}


@app.post("/api/projects/{name}/containers/{container}/restart")
async def api_container_restart(name: str, container: str):
    c = await project_container(name, container)
    code, out = await run("docker", "restart", c["id"])
    return JSONResponse(
        {"ok": code == 0, "command": f"restart {c['name']}", "output": "" if code == 0 else out},
        status_code=200 if code == 0 else 500,
    )


# --------------------------------------------------------------- exec (shell)
# `docker exec -it` runs on a pty owned by this process. The browser reads the
# output as SSE (/api/exec/{id}/stream) and sends keystrokes with POST
# (/api/exec/{id}/input) - plain HTTP, so basic auth and proxies just work.
EXEC_MAX_SESSIONS = 8
EXEC_IDLE_SEC = 60        # no stream attached for this long -> the session is killed
EXEC_SHELL = 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'
# Killing `docker exec` does not end the process in the container (dockerd keeps it
# running), so every shell gets a CM_EXEC=<marker> env var; on close every process in
# the container carrying it (the shell and its children) gets SIGHUP, then SIGKILL.
EXEC_KILL = ('k() { for p in /proc/[0-9]*; do '
             'if tr "\\0" "\\n" < "$p/environ" 2>/dev/null | grep -qx "CM_EXEC=$1"; then '
             'kill -$2 "${p#/proc/}" 2>/dev/null; fi; done; }; k "$1" HUP; sleep 1; k "$1" KILL')
_bg_tasks: set[asyncio.Task] = set()


class ExecSession:
    def __init__(self, sid: str, container: dict, proc, fd: int, marker: str):
        self.id, self.container, self.proc, self.fd, self.marker = sid, container, proc, fd, marker
        self.q: asyncio.Queue = asyncio.Queue()
        self.decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self.attached = 0
        self.detached_at = time.monotonic()
        self.paused = False
        self.closed = False
        loop = asyncio.get_running_loop()
        loop.add_reader(fd, self._on_read)
        self.waiter = asyncio.create_task(self._wait())
        self.reaper = asyncio.create_task(self._reap())

    def _on_read(self):
        try:
            data = os.read(self.fd, 65536)
        except BlockingIOError:
            return
        except OSError:  # EIO: the other side of the pty is closed
            data = b""
        if not data:
            asyncio.get_running_loop().remove_reader(self.fd)
            return
        text = self.decoder.decode(data)
        if text:
            self.q.put_nowait(text)
        if self.q.qsize() > 256 and not self.paused:  # nobody reads: stop reading (backpressure)
            asyncio.get_running_loop().remove_reader(self.fd)
            self.paused = True

    def resume(self):
        if self.paused and not self.closed and self.q.qsize() < 64:
            self.paused = False
            asyncio.get_running_loop().add_reader(self.fd, self._on_read)

    async def _wait(self):
        code = await self.proc.wait()
        await asyncio.sleep(0.2)  # let the reader drain the last output
        self.resume()
        self._on_read_rest()
        self.close()  # queues {"exit": code}

    def _on_read_rest(self):
        while not self.closed:
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                break
            if not data:
                break
            self.q.put_nowait(self.decoder.decode(data))

    async def _reap(self):
        while not self.closed:
            await asyncio.sleep(10)
            if not self.attached and time.monotonic() - self.detached_at > EXEC_IDLE_SEC:
                self.close()

    def write(self, data: bytes):
        view = memoryview(data)
        while view:
            try:
                n = os.write(self.fd, view)
            except BlockingIOError:
                return False  # pty buffer full - the rest is dropped
            view = view[n:]
        return True

    def resize(self, cols: int, rows: int):
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def close(self):
        if self.closed:
            return
        self.closed = True
        _exec_sessions.pop(self.id, None)
        try:
            asyncio.get_running_loop().remove_reader(self.fd)
        except Exception:
            pass
        if self.proc.returncode is None:
            try:
                self.proc.kill()
            except ProcessLookupError:
                pass
            task = asyncio.create_task(run(
                "docker", "exec", "-u", "0", self.container["id"], "sh", "-c", EXEC_KILL, "sh", self.marker,
                timeout=30))
            _bg_tasks.add(task)
            task.add_done_callback(_bg_tasks.discard)
        try:
            os.close(self.fd)
        except OSError:
            pass
        self.q.put_nowait({"exit": self.proc.returncode})
        if asyncio.current_task() is not self.reaper:
            self.reaper.cancel()


_exec_sessions: dict[str, ExecSession] = {}


def _set_ctty():  # runs in the child: the pty becomes its controlling terminal (SIGWINCH)
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


class ExecStart(BaseModel):
    cols: int = 80
    rows: int = 24


class ExecInput(BaseModel):
    data: str


@app.post("/api/projects/{name}/containers/{container}/exec")
async def api_exec_start(name: str, container: str, body: ExecStart):
    c = await project_container(name, container)
    if c["status"] != "running":
        raise HTTPException(400, "The container is not running")
    if len(_exec_sessions) >= EXEC_MAX_SESSIONS:
        raise HTTPException(429, "Too many open shells")
    cols, rows = max(10, min(body.cols, 500)), max(4, min(body.rows, 200))
    marker = secrets.token_hex(8)  # not the session id: processes in the container can read it
    master, slave = pty.openpty()
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    os.set_blocking(master, False)
    try:
        proc = await asyncio.create_subprocess_exec(
            "docker", "exec", "-it", "--detach-keys", "ctrl-^,ctrl-@",
            "-e", "TERM=xterm-256color", "-e", f"CM_EXEC={marker}", c["id"], "sh", "-c", EXEC_SHELL,
            stdin=slave, stdout=slave, stderr=slave,
            start_new_session=True, preexec_fn=_set_ctty,
        )
    except Exception as e:
        os.close(master)
        raise HTTPException(500, f"Cannot start docker exec: {e}")
    finally:
        os.close(slave)
    sid = secrets.token_urlsafe(18)
    _exec_sessions[sid] = ExecSession(sid, c, proc, master, marker)
    return {"id": sid, "container": c["name"]}


def exec_session(sid: str) -> ExecSession:
    s = _exec_sessions.get(sid)
    if not s:
        raise HTTPException(404, "No such shell session (closed or timed out)")
    return s


@app.get("/api/exec/{sid}/stream")
async def api_exec_stream(sid: str, request: Request):
    """SSE: data = JSON string (terminal output); event `end` (data = exit code) when the shell exits."""
    s = exec_session(sid)

    async def stream():
        s.attached += 1
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    item = await asyncio.wait_for(s.q.get(), 15)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    continue
                chunks, end = [], None
                while True:  # coalesce what is already queued into one message
                    if isinstance(item, dict):
                        end = item
                        break
                    chunks.append(item)
                    if s.q.empty() or sum(map(len, chunks)) > 65536:
                        break
                    item = s.q.get_nowait()
                s.resume()
                if chunks:
                    yield "data: " + json.dumps("".join(chunks), ensure_ascii=False) + "\n\n"
                if end is not None:
                    yield f"event: end\ndata: {json.dumps(end.get('exit'))}\n\n"
                    break
        finally:
            s.attached -= 1
            s.detached_at = time.monotonic()

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/exec/{sid}/input")
async def api_exec_input(sid: str, body: ExecInput):
    s = exec_session(sid)
    data = body.data.encode("utf-8")
    if len(data) > 65536:
        raise HTTPException(413, "Input too large")
    return {"ok": s.write(data)}


@app.post("/api/exec/{sid}/resize")
async def api_exec_resize(sid: str, body: ExecStart):
    exec_session(sid).resize(max(10, min(body.cols, 500)), max(4, min(body.rows, 200)))
    return {"ok": True}


@app.post("/api/exec/{sid}/close")
async def api_exec_close(sid: str):
    s = _exec_sessions.get(sid)
    if s:
        s.close()
    return {"ok": True}


@app.get("/api/projects/{name}/logs")
async def api_logs(name: str, request: Request, tail: int = 200, service: str = "", follow: bool = True):
    await get_project(name)
    tail = max(1, min(tail, 5000))
    args = ["docker", "compose", "-p", name, "logs", "--no-color", "--tail", str(tail)]
    if follow:
        args.append("-f")
    if service:
        if not SERVICE_RE.match(service):
            raise HTTPException(400, "Invalid service name")
        args.append(service)

    async def stream():
        proc = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
        )
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    line = await asyncio.wait_for(proc.stdout.readline(), 15)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"  # keep-alive (for proxies)
                    continue
                if not line:
                    yield "event: end\ndata: \n\n"
                    break
                yield "data: " + json.dumps(line.decode(errors="replace").rstrip("\n")) + "\n\n"
        finally:
            if proc.returncode is None:
                proc.kill()
                await proc.wait()

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ------------------------------------------------------------------ file editor
# File browser + editor for the whole COMPOSE_DIR. Everything can be viewed,
# only files matching EDIT_EXTENSIONS / EDIT_FILENAMES can be written.
DEFAULT_EDIT_EXTENSIONS = ("yaml,yml,json,conf,cfg,cnf,ini,toml,env,txt,md,sh,cmd,bat,xml,properties,"
                           "service,timer,lua,py,js,css,html,j2,tmpl,template,zone")
DEFAULT_EDIT_FILENAMES = ".env,.env-*,.env.*,Caddyfile,Dockerfile,Makefile,crontab,named.conf*,db.*"
# an empty value (e.g. `${EDIT_EXTENSIONS:-}` from compose) = default
EDIT_EXTENSIONS = {e.strip().lower().lstrip(".") for e in (
    os.environ.get("EDIT_EXTENSIONS", "").strip() or DEFAULT_EDIT_EXTENSIONS).split(",") if e.strip()}
EDIT_FILENAMES = [n.strip() for n in (
    os.environ.get("EDIT_FILENAMES", "").strip() or DEFAULT_EDIT_FILENAMES).split(",") if n.strip()]
LIST_LIMIT = 2000
BACKUP_ID_RE = re.compile(r"^(original|\d{8}-\d{6}(-\d{6})?)$")


def is_editable_name(name: str) -> bool:
    if any(fnmatch.fnmatchcase(name, pat) for pat in EDIT_FILENAMES):
        return True
    stem, dot, ext = name.rpartition(".")
    return bool(dot and stem and ext.lower() in EDIT_EXTENSIONS)


def resolve_rel(rel: str) -> tuple[Path, str]:
    """Path relative to COMPOSE_DIR -> (Path, normalised rel). Escaping it (.., symlink) is refused."""
    if not compose_dir_ok():
        raise HTTPException(404, f"{COMPOSE_DIR} is not mounted")
    if "\x00" in (rel or ""):
        raise HTTPException(400, "Invalid path")
    parts = [p for p in (rel or "").split("/") if p not in ("", ".")]
    if ".." in parts:
        raise HTTPException(400, "Invalid path")
    path = Path(COMPOSE_DIR).joinpath(*parts)
    root = os.path.realpath(COMPOSE_DIR)
    real = os.path.realpath(path)
    if real != root and not real.startswith(root + os.sep):
        raise HTTPException(403, "The path points outside the directory")
    inner = os.path.relpath(real, root).split(os.sep)
    if (parts and parts[0] == BACKUP_DIR_NAME) or inner[0] == BACKUP_DIR_NAME:
        raise HTTPException(403, "The backup directory is not accessible here")
    return path, "/".join(parts)


def content_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def stacks_using(path: Path) -> list[dict]:
    target = str(path)
    return [s for s in discover_stacks() if target in s["files"] or target in s["envFiles"]]


@app.get("/api/fs/list")
async def api_fs_list(path: str = ""):
    p, rel = resolve_rel(path)
    if not p.is_dir():
        raise HTTPException(400, "Not a directory")
    root = os.path.realpath(COMPOSE_DIR)
    entries, truncated = [], False
    try:
        with os.scandir(p) as it:
            for e in it:
                if (not rel and e.name == BACKUP_DIR_NAME) or e.name.startswith(".cm-tmp-"):
                    continue
                if len(entries) >= LIST_LIMIT:
                    truncated = True
                    break
                link = e.is_symlink()
                outside = False
                if link:
                    real = os.path.realpath(e.path)
                    outside = real != root and not real.startswith(root + os.sep)
                try:
                    st = e.stat()
                    is_dir = e.is_dir()
                except OSError:  # broken symlink
                    st, is_dir = None, False
                entries.append({
                    "name": e.name, "type": "dir" if is_dir else "file",
                    "size": st.st_size if st and not is_dir else None,
                    "mtime": st.st_mtime if st else None,
                    "link": link, "outside": outside,
                    "editable": not is_dir and not outside and st is not None and is_editable_name(e.name),
                })
    except OSError as e:
        raise HTTPException(403, f"Not readable: {e.strerror}")
    entries.sort(key=lambda x: (x["type"] != "dir", x["name"].casefold()))
    return {"path": rel, "root": COMPOSE_DIR, "entries": entries, "truncated": truncated}


@app.get("/api/fs/file")
async def api_fs_read(path: str):
    p, rel = resolve_rel(path)
    if not p.is_file():
        raise HTTPException(404, "No such file")
    size = p.stat().st_size
    info = {"path": rel, "abs": str(p), "size": size, "editable": is_editable_name(p.name),
            "binary": False, "tooLarge": False, "encodingError": False, "eol": "lf",
            "content": "", "hash": "", "stacks": [s["project"] for s in stacks_using(p)]}
    if size > MAX_FILE_SIZE:
        return {**info, "editable": False, "tooLarge": True}
    data = p.read_bytes()
    info["hash"] = content_hash(data)
    if b"\x00" in data[:8192]:
        return {**info, "editable": False, "binary": True}
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        text = data.decode("utf-8", errors="replace")
        info["editable"], info["encodingError"] = False, True
    if "\r\n" in text:  # the textarea converts to \n -> restored on save
        info["eol"] = "crlf"
        text = text.replace("\r\n", "\n")
    return {**info, "content": text}


async def validate_content(path: Path, content: str) -> dict:
    """compose / env file of a stack: `docker compose config -q` (with a temp copy);
    other .yaml/.yml: YAML parse; .json: JSON parse. -> {ok, checked, output, line}"""
    target = str(path)
    stacks = stacks_using(path)
    ext = path.suffix.lower()
    if stacks:
        tmp = path.with_name(f".cm-tmp-{secrets.token_hex(4)}-{path.name}")
        try:
            tmp.write_text(content, encoding="utf-8")
            outputs = []
            for st in stacks:
                code, out = await run(*stack_args(st, {target: str(tmp)}), "config", "-q", timeout=30)
                if code != 0:
                    outputs.append(f"[{st['project']}] " + out.replace(str(tmp), target).strip())
        finally:
            tmp.unlink(missing_ok=True)
        out = "\n".join(outputs)
        m = re.search(rf"{re.escape(target)}: yaml: line (\d+)", out)
        return {"ok": not outputs, "checked": True, "output": out, "line": int(m.group(1)) if m else 0}
    if ext in (".yaml", ".yml"):
        try:
            for _ in yaml.safe_load_all(content):
                pass
        except yaml.YAMLError as e:
            mark = getattr(e, "problem_mark", None)
            return {"ok": False, "checked": True, "output": str(e), "line": mark.line + 1 if mark else 0}
        return {"ok": True, "checked": True, "output": "", "line": 0}
    if ext == ".json":
        try:
            json.loads(content)
        except json.JSONDecodeError as e:
            return {"ok": False, "checked": True, "output": str(e), "line": e.lineno}
        return {"ok": True, "checked": True, "output": "", "line": 0}
    return {"ok": True, "checked": False, "output": "", "line": 0}


# ----- backups: COMPOSE_DIR/.compose-manager-backup/<rel path>.<id>
#   <file>.original      = earliest known content, NEVER pruned
#   <file>.<timestamp>   = state before each save, the last BACKUP_KEEP are kept
def glob_escape(s: str) -> str:
    return re.sub(r"([*?\[])", r"[\1]", s)


def backup_dir_for(rel: str) -> Path:
    return Path(COMPOSE_DIR, BACKUP_DIR_NAME, *rel.split("/")[:-1])


def backups_of(rel: str) -> tuple[Path | None, list[Path]]:
    """(original, timestamped backups oldest first)"""
    bdir, name = backup_dir_for(rel), rel.split("/")[-1]
    if not bdir.is_dir():
        return None, []
    orig = bdir / f"{name}.original"
    ts = sorted(f for f in bdir.glob(f"{glob_escape(name)}.*")
                if f.is_file() and BACKUP_ID_RE.match(f.name[len(name) + 1:])
                and not f.name.endswith(".original"))
    return (orig if orig.is_file() else None), ts


def backup_file(rel: str, data: bytes) -> None:
    root = Path(COMPOSE_DIR, BACKUP_DIR_NAME)
    root.mkdir(mode=0o700, exist_ok=True)
    os.chmod(root, 0o700)  # root-only, because .env files hold secrets
    bdir, name = backup_dir_for(rel), rel.split("/")[-1]
    bdir.mkdir(parents=True, exist_ok=True)
    orig, ts = backups_of(rel)
    if orig is None:
        if not ts:  # first save: the current (pre-save) content is the original
            (bdir / f"{name}.original").write_bytes(data)
            return
        os.rename(ts[0], bdir / f"{name}.original")  # existing backups: the oldest becomes the original
    (bdir / f"{name}.{datetime.now().strftime('%Y%m%d-%H%M%S-%f')}").write_bytes(data)
    for f in backups_of(rel)[1][:-BACKUP_KEEP]:
        f.unlink(missing_ok=True)


def backup_path(rel: str, bid: str) -> Path:
    if not BACKUP_ID_RE.match(bid or ""):
        raise HTTPException(400, "Invalid backup id")
    f = backup_dir_for(rel) / f"{rel.split('/')[-1]}.{bid}"
    if not f.is_file():
        raise HTTPException(404, "No such backup")
    return f


@app.get("/api/fs/backups")
async def api_fs_backups(path: str):
    """Previous versions, newest first; the original last."""
    _, rel = resolve_rel(path)
    orig, ts = backups_of(rel)
    items = [{"id": f.name[len(rel.split('/')[-1]) + 1:], "time": f.stat().st_mtime,
              "size": f.stat().st_size, "original": False} for f in reversed(ts)]
    if orig:
        items.append({"id": "original", "time": orig.stat().st_mtime,
                      "size": orig.stat().st_size, "original": True})
    return {"keep": BACKUP_KEEP, "backups": items}


@app.get("/api/fs/backup")
async def api_fs_backup(path: str, id: str):
    _, rel = resolve_rel(path)
    f = backup_path(rel, id)
    text = f.read_bytes().decode("utf-8", errors="replace").replace("\r\n", "\n")
    return {"id": id, "time": f.stat().st_mtime, "content": text}


class FileDiff(BaseModel):
    path: str
    id: str
    content: str  # current content of the editor


@app.post("/api/fs/diff")
async def api_fs_diff(body: FileDiff):
    _, rel = resolve_rel(body.path)
    f = backup_path(rel, body.id)
    old = f.read_bytes().decode("utf-8", errors="replace").replace("\r\n", "\n")
    label = "original" if body.id == "original" else body.id
    diff = difflib.unified_diff(old.splitlines(), body.content.splitlines(),
                                f"{rel} ({label})", f"{rel} (editor)", lineterm="", n=3)
    return {"diff": "\n".join(diff)}


class FileCheck(BaseModel):
    path: str
    content: str


@app.post("/api/fs/validate")
async def api_fs_validate(body: FileCheck):
    p, _ = resolve_rel(body.path)
    if len(body.content.encode()) > MAX_FILE_SIZE:
        raise HTTPException(413, "Content too large")
    return await validate_content(p, body.content)


class FileSave(BaseModel):
    path: str
    content: str
    hash: str = ""        # hash of the loaded content (conflict detection)
    force: bool = False   # save even if validation fails
    eol: str = "lf"       # "crlf": the file originally had CRLF line endings


class FileNew(BaseModel):
    dir: str = ""   # directory relative to COMPOSE_DIR
    name: str       # plain file name, no "/"


NEW_FILE_TEMPLATES = {
    # a new docker-compose-<key>.yaml becomes a stack (Up / Down / Pull / Edit)
    "compose": "services:\n  app:\n    image: \n    restart: unless-stopped\n",
}


@app.post("/api/fs/new")
async def api_fs_new(body: FileNew):
    """Create a new, whitelisted file in an existing directory. Never overwrites."""
    name = body.name.strip()
    if not name or name in (".", "..") or "/" in name or "\x00" in name or name.startswith(".cm-tmp-"):
        raise HTTPException(400, "Invalid file name")
    if not is_editable_name(name):
        raise HTTPException(403, "This file type is not editable (EDIT_EXTENSIONS / EDIT_FILENAMES)")
    parent, rel_dir = resolve_rel(body.dir)
    if not parent.is_dir():
        raise HTTPException(400, "Not a directory")
    if not rel_dir and name == BACKUP_DIR_NAME:
        raise HTTPException(400, "Invalid file name")
    path, rel = resolve_rel(f"{rel_dir}/{name}" if rel_dir else name)
    content = NEW_FILE_TEMPLATES["compose"] if COMPOSE_FILE_RE.match(name) and not rel_dir else ""
    try:
        # O_EXCL: fails if the file (or a symlink with that name) already exists
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    except FileExistsError:
        raise HTTPException(409, "A file with this name already exists")
    except OSError as e:
        raise HTTPException(403, f"Cannot create file: {e.strerror}")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(content)
    st = parent.stat()
    try:  # same owner as the directory (e.g. data dirs owned by a non-root user)
        os.chown(path, st.st_uid, st.st_gid)
    except OSError:
        pass
    return {"ok": True, "path": rel}


@app.put("/api/fs/file")
async def api_fs_write(body: FileSave):
    p, rel = resolve_rel(body.path)
    if not p.is_file():
        raise HTTPException(404, "No such file")
    if not is_editable_name(p.name):
        raise HTTPException(403, "This file type is not editable (EDIT_EXTENSIONS / EDIT_FILENAMES)")
    content = body.content.replace("\r\n", "\n")
    if len(content.encode()) > MAX_FILE_SIZE:
        raise HTTPException(413, "Content too large")
    old = p.read_bytes()
    if body.hash and body.hash != content_hash(old):
        raise HTTPException(409, "The file has changed on disk – reload it")
    check = await validate_content(p, content)
    if not check["ok"] and not body.force:
        return JSONResponse({"ok": False, "invalid": True, **check}, status_code=422)
    if body.eol == "crlf":
        content = content.replace("\n", "\r\n")
    if content.encode("utf-8") == old:
        return {"ok": True, "hash": content_hash(old), "valid": check["ok"], "output": "", "unchanged": True}
    backup_file(rel, old)
    # rewrite in place: keeps owner, permissions and inode
    with open(p, "w", encoding="utf-8", newline="") as fh:
        fh.write(content)
    return {"ok": True, "hash": content_hash(p.read_bytes()), "valid": check["ok"],
            "output": check["output"], "line": check["line"]}


# ------------------------------------------------------------------------- stats
UNITS = {
    "b": 1, "kb": 1e3, "mb": 1e6, "gb": 1e9, "tb": 1e12,
    "kib": 1024, "mib": 1024**2, "gib": 1024**3, "tib": 1024**4,
}
SIZE_RE = re.compile(r"([\d.]+)\s*([kmgt]?i?b)", re.I)


def parse_size(text: str) -> float:
    m = SIZE_RE.search(text or "")
    if not m:
        return 0.0
    return float(m.group(1)) * UNITS.get(m.group(2).lower(), 1)


def parse_pair(text: str) -> tuple[float, float]:
    """'1.05kB / 126B' -> (1050, 126)"""
    a, _, b = (text or "").partition("/")
    return parse_size(a), parse_size(b)


def parse_pct(text: str) -> float:
    try:
        return float((text or "0").strip().rstrip("%"))
    except ValueError:
        return 0.0


_stats = {"t": 0.0, "data": None, "host": None}
_stats_lock = asyncio.Lock()


async def host_info() -> dict:
    if _stats["host"] is None:
        code, out = await run("docker", "info", "--format", "{{.NCPU}} {{.MemTotal}}", timeout=30)
        ncpu, mem = (out.split() + ["0", "0"])[:2] if code == 0 else ("0", "0")
        _stats["host"] = {"ncpu": int(ncpu or 0), "memTotal": int(mem or 0)}
    return _stats["host"]


async def collect_stats() -> dict:
    # only one `docker stats` runs for several clients / rapid requests
    async with _stats_lock:
        if _stats["data"] and time.monotonic() - _stats["t"] < STATS_CACHE_SEC:
            return _stats["data"]

        tmpl = ('{{.ID}}\t{{.Names}}\t{{.Label "com.docker.compose.project"}}\t'
                '{{.Label "com.docker.compose.service"}}\t{{.State}}')
        (c1, ps_out), (c2, st_out), host = await asyncio.gather(
            run("docker", "ps", "-a", "--no-trunc", "--filter", "label=com.docker.compose.project",
                "--format", tmpl, timeout=30),
            run("docker", "stats", "--no-stream", "--no-trunc", "--format", "json", timeout=60),
            host_info(),
        )
        if c1 != 0:
            raise HTTPException(500, ps_out)

        stats_by_id = {}
        if c2 == 0:
            for item in parse_json_lines(st_out):
                stats_by_id[item.get("Container") or item.get("ID")] = item

        projects: dict[str, dict] = {}
        for line in ps_out.splitlines():
            parts = line.split("\t")
            if len(parts) < 5:
                continue
            cid, cname, project, service, cstate = parts[:5]
            pr = projects.setdefault(project, {
                "total": 0, "running": 0, "cpu": 0.0, "mem": 0.0,
                "netRx": 0.0, "netTx": 0.0, "blkRead": 0.0, "blkWrite": 0.0,
                "pids": 0, "containers": {},
            })
            pr["total"] += 1
            if cstate == "running":
                pr["running"] += 1
            st = stats_by_id.get(cid)
            if not st:
                continue
            mem_used, mem_limit = parse_pair(st.get("MemUsage"))
            rx, tx = parse_pair(st.get("NetIO"))
            br, bw = parse_pair(st.get("BlockIO"))
            cpu = parse_pct(st.get("CPUPerc"))
            pids = int(st.get("PIDs") or 0) if str(st.get("PIDs", "")).isdigit() else 0
            pr["containers"][cname] = {
                "service": service, "cpu": cpu, "mem": mem_used, "memLimit": mem_limit,
                "memPerc": parse_pct(st.get("MemPerc")),
                "netRx": rx, "netTx": tx, "blkRead": br, "blkWrite": bw, "pids": pids,
            }
            pr["cpu"] += cpu
            pr["mem"] += mem_used
            pr["netRx"] += rx
            pr["netTx"] += tx
            pr["blkRead"] += br
            pr["blkWrite"] += bw
            pr["pids"] += pids

        data = {**host, "time": time.time(), "projects": projects}
        _stats.update(t=time.monotonic(), data=data)
        return data


@app.get("/api/stats")
async def api_stats():
    return await collect_stats()


# ------------------------------------------------------------------------ static
@app.get("/sw.js")
async def service_worker():
    return FileResponse(STATIC_DIR / "sw.js", media_type="application/javascript",
                        headers={"Cache-Control": "no-cache"})


@app.get("/manifest.webmanifest")
async def manifest():
    data = json.loads((STATIC_DIR / "manifest.webmanifest").read_text(encoding="utf-8"))
    data["name"] = APP_NAME
    data["short_name"] = APP_SHORT_NAME
    return Response(json.dumps(data, ensure_ascii=False), media_type="application/manifest+json",
                    headers={"Cache-Control": "no-cache"})


@app.get("/")
@app.get("/index.html")
async def index():
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    page = (page.replace("{{APP_NAME}}", html.escape(APP_NAME))
                .replace("{{APP_SHORT_NAME}}", html.escape(APP_SHORT_NAME)))
    return Response(page, media_type="text/html; charset=utf-8", headers={"Cache-Control": "no-cache"})


app.mount("/", StaticFiles(directory=STATIC_DIR), name="static")
