"""Compose Manager - a host docker compose projektek kezelése böngészőből."""

import asyncio
import base64
import hashlib
import html
import json
import os
import re
import secrets
import shlex
import time
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

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

# compose fájlok könyvtára (a hoston ugyanazon az útvonalon, írhatóan csatolva)
COMPOSE_DIR = os.environ.get("COMPOSE_DIR", "/docker-compose").rstrip("/") or "/docker-compose"
MAX_FILE_SIZE = 1024 * 1024
# ennyi korábbi változatot tartunk meg fájlonként (COMPOSE_DIR/.compose-manager-backup)
BACKUP_KEEP = max(1, int(os.environ.get("BACKUP_KEEP", "10")))
BACKUP_DIR_NAME = ".compose-manager-backup"
BACKUP_ID_RE = re.compile(r"^\d{8}-\d{6}(-\d{6})?$")

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
SERVICE_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]*$")
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
    st = find_stack(name)
    if st:  # compose fájl van, de nincs konténere (down után / sosem indult)
        return {"Name": name, "Status": "", "ConfigFiles": ",".join(st["files"]), "absent": True}
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


# ------------------------------------------------------------- compose fájlok
# COMPOSE_DIR-ben: docker-compose-<kulcs>.yaml, opcionálisan run-<kulcs>.cmd
# (pl. `docker-compose -p immich-app -f ... --env-file=... up -d`) és .env-* fájlok.
# A run-*.cmd-t NEM futtatjuk, csak kiolvassuk belőle a compose kapcsolókat.
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
    """A run-*.cmd első compose parancsából a -p / -f / --env-file / ... kapcsolók."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    text = re.sub(r"[\\^]\r?\n", " ", text)  # sorfolytatás (sh: \, cmd: ^)
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith(("#", "::")) or line.lower().startswith("rem "):
            continue
        try:
            tokens = shlex.split(line)
        except ValueError:
            continue
        # "docker-compose ..." vagy "docker compose ..." (akár sudo / teljes útvonal előtte)
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
                break  # alparancs (up, start, ...)
            opt, eq, val = t.partition("=")
            key = VALUE_OPTS.get(opt)
            if not key:
                continue  # egyéb (érték nélküli) kapcsoló
            if not eq:
                val = next(it, "")
            if isinstance(res[key], list):
                res[key].append(val)
            else:
                res[key] = val
        return res
    return None


def yaml_name(path: Path) -> str | None:
    """A compose fájl felső szintű `name:` mezője (egyszerű regex, YAML parser nélkül)."""
    try:
        m = re.search(r"^name:\s*['\"]?([A-Za-z0-9_-]+)['\"]?\s*(#.*)?$",
                      path.read_text(encoding="utf-8", errors="replace"), re.M)
    except OSError:
        return None
    return m.group(1).lower() if m else None


def discover_stacks() -> list[dict]:
    """A COMPOSE_DIR compose fájljaiból összerakott "stack"-ek (projektenként egy)."""
    if not compose_dir_ok():
        return []
    base = Path(COMPOSE_DIR)
    try:
        names = sorted(os.listdir(base))
    except OSError:
        return []
    env_names = [n for n in names if ENV_FILE_RE.match(n) and (base / n).is_file()]

    # run-*.cmd -> a benne -f-fel megadott fájlokhoz rendeljük
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
            continue  # érvénytelen vagy már másik fájl használja ezt a projekt nevet

        # szerkeszthető fájlok: a stack compose fájljai + hivatkozott és .env-<kulcs>* env fájlok
        editable = [os.path.basename(f) for f in files
                    if os.path.dirname(f) == COMPOSE_DIR and COMPOSE_FILE_RE.match(os.path.basename(f))]
        envs = [os.path.basename(e) for e in env_files if os.path.dirname(e) == COMPOSE_DIR]
        envs += [e for e in env_names if e == f".env-{key}" or e.startswith(f".env-{key}-")]
        if not env_files and ".env" in env_names and project_dir == COMPOSE_DIR:
            envs.append(".env")  # --env-file nélkül a compose a .env-et olvassa
        editable += [e for e in dict.fromkeys(envs) if ENV_FILE_RE.match(e)]

        st = {"key": key, "project": project, "files": files, "projectDir": project_dir,
              "envFiles": env_files, "profiles": profiles, "runFile": run_file,
              "editable": list(dict.fromkeys(editable))}
        st["command"] = shlex.join(stack_args(st)[1:])
        stacks[project] = st
    return list(stacks.values())


def stack_args(st: dict, replace: dict[str, str] | None = None) -> list[str]:
    """`docker compose -p .. -f .. --project-directory .. --env-file ..` (replace: fájl csere)."""
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
    # compose fájl van, de konténer nincs -> "absent"
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
    if action not in ("start", "stop", "restart", "up", "down"):
        raise HTTPException(400, "Ismeretlen művelet")
    project = await get_project(name)
    if project["Name"] == SELF_PROJECT and action in ("stop", "down"):
        raise HTTPException(400, "A Compose Managert nem lehet önmagából leállítani")

    stack = find_stack(name)
    files = config_files(project)
    if action in ("up", "down"):
        if not stack:
            raise HTTPException(400, f"Nincs {COMPOSE_DIR}/docker-compose-*.yaml ehhez a projekthez")
        if not files_available(stack["files"]):
            raise HTTPException(400, "A compose fájl nem olvasható a konténerből")
        args = stack_args(stack) + (["up", "-d", "--remove-orphans"] if action == "up"
                                    else ["down", "--remove-orphans"])
        cmd = "up -d" if action == "up" else "down"
    elif project.get("absent"):
        raise HTTPException(400, "A projektnek nincs konténere – használd az Up-ot")
    elif stack:
        # compose fájlos projektnél a Start sima `start` (fájl változások: Up gomb)
        args = stack_args(stack) + [action]
        cmd = action
    elif action == "start" and files_available(files):
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


# --------------------------------------------------------------- fájl szerkesztés
class FileSave(BaseModel):
    content: str
    hash: str = ""        # a betöltött tartalom hash-e (ütközés figyelés)
    force: bool = False   # mentés akkor is, ha a `docker compose config` hibát jelez


def editable_file(fname: str) -> Path:
    """Csak a COMPOSE_DIR közvetlen docker-compose-*.yaml / .env-* fájljai."""
    if not compose_dir_ok():
        raise HTTPException(404, f"{COMPOSE_DIR} nincs csatolva")
    if "/" in fname or not (COMPOSE_FILE_RE.match(fname) or ENV_FILE_RE.match(fname)):
        raise HTTPException(400, "Ez a fájl nem szerkeszthető")
    path = Path(COMPOSE_DIR) / fname
    if not path.is_file():
        raise HTTPException(404, "Nincs ilyen fájl")
    return path


def content_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@app.get("/api/files/{fname}")
async def api_file_read(fname: str):
    path = editable_file(fname)
    data = path.read_bytes()
    if len(data) > MAX_FILE_SIZE:
        raise HTTPException(413, "Túl nagy fájl")
    return {"name": fname, "path": str(path), "content": data.decode("utf-8", errors="replace"),
            "hash": content_hash(data)}


async def validate_change(path: Path, content: str) -> tuple[bool, str]:
    """`docker compose config -q` minden stack-re, ami ezt a fájlt -f / --env-file-ként használja,
    úgy, hogy a fájl helyére egy ideiglenes másolatot teszünk."""
    target = str(path)
    stacks = [s for s in discover_stacks() if target in s["files"] or target in s["envFiles"]]
    if not stacks:
        return True, ""
    tmp = path.with_name(f".cm-tmp-{secrets.token_hex(4)}-{path.name}")
    try:
        tmp.write_text(content, encoding="utf-8")
        outputs = []
        for st in stacks:
            code, out = await run(*stack_args(st, {target: str(tmp)}), "config", "-q", timeout=30)
            if code != 0:
                outputs.append(f"[{st['project']}] " + out.replace(str(tmp), target).strip())
        return not outputs, "\n".join(outputs)
    finally:
        tmp.unlink(missing_ok=True)


def glob_escape(s: str) -> str:
    return re.sub(r"([*?\[])", r"[\1]", s)


def backups_of(path: Path) -> list[Path]:
    """A fájl mentései, legrégebbi elöl (név: <fájl>.<ÉÉÉÉHHNN-ÓÓPPMM-mikroszek>)."""
    bdir = path.parent / BACKUP_DIR_NAME
    if not bdir.is_dir():
        return []
    prefix = path.name + "."
    return sorted(f for f in bdir.glob(f"{glob_escape(path.name)}.*")
                  if f.is_file() and BACKUP_ID_RE.match(f.name[len(prefix):]))


def backup_file(path: Path, data: bytes) -> None:
    bdir = path.parent / BACKUP_DIR_NAME
    bdir.mkdir(mode=0o700, exist_ok=True)
    (bdir / f"{path.name}.{datetime.now().strftime('%Y%m%d-%H%M%S-%f')}").write_bytes(data)
    for f in backups_of(path)[:-BACKUP_KEEP]:
        f.unlink(missing_ok=True)


@app.get("/api/files/{fname}/backups")
async def api_file_backups(fname: str):
    """A korábbi változatok listája, legújabb elöl."""
    path = editable_file(fname)
    result = []
    for f in reversed(backups_of(path)):
        st = f.stat()
        result.append({"id": f.name[len(path.name) + 1:], "time": st.st_mtime, "size": st.st_size})
    return {"keep": BACKUP_KEEP, "backups": result}


@app.get("/api/files/{fname}/backups/{bid}")
async def api_file_backup(fname: str, bid: str):
    path = editable_file(fname)
    if not BACKUP_ID_RE.match(bid):
        raise HTTPException(400, "Érvénytelen mentés azonosító")
    f = path.parent / BACKUP_DIR_NAME / f"{path.name}.{bid}"
    if not f.is_file():
        raise HTTPException(404, "Nincs ilyen mentés")
    return {"id": bid, "time": f.stat().st_mtime,
            "content": f.read_bytes().decode("utf-8", errors="replace")}


class FileCheck(BaseModel):
    content: str


@app.post("/api/files/{fname}/validate")
async def api_file_validate(fname: str, body: FileCheck):
    """Mentés nélküli ellenőrzés (`docker compose config -q`)."""
    path = editable_file(fname)
    if len(body.content.encode()) > MAX_FILE_SIZE:
        raise HTTPException(413, "Túl nagy tartalom")
    ok, out = await validate_change(path, body.content)
    target = str(path)
    checked = any(target in st["files"] or target in st["envFiles"] for st in discover_stacks())
    return {"ok": ok, "checked": checked, "output": out}


@app.put("/api/files/{fname}")
async def api_file_write(fname: str, body: FileSave):
    path = editable_file(fname)
    if len(body.content.encode()) > MAX_FILE_SIZE:
        raise HTTPException(413, "Túl nagy tartalom")
    old = path.read_bytes()
    if body.hash and body.hash != content_hash(old):
        raise HTTPException(409, "A fájl időközben megváltozott – töltsd be újra")
    ok, out = await validate_change(path, body.content)
    if not ok and not body.force:
        return JSONResponse({"ok": False, "invalid": True, "output": out}, status_code=422)
    backup_file(path, old)
    # helyben írjuk felül: megmarad a tulajdonos, a jogosultság és az inode
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(body.content)
    return {"ok": True, "hash": content_hash(path.read_bytes()), "valid": ok, "output": out}


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
