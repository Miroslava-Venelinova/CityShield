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
import math
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
#
# `by_settlement` mirrors migration 0015: streets are unique per
# (street_name, region_id), so the seed file is keyed the same way and one name
# can appear once per settlement. Regions stay keyed on the name alone.
TARGETS = {
    "regions": {"file": "regions.json", "table": "regions", "column": "region_name",
                "by_settlement": False},
    "streets": {"file": "streets.json", "table": "streets", "column": "street_name",
                "by_settlement": True},
}

# The settlement a street entry written before migration 0015 belongs to — the
# whole seed was the city back then. Matches DEFAULT_SETTLEMENT in
# backend/seeds/generate-seed.mjs, which reads these files.
DEFAULT_SETTLEMENT = "Варна"

# OSM's admin_level for населено място — a city, town or village. It is the only
# level whose name is a settlement, which is what a street row has to point at:
# level 4/5 is a province or municipality (many settlements), level 9/10 a
# district *inside* one, whose streets belong to the city behind it.
SETTLEMENT_ADMIN_LEVEL = "8"

# Highway classes worth seeding: everything a person would call an address.
# Excludes service roads, tracks and footpaths — they are overwhelmingly
# unnamed, and the named ones are not places alerts refer to.
STREET_HIGHWAYS = (
    "motorway|trunk|primary|secondary|tertiary|unclassified|residential|"
    "living_street|pedestrian|road"
)

# The classes the line above deliberately leaves out. Most named ways in these
# classes are not addresses (parking aisles, forest tracks, "McDrive"), but a
# minority are: whole residential streets in Варна are tagged `service`, and
# alerts do name them. Offered as a separate extraction kind rather than folded
# into the default, because it roughly triples the noise the matcher scores
# against — extract it, then deselect by eye.
MINOR_HIGHWAYS = "service|track|path|footway|steps|raceway"

# Each kind is (label, default target table, Overpass statements). The
# statements run against `.searchArea`, bound by the query template below.
KINDS = {
    "streets": {
        "label": "Streets",
        "target": "streets",
        "statements": [f'way["highway"~"^({STREET_HIGHWAYS})$"]["name"](area.searchArea);'],
    },
    "streets_minor": {
        "label": "Streets — minor classes only (service, track, path…)",
        "target": "streets",
        "statements": [f'way["highway"~"^({MINOR_HIGHWAYS})$"]["name"](area.searchArea);'],
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
    # Most Bulgarian villages have NO admin_level 8 boundary relation — Тополи,
    # in община Варна, is a bare place=village node — so there is no area to
    # query and the boundary workflow simply cannot reach them. Their centre is
    # already known (regions.json carries a coordinate for all 252 settlements),
    # so extract around that instead. `around` also sidesteps the province-scope
    # trap the boundary path has: a radius is exactly as big as you say it is.
    "streets_around": {
        "label": "Streets — around a settlement (no boundary needed)",
        "target": "streets",
        "needs_point": True,
        "statements": [
            f'way["highway"~"^({STREET_HIGHWAYS})$"]["name"](around:{{radius}},{{lat}},{{lng}});',
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

AROUND_TEMPLATE = """\
[out:json][timeout:{timeout}];
(
{statements}
);
out tags center;\
"""

# OSM's admin_level for област — a province. The scope one sweep covers.
PROVINCE_ADMIN_LEVEL = "4"

# `place` values that name a settlement, and those that name a district inside
# one. Deliberately disjoint: a sweep files every result as exactly one of the
# two, and a value in both would make that ambiguous.
#
# `locality` is in the district set because "м-т" (местност) is exactly what OSM
# tags that way, and its absence is why every м-т the sources publish against had
# no seeded row at all: eleven distinct names appeared in the 08.08.2026 review
# window — Ваялар, Траката, Ракитника, Голяма могила, Коджа тепе, Руските окопи,
# Фатрико дере, Емешенлията, Малко Ю, Глико, Пътека тала — and each of them
# targeted nobody by construction. epro and ViK address the whole northern
# coastal strip by locality. It belongs in neither set today, so adding it here
# keeps the two disjoint.
SETTLEMENT_PLACES = "city|town|village|hamlet"
DISTRICT_PLACES = "suburb|neighbourhood|quarter|borough|locality"

# How close a district claim has to sit to a same-named settlement before the two
# are read as ONE place tagged twice rather than two places sharing a name.
#
# The distinction is the whole difficulty of §1.2. `с. Припек` is a village of
# община Аврен that OSM also tags as a place inside Константиново's boundary —
# the SAME place, 0 km apart, and filing it as a district makes `settlementScope`
# answer "с. Припек" with Константиново's centroid 1.7 km away. `Чайка` is the
# opposite: a village at 43.08, 27.43 and the resort suburb at 43.25, 28.03, 50 km
# apart, two genuinely different places that migration 0017 exists to let the
# table hold. A name test alone cannot separate them; a name test plus proximity
# can, and 2 km leaves both cases an order of magnitude of headroom.
SAME_PLACE_KM = 2.0

# How far from a settlement's own centre an extracted street or district may sit.
#
# A backstop, not the fix — the identity-keyed query below should make it
# impossible for anything to be this far out, so a row that trips it means
# something ELSE is wrong and the report is how you find out. That is why it
# reports rather than silently dropping.
#
# The errors it was written against were 29–269 km (11 settlements' street sets
# came from same-named towns elsewhere in Bulgaria: Бяла's 177 streets from Бяла
# in Русе, 185 km away). 15 km is an order of magnitude tighter than the smallest
# of those and still generous for Варна, whose own streets reach 10.7 km from the
# centre at the 95th percentile.
MAX_EXTRACT_KM = 15.0

# One settlement's whole contribution to the seed, in one round trip: its
# streets and its districts, both bounded by its own boundary relation.
#
# Bounded by that relation's OSM **id**, which is the only thing about a
# settlement that is actually unique. This used to resolve the relation by name
# and admin_level, on the reasoning that pinning the level keeps the city of
# Варна apart from the province of Варна. It does — and it does nothing at all
# about the far bigger collision one level down: settlement names repeat all over
# Bulgaria. There are two Бяла, two Левски, two Дебелец, two Войводино, two
# Ботево, two Искър and FOUR Горица, every one of them an admin_level 8 relation.
# `map_to_area` turned all of them into `.s`, the union was searched, and 416 of
# the seed's 2,974 streets came back from a town in another province — Бяла's 177
# from Бяла in Русе, 185 km away, while ViK published for the real Бяла three
# times in one review window.
#
# The id comes from the enumeration, which resolved it INSIDE the province area
# (province_settlements). Identity, not a name; nothing can collide with it.
SETTLEMENT_SWEEP_TEMPLATE = """\
[out:json][timeout:{timeout}];
rel(id:{rel_id});
map_to_area->.s;
(
  way(area.s)["highway"~"^({streets})$"]["name"];
  node(area.s)["place"~"^({districts})$"]["name"];
  way(area.s)["place"~"^({districts})$"]["name"];
  relation(area.s)["place"~"^({districts})$"]["name"];
);
out tags center;\
"""

# The same for a settlement OSM maps as a bare node with no boundary to bound
# anything — 13 of Варна province's 171, and Тополи among them. A radius is the
# only container available, and it is exactly as big as it says it is.
SETTLEMENT_SWEEP_AROUND_TEMPLATE = """\
[out:json][timeout:{timeout}];
(
  way(around:{radius},{lat},{lng})["highway"~"^({streets})$"]["name"];
  node(around:{radius},{lat},{lng})["place"~"^({districts})$"]["name"];
  way(around:{radius},{lat},{lng})["place"~"^({districts})$"]["name"];
  relation(around:{radius},{lat},{lng})["place"~"^({districts})$"]["name"];
);
out tags center;\
"""

# How far around a settlement's centre to look for its streets, in metres.
# 2500 is what the survey behind migration 0015 used around Тополи, Аврен and
# Долни чифлик; villages are small and the next settlement over is further than
# this, which is what keeps a neighbour's streets out of the results.
DEFAULT_RADIUS_M = 2500


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


def build_query(kind: str, area_id: int = 0, timeout: int = 180,
                point: tuple[float, float] | None = None,
                radius: int = DEFAULT_RADIUS_M) -> str:
    if kind not in KINDS:
        raise ToolError(f"Unknown extraction kind: {kind}")

    if KINDS[kind].get("needs_point"):
        if point is None:
            raise ToolError(
                "Pick the settlement to extract around — this kind searches a radius "
                "from its seeded centre rather than a boundary.")
        lat, lng = point
        statements = "\n".join(
            "  " + s.format(radius=int(radius), lat=lat, lng=lng)
            for s in KINDS[kind]["statements"])
        return AROUND_TEMPLATE.format(timeout=timeout, statements=statements)

    statements = "\n".join(f"  {s}" for s in KINDS[kind]["statements"])
    return QUERY_TEMPLATE.format(timeout=timeout, area_id=area_id, statements=statements)


def settlement_point(name: str) -> tuple[float, float]:
    """
    The seeded centre of a settlement, for the `around` extraction kinds.

    Read from the seed files rather than looked up in OSM: the coordinate is
    already there for all 252 settlements (migration 0005), and taking it from
    the same place the settlement NAME has to match removes the only way the two
    could disagree.
    """
    wanted = name.strip()
    for store in STORES:
        for entry in load_seed("regions", store):
            if entry["name"] == wanted:
                lat, lng = entry.get("lat"), entry.get("lng")
                if isinstance(lat, (int, float)) and isinstance(lng, (int, float)):
                    return (lat, lng)
                raise ToolError(
                    f'"{wanted}" is a region but has no coordinates, so there is no point '
                    f"to search around. Extract it as a region first to give it one.")
    raise ToolError(f'"{wanted}" is not a region in either seed file.')


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


# Name + admin_level per resolved area, so an extraction can say which
# settlement it is for without the browser having to be believed about it.
_area_cache: dict[tuple[str, int], dict] = {}


def area_info(endpoint: str, area_id: int) -> dict:
    """
    The boundary relation behind an Overpass area id, as {name, admin_level}.

    Read from Overpass rather than taken from the request, because it decides
    which settlement a whole extraction is filed under — and a wrong settlement
    is not visible in the data afterwards (see the invariant in migration 0015).

    An id that is not a relation area, or a relation that no longer exists,
    comes back empty rather than raising: it only ever pre-fills a field the
    user can see and correct.
    """
    key = (endpoint, area_id)
    if key in _area_cache:
        return _area_cache[key]

    blank = {"name": "", "admin_level": "?"}
    if area_id < 3600000000:
        return blank
    query = f"[out:json][timeout:60];\nrelation({area_id - 3600000000});\nout tags;"
    try:
        elements = overpass_post(endpoint, query).get("elements", [])
    except ToolError:
        return blank
    for element in elements:
        tags = element.get("tags", {})
        info = {"name": tags.get("name", ""), "admin_level": tags.get("admin_level", "?")}
        _area_cache[key] = info
        return info
    return blank


def group_elements(elements: list[dict]) -> list[dict]:
    """
    Collapse raw OSM elements into one row per name with an averaged centre.

    A street is many `way` elements sharing one `name` tag, so the per-element
    centres are averaged into a single representative point. That point is
    deliberately crude — it is the map pin for an alert, not the geometry.

    Each row also keeps the OSM ids it was built from. The name is not an
    identity — two settlements can hold two different places that share one —
    so the ids are what lets a caller tell "the same place, seen from two
    sweeps" from "two places, one name". See resolve_district_rows.
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

        row = grouped.setdefault(
            name, {"name": name, "lat_sum": 0.0, "lng_sum": 0.0, "parts": 0, "ids": set()})
        row["lat_sum"] += lat
        row["lng_sum"] += lng
        row["parts"] += 1
        row["ids"].add(f"{element.get('type', '?')}/{element.get('id', '')}")

    rows = [
        {
            "name": r["name"],
            "lat": round(r["lat_sum"] / r["parts"], 7),
            "lng": round(r["lng_sum"] / r["parts"], 7),
            "parts": r["parts"],
            "ids": r["ids"],
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


def by_settlement(target: str) -> bool:
    if target not in TARGETS:
        raise ToolError(f"Unknown target table: {target}")
    return TARGETS[target]["by_settlement"]


def entry_key(target: str, entry: dict):
    """
    What counts as the same row — the same key the UNIQUE constraint uses, so a
    merge here and an `INSERT ... ON CONFLICT` there agree on what a duplicate
    is. Migration 0015 moved the streets constraint to (street_name, region_id)
    and 0017 moved the regions one to (region_name, settlement); this moved with
    both.

    The empty string stands in for a region with no parent — a settlement, which
    is inside nothing — and is the same fold `COALESCE(settlement_id, 0)` does in
    the index. Both halves matter: without it "Цветен квартал" in Варна and in
    Белослав are one row here and two there, and the merge would drop one of
    them before the database ever saw it.
    """
    if by_settlement(target):
        return (entry.get("settlement") or DEFAULT_SETTLEMENT, entry["name"])
    return (entry.get("settlement") or "", entry["name"])


def load_seed(target: str, store: str) -> list[dict]:
    """
    Read a seed file, accepting both the legacy flat `["name", ...]` form and
    the `[{"name", "settlement", "lat", "lng"}, ...]` form this tool writes.

    A street entry with no `settlement` is read as Варна — the seed held city
    streets and nothing else before migration 0015, which is the same reading
    generate-seed.mjs applies to the same files.
    """
    path = store_dir(store) / TARGETS[target]["file"] if target in TARGETS else None
    if path is None:
        raise ToolError(f"Unknown target table: {target}")
    if not path.exists():
        return []

    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ToolError(f"{path.name}: expected a JSON array.")

    keyed = by_settlement(target)
    entries = []
    for item in data:
        if isinstance(item, str):
            name = item.strip()
            if not name:
                continue
            entry = {"name": name, "lat": None, "lng": None}
        elif isinstance(item, dict) and str(item.get("name", "")).strip():
            entry = {
                "name": str(item["name"]).strip(),
                "lat": item.get("lat"),
                "lng": item.get("lng"),
            }
        else:
            continue
        settlement = str(item.get("settlement", "")).strip() if isinstance(item, dict) else ""
        if keyed:
            entry = {"name": entry["name"], "settlement": settlement or DEFAULT_SETTLEMENT,
                     "lat": entry["lat"], "lng": entry["lng"]}
        elif settlement and settlement != entry["name"]:
            # A region's settlement is its PARENT (migration 0016) — the city a
            # district sits inside. Absent on a settlement row, which is in
            # nothing, and never itself: a self-link would say a place contains
            # itself, and generate-seed.mjs would write a cycle into the FK.
            entry["settlement"] = settlement
        entries.append(entry)
    return entries


def known_region_names() -> set[str]:
    """
    Every SETTLEMENT name either seed store holds — the settlements a street may
    claim.

    Settlement-class rows only, i.e. those with no parent of their own. A street
    is filed under a settlement and never under a district (migration 0015's
    invariant), and since 0017 a district may share its name with one, so
    accepting any region here would let a street be filed against a row
    `streets.region_id` must never point at.

    A street whose settlement has no `regions` row inserts NOTHING at apply
    time and says nothing about it (the INSERT ... SELECT finds no region), so
    a whole village can vanish between "merged 94 streets" and a database that
    gained none. Checking the name here is the one place that failure is cheap
    to catch.
    """
    names = set()
    for store in STORES:
        names.update(entry["name"] for entry in load_seed("regions", store)
                     if not entry.get("settlement"))
    return names


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
    # git diff containing only the rows that actually changed. Settlement first
    # where there is one, so a village's streets read as one block in the diff
    # instead of interleaving with the city's.
    if by_settlement(target):
        entries = sorted(entries, key=lambda e: (e.get("settlement") or "", e["name"]))
        entries = [{"name": e["name"], "settlement": e.get("settlement") or DEFAULT_SETTLEMENT,
                    "lat": e["lat"], "lng": e["lng"]} for e in entries]
    else:
        # Name first, parent only as the tie-break: a district keeps its place
        # in the diff when its parent is filled in later, and two districts
        # sharing a name still get a stable order. The parent is written only
        # when there is one, which keeps a settlement row byte-identical to what
        # the tool wrote before migration 0016.
        entries = sorted(entries, key=lambda e: (e["name"], e.get("settlement") or ""))
        entries = [
            {"name": e["name"], **({"settlement": e["settlement"]} if e.get("settlement") else {}),
             "lat": e["lat"], "lng": e["lng"]}
            for e in entries
        ]
    path.write_text(json.dumps(entries, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def merge_into_seed(target: str, incoming: list[dict], overwrite: bool,
                    store: str = "output", settlement: str | None = None,
                    authoritative: bool = False) -> dict:
    """
    Merge rows into a seed file, keyed the way the `UNIQUE` constraint is (see
    entry_key), so a merge here and an `INSERT ... ON CONFLICT` there agree on
    what a duplicate is.

    The same function serves both hops: Overpass rows into output/, and output/
    into backend/seeds/. They are the same operation over the same key.

    `settlement` stamps every incoming row, and is how an extraction files its
    results: the browser sends rows, never which settlement they are in. Left
    None — the promote hop — each row keeps the settlement it already carries.

    `overwrite` decides what happens to a value that is already there, and covers
    both of them: coordinates and a district's parent link. A missing value is
    always filled in without it.

    `authoritative` says the incoming rows are the COMPLETE set for the names
    they carry, which is the only condition under which a row can be retired —
    see the removal pass below. Only a whole-province sweep can claim it; a hand
    merge of a few extracted rows cannot, and saying so wrongly would delete a
    district's namesake in another settlement.
    """
    keyed = by_settlement(target)
    if keyed and settlement is not None:
        settlement = settlement.strip()
        if not settlement:
            raise ToolError("A street extraction needs the settlement its streets are in.")
        known = known_region_names()
        if settlement not in known:
            raise ToolError(
                f'"{settlement}" is not a region in either seed file, so every street filed '
                f"under it would insert nothing at apply time. Extract it as a region first "
                f'(kind "Cities / towns / villages"), or correct the spelling — the name has '
                f"to match a regions entry exactly."
            )

    existing = {entry_key(target, e): e for e in load_seed(target, store)}
    added, enriched, updated, unchanged = [], [], [], 0
    seen_keys, seen_names = set(), set()

    for row in incoming:
        name = str(row.get("name", "")).strip()
        if not name:
            continue
        lat, lng = row.get("lat"), row.get("lng")
        has_coords = isinstance(lat, (int, float)) and isinstance(lng, (int, float))

        entry = {"name": name, "lat": lat if has_coords else None,
                 "lng": lng if has_coords else None}
        row_parent = str(row.get("settlement", "")).strip()
        if keyed:
            entry["settlement"] = settlement or row_parent or DEFAULT_SETTLEMENT
        elif row_parent and row_parent != name:
            entry["settlement"] = row_parent
        key = entry_key(target, entry)
        seen_keys.add(key)
        seen_names.add(name)

        current = existing.get(key)
        if current is None:
            existing[key] = entry
            added.append(name)
            continue

        # A region already present can still gain its parent link, the same way
        # it can gain coordinates: the sweep learns which settlement a district
        # is in, and the 252 regions seeded before migration 0016 have none.
        #
        # Replacing one that disagrees needs `overwrite`, for the same reason
        # coordinates do — but it has to be reachable, or a link the sweep wrote
        # before its resolution was corrected can never be put right. That is not
        # hypothetical: the first sweep of Варна province filed four `с.о.` villa
        # zones under Варна, because the city's `admin_level 8` relation is the
        # whole municipality.
        if not keyed and entry.get("settlement"):
            if not current.get("settlement"):
                current["settlement"] = entry["settlement"]
                if name not in enriched:
                    enriched.append(name)
            elif overwrite and current["settlement"] != entry["settlement"]:
                current["settlement"] = entry["settlement"]
                if name not in updated:
                    updated.append(name)

        if not has_coords:
            unchanged += 1
        elif current.get("lat") is None or current.get("lng") is None:
            current["lat"], current["lng"] = lat, lng
            if name not in enriched:
                enriched.append(name)
        elif overwrite:
            current["lat"], current["lng"] = lat, lng
            updated.append(name)
        else:
            unchanged += 1

    # A parent link is half a region's key since migration 0017, so a district
    # whose settlement changed does not land on its old entry — it lands beside
    # it, and the stale one would be seeded as a second region.
    #
    # Retiring it needs BOTH flags, and they say different things. `overwrite` is
    # the user's permission to change what is already there; `authoritative` is
    # the caller's promise that this batch is every row those names have, so an
    # entry the batch did not produce is one the source no longer has.
    #
    # Without that second condition this would be a trap rather than a repair: a
    # hand merge of Белослав's "Цветен квартал" alone would look exactly like a
    # sweep that had stopped finding Варна's, and delete it.
    # A settlement row is never something a DISTRICT batch is authoritative
    # about, and retiring one is how the seed lost `с. Припек`. Варна province
    # holds two places of that name 10 km apart — the village at 43.255, 27.738
    # and a suburb of Константиново at 43.174, 27.796 — so the district pass
    # produced ("Припек", Константиново), the name matched, the key did not, and
    # the village row was deleted. `с. Припек` then had only the suburb to match,
    # settlementScope followed its parent link, and two alerts pinned
    # Константиново. Since migration 0017 a settlement row and a district row of
    # the same name are two different places BY CONSTRUCTION — that is what
    # putting the parent in the key means — so a batch of districts can say
    # nothing about the parentless row.
    removed = []
    if not keyed and overwrite and authoritative:
        for key, entry in list(existing.items()):
            if entry.get("settlement") and entry["name"] in seen_names and key not in seen_keys:
                del existing[key]
                removed.append(f"{entry['name']} ({entry.get('settlement')})")

    entries = list(existing.values())
    path = save_seed(target, store, entries)
    return {
        "target": target,
        "file": display_path(path),
        "settlement": settlement if keyed else None,
        "added": added,
        "enriched": enriched,
        "updated": updated,
        "removed": removed,
        "unchanged": unchanged,
        "total": len(entries),
        "without_coords": sum(1 for e in entries if e["lat"] is None or e["lng"] is None),
    }


def seed_status() -> dict:
    """
    Per-store counts plus the full key list. The keys drive the "not in
    output"/"not in backend" figures in the UI, which is how you see what a
    merge would actually change before anything is written — so they are the
    UNIQUE key, not the bare name: "ул. Тича" being present says nothing about
    whether it is present *for the settlement being extracted*.

    Keys travel as "settlement\\u0000name" because JSON has no tuples; the UI
    joins the same way. `settlements` is the readable form of the same fact.
    """
    status = {}
    for store, meta in STORES.items():
        status[store] = {"label": meta["label"], "dir": display_path(meta["dir"]), "targets": {}}
        for target in TARGETS:
            entries = load_seed(target, store)
            settlements: dict[str, int] = {}
            for entry in entries:
                if by_settlement(target):
                    name = entry.get("settlement") or DEFAULT_SETTLEMENT
                    settlements[name] = settlements.get(name, 0) + 1
            status[store]["targets"][target] = {
                "total": len(entries),
                "with_coords": sum(
                    1 for e in entries if e["lat"] is not None and e["lng"] is not None),
                "keys": ["\u0000".join(entry_key(target, e)) if by_settlement(target)
                         else e["name"] for e in entries],
                "settlements": dict(sorted(settlements.items(), key=lambda kv: -kv[1])),
            }
    status["sql"] = sql_status()
    status["regions_known"] = sorted(known_region_names())
    # Settlements the `around` kinds cannot search from, because nothing has
    # given them a centre yet. Named rather than merely absent, so the answer to
    # "why is Х not offered" is on screen instead of in this file.
    with_point = {e["name"] for store in STORES for e in load_seed("regions", store)
                  if isinstance(e.get("lat"), (int, float))
                  and isinstance(e.get("lng"), (int, float))}
    status["regions_without_point"] = sorted(set(status["regions_known"]) - with_point)
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


def promote_to_backend(overwrite: bool) -> dict:
    """Merge output/ into backend/seeds/ — the one step that writes outside the
    tool's own directory, hence its own button rather than a side effect."""
    pending = {target: load_seed(target, "output") for target in TARGETS}
    if not any(pending.values()):
        raise ToolError("output/ is empty — merge some extracted rows into it first.")
    return {"reports": [
        # output/ is the tool's complete set for every name it holds — a whole
        # province sweep, not a hand-picked batch — so a backend row under one of
        # those names that output/ does not carry is a superseded key, typically a
        # district seeded before it had a parent. Names output/ has never seen (the
        # industrial zones, the к.к. resorts, 0014's village renames) are not in the
        # batch and are left exactly as they are.
        merge_into_seed(target, entries, overwrite, store="backend", authoritative=True)
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


# ── province sweep ────────────────────────────────────────────────────────────
#
# One input, the whole seed. The step-by-step flow above exists to let you look
# at what Overpass returned and deselect by eye; this exists because doing that
# 171 times for Варна province is not a workflow anyone will follow, and the
# per-settlement extraction it replaces was the part of migration 0015 nobody
# had finished.
#
# The three levels come out of it the way the app now models a location
# (settlement → area → street, SPEC.md §1.7):
#
#   * settlements — `place=city|town|village|hamlet` in the province.
#   * districts   — extracted from INSIDE each settlement's own boundary, which
#                   is what ties them to it. Not inferred afterwards from
#                   distance: the containment IS the query.
#   * streets     — from the same boundary, filed under that settlement.
#
# What it deliberately does NOT do is tie a street to a district. 67 of Варна
# province's 79 districts are mapped as a single node with no extent, and the 12
# that do have one are all м-т/с.о. villa zones — every real district (Виница,
# Аспарухово, Галата, Чайка) is a bare point. There is nothing in OSM to test a
# street against, so a street is filed under its settlement, which is also the
# only thing `streets.region_id` can hold (migration 0015).

_sweep_lock = threading.Lock()
_sweep: dict = {"state": "idle"}


def sweep_status() -> dict:
    with _sweep_lock:
        return dict(_sweep)


def _sweep_set(**fields) -> None:
    with _sweep_lock:
        _sweep.update(fields)


def province_settlements(endpoint: str, province: str,
                         timeout: int = 300) -> tuple[list[dict], dict[str, list[int]]]:
    """
    Every settlement in a province, and the boundary relation IDs the province
    holds for each name.

    The boundary map decides how each one is swept: a settlement with exactly one
    relation inside this province is bounded by that relation's id, and the rest
    fall back to a radius. Asked once for the whole province rather than probed
    per settlement, which is 2 queries instead of 2 × 171.

    Ids rather than the bare set of names this used to return. The names were
    enough to answer "is this one bounded" and not enough to bound it: the
    per-settlement query then re-resolved the name with no province filter, which
    is how eleven settlements' streets came from same-named towns elsewhere in
    Bulgaria. This query is already scoped by `area.p`, so the ids it returns are
    the province's own — carrying them through is the whole fix.

    A name with more than one relation IN THE PROVINCE is returned as such rather
    than picked between. See run_sweep: that is a condition to report and stop
    on, not to union.
    """
    escaped = province.strip().replace("\\", "\\\\").replace('"', '\\"')
    if not escaped:
        raise ToolError("Enter a province to sweep.")

    area = (f'relation["name"="{escaped}"]["boundary"="administrative"]'
            f'["admin_level"="{PROVINCE_ADMIN_LEVEL}"];\nmap_to_area->.p;')

    found = overpass_post(endpoint, (
        f"[out:json][timeout:{timeout}];\n{area}\n(\n"
        + "\n".join(f'  {t}(area.p)["place"~"^({SETTLEMENT_PLACES})$"]["name"];'
                    for t in ("node", "way", "relation"))
        + "\n);\nout tags center;"
    )).get("elements", [])
    if not found:
        raise ToolError(
            f'No settlements found in a province named "{province}". Check the spelling, or '
            f"that this endpoint's data covers it — the query needs an admin_level "
            f"{PROVINCE_ADMIN_LEVEL} boundary with that exact name.")

    bounded = overpass_post(endpoint, (
        f"[out:json][timeout:{timeout}];\n{area}\n"
        f'relation(area.p)["boundary"="administrative"]'
        f'["admin_level"="{SETTLEMENT_ADMIN_LEVEL}"]["name"];\nout tags;'
    )).get("elements", [])

    settlements = {}
    for element in found:
        tags = element.get("tags") or {}
        name = (tags.get("name") or "").strip()
        centre = element.get("center") or element
        lat, lng = centre.get("lat"), centre.get("lon")
        if not name or name in settlements:
            continue
        settlements[name] = {
            "name": name,
            "place": tags.get("place", ""),
            "lat": lat if isinstance(lat, (int, float)) else None,
            "lng": lng if isinstance(lng, (int, float)) else None,
        }
    boundary_ids: dict[str, list[int]] = {}
    for element in bounded:
        name = ((element.get("tags") or {}).get("name") or "").strip()
        if name and isinstance(element.get("id"), int):
            boundary_ids.setdefault(name, []).append(element["id"])
    return sorted(settlements.values(), key=lambda s: s["name"]), boundary_ids


def sweep_settlement(endpoint: str, settlement: dict, rel_id: int | None,
                     radius: int, timeout: int = 300) -> tuple[list[dict], list[dict]]:
    """One settlement's streets and districts, as two grouped row lists."""
    if rel_id is not None:
        query = SETTLEMENT_SWEEP_TEMPLATE.format(
            timeout=timeout, rel_id=int(rel_id),
            streets=STREET_HIGHWAYS, districts=DISTRICT_PLACES)
    else:
        if settlement["lat"] is None or settlement["lng"] is None:
            return [], []
        query = SETTLEMENT_SWEEP_AROUND_TEMPLATE.format(
            timeout=timeout, radius=int(radius),
            lat=settlement["lat"], lng=settlement["lng"],
            streets=STREET_HIGHWAYS, districts=DISTRICT_PLACES)

    elements = overpass_post(endpoint, query).get("elements", [])
    streets = [e for e in elements if "highway" in (e.get("tags") or {})]
    districts = [e for e in elements if "place" in (e.get("tags") or {})]
    return group_elements(streets), group_elements(districts)


# A name that is nothing but its own kind word: OSM carries `name=Площад` for an
# unnamed square, and one such row reached the seed. It can never match anything
# — the matcher scores on the name minus its kind prefix, and that is the empty
# string here — so it is dead weight the fuzzy matcher pays for on every lookup.
# Mirrors core/place-names.ts's KIND_PATTERNS and ingestion/normalize.ts's A1.
KINDLESS_NAME = re.compile(
    r"^(?:улица|ул\s*\.|булевард|бул\s*\.|алея|ал\s*\.|площад|пл\s*\.|"
    r"квартал|кв\s*\.|жилищен\s+комплекс|ж\s*\.?\s*к\s*\.?|местност|м\s*-\s*с?т|"
    r"град|гр\s*\.|село|с\s*\.)\s*$",
    re.IGNORECASE)


def drop_kindless(rows: list[dict]) -> tuple[list[dict], list[str]]:
    """Split rows into usable names and bare kind words. See KINDLESS_NAME."""
    kept, dropped = [], []
    for row in rows:
        (dropped if KINDLESS_NAME.match(row["name"].strip()) else kept).append(row)
    return kept, [r["name"] for r in dropped]


def within_reach(rows: list[dict], settlement: dict) -> tuple[list[dict], list[str]]:
    """
    Split extracted rows into those inside MAX_EXTRACT_KM of the settlement
    centre and those beyond it.

    Belt-and-braces behind the identity-keyed query: with the relation id
    carrying the province scope through, nothing should ever be out here. So the
    far rows are RETURNED rather than dropped in silence — a rule you cannot see
    applied is one you cannot notice being wrong, and this one firing is evidence
    that some other part of the extraction has gone astray.
    """
    if settlement["lat"] is None or settlement["lng"] is None:
        return rows, []
    near, far = [], []
    for row in rows:
        km = haversine_km(row["lat"], row["lng"], settlement["lat"], settlement["lng"])
        (near if km <= MAX_EXTRACT_KM else far).append(
            row if km <= MAX_EXTRACT_KM else f"{row['name']} ({km:.0f} km)")
    return near, far


def haversine_km(lat1, lon1, lat2, lon2) -> float:
    """Great-circle distance, for ranking which settlement a district is nearest."""
    if None in (lat1, lon1, lat2, lon2):
        return float("inf")
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def cluster_by_identity(hits: list[dict]) -> list[list[dict]]:
    """
    Split one name's claims into the distinct *places* behind them.

    Two claims are the same place when the sweeps that produced them saw at
    least one OSM element in common, and the transitive closure of that groups a
    place mapped as several ways. Identity, not distance: settlement centres in
    Варна province come as close as 0.37 km, so no radius separates "two places
    sharing a name" from "one place two sweeps both reached".
    """
    clusters: list[list[dict]] = []
    for hit in hits:
        ids = set(hit.get("ids") or ())
        touching = [c for c in clusters
                    if any(ids & set(h.get("ids") or ()) for h in c)] if ids else []
        if not touching:
            clusters.append([hit])
            continue
        merged = [hit]
        for c in touching:
            merged.extend(c)
            clusters.remove(c)
        clusters.append(merged)
    return clusters


def resolve_district_rows(found: dict[str, list[dict]]) -> tuple[list[dict], list[str]]:
    """
    Decide which settlement each swept district belongs to.

    A district name is only unique inside its settlement — the same mismatch
    migration 0015 fixed for streets and 0017 fixed for regions — and Варна
    province produces six names that more than one settlement claims. They are
    not one problem but two, which is why this runs in two passes.

    **Pass 1 — one name can be two places.** `Цветен квартал` is node
    9664925200 at 43.2239,27.9138 in Варна *and* node 10702624492 at
    43.1817,27.7038 in Белослав, 17.5 km apart. Nothing is wrong with the data
    and neither claim should lose: since 0017 keys `regions` on (name, parent),
    both are simply kept, under the one name they are both really called. The
    four `с.о.`/`со` names and `ж.к. Север`, by contrast, are a *single* element
    each that several sweeps reached — one place, one row.

    **Pass 2 — one place can be claimed by several settlements**, in two ways
    that need opposite answers:

      * *A radius overreaching.* 11 of this province's 12 hamlets have no
        boundary, so the 2,500 m fallback reaches into a neighbour. `ж.к. Север`
        is Провадия's (boundary, 1.5 km) and three м-т hamlets grabbed a copy —
        м. Шашкъните from 0.24 km, nearer than the town. Proximity alone would
        hand it to the hamlet, so **a boundary match beats a radius match**: it
        is authoritative containment where a radius is a guess.
      * *A boundary claim that is merely large.* Measured against the local
        Overpass instance on 10.08.2026: `admin_level 8` in Bulgaria is the
        **населено място**, not the община — `rel(13477567)` ("Варна", level 8)
        contains exactly one `place` settlement, Варна itself. (An earlier
        comment here asserted the opposite and was wrong; §1.0 of ACCURACY.md
        was right.) The city's boundary is still *big* — it reaches Галата and
        Аспарухово — so it legitimately contains villa zones 8–12 km from the
        centre that sit 2.1–2.7 km from a village. Among boundary matches the
        **nearest settlement wins**, not the biggest. Administrative boundaries
        at one level do not overlap, so in practice at most one settlement
        claims a place by boundary and this degenerates to that claim; the rule
        earns its keep on the radius claims below.

    Villages do legitimately own districts — every one is a `с.о.`/`со` villa
    zone, a countryside formation inside a village boundary rather than a housing
    estate. Towns own real ones: Белослав's three (`ж.к. Младост`, `кв.
    Акациите`, `Цветен квартал`) are confirmed against Nominatim.

    There is no name disambiguation left to do. Before 0017 the second of two
    places had to be renamed — migration 0014 wrote "ж.к. Младост (Белослав)" by
    hand and this function had to keep doing the same — and that suffix was a
    poor key: no source writes it, so the row was reachable only by fuzzy
    matching a string nobody produces. The parent carries that fact now.
    """
    rows, resolved = [], []
    for name, hits in sorted(found.items()):
        places = cluster_by_identity(hits)
        for cluster in places:
            # Authoritative containment first, then proximity.
            bounded = [h for h in cluster if h["bounded"]] or cluster
            best = min(bounded, key=lambda h: h["km"])
            rows.append({"name": name, "settlement": best["settlement"],
                         "lat": best["lat"], "lng": best["lng"]})
            losers = ", ".join(f"{h['settlement']} ({h['place']}"
                               f"{'' if h['bounded'] else ', radius only'})"
                               for h in cluster if h is not best)
            if losers:
                resolved.append(
                    f"{name} → {best['settlement']} ({best['place']}); also claimed by {losers}")
        if len(places) > 1:
            resolved.append(
                f'"{name}" is {len(places)} different places — kept as one row each, in '
                + ", ".join(sorted(
                    min([h for h in c if h["bounded"]] or c, key=lambda h: h["km"])["settlement"]
                    for c in places)))
    return rows, resolved


def run_sweep(endpoint: str, province: str, radius: int,
              cyrillic_only: bool, overwrite: bool) -> None:
    """
    The whole province, into output/. Runs on a worker thread; progress is polled
    from /api/sweep/status because 171 round trips is longer than a request
    should block for, and a silent minute is indistinguishable from a hang.

    Queried first, merged second. The district links can only be decided once
    every settlement has been seen — a name found under two of them is not
    something the settlement processed first should get to settle.
    """
    try:
        _sweep_set(state="running", phase="Resolving the province…", done=0, total=0,
                   settlements=0, districts=0, streets=0, current="",
                   skipped=[], dropped=[], resolved=[], error=None)
        settlements, boundary_ids = province_settlements(endpoint, province)
        _sweep_set(phase="Sweeping settlements…", total=len(settlements))

        # Every name this province enumerates as a settlement in its own right,
        # with where it is. A district may not be filed under another settlement
        # when it is one of these AND sits on top of it: `с. Припек` is a village
        # of община Аврен that OSM also tags as a place inside Константиново's
        # boundary, so the district pass overwrote its own settlement row with a
        # parented one and `settlementScope` then answered "с. Припек" with
        # Константиново's centroid, 1.7 km off. Раков дол and Гара Бяла are the
        # same shape at 260 and 190 km, and those two became impossible the
        # moment the query was keyed by relation id; this rule is what catches
        # the one that is genuinely next door.
        #
        # The proximity half is not optional. Without it the rule also refuses
        # the resort suburb `Чайка` (43.25, 28.03) because a *village* Чайка
        # exists 50 km away at 43.08, 27.43 — two different places sharing a
        # name, which is exactly what migration 0017 lets the table hold. See
        # SAME_PLACE_KM.
        settlement_points = {s["name"]: (s["lat"], s["lng"]) for s in settlements}

        district_where: dict[str, list[dict]] = {}
        street_rows: list[tuple[str, list[dict]]] = []
        skipped: list[str] = []
        dropped: list[str] = []
        streets_total = 0

        for i, settlement in enumerate(settlements, 1):
            name = settlement["name"]
            _sweep_set(current=name, done=i - 1)
            ids = boundary_ids.get(name, [])
            if len(ids) > 1:
                # Two boundary relations of one name INSIDE one province. Nothing
                # in the data says which is the settlement, and unioning them is
                # exactly the failure this sweep was rewritten to make impossible
                # — so it stops and says so rather than guessing.
                skipped.append(
                    f"{name}: {len(ids)} admin_level {SETTLEMENT_ADMIN_LEVEL} relations in this "
                    f"province ({', '.join(str(i) for i in ids)}) — ambiguous, not swept")
                _sweep_set(skipped=list(skipped))
                continue
            rel_id = ids[0] if ids else None
            if rel_id is None and (settlement["lat"] is None or settlement["lng"] is None):
                # No boundary to bound it and no point to search around: OSM
                # knows the name and nothing else about where it is.
                skipped.append(f"{name}: no boundary and no centre — nothing to search")
                _sweep_set(skipped=list(skipped))
                continue
            bounded = rel_id is not None
            try:
                streets, districts = sweep_settlement(endpoint, settlement, rel_id, radius)
            except ToolError as e:
                skipped.append(f"{name}: {e}")
                _sweep_set(skipped=list(skipped))
                continue

            if cyrillic_only:
                streets, _ = split_by_script(streets)
                districts, _ = split_by_script(districts)
            # Names that are nothing but a kind word, then the distance backstop.
            streets, kindless = drop_kindless(streets)
            districts, kindless_d = drop_kindless(districts)
            if kindless or kindless_d:
                dropped.append(f"{name}: {len(kindless) + len(kindless_d)} name(s) that are only "
                               f"a kind word — {', '.join(kindless + kindless_d)}")
            streets, far_streets = within_reach(streets, settlement)
            districts, far_districts = within_reach(districts, settlement)
            for label, far in (("street", far_streets), ("district", far_districts)):
                if far:
                    dropped.append(f"{name}: {len(far)} {label}(s) beyond {MAX_EXTRACT_KM:.0f} km "
                                   f"— {', '.join(far[:5])}{' …' if len(far) > 5 else ''}")
            if far_streets or far_districts:
                _sweep_set(dropped=list(dropped))
            # A district that repeats the settlement's own name is the settlement
            # tagged twice, not a place inside itself.
            for d in districts:
                if d["name"] == name:
                    continue
                # …and one that IS another settlement of this province, standing
                # on that settlement's own spot, is that settlement rather than a
                # district of this one.
                twin = settlement_points.get(d["name"])
                if twin is not None:
                    km = haversine_km(d["lat"], d["lng"], twin[0], twin[1])
                    if km <= SAME_PLACE_KM:
                        dropped.append(
                            f"{name}: '{d['name']}' is a settlement of this province "
                            f"({km:.1f} km away), not a district of it")
                        _sweep_set(dropped=list(dropped))
                        continue
                # Everything the resolution needs, recorded where it is known:
                # which OSM elements this sweep actually saw (the identity the
                # name is not), how the settlement matched, what size it is, and
                # how far the district sits from its centre. The geometry rides
                # along per claim — a name cannot carry one, because two
                # settlements' claims on one name can be two different places.
                district_where.setdefault(d["name"], []).append({
                    "settlement": name,
                    "bounded": bounded,
                    "place": settlement["place"],
                    "ids": d["ids"],
                    "lat": d["lat"],
                    "lng": d["lng"],
                    "km": haversine_km(d["lat"], d["lng"], settlement["lat"], settlement["lng"]),
                })
            if streets:
                street_rows.append((name, streets))
                streets_total += len(streets)
            _sweep_set(done=i, districts=len(district_where), streets=streets_total)

        _sweep_set(phase="Merging…", current="")

        # Settlements first: a district's parent and a street's settlement are
        # both resolved by NAME at apply time, so the row they point at has to
        # exist before anything points at it.
        rows = [{"name": s["name"], "lat": s["lat"], "lng": s["lng"]} for s in settlements]
        if cyrillic_only:
            rows, _ = split_by_script(rows)
        merge_into_seed("regions", rows, overwrite, store="output")
        _sweep_set(settlements=len(rows))

        # Each row already carries the coordinate of the place it resolved to,
        # not of whatever else shared its name — the two Цветен квартал rows are
        # 17.5 km apart and must stay that way.
        district_entries, resolved = resolve_district_rows(district_where)
        if district_entries:
            # The sweep saw every settlement in the province, so its districts
            # are the complete set for the names in them.
            merge_into_seed("regions", district_entries, overwrite, store="output",
                            authoritative=True)

        for settlement_name, streets in street_rows:
            merge_into_seed("streets", streets, overwrite,
                            store="output", settlement=settlement_name)

        _sweep_set(state="done", phase="Finished.", current="", done=len(settlements),
                   districts=len(district_entries), skipped=skipped, dropped=dropped,
                   resolved=resolved,
                   seeds=seed_status())
    except (ToolError, OSError, ValueError, KeyError) as e:
        _sweep_set(state="error", error=str(e), phase="Failed.")


def start_sweep(body: dict) -> dict:
    with _sweep_lock:
        if _sweep.get("state") == "running":
            raise ToolError("A sweep is already running.")
        _sweep.clear()
        _sweep.update({"state": "running", "phase": "Starting…", "done": 0, "total": 0})

    args = (
        body["endpoint"],
        str(body.get("province", "")).strip(),
        int(body.get("radius") or DEFAULT_RADIUS_M),
        bool(body.get("cyrillic_only", True)),
        bool(body.get("overwrite")),
    )
    threading.Thread(target=run_sweep, args=args, daemon=True).start()
    return {"started": True}


def query_for(body: dict) -> str:
    """One request body → one Overpass query, whichever kind it names."""
    kind = body["kind"]
    point = None
    if kind in KINDS and KINDS[kind].get("needs_point"):
        point = settlement_point(body.get("settlement", ""))
    return build_query(
        kind,
        int(body.get("area_id") or 0),
        int(body.get("timeout", 180)),
        point=point,
        radius=int(body.get("radius") or DEFAULT_RADIUS_M),
    )


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
                "kinds": [{"id": k, "label": v["label"], "target": v["target"],
                           "needs_point": bool(v.get("needs_point"))}
                          for k, v in KINDS.items()],
                "targets": [{"id": t, "by_settlement": TARGETS[t]["by_settlement"]}
                            for t in TARGETS],
                "settlement_level": SETTLEMENT_ADMIN_LEVEL,
                "province_level": PROVINCE_ADMIN_LEVEL,
                "default_province": presets.get("default_province", ""),
                "default_radius": DEFAULT_RADIUS_M,
                "seeds": seed_status(),
            })
        elif path == "/api/sweep/status":
            self._send_json(sweep_status())
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
                self._send_json({"query": query_for(body)})
            elif path == "/api/run-query":
                query = body.get("raw") or query_for(body)
                result = overpass_post(body["endpoint"], query)
                rows = group_elements(result.get("elements", []))
                dropped = []
                # Default on: absent means the caller predates the checkbox.
                if body.get("cyrillic_only", True):
                    rows, dropped = split_by_script(rows)
                # Which settlement these rows are in, read back from the
                # boundary itself so the UI can propose it rather than have the
                # user retype a name that has to match a regions row exactly.
                area = area_info(body["endpoint"], int(body.get("area_id") or 0))
                self._send_json({"query": query, "rows": rows, "dropped": dropped,
                                 "area": area,
                                 "settlement_level": SETTLEMENT_ADMIN_LEVEL})
            elif path == "/api/merge":
                # Extractions only ever land in the tool's own output/, and the
                # settlement is stamped on here rather than carried per row —
                # one extraction is one settlement.
                self._send_json(merge_into_seed(
                    body["target"], body.get("rows", []), bool(body.get("overwrite")),
                    store="output",
                    settlement=body.get("settlement") if by_settlement(body["target"]) else None))
            elif path == "/api/sweep":
                self._send_json(start_sweep(body))
            elif path == "/api/promote":
                self._send_json(promote_to_backend(bool(body.get("overwrite"))))
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
    # Windows consoles still default to a legacy code page (cp1252 here), and
    # every message this tool prints — the banner's arrow, a Bulgarian place
    # name in an error — is outside it. Printing one raised UnicodeEncodeError
    # and killed the process before the server started. Reconfiguring is enough;
    # `errors="replace"` keeps a name we cannot render from being fatal.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, OSError):
            pass

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
