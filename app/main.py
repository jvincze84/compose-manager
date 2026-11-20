"""Compose Manager - a host docker compose projektek kezelése böngészőből."""

import asyncio
import base64
import html
import json
import os
import re
import secrets
import time
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

STATIC_DIR = Path(__file__).parent / "static"
AUTH_USER = os.environ.get("AUTH_USER", "")
AUTH_PASSWORD = os.environ.get("AUTH_PASSWORD", "")
SELF_PROJECT = os.environ.get("SELF_PROJECT", "")
APP_NAME = os.environ.get("APP_NAME", "").strip() or "Compose Manager"
# a telefon kezdőképernyőjén az ikon alatt ez jelenik meg (kb. 12 karakter fér ki)
APP_SHORT_NAME = os.environ.get("APP_SHORT_NAME", "").strip() or (
    "Compose" if APP_NAME == "Compose Manager" else APP_NAME)
CMD_TIMEOUT = int(os.environ.get("CMD_TIMEOUT", "300"))
STATS_CACHE_SEC = float(os.environ.get("STATS_CACHE_SEC", "4"))
# healthcheck nélküli konténer ennyi másodperc futás után számít "rendesen elindultnak"
START_GRACE_SEC = float(os.environ.get("START_GRACE_SEC", "5"))

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
SERVICE_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]*$")

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
        return 124, f"Időtúllépés ({timeout}s)"
    return proc.returncode, out.decode(errors="replace")


def parse_json_lines(text: str) -> list:
    """`docker compose ps --format json` verziótól függően tömböt vagy NDJSON-t ad."""
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
        raise HTTPException(400, "Érvénytelen projekt név")
    for p in await list_projects():
        if p["Name"] == name:
            return p
    raise HTTPException(404, "Nincs ilyen projekt")


def config_files(project: dict) -> list[str]:
    return [f for f in (project.get("ConfigFiles") or "").split(",") if f]


def files_available(files: list[str]) -> bool:
    return bool(files) and all(os.path.isfile(f) for f in files)


def summarize_status(status: str) -> str:
    """Tartalék, ha az inspect nem sikerül: 'running(2), exited(1)' -> állapot."""
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
    """Egy konténer: ok | starting | unhealthy | error | done | stopped"""
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
    # a 0 kóddal kilépett (pl. init / migrációs) konténerek nem számítanak hibának
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
    # konténer eltűnhetett a két hívás között -> részleges kimenet is használható
    result: dict[str, list[dict]] = {}
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        project, oneoff, name, status, health, started, exit_code = parts[:7]
        if oneoff == "True":  # `docker compose run` konténerek
            continue
        result.setdefault(project, []).append({
            "name": name.lstrip("/"), "status": status, "health": health,
            "startedAt": started, "exitCode": int(exit_code) if exit_code.lstrip("-").isdigit() else 0,
        })
    return result


# --------------------------------------------------------------------------- API
@app.get("/api/projects")
async def api_projects():
    projects, containers = await asyncio.gather(list_projects(), project_containers())
    result = []
    for p in projects:
        files = config_files(p)
        cs = (containers or {}).get(p["Name"])
        result.append(
            {
                "name": p["Name"],
                "status": p.get("Status", ""),
                "state": project_state(cs) if cs else summarize_status(p.get("Status", "")),
                "configFiles": files,
                "filesAvailable": files_available(files),
                "self": p["Name"] == SELF_PROJECT,
            }
        )
    result.sort(key=lambda x: x["name"])
    return result


@app.get("/api/projects/{name}/services")
async def api_services(name: str):
    await get_project(name)
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
    if action not in ("start", "stop", "restart"):
        raise HTTPException(400, "Ismeretlen művelet")
    project = await get_project(name)
    if project["Name"] == SELF_PROJECT and action == "stop":
        raise HTTPException(400, "A Compose Managert nem lehet önmagából leállítani")

    files = config_files(project)
    if action == "start" and files_available(files):
        # `up -d` a compose fájl alapján: létrehozza a hiányzó konténereket is
        args = ["docker", "compose", "-p", name]
        for f in files:
            args += ["-f", f]
        args += ["up", "-d", "--remove-orphans"]
        cmd = "up -d"
    else:
        # compose fájl nélkül is működik (konténer label-ek alapján)
        args = ["docker", "compose", "-p", name, action]
        cmd = action

    code, out = await run(*args)
    return JSONResponse(
        {"ok": code == 0, "command": cmd, "output": out},
        status_code=200 if code == 0 else 500,
    )


@app.get("/api/projects/{name}/logs")
async def api_logs(name: str, request: Request, tail: int = 200, service: str = "", follow: bool = True):
    await get_project(name)
    tail = max(1, min(tail, 5000))
    args = ["docker", "compose", "-p", name, "logs", "--no-color", "--tail", str(tail)]
    if follow:
        args.append("-f")
    if service:
        if not SERVICE_RE.match(service):
            raise HTTPException(400, "Érvénytelen service név")
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
                    yield ": ping\n\n"  # keep-alive (proxy-k miatt)
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
    # több kliens / gyors egymásutáni kérés esetén egyetlen `docker stats` fut
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
