"""
Push tester — a local UI for POST /api/alerts/test-push.

Sends a real OneSignal push through a running Worker, to one user or to every
registered user, and shows what came back. It is a delivery check: nothing is
written to D1 and the push never enters /api/alerts/recent.

Run it with:

    python tools/push-tester/app.py

It prints a tokenized http://127.0.0.1:<port>/?t=<token> URL and opens it. As in
the seed builder, the token is checked on every API call and the Host header is
pinned to loopback — this process holds an ingest key and can shell out to
`wrangler d1 execute --remote`, so no other page in the browser may reach it.

The ingest key is never sent to the browser. The page asks for a send "as local"
or "as remote" and this process attaches the key itself, read from
backend/.dev.vars or from `wrangler secret`-style entry in the UI, which is kept
in memory for the session only. config.json holds base URLs and nothing else.

Standard library only: this is a developer tool that should run from a fresh
checkout without a pip install.
"""

import json
import re
import secrets
import socket
import subprocess
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
BACKEND_DIR = REPO_ROOT / "backend"
DEV_VARS = BACKEND_DIR / ".dev.vars"

# Base URLs only — never a key. Gitignored, because the remote URL is
# deployment-specific and nobody else's checkout wants it.
CONFIG_FILE = HERE / "config.json"

DEFAULT_LOCAL_URL = "http://127.0.0.1:8787"
D1_DATABASE = "cityshield-db"
SEND_TIMEOUT_S = 30

# Mirrors the Worker's own cap on a push body; a longer one is silently
# truncated by the sender, so say so here instead.
MAX_BODY_LENGTH = 240


class ToolError(Exception):
    """Anything the UI should show as a message rather than a stack trace."""


# In-memory only. A key typed into the UI lasts as long as this process, so
# closing the tool disposes of it — it is never written next to the repo.
_session_keys: dict[str, str] = {}


# ── configuration ─────────────────────────────────────────────────────────────


def load_config() -> dict:
    if not CONFIG_FILE.exists():
        return {}
    try:
        data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}  # a corrupt scratch file is not worth failing startup over
    return data if isinstance(data, dict) else {}


def save_config(config: dict) -> None:
    CONFIG_FILE.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")


def dev_vars_key() -> str:
    """
    INGEST_API_KEY from backend/.dev.vars — the key `wrangler dev` itself loads,
    so the local target works with no setup at all.
    """
    if not DEV_VARS.exists():
        return ""
    for line in DEV_VARS.read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"\s*INGEST_API_KEY\s*=\s*(.*?)\s*", line)
        if match:
            return match.group(1).strip().strip('"').strip("'")
    return ""


def resolve_key(scope: str) -> str:
    """
    The key for a scope: whatever was typed into the UI this session, else — for
    local only — the one wrangler dev is already using. Production secrets are
    not readable back out of `wrangler secret`, so remote always has to be typed.
    """
    if _session_keys.get(scope):
        return _session_keys[scope]
    if scope == "local" and (key := dev_vars_key()):
        return key
    raise ToolError(
        "No ingest key for this target. Paste the INGEST_API_KEY it was deployed with."
        if scope == "remote" else
        "No INGEST_API_KEY found in backend/.dev.vars — paste one, or create that file "
        "from .dev.vars.example."
    )


def targets() -> dict:
    config = load_config()
    return {
        "local": {
            "label": "Local — wrangler dev",
            "url": config.get("local_url") or DEFAULT_LOCAL_URL,
            "has_key": bool(_session_keys.get("local") or dev_vars_key()),
            "key_source": ("typed this session" if _session_keys.get("local")
                           else "backend/.dev.vars" if dev_vars_key() else ""),
        },
        "remote": {
            "label": "Remote — deployed Worker",
            "url": config.get("remote_url", ""),
            "has_key": bool(_session_keys.get("remote")),
            "key_source": "typed this session" if _session_keys.get("remote") else "",
        },
    }


def set_target(scope: str, url: str, key: str) -> dict:
    if scope not in ("local", "remote"):
        raise ToolError(f"Unknown target: {scope}")

    url = url.strip().rstrip("/")
    if url:
        check_url(url)
        config = load_config()
        config[f"{scope}_url"] = url
        save_config(config)

    # An empty key field means "leave what I set earlier alone", so the key does
    # not have to be retyped every time the URL is edited.
    if key.strip():
        _session_keys[scope] = key.strip()
    return {"targets": targets()}


def forget_keys() -> dict:
    _session_keys.clear()
    return {"targets": targets()}


# ── the Worker call ───────────────────────────────────────────────────────────


def check_url(url: str) -> None:
    """
    Plain http only to a Worker on this machine. A remote target carries the
    ingest key in a header, and that must never cross the network in the clear.
    """
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme == "https":
        return
    if parsed.scheme == "http" and (parsed.hostname or "") in ("127.0.0.1", "::1", "localhost"):
        return
    raise ToolError(f"{url or '(empty)'} — the target must be https://, or http:// on localhost.")


def send_push(scope: str, title: str, body: str, user_id: str) -> dict:
    """
    POST /api/alerts/test-push. The response is handed back close to verbatim:
    the point of the tool is to see what the endpoint actually said.
    """
    title, body, user_id = title.strip(), body.strip(), user_id.strip()
    if not title or not body:
        raise ToolError("Title and message are both required.")
    if len(body) > MAX_BODY_LENGTH:
        raise ToolError(f"Message is {len(body)} characters; the push body caps at {MAX_BODY_LENGTH}.")

    target = targets().get(scope)
    if target is None:
        raise ToolError(f"Unknown target: {scope}")
    if not target["url"]:
        raise ToolError("Set the base URL for this target first.")
    check_url(target["url"])

    payload = {"title": title, "body": body}
    if user_id:
        payload["userId"] = user_id

    request = urllib.request.Request(
        f"{target['url']}/api/alerts/test-push",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "X-Api-Key": resolve_key(scope)},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=SEND_TIMEOUT_S) as response:
            return {"status": response.status, "body": decode(response.read())}
    except urllib.error.HTTPError as e:
        detail = decode(e.read())
        if e.code == 401:
            raise ToolError(
                "401 from the Worker — the ingest key does not match its INGEST_API_KEY.") from e
        return {"status": e.code, "body": detail}
    except urllib.error.URLError as e:
        hint = (" Is `npx wrangler dev` running?" if scope == "local" else "")
        raise ToolError(f"Could not reach {target['url']}: {e.reason}.{hint}") from e


def decode(raw: bytes):
    """Parsed JSON when the endpoint returned JSON, the raw text when it didn't
    (a 401 from the middleware has an empty body, by design)."""
    text = raw.decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


# ── recipients ────────────────────────────────────────────────────────────────


def list_users(scope: str) -> dict:
    """
    Read users straight out of D1 so a recipient can be picked by email instead
    of by pasting a UUID. There is no API for this, and there should not be —
    the app never needs to enumerate its users.
    """
    if scope not in ("local", "remote"):
        raise ToolError(f"Unknown target: {scope}")

    result = run_command([
        "npx", "wrangler", "d1", "execute", D1_DATABASE,
        "--remote" if scope == "remote" else "--local", "--json",
        "--command", "SELECT user_id, email, created_on_utc FROM users ORDER BY created_on_utc DESC",
    ])
    if result["exit_code"] != 0:
        raise ToolError(f"wrangler failed:\n{result['output']}")

    # wrangler prints banner lines before the JSON payload; take the document.
    start = result["output"].find("[")
    if start < 0:
        raise ToolError(f"wrangler returned no JSON:\n{result['output']}")
    try:
        documents = json.loads(result["output"][start:])
    except json.JSONDecodeError as e:
        raise ToolError(f"Could not parse wrangler's output:\n{result['output']}") from e

    users = []
    for document in documents if isinstance(documents, list) else [documents]:
        for row in document.get("results", []):
            users.append({
                "user_id": row.get("user_id", ""),
                "email": row.get("email", ""),
                "created": (row.get("created_on_utc") or "")[:10],
            })
    return {"scope": scope, "users": users}


def run_command(argv: list[str], timeout: int = 180) -> dict:
    """
    Run a fixed argument vector in backend/. The SQL is a constant here; nothing
    from the request body is ever interpolated into a command.
    """
    try:
        completed = subprocess.run(
            argv, cwd=BACKEND_DIR, capture_output=True, text=True, timeout=timeout,
            encoding="utf-8", errors="replace",
            # npx is a .cmd shim on Windows, which CreateProcess will not execute
            # without a shell. argv is constant, so this adds no injection surface.
            shell=(sys.platform == "win32"),
            stdin=subprocess.DEVNULL,
        )
    except FileNotFoundError as e:
        raise ToolError(f"{argv[0]} was not found on PATH.") from e
    except subprocess.TimeoutExpired as e:
        raise ToolError(f"`{' '.join(argv)}` did not finish within {timeout} s.") from e

    return {
        "exit_code": completed.returncode,
        "output": (completed.stdout + completed.stderr).strip()[-8000:],
    }


# ── HTTP ──────────────────────────────────────────────────────────────────────


class Handler(BaseHTTPRequestHandler):
    server_version = "PushTester/1.0"
    token = ""

    def log_message(self, fmt, *args):  # quieter console; errors still surface in the UI
        pass

    def _authorized(self) -> bool:
        """
        Loopback Host + matching token. The Host check blocks DNS rebinding; the
        token blocks plain CSRF from any other local page. Both matter more here
        than usual — this process can send a real broadcast to production.
        """
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

        if path == "/":
            self._send(200, (HERE / "index.html").read_bytes(), "text/html; charset=utf-8")
        elif path == "/api/config":
            self._send_json({"targets": targets(), "max_body_length": MAX_BODY_LENGTH})
        else:
            self._send(404, b"Not found", "text/plain; charset=utf-8")

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if not self._authorized():
            self._send_json({"error": "Forbidden."}, 403)
            return

        try:
            body = self._read_json()
            if path == "/api/target":
                self._send_json(set_target(
                    body.get("scope", ""), body.get("url", ""), body.get("key", "")))
            elif path == "/api/forget-keys":
                self._send_json(forget_keys())
            elif path == "/api/users":
                self._send_json(list_users(body.get("scope", "")))
            elif path == "/api/send":
                self._send_json(send_push(
                    body.get("scope", ""), body.get("title", ""),
                    body.get("body", ""), body.get("user_id", "")))
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
    if not BACKEND_DIR.is_dir():
        sys.exit(f"Expected the backend at {BACKEND_DIR} — run this from the CityShield repo.")

    Handler.token = secrets.token_urlsafe(24)
    port = free_port()
    url = f"http://127.0.0.1:{port}/?t={Handler.token}"

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Push tester → {url}\n"
          f"Local key: {'backend/.dev.vars' if dev_vars_key() else 'not found — paste one in the UI'}\n"
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
