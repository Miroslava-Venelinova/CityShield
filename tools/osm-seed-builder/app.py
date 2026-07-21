"""
OSM seed builder — a local UI for extracting regions and streets from Overpass.

Everything the tool produces lands in its own output/ directory: extractions are
merged into output/{regions,streets}.json, output/seed.sql is generated from
those, and that file is what gets applied to D1. backend/seeds/ is only ever
touched by the explicit "promote" step, so an exploratory extraction can never
quietly rewrite the checked-in seed data.

Run it with:

    python tools/osm-seed-builder/app.py

It prints a tokenized http://127.0.0.1:<port>/?t=<token> URL and opens it. The
token is checked on every API call and the Host header is pinned to loopback,
because this process can shell out to `wrangler d1 execute --remote` — without
those guards any page in the browser could POST to localhost and reach the
production database.

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
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
BACKEND_DIR = REPO_ROOT / "backend"
SEEDS_DIR = BACKEND_DIR / "seeds"

# The tool's own working set. Nothing here is checked in (output/.gitignore),
# and nothing outside it is written except by the promote step.
OUTPUT_DIR = HERE / "output"
OUTPUT_SQL = OUTPUT_DIR / "seed.sql"

# The two JSON stores the UI can show and merge between, in the order the
# workflow moves through them.
STORES = {
    "output": {"label": "tool output", "dir": OUTPUT_DIR},
    "backend": {"label": "backend/seeds", "dir": SEEDS_DIR},
}

USER_AGENT = "CityShield-seed-builder/1.0 (+https://github.com/StunnyBG/CityShield)"
OVERPASS_TIMEOUT_S = 300

# Reference tables the extracts can be merged into, and the key each JSON
# object uses once written (matching the column names in migrations/0001_init.sql).
TARGETS = {
    "regions": {"file": "regions.json", "table": "regions", "column": "region_name"},
    "streets": {"file": "streets.json", "table": "streets", "column": "street_name"},
}

# Highway classes worth seeding: everything a person would call an address.
# Excludes service roads, tracks and footpaths — they are overwhelmingly
# unnamed, and the named ones are not places alerts refer to.
STREET_HIGHWAYS = (
    "motorway|trunk|primary|secondary|tertiary|unclassified|residential|"
    "living_street|pedestrian|road"
)

# Each kind is (label, default target table, Overpass statements). The
# statements run against `.searchArea`, bound by the query template below.
KINDS = {
    "streets": {
        "label": "Streets",
        "target": "streets",
        "statements": [f'way["highway"~"^({STREET_HIGHWAYS})$"]["name"](area.searchArea);'],
    },
    "neighbourhoods": {
        "label": "Neighbourhoods / quarters",
        "target": "regions",
        "statements": [
            f'{t}["place"~"^(suburb|neighbourhood|quarter|borough)$"]["name"](area.searchArea);'
            for t in ("node", "way", "relation")
        ],
    },
    "localities": {
        "label": "Cities / towns / villages",
        "target": "regions",
        "statements": [
            f'{t}["place"~"^(city|town|village|hamlet)$"]["name"](area.searchArea);'
            for t in ("node", "way", "relation")
        ],
    },
    "admin": {
        "label": "Administrative boundaries (level 8–10)",
        "target": "regions",
        "statements": [
            'relation["boundary"="administrative"]["admin_level"~"^(8|9|10)$"]'
            '["name"](area.searchArea);',
        ],
    },
}

QUERY_TEMPLATE = """\
[out:json][timeout:{timeout}];
area({area_id})->.searchArea;
(
{statements}
);
out tags center;\
"""


class ToolError(Exception):
    """Anything the UI should show as a message rather than a stack trace."""


# ── Overpass ──────────────────────────────────────────────────────────────────


def is_loopback(url: str) -> bool:
    return (urllib.parse.urlparse(url).hostname or "") in ("127.0.0.1", "::1", "localhost")


def overpass_post(endpoint: str, query: str) -> dict:
    # Plain http is allowed only for a self-hosted instance on this machine
    # (overpass/docker-compose.yml serves http on 12345); anything remote must
    # be https so the query and results are not sent in the clear.
    if not (endpoint.startswith("https://") or
            (endpoint.startswith("http://") and is_loopback(endpoint))):
        raise ToolError("Overpass endpoint must be https://, or http:// on localhost.")

    request = urllib.request.Request(
        endpoint,
        data=urllib.parse.urlencode({"data": query}).encode("utf-8"),
        headers={"User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(request, timeout=OVERPASS_TIMEOUT_S) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # 429/504 are Overpass's load-shedding responses and are worth naming:
        # the fix is to wait or switch mirrors, not to change the query.
        detail = {
            429: "Overpass is rate-limiting this IP. Wait a minute or pick another endpoint.",
            504: "Overpass timed out building the result. Narrow the area or raise the timeout.",
        }.get(e.code, f"Overpass returned HTTP {e.code}.")
        raise ToolError(detail) from e
    except urllib.error.URLError as e:
        if is_loopback(endpoint):
            raise ToolError(
                f"Could not reach the self-hosted Overpass at {endpoint} ({e.reason}). "
                "Start it with `docker compose up -d` in tools/osm-seed-builder/overpass, "
                "and note that the first import takes a while — see that folder's notes."
            ) from e
        raise ToolError(f"Could not reach {endpoint}: {e.reason}") from e
    except json.JSONDecodeError as e:
        raise ToolError("Overpass returned a non-JSON body (usually an error page).") from e


def build_query(kind: str, area_id: int, timeout: int = 180) -> str:
    if kind not in KINDS:
        raise ToolError(f"Unknown extraction kind: {kind}")
    statements = "\n".join(f"  {s}" for s in KINDS[kind]["statements"])
    return QUERY_TEMPLATE.format(timeout=timeout, area_id=area_id, statements=statements)


# Country bounding boxes, resolved once per endpoint+country and reused.
_bbox_cache: dict[tuple[str, str], tuple[float, float, float, float]] = {}


def within_bbox(lat, lon, bbox: tuple[float, float, float, float]) -> bool:
    # A candidate with no centre cannot be placed, so it is kept rather than
    # dropped — the filter exists to disambiguate, not to hide results.
    if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
        return True
    min_lat, min_lon, max_lat, max_lon = bbox
    return min_lat <= lat <= max_lat and min_lon <= lon <= max_lon


def country_bbox(endpoint: str, country: str) -> tuple[float, float, float, float]:
    """
    (min_lat, min_lon, max_lat, max_lon) for a country's level-2 boundary.

    The field is free text, so accept the forms someone would actually type for
    Bulgaria: "България", "Bulgaria", or "BG".
    """
    token = country.strip()
    key = (endpoint, token.casefold())
    if key in _bbox_cache:
        return _bbox_cache[key]

    escaped = token.replace("\\", "\\\\").replace('"', '\\"')
    base = 'relation["boundary"="administrative"][admin_level=2]'
    clauses = [f'{base}["name"="{escaped}"];', f'{base}["name:en"="{escaped}"];']
    if re.fullmatch(r"[A-Za-z]{2}", token):
        clauses.insert(0, f'{base}["ISO3166-1"="{token.upper()}"];')

    query = "[out:json][timeout:60];\n(\n  " + "\n  ".join(clauses) + "\n);\nout bb;"
    for element in overpass_post(endpoint, query).get("elements", []):
        b = element.get("bounds")
        if b:
            box = (b["minlat"], b["minlon"], b["maxlat"], b["maxlon"])
            _bbox_cache[key] = box
            return box
    raise ToolError(f'No country boundary matched "{token}". Try "България", "Bulgaria" or "BG".')


def resolve_areas(endpoint: str, name: str, country: str = "") -> list[dict]:
    """
    Look up candidate areas by name so area ids never have to be hardcoded.

    Overpass exposes areas derived from boundary relations; the area id is the
    relation id plus 3600000000, which is what the extraction queries take.

    `country` narrows the search to Bulgaria. It is worth having even against
    the local instance, because a Geofabrik country extract still carries the
    border strips of its neighbours, and place names repeat across a border.
    It is applied as a bounding-box test on each candidate's centre rather than
    as an Overpass `(area.country)` filter: that filter is unreliable for
    relations and silently drops real matches — scoping "Варна" to BG lost the
    admin_level 9 district entirely. A bbox is a superset of the country, so it
    can admit a neighbour's border town but can never hide a genuine result,
    and every candidate is shown with its admin_level for the final choice.
    """
    if not name.strip():
        raise ToolError("Enter an area name to resolve.")

    escaped = name.strip().replace("\\", "\\\\").replace('"', '\\"')
    bbox = country_bbox(endpoint, country) if country.strip() else None
    query = (
        f"[out:json][timeout:60];\n"
        f'relation["boundary"="administrative"]["name"="{escaped}"];\n'
        f"out tags center;"
    )
    elements = overpass_post(endpoint, query).get("elements", [])

    candidates = []
    for element in elements:
        tags = element.get("tags", {})
        centre = element.get("center", {})
        if bbox and not within_bbox(centre.get("lat"), centre.get("lon"), bbox):
            continue
        candidates.append({
            "area_id": 3600000000 + element["id"],
            "relation_id": element["id"],
            "name": tags.get("name", "—"),
            "admin_level": tags.get("admin_level", "?"),
            "place": tags.get("place", ""),
            "lat": centre.get("lat"),
            "lng": centre.get("lon"),
        })
    if not candidates:
        where = f" within {country.strip()}'s bounding box" if bbox else ""
        raise ToolError(f'No administrative boundary named "{name}" was found{where}.')
    # Lower admin_level = larger area; show provinces before municipalities.
    candidates.sort(key=lambda c: (int(c["admin_level"]) if c["admin_level"].isdigit() else 99))
    return candidates


def group_elements(elements: list[dict]) -> list[dict]:
    """
    Collapse raw OSM elements into one row per name with an averaged centre.

    A street is many `way` elements sharing one `name` tag, so the per-element
    centres are averaged into a single representative point. That point is
    deliberately crude — it is the map pin for an alert, not the geometry.
    """
    grouped: dict[str, dict] = {}
    for element in elements:
        tags = element.get("tags") or {}
        name = (tags.get("name") or tags.get("name:bg") or "").strip()
        if not name:
            continue

        # Nodes carry lat/lon directly; ways and relations carry `center`
        # because the queries ask for `out center` rather than full geometry.
        centre = element.get("center") or element
        lat, lng = centre.get("lat"), centre.get("lon")
        if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
            continue

        row = grouped.setdefault(name, {"name": name, "lat_sum": 0.0, "lng_sum": 0.0, "parts": 0})
        row["lat_sum"] += lat
        row["lng_sum"] += lng
        row["parts"] += 1

    rows = [
        {
            "name": r["name"],
            "lat": round(r["lat_sum"] / r["parts"], 7),
            "lng": round(r["lng_sum"] / r["parts"], 7),
            "parts": r["parts"],
        }
        for r in grouped.values()
    ]
    rows.sort(key=lambda r: r["name"])
    return rows


# Cyrillic, including the supplement block — one character anywhere in the name
# is enough, so "ж.к. Младост" and "бул. Сливница" pass while "Odos Egnatia"
# does not. Requiring the whole name to be Cyrillic would throw away every
# Bulgarian name carrying a digit or a Latin block letter ("ул. Драган Цанков 5",
# "бл. 12А").
CYRILLIC = re.compile(r"[Ѐ-ӿԀ-ԯ]")


def split_by_script(rows: list[dict]) -> tuple[list[dict], list[str]]:
    """
    Partition grouped rows into Cyrillic names and everything else.

    The Bulgaria extract carries thin border strips of the neighbouring
    countries, and the country bounding box deliberately over-admits rather than
    risk hiding a real result — so Greek, Turkish and Romanian names do reach the
    results table. They are never wanted in the seed data: an alert's free text
    is Bulgarian, so a Latin-script name is dead weight the fuzzy matcher has to
    score against every lookup.

    Returns the dropped names too, so the UI can say what it removed rather than
    quietly shrinking the result count.
    """
    kept, dropped = [], []
    for row in rows:
        (kept if CYRILLIC.search(row["name"]) else dropped).append(row)
    return kept, [r["name"] for r in dropped]


# ── seed files ────────────────────────────────────────────────────────────────


def store_dir(store: str) -> Path:
    if store not in STORES:
        raise ToolError(f"Unknown store: {store}")
    return STORES[store]["dir"]


def load_seed(target: str, store: str) -> list[dict]:
    """
    Read a seed file, accepting both the legacy flat `["name", ...]` form and
    the `[{"name", "lat", "lng"}, ...]` form this tool writes.
    """
    if target not in TARGETS:
        raise ToolError(f"Unknown target table: {target}")
    path = store_dir(store) / TARGETS[target]["file"]
    if not path.exists():
        return []

    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ToolError(f"{path.name}: expected a JSON array.")

    entries = []
    for item in data:
        if isinstance(item, str):
            name = item.strip()
            if name:
                entries.append({"name": name, "lat": None, "lng": None})
        elif isinstance(item, dict) and str(item.get("name", "")).strip():
            entries.append({
                "name": str(item["name"]).strip(),
                "lat": item.get("lat"),
                "lng": item.get("lng"),
            })
    return entries


def display_path(path: Path) -> str:
    """Repo-relative when possible, absolute otherwise — `relative_to` raises
    for a path outside the repo, and a label is never worth an exception."""
    try:
        return str(path.relative_to(REPO_ROOT)).replace("\\", "/")
    except ValueError:
        return str(path)


def save_seed(target: str, store: str, entries: list[dict]) -> Path:
    directory = store_dir(store)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / TARGETS[target]["file"]
    # Sorted and newline-terminated so that re-running the tool produces a
    # git diff containing only the rows that actually changed.
    entries = sorted(entries, key=lambda e: e["name"])
    path.write_text(json.dumps(entries, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def merge_into_seed(target: str, incoming: list[dict], overwrite_coords: bool,
                    store: str = "output") -> dict:
    """
    Merge rows into a seed file, keyed on the exact name — the same key the
    `UNIQUE` constraint on region_name / street_name uses, so a merge here and
    an `INSERT ... ON CONFLICT` there agree on what a duplicate is.

    The same function serves both hops: Overpass rows into output/, and output/
    into backend/seeds/. They are the same operation over the same key.
    """
    existing = {entry["name"]: entry for entry in load_seed(target, store)}
    added, enriched, updated, unchanged = [], [], [], 0

    for row in incoming:
        name = str(row.get("name", "")).strip()
        if not name:
            continue
        lat, lng = row.get("lat"), row.get("lng")
        has_coords = isinstance(lat, (int, float)) and isinstance(lng, (int, float))

        current = existing.get(name)
        if current is None:
            existing[name] = {"name": name, "lat": lat if has_coords else None,
                              "lng": lng if has_coords else None}
            added.append(name)
        elif not has_coords:
            unchanged += 1
        elif current.get("lat") is None or current.get("lng") is None:
            current["lat"], current["lng"] = lat, lng
            enriched.append(name)
        elif overwrite_coords:
            current["lat"], current["lng"] = lat, lng
            updated.append(name)
        else:
            unchanged += 1

    entries = list(existing.values())
    path = save_seed(target, store, entries)
    return {
        "target": target,
        "file": display_path(path),
        "added": added,
        "enriched": enriched,
        "updated": updated,
        "unchanged": unchanged,
        "total": len(entries),
        "without_coords": sum(1 for e in entries if e["lat"] is None or e["lng"] is None),
    }


def seed_status() -> dict:
    """
    Per-store counts plus the full name list. The names drive the "not in
    output"/"not in backend" figures in the UI, which is how you see what a
    merge would actually change before anything is written.
    """
    status = {}
    for store, meta in STORES.items():
        status[store] = {"label": meta["label"], "dir": display_path(meta["dir"]), "targets": {}}
        for target in TARGETS:
            entries = load_seed(target, store)
            status[store]["targets"][target] = {
                "total": len(entries),
                "with_coords": sum(
                    1 for e in entries if e["lat"] is not None and e["lng"] is not None),
                "names": [e["name"] for e in entries],
            }
    status["sql"] = sql_status()
    return status


def sql_status() -> dict:
    if not OUTPUT_SQL.exists():
        return {"exists": False, "path": display_path(OUTPUT_SQL)}
    stat = OUTPUT_SQL.stat()
    return {
        "exists": True,
        "path": display_path(OUTPUT_SQL),
        "bytes": stat.st_size,
        "modified": time.strftime("%Y-%m-%d %H:%M", time.localtime(stat.st_mtime)),
    }


def reveal_output() -> dict:
    """
    Open output/ in the desktop file manager.

    A fixed path, never one from the request — and the platform openers are
    invoked without a shell so the path is an argument, not something the shell
    could reinterpret.
    """
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    target = str(OUTPUT_DIR)
    try:
        if sys.platform == "win32":
            subprocess.Popen(["explorer", target])  # explorer exits 1 even on success
        elif sys.platform == "darwin":
            subprocess.Popen(["open", target])
        else:
            subprocess.Popen(["xdg-open", target])
    except (OSError, FileNotFoundError) as e:
        raise ToolError(f"Could not open a file manager for {target}: {e}") from e
    return {"path": display_path(OUTPUT_DIR)}


def wipe_output() -> dict:
    """
    Clear the tool's working set.

    Deletes the three files it knows how to produce, by name — never a glob of
    output/, so nothing a user parked in that directory can be caught by a
    stray click, and .gitignore survives.
    """
    removed = []
    for path in [OUTPUT_DIR / TARGETS[t]["file"] for t in TARGETS] + [OUTPUT_SQL]:
        if path.exists():
            path.unlink()
            removed.append(display_path(path))
    return {"removed": removed, "seeds": seed_status()}


def promote_to_backend(overwrite_coords: bool) -> dict:
    """Merge output/ into backend/seeds/ — the one step that writes outside the
    tool's own directory, hence its own button rather than a side effect."""
    pending = {target: load_seed(target, "output") for target in TARGETS}
    if not any(pending.values()):
        raise ToolError("output/ is empty — merge some extracted rows into it first.")
    return {"reports": [
        merge_into_seed(target, entries, overwrite_coords, store="backend")
        for target, entries in pending.items()
    ]}


# ── commands ──────────────────────────────────────────────────────────────────


def run_command(argv: list[str], timeout: int = 900) -> dict:
    """
    Run a fixed argument vector in backend/ and hand the output back verbatim.
    Callers build argv from constants only; nothing from the request body is
    ever interpolated into a command.
    """
    try:
        completed = subprocess.run(
            argv, cwd=BACKEND_DIR, capture_output=True, text=True, timeout=timeout,
            encoding="utf-8", errors="replace",
            # npx/npm are .cmd shims on Windows, which CreateProcess will not
            # execute without a shell. argv is constant, so this adds no
            # injection surface.
            shell=(sys.platform == "win32"),
            stdin=subprocess.DEVNULL,
        )
    except FileNotFoundError as e:
        raise ToolError(f"{argv[0]} was not found on PATH.") from e
    except subprocess.TimeoutExpired as e:
        raise ToolError(f"`{' '.join(argv)}` did not finish within {timeout // 60} minutes.") from e

    return {
        "command": " ".join(argv),
        "exit_code": completed.returncode,
        "output": (completed.stdout + completed.stderr).strip()[-8000:],
    }


def generate_sql() -> dict:
    """
    Generate output/seed.sql from output/*.json using the backend's own
    generator, pointed at this directory. Regenerating the SQL must not depend
    on, or disturb, backend/seeds — but it must emit byte-identical statements,
    so the upsert semantics pinned by backend/test/seed-upsert.spec.ts are the
    ones that actually get applied.
    """
    if not any((OUTPUT_DIR / TARGETS[t]["file"]).exists() for t in TARGETS):
        raise ToolError("Nothing in output/ yet — merge some extracted rows first.")
    for target in TARGETS:  # the generator reads both files unconditionally
        path = OUTPUT_DIR / TARGETS[target]["file"]
        if not path.exists():
            save_seed(target, "output", [])

    result = run_command([
        "node", str(SEEDS_DIR / "generate-seed.mjs"),
        "--in", str(OUTPUT_DIR), "--out", str(OUTPUT_SQL),
    ], timeout=120)
    result["sql"] = sql_status()
    return result


def apply_to_d1(remote: bool) -> dict:
    """
    Migrate, then apply output/seed.sql. Migrations first because the
    coordinates the tool writes only have columns to land in from 0005 onwards.

    wrangler prompts for confirmation on the remote database; with no TTY it
    logs the question and takes the fallback (yes), so the run is not left
    hanging on input nobody can type.
    """
    if not OUTPUT_SQL.exists():
        raise ToolError("output/seed.sql does not exist yet — generate it first.")

    scope = "--remote" if remote else "--local"
    steps = [
        ["npx", "wrangler", "d1", "migrations", "apply", "cityshield-db", scope],
        ["npx", "wrangler", "d1", "execute", "cityshield-db", scope, f"--file={OUTPUT_SQL}"],
    ]

    results = []
    for argv in steps:
        result = run_command(argv)
        results.append(result)
        if result["exit_code"] != 0:
            break  # applying seed.sql against an unmigrated schema only compounds the failure
    return {"scope": scope, "steps": results,
            "exit_code": max(r["exit_code"] for r in results)}


# ── HTTP ──────────────────────────────────────────────────────────────────────


class Handler(BaseHTTPRequestHandler):
    server_version = "OSMSeedBuilder/1.0"
    token = ""

    def log_message(self, fmt, *args):  # quieter console; errors still surface in the UI
        pass

    # -- guards ----------------------------------------------------------------

    def _authorized(self) -> bool:
        """
        Loopback Host + matching token. The Host check blocks DNS rebinding,
        where a hostile page resolves its own domain to 127.0.0.1 and reaches
        this server; the token blocks plain CSRF from any other local page.
        """
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost"):
            return False
        query = urllib.parse.urlparse(self.path).query
        supplied = urllib.parse.parse_qs(query).get("t", [""])[0]
        if not supplied:
            supplied = self.headers.get("X-Seed-Token", "")
        return secrets.compare_digest(supplied, self.token)

    # -- plumbing --------------------------------------------------------------

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

    # -- routes ----------------------------------------------------------------

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if not self._authorized():
            self._send(403, b"Forbidden: open the tokenized URL printed in the terminal.",
                       "text/plain; charset=utf-8")
            return

        if path == "/":
            html = (HERE / "index.html").read_bytes()
            self._send(200, html, "text/html; charset=utf-8")
        elif path == "/api/config":
            presets = json.loads((HERE / "presets.json").read_text(encoding="utf-8"))
            self._send_json({
                "endpoints": presets["endpoints"],
                "default_country": presets["default_country"],
                "kinds": [{"id": k, "label": v["label"], "target": v["target"]}
                          for k, v in KINDS.items()],
                "targets": list(TARGETS),
                "seeds": seed_status(),
            })
        else:
            self._send(404, b"Not found", "text/plain; charset=utf-8")

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if not self._authorized():
            self._send_json({"error": "Forbidden."}, 403)
            return

        try:
            body = self._read_json()
            if path == "/api/resolve-area":
                self._send_json({"candidates": resolve_areas(
                    body["endpoint"], body.get("name", ""), body.get("country", ""))})
            elif path == "/api/build-query":
                self._send_json({"query": build_query(
                    body["kind"], int(body["area_id"]), int(body.get("timeout", 180)))})
            elif path == "/api/run-query":
                query = body.get("raw") or build_query(
                    body["kind"], int(body["area_id"]), int(body.get("timeout", 180)))
                result = overpass_post(body["endpoint"], query)
                rows = group_elements(result.get("elements", []))
                dropped = []
                # Default on: absent means the caller predates the checkbox.
                if body.get("cyrillic_only", True):
                    rows, dropped = split_by_script(rows)
                self._send_json({"query": query, "rows": rows, "dropped": dropped})
            elif path == "/api/merge":
                # Extractions only ever land in the tool's own output/.
                self._send_json(merge_into_seed(
                    body["target"], body.get("rows", []), bool(body.get("overwrite_coords")),
                    store="output"))
            elif path == "/api/promote":
                self._send_json(promote_to_backend(bool(body.get("overwrite_coords"))))
            elif path == "/api/generate-sql":
                self._send_json(generate_sql())
            elif path == "/api/reveal-output":
                self._send_json(reveal_output())
            elif path == "/api/wipe-output":
                self._send_json(wipe_output())
            elif path == "/api/apply":
                self._send_json(apply_to_d1(bool(body.get("remote"))))
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
    if not SEEDS_DIR.is_dir():
        sys.exit(f"Expected the seeds directory at {SEEDS_DIR} — run this from the CityShield repo.")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    Handler.token = secrets.token_urlsafe(24)
    port = free_port()
    url = f"http://127.0.0.1:{port}/?t={Handler.token}"

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"OSM seed builder → {url}\nOutput: {OUTPUT_DIR}\nBackend seeds: {SEEDS_DIR}\n"
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
