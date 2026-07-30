"""
Polygon tester — see what the block builder actually cut, and why.

An alert that lists streets is supposed to come out as a ring around the block
they enclose. When it doesn't, the stored row says only `is_polygon: false` and
a one-line reason, and the reason cannot tell you whether the geometry was
judged correctly or whether a threshold threw away a real block: "all 1 enclosed
area(s) were bounded by a single street" is the right answer for one alert and a
bug for the next one. The difference is visible on a map and nowhere else.

So this draws every stage: the ways Overpass returned, which of them the clip
window kept, the road bands the blocks are cut from, and every enclosed area
with the share of its boundary each street accounts for — the number the
sliver rule is decided on.

    python tools/polygon-tester/app.py

It prints a tokenized http://127.0.0.1:<port>/?t=<token> URL and opens it. As in
the other tools, the token is checked on every call and the Host header is
pinned to loopback: this process runs Node and can reach Overpass, so no other
page in the browser gets to drive it.

**The geometry is not reimplemented here.** Every run goes through the Worker's
own `buildBlockPolygon` via entry.ts, bundled by esbuild out of backend/src, so
a polygon judged in this tool is the polygon ingestion would have built. The
knobs override the same constants ingestion defaults to; nothing you change in
the UI changes what the Worker ships until you edit polygon.ts.

Standard library only.
"""

import argparse
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import threading
import urllib.parse
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
BACKEND_DIR = REPO_ROOT / "backend"
WORKER_SRC = BACKEND_DIR / "src"
FIXTURES_DIR = BACKEND_DIR / "test" / "fixtures"
STREETS_SEED = REPO_ROOT / "tools" / "osm-seed-builder" / "output" / "streets.json"

# Fetched Overpass responses, kept so tuning never re-hits the API — Overpass
# rate-limits, and a run that is answered from disk is also a run two knob
# settings can be compared across. Gitignored; promote one to a fixture instead.
CACHE_DIR = HERE / "cache"
BUILD_DIR = HERE / ".build"
BUNDLE = BUILD_DIR / "worker.mjs"
ENTRY = HERE / "entry.ts"
RUNNER = HERE / "run.mjs"
PRESETS_FILE = HERE / "presets.json"

ESBUILD = BACKEND_DIR / "node_modules" / ".bin" / ("esbuild.cmd" if sys.platform == "win32" else "esbuild")

# A fixture or cache file names its street set only by convention, so a saved
# name has to be safe to put in a path and readable a month later.
SAFE_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,48}$")

NODE_TIMEOUT_S = 120  # a live Overpass fetch carries its own 15 s cap and one retry

_lock = threading.Lock()


class ToolError(Exception):
    """Anything the UI should show as a message rather than a stack trace."""


# ── the Worker bundle ─────────────────────────────────────────────────────────


def overpass_url() -> str:
    """
    The URL the Worker is configured with, read from wrangler.jsonc rather than
    repeated here — a tester pointed at a different endpoint than production is
    a tester that answers a different question.
    """
    try:
        text = (BACKEND_DIR / "wrangler.jsonc").read_text(encoding="utf-8")
        found = re.search(r'"OVERPASS_URL"\s*:\s*"([^"]+)"', text)
        if found:
            return found.group(1)
    except OSError:
        pass
    raise ToolError("Could not read OVERPASS_URL from backend/wrangler.jsonc.")


def sources_mtime() -> float:
    newest = ENTRY.stat().st_mtime
    for path in WORKER_SRC.rglob("*.ts"):
        newest = max(newest, path.stat().st_mtime)
    return newest


def ensure_bundle() -> dict:
    """
    Rebuild the bundle whenever anything under backend/src has changed.

    This is what keeps "the same logic as the backend" true across an editing
    session: change a threshold in polygon.ts, press Build, and the next run is
    already the new code. The Worker sources use extensionless relative imports,
    which plain Node ESM will not resolve, so esbuild does the resolving.
    """
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    fresh = BUNDLE.exists() and BUNDLE.stat().st_mtime >= sources_mtime()
    if fresh:
        return {"rebuilt": False}

    if not ESBUILD.exists():
        raise ToolError(
            f"esbuild is not at {ESBUILD}. Run `npm install` in backend/ first — "
            "it is already a dependency there, nothing extra is needed.")

    result = run_process([
        str(ESBUILD), str(ENTRY), "--bundle", "--format=esm", "--platform=node",
        f"--outfile={BUNDLE}", "--log-level=warning",
    ], cwd=HERE, timeout=120)
    if result["exit_code"] != 0:
        raise ToolError(f"esbuild failed:\n{result['output']}")
    return {"rebuilt": True, "warnings": result["output"]}


def run_process(argv: list[str], cwd: Path, timeout: int, stdin_text: str = "") -> dict:
    try:
        completed = subprocess.run(
            argv, cwd=cwd, capture_output=True, text=True, timeout=timeout,
            encoding="utf-8", errors="replace", input=stdin_text,
            # npx/esbuild are .cmd shims on Windows, which CreateProcess will not
            # execute without a shell. argv is fixed and the job travels on
            # stdin, so nothing from a request is ever parsed as a command.
            shell=(sys.platform == "win32"),
        )
    except FileNotFoundError as e:
        raise ToolError(f"{argv[0]} was not found on PATH.") from e
    except subprocess.TimeoutExpired as e:
        raise ToolError(f"`{Path(argv[0]).name} …` did not finish within {timeout} s.") from e
    return {"exit_code": completed.returncode, "output": (completed.stdout + completed.stderr).strip()}


def run_job(job: dict) -> dict:
    """One job through run.mjs. The job is JSON on stdin, never an argument."""
    build = ensure_bundle()
    result = run_process(["node", str(RUNNER), str(BUNDLE)], cwd=HERE,
                         timeout=NODE_TIMEOUT_S,
                         stdin_text=json.dumps(job, ensure_ascii=False))
    if result["exit_code"] != 0:
        raise ToolError(f"node failed:\n{result['output']}")

    # run.mjs prints one JSON document and nothing else; anything before it is a
    # Node warning worth showing rather than swallowing.
    start = result["output"].find("{")
    if start < 0:
        raise ToolError(f"run.mjs printed no JSON:\n{result['output']}")
    try:
        payload = json.loads(result["output"][start:])
    except json.JSONDecodeError as e:
        raise ToolError(f"Could not parse run.mjs output ({e}):\n{result['output'][:2000]}")

    if not payload.get("ok"):
        raise ToolError(payload.get("error", "The run failed without saying why."))
    payload.pop("ok", None)
    return {**payload, "rebuilt": build["rebuilt"]}


# ── way documents: fixtures and the fetch cache ───────────────────────────────


def list_sources() -> list[dict]:
    """
    Every set of ways a build can run against: the checked-in fixtures the tests
    use, and whatever this tool has fetched. Fixtures come first because a
    result that disagrees with one of them is a result worth explaining.
    """
    out = []
    for kind, directory, pattern in (("fixture", FIXTURES_DIR, "overpass-*.json"),
                                     ("cache", CACHE_DIR, "*.json")):
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob(pattern)):
            try:
                stat = path.stat()
            except OSError:
                continue
            out.append({
                "kind": kind,
                "id": f"{kind}:{path.stem}",
                "name": path.stem.removeprefix("overpass-"),
                "size_kb": round(stat.st_size / 1024),
                "saved": datetime.fromtimestamp(stat.st_mtime).strftime("%d.%m.%Y %H:%M"),
                "path": repo_path(path),
            })
    return out


def source_path(source_id: str) -> Path:
    """Resolve a `kind:name` id from the picker, and only that shape — the name
    is checked against SAFE_NAME before it is ever joined onto a directory."""
    kind, _, name = (source_id or "").partition(":")
    if kind == "fixture":
        path = FIXTURES_DIR / f"{name}.json"
    elif kind == "cache":
        path = CACHE_DIR / f"{name}.json"
    else:
        raise ToolError(f"Unknown ways source: {source_id!r}")
    if not SAFE_NAME.match(name.removeprefix("overpass-")) or not path.is_file():
        raise ToolError(f"No such ways file: {source_id}")
    return path


def read_document(source_id: str) -> dict:
    path = source_path(source_id)
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise ToolError(f"{path.name} is not readable as JSON: {e}") from e
    if not isinstance(document, dict) or not isinstance(document.get("elements"), list):
        raise ToolError(f"{path.name} is not an Overpass response (no `elements` array).")
    return document


def write_document(directory: Path, name: str, document: dict) -> Path:
    if not SAFE_NAME.match(name):
        raise ToolError("A name is lowercase letters, digits and hyphens — "
                        f"{name!r} is not.")
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{name}.json"
    # Minified, like the existing fixtures: these are hundreds of kilobytes of
    # coordinates and nobody reads them as text.
    path.write_text(json.dumps(document, ensure_ascii=False, separators=(",", ":")),
                    encoding="utf-8")
    return path


def fetch_ways(names: list[str], resolve: bool, name: str) -> dict:
    """
    Go to Overpass once, through the Worker's own `fetchStreetWays`, and keep
    what comes back. Every later build reads the file, so tuning a threshold
    across twenty runs is twenty local runs and one request.
    """
    payload = run_job({
        "action": "fetch",
        "names": names,
        "seedPath": str(STREETS_SEED) if resolve else None,
        "overpassUrl": overpass_url(),
    })
    with _lock:
        path = write_document(CACHE_DIR, name, payload["document"])
    payload.pop("document", None)
    return {**payload, "saved": repo_path(path), "source_id": f"cache:{path.stem}",
            "sources": list_sources()}


def promote(source_id: str, name: str) -> dict:
    """
    Copy a cached fetch into backend/test/fixtures, where the test suite can
    reach it. The workflow this exists for is: a real alert builds a wrong
    polygon, you fetch its ways here, you tune until it is right, and then the
    case becomes a test so it stays right.
    """
    document = read_document(source_id)
    with _lock:
        path = write_document(FIXTURES_DIR, f"overpass-{name}", document)
    return {"saved": repo_path(path), "source_id": f"fixture:{path.stem}",
            "sources": list_sources()}


# ── presets ───────────────────────────────────────────────────────────────────


def read_presets() -> list[dict]:
    try:
        data = json.loads(PRESETS_FILE.read_text(encoding="utf-8"))
        return [p for p in data if isinstance(p, dict)] if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def save_preset(label: str, streets: list, source_id: str, options: dict) -> dict:
    label = str(label or "").strip()[:80]
    if not label:
        raise ToolError("A preset needs a label.")
    entry = {
        "label": label,
        "streets": [str(s) for s in streets][:20],
        "source": str(source_id or ""),
        "options": {k: v for k, v in (options or {}).items() if isinstance(v, (int, float))},
    }
    with _lock:
        presets = [p for p in read_presets() if p.get("label") != label]
        presets.append(entry)
        presets.sort(key=lambda p: p["label"].lower())
        PRESETS_FILE.write_text(json.dumps(presets, ensure_ascii=False, indent=2) + "\n",
                                encoding="utf-8")
    return {"presets": presets}


def delete_preset(label: str) -> dict:
    with _lock:
        presets = [p for p in read_presets() if p.get("label") != label]
        PRESETS_FILE.write_text(json.dumps(presets, ensure_ascii=False, indent=2) + "\n",
                                encoding="utf-8")
    return {"presets": presets}


# ── misc ──────────────────────────────────────────────────────────────────────


def repo_path(path: Path) -> str:
    return os.path.relpath(path, REPO_ROOT).replace("\\", "/")


def parse_streets(raw) -> list[str]:
    """One per line or comma-separated — alerts list them both ways and nobody
    should have to reformat a paste."""
    if isinstance(raw, list):
        parts = [str(item) for item in raw]
    else:
        parts = re.split(r"[\n,;]+", str(raw or ""))
    return [p.strip() for p in parts if p.strip()][:20]


def clean_options(raw) -> dict:
    """Only the knobs the builder knows, only as finite numbers. Anything else
    would reach `buildBlockPolygon` as an override it silently ignores."""
    known = run_job({"action": "defaults"})["defaults"]
    out = {}
    for key, default in known.items():
        value = (raw or {}).get(key)
        if value in (None, ""):
            continue
        try:
            number = float(value)
        except (TypeError, ValueError):
            raise ToolError(f"{key} must be a number, not {value!r}.")
        if number != number or number in (float("inf"), float("-inf")) or number < 0:
            raise ToolError(f"{key} must be a non-negative number.")
        if number != default:
            out[key] = number
    return out


def build(streets: list, source_id: str, resolve: bool, options: dict) -> dict:
    names = parse_streets(streets)
    if not names:
        raise ToolError("Give at least one street name.")
    return {
        **run_job({
            "action": "build",
            "names": names,
            "seedPath": str(STREETS_SEED) if resolve else None,
            "document": read_document(source_id),
            "options": clean_options(options),
        }),
        "source_id": source_id,
    }


# ── HTTP ──────────────────────────────────────────────────────────────────────


class Handler(BaseHTTPRequestHandler):
    server_version = "PolygonTester/1.0"
    token = ""

    def log_message(self, fmt, *args):
        pass

    def _authorized(self) -> bool:
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost"):
            return False
        supplied = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("t", [""])[0]
        if not supplied:
            supplied = self.headers.get("X-Tool-Token", "")
        return secrets.compare_digest(supplied, self.token)

    def _send(self, status: int, body: bytes, content_type: str):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, payload: dict, status: int = 200):
        self._send(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except json.JSONDecodeError as e:
            raise ToolError("Malformed JSON request body.") from e

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if not self._authorized():
            self._send(403, b"Forbidden: open the tokenized URL printed in the terminal.",
                       "text/plain; charset=utf-8")
            return
        try:
            if path == "/":
                self._send(200, (HERE / "index.html").read_bytes(), "text/html; charset=utf-8")
            elif path == "/api/config":
                self._send_json({
                    "defaults": run_job({"action": "defaults"})["defaults"],
                    "sources": list_sources(),
                    "presets": read_presets(),
                    "seeded": STREETS_SEED.is_file(),
                    "seed_path": repo_path(STREETS_SEED),
                    "overpass_url": overpass_url(),
                })
            else:
                self._send(404, b"Not found", "text/plain; charset=utf-8")
        except ToolError as e:
            self._send_json({"error": str(e)}, 400)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if not self._authorized():
            self._send_json({"error": "Forbidden."}, 403)
            return
        try:
            body = self._read_json()
            if path == "/api/build":
                self._send_json(build(body.get("streets", []), body.get("source", ""),
                                      bool(body.get("resolve", True)), body.get("options", {})))
            elif path == "/api/fetch":
                self._send_json(fetch_ways(parse_streets(body.get("streets", [])),
                                           bool(body.get("resolve", True)),
                                           str(body.get("name", "")).strip()))
            elif path == "/api/promote":
                self._send_json(promote(body.get("source", ""), str(body.get("name", "")).strip()))
            elif path == "/api/preset":
                self._send_json(save_preset(body.get("label", ""), body.get("streets", []),
                                            body.get("source", ""), body.get("options", {})))
            elif path == "/api/preset/delete":
                self._send_json(delete_preset(body.get("label", "")))
            else:
                self._send_json({"error": "Not found."}, 404)
        except ToolError as e:
            self._send_json({"error": str(e)}, 400)
        except (KeyError, ValueError, TypeError) as e:
            self._send_json({"error": f"Bad request: {e}"}, 400)
        except OSError as e:
            self._send_json({"error": f"Filesystem error: {e}"}, 500)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main():
    argparse.ArgumentParser(description="Draw what the block polygon builder cut.").parse_args()

    if not WORKER_SRC.is_dir():
        sys.exit(f"Expected the Worker sources at {WORKER_SRC} — run this from the CityShield repo.")

    # Fail here rather than on the first click: a bundle that will not build is
    # a broken tool, and the error is far more legible on a console.
    try:
        ensure_bundle()
    except ToolError as e:
        sys.exit(str(e))
    if not STREETS_SEED.is_file():
        print(f"Note: {repo_path(STREETS_SEED)} is missing — name resolution will be "
              "unavailable, so type street names exactly as OSM has them.")

    Handler.token = secrets.token_urlsafe(24)
    port = free_port()
    url = f"http://127.0.0.1:{port}/?t={Handler.token}"
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    # ASCII only on the console: a redirected stdout on Windows is cp1252, and a
    # tool that dies on its own startup banner depending on where the output
    # points is not a tool. The UI is UTF-8 over HTTP and unaffected.
    print(f"Polygon tester -> {url}\n"
          f"Ways: {len(list_sources())} set(s) available, cache in {repo_path(CACHE_DIR)}\n"
          "Ctrl+C to stop.")
    threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
