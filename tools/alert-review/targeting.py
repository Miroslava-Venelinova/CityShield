"""
Who a stored alert would notify — a port of the Worker's targeting.

"Wrong coordinates" you can see on a map. "This alert reached nobody" you
cannot see at all: the pins look right, the streets are listed, and the row
says nothing about which users the matcher actually resolved. That is the
failure this file exists to surface — a district that resolves to no region, a
street name that exists in no settlement we seeded, a settlement slot that
scopes the street lookup to nothing.

So this is a line-by-line mirror of `backend/src/core/alert-service.ts`
(`sendUsersNotification` → `getUserIdsInRange` / `getUserIdsInPolygonRange` /
`getUserIdsCityWide`), `core/place-names.ts`, `core/fuzzy.ts` and `core/geo.ts`,
running against the same four tables the Worker reads. It answers with the
audience *and* with how each user got in, because a reviewer needs the second
one to say what went wrong.

Two things it cannot know, and says so rather than guessing:

* **`city_wide` is not stored.** It decides targeting at ingest time and is
  then gone (SPEC §1.5, decision 2), so an alert with no locations is genuinely
  ambiguous: either the model said city-wide and everyone inside 15 km was
  notified, or it produced nothing and the alert was stored without notifying
  anyone. Both branches are reported.
* **`bus_lines` is not stored either.** A vt route alert is narrowed to
  subscribers of the affected lines, so for that category the answer here is an
  upper bound.

Everything else is exact, and deliberately duplicated rather than approximated:
an "about right" audience would be worse than none, because it would be
believed. When the Worker's matcher changes, this has to change with it — the
constants below carry the same names as the ones they mirror so a diff is
findable.

Standard library only, like the rest of the tool.
"""

import math
import re
from dataclasses import dataclass, field

# ── trigrams: backend/src/core/fuzzy.ts ───────────────────────────────────────
#
# The Worker packs each trigram into a number to save allocations against its
# 10 ms CPU budget; plain strings are in bijection with those keys, so Jaccard
# over either set gives the same score. Nothing here is on a budget.

# `[^\p{L}\p{N}]+` over there. Python's `\W` is "not letter, digit or
# underscore" under Unicode, so `[\W_]` is exactly "not letter and not digit".
WORD_SPLIT = re.compile(r"[\W_]+")


def trigrams(text) -> set:
    grams = set()
    for word in WORD_SPLIT.split(str(text).lower()):
        if not word:
            continue
        padded = f"  {word} "
        for i in range(len(padded) - 2):
            grams.add(padded[i:i + 3])
    return grams


def jaccard(a: set, b: set) -> float:
    if not a and not b:
        return 0.0
    shared = len(a & b)
    return shared / (len(a) + len(b) - shared)


def similarity(a: str, b: str) -> float:
    return jaccard(trigrams(a), trigrams(b))


# ── place names: backend/src/core/place-names.ts ──────────────────────────────

KIND_CLASS = {
    "ул.": "street", "бул.": "street", "ал.": "street", "пл.": "street",
    # Every kind that names a place INSIDE a settlement shares one class: the
    # sources use them interchangeably. кв. and ж.к. always did, and the
    # 08.08.2026 review found м-т and с.о. doing the same — epro writes
    # "м-ст Изгрев" for the row the seed carries as "кв. Изгрев", and "м-т Ален
    # мак" for an с.о. villa zone. Held apart, those three matched nothing.
    #
    # к.к. stays out: it is the one the sources do NOT confuse, and alert
    # 584f1445 pinned "ж.к. Чайка" on к.к. Чайка when the kind stopped deciding.
    "ж.к.": "district", "кв.": "district", "м-т": "district", "с.о.": "district",
    "к.к.": "resort",
    "с.": "village",
    "гр.": "city",
}

# `\p{L}` has no Python equivalent; `[^\W\d_]` is a word character that is
# neither a digit nor an underscore, i.e. a letter.
_L = r"[^\W\d_]"

# Order matters where one pattern could swallow another's prefix — "с.о."
# before "с.", and both dots required, or "с. Осеново" parses as с.о. + сеново.
KIND_PATTERNS = [
    (re.compile(rf"^(?:улица(?!{_L})|ул\s*\.|ул(?=\s))\s*", re.I), "ул."),
    (re.compile(rf"^(?:булевард(?!{_L})|бул\s*\.|бул(?=\s))\s*", re.I), "бул."),
    (re.compile(rf"^(?:алея(?!{_L})|ал\s*\.)\s*", re.I), "ал."),
    (re.compile(rf"^(?:площад(?!{_L})|пл\s*\.)\s*", re.I), "пл."),
    (re.compile(rf"^(?:жилищен\s+комплекс(?!{_L})|ж\s*\.?\s*к\s*\.?)\s*", re.I), "ж.к."),
    (re.compile(rf"^(?:квартал(?!{_L})|кв\s*\.|кв(?=\s))\s*", re.I), "кв."),
    (re.compile(rf"^(?:курортен\s+комплекс(?!{_L})|к\s*\.\s*к(?:\s*-\s*с)?\s*\.?|кк(?=\s))\s*", re.I), "к.к."),
    (re.compile(rf"^(?:местност(?!{_L})|м\s*-\s*с?т|м\s*\.)\s*", re.I), "м-т"),
    (re.compile(r"^(?:с\s*\.\s*о\s*\.|со(?=\s))\s*", re.I), "с.о."),
    (re.compile(rf"^(?:село(?!{_L})|с\s*\.)\s*", re.I), "с."),
    (re.compile(rf"^(?:град(?!{_L})|гр\s*\.)\s*", re.I), "гр."),
]

QUOTES = re.compile(r"[\"'„“”«»‘’]+")
SPACES = re.compile(r"\s+")


def clean_name(raw: str) -> str:
    return SPACES.sub(" ", QUOTES.sub(" ", str(raw or ""))).strip()


def parse_name(raw: str):
    """(kind, core) — the written kind prefix and the name without it."""
    cleaned = clean_name(raw)
    for pattern, kind in KIND_PATTERNS:
        m = pattern.match(cleaned)
        if m:
            return kind, cleaned[m.end():].strip()
    return None, cleaned


def place_class(kind):
    return None if kind is None else KIND_CLASS[kind]


def kinds_compatible(a, b) -> bool:
    return a is None or b is None or a == b


CORE_MATCH_THRESHOLD = 0.4
NEAR_TIE_BAND = 0.2
IN_CITY_RADIUS_KM = 9
VARNA_CENTER = (43.2073873, 27.9166653)

# ── geometry: backend/src/core/geo.ts ─────────────────────────────────────────

EARTH_RADIUS_KM = 6371
RAD = math.pi / 180
EDGE_EPS = 1e-12


def distance_km(a_lat, a_lng, b_lat, b_lng) -> float:
    """The Worker's equirectangular approximation, not a haversine — metres of
    error over the tens of kilometres these comparisons are about."""
    d_lat = (b_lat - a_lat) * RAD
    d_lng = (b_lng - a_lng) * RAD * math.cos(((a_lat + b_lat) / 2) * RAD)
    return math.hypot(d_lat, d_lng) * EARTH_RADIUS_KM


def ring_bbox(ring):
    if not ring:
        return None
    lats = [p[1] for p in ring]
    lngs = [p[0] for p in ring]
    return min(lats), max(lats), min(lngs), max(lngs)


def point_in_ring(lat, lng, ring) -> bool:
    """Ray casting with the boundary counted as inside, as the Worker does."""
    inside = False
    n = len(ring)
    for i in range(n):
        j = (i - 1) % n
        xi, yi = ring[i]
        xj, yj = ring[j]

        cross = (xj - xi) * (lat - yi) - (yj - yi) * (lng - xi)
        if (abs(cross) < EDGE_EPS
                and min(xi, xj) - EDGE_EPS <= lng <= max(xi, xj) + EDGE_EPS
                and min(yi, yj) - EDGE_EPS <= lat <= max(yi, yj) + EDGE_EPS):
            return True

        if (yi > lat) != (yj > lat) and lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi:
            inside = not inside
    return inside


def outer_ring(geometry):
    """Outer ring of a GeoJSON Polygon geometry as [lng, lat] pairs, or None."""
    coordinates = geometry.get("coordinates")
    if not isinstance(coordinates, list) or not coordinates or not isinstance(coordinates[0], list):
        return None
    ring = []
    for point in coordinates[0]:
        if (not isinstance(point, list) or len(point) < 2
                or not isinstance(point[0], (int, float)) or not isinstance(point[1], (int, float))):
            return None
        ring.append((float(point[0]), float(point[1])))
    return ring


def all_geometries(polygon_json):
    """Every geometry the Worker would target: each feature of a
    FeatureCollection, or the bare geometry itself."""
    features = polygon_json.get("features")
    if isinstance(features, list):
        out = []
        for feature in features:
            geometry = feature.get("geometry") if isinstance(feature, dict) else None
            if isinstance(geometry, dict):
                out.append(geometry)
        return out
    return [polygon_json] if "coordinates" in polygon_json else []


# ── the four tables the Worker reads ──────────────────────────────────────────


@dataclass
class Named:
    """A regions or streets row, as db/queries.ts's NamedRow."""
    id: int
    name: str
    lat: float | None
    lng: float | None
    settlement_id: int | None = None   # regions
    region_id: int | None = None       # streets


@dataclass
class User:
    user_id: str
    email: str
    latitude: float | None
    longitude: float | None
    region_id: int | None
    street_id: int | None
    receives_all: bool
    bus_lines: str


@dataclass
class Tables:
    regions: list = field(default_factory=list)
    streets: list = field(default_factory=list)
    users: list = field(default_factory=list)
    # {user_id: {category, …}} — only opt-OUTs are stored (migration 0004).
    disabled: dict = field(default_factory=dict)
    scope: str = ""          # which database these came from
    loaded_at: str = ""

    def __post_init__(self):
        # The Worker memoizes parsed kinds and trigrams against the ref cache;
        # here the equivalent is done once when the tables are loaded, so a
        # per-alert request never re-tokenizes 261 regions and 1,300 streets.
        self._prepared = {
            "regions": _prepare(self.regions),
            "streets": _prepare(self.streets),
        }
        self._center = _center_of(self.regions)
        self.by_id = {u.user_id: u for u in self.users}
        # First-wins, which keeps these identical to the linear scans they
        # replace: the regions list is `regions UNION ALL region_aliases`, so an
        # id appears once under its canonical name and again under each alias,
        # and the canonical row is the one that comes first.
        self.region_by_id: dict = {}
        for row in self.regions:
            self.region_by_id.setdefault(row.id, row)
        self.street_by_id: dict = {}
        for row in self.streets:
            self.street_by_id.setdefault(row.id, row)

    def prepared(self, which):
        return self._prepared[which]

    @property
    def center(self):
        return self._center


@dataclass
class Prepared:
    row: Named
    cls: str | None
    grams: set


def _prepare(rows):
    prepared = []
    for row in rows:
        kind, core = parse_name(row.name)
        prepared.append(Prepared(row, place_class(kind), trigrams(core)))
    return prepared


def _center_of(regions):
    """The Варна centroid from the seeded rows — what the in-city tie-break and
    the city-wide radius both measure from."""
    for row in regions:
        if row.lat is None or row.lng is None:
            continue
        if parse_name(row.name)[1].lower() == "варна":
            return (row.lat, row.lng)
    return VARNA_CENTER


def _in_city(row, center) -> bool:
    return (row.lat is not None and row.lng is not None
            and distance_km(row.lat, row.lng, center[0], center[1]) <= IN_CITY_RADIUS_KM)


# ── the matcher: place-names.ts matchCore ─────────────────────────────────────

_UNSET = object()


def _match_core(raw, tables, which, accepts, threshold, prefer_in_city, in_scope=None):
    kind, core = parse_name(raw)
    query_class = place_class(kind)
    # A bare kind abbreviation names no place, so it matches nothing.
    if not core or not accepts(query_class):
        return None

    query_grams = trigrams(core)
    if not query_grams:
        return None

    top = 0.0
    scored = []
    for p in tables.prepared(which):
        if in_scope is not None and not in_scope(p.row):
            continue
        if not kinds_compatible(query_class, p.cls):
            continue
        score = jaccard(query_grams, p.grams)
        if score < threshold:
            continue
        top = max(top, score)
        scored.append((p, score))
    if not scored:
        return None

    center = tables.center
    pool = [s for s in scored if s[1] >= top - NEAR_TIE_BAND]
    if prefer_in_city:
        in_city = [s for s in pool if _in_city(s[0].row, center)]
        if in_city:
            pool = in_city

    winner = pool[0]
    for s in pool:
        if s[1] > winner[1]:
            winner = s

    # Cores tie exactly often enough to matter ("Боровец" / "Бул. Боровец"), so
    # the whole written names get the last word.
    tied = [s for s in pool if s[1] == winner[1]]
    if len(tied) > 1:
        literal_best = -1.0
        for s in tied:
            # Strictly greater, so an unbroken tie keeps seed order.
            literal = similarity(raw, s[0].row.name)
            if literal > literal_best:
                literal_best = literal
                winner = s

        # Since migration 0017 two rows can be spelled identically (Варна's
        # "Цветен квартал" and Белослав's). Distance settles those.
        if prefer_in_city:
            def dist(row):
                if row.lat is None or row.lng is None:
                    return math.inf
                return distance_km(row.lat, row.lng, center[0], center[1])
            for s in tied:
                if (similarity(raw, s[0].row.name) == literal_best
                        and s[0].row.lat is not None and s[0].row.lng is not None
                        and dist(s[0].row) < dist(winner[0].row)):
                    winner = s
    return winner[0].row


def _is_region_class(cls):
    return cls != "street"


def _is_street_class(cls):
    return cls is None or cls == "street"


def match_region(raw, tables, threshold=CORE_MATCH_THRESHOLD, in_settlement=_UNSET):
    """
    The regions row a written place name refers to, or None.

    `in_settlement` is a preference, not a restriction: it retries unscoped when
    the scope matches nothing, because 181 of the seeded regions still carry no
    parent link and a hard filter would make those unreachable. Passing `_UNSET`
    (the Worker's `undefined`) skips the scoped pass entirely — which is what
    happens when no settlement resolved at all.
    """
    if in_settlement is not _UNSET:
        if in_settlement is None:
            def scope(r):
                return r.settlement_id is None
        else:
            def scope(r):
                return r.settlement_id == in_settlement or r.id == in_settlement
        scoped = _match_core(raw, tables, "regions", _is_region_class, threshold, True, scope)
        if scoped is not None:
            return scoped
    return _match_core(raw, tables, "regions", _is_region_class, threshold, True)


def match_street(raw, tables, scope_region_id=None, threshold=CORE_MATCH_THRESHOLD):
    """
    The streets row a written street name refers to, or None.

    `scope_region_id` is the settlement the lookup happens in, and rows in any
    other settlement are not candidates — 52% of the street names around Тополи,
    Аврен and Долни чифлик also exist in Варна.
    """
    return _match_core(
        raw, tables, "streets", _is_street_class, threshold, False,
        None if scope_region_id is None else (lambda r: r.region_id == scope_region_id))


DEFAULT_SETTLEMENT = "Варна"


def settlement_of(location_name: str) -> str:
    kind, core = parse_name(location_name)
    cls = place_class(kind)
    return core if cls in ("city", "village") and core else DEFAULT_SETTLEMENT


def settlement_scope(settlement, area, tables):
    """
    The regions row for a location's settlement — the scope its street lookups
    take. Not the same thing as the region the location matches: for "кв. Виница"
    the region is the district and the settlement is Варна, and only the latter
    can scope a street (`streets.region_id` never points at a district).
    """
    for name in (settlement, area):
        if name is None:
            continue
        # A written "гр."/"с." names a settlement in its own right, so it IS the
        # scope and the parent-link branch must not get to it first. Варна
        # province holds two places called Припек 10 km apart — the village and a
        # suburb of Константиново — and landing on the suburb meant following its
        # parent link and answering with Константиново's centroid, 1.7 km off.
        written = settlement_of(name)
        if written != DEFAULT_SETTLEMENT:
            return match_region(written, tables, in_settlement=None)
        row = match_region(name, tables)
        if row is not None and row.settlement_id is not None:
            parent = tables.region_by_id.get(row.settlement_id)
            if parent is not None:
                return parent
    return match_region(DEFAULT_SETTLEMENT, tables, in_settlement=None)


# ── reading a stored location ─────────────────────────────────────────────────


def _str(value):
    return value if isinstance(value, str) and value.strip() != "" else None


def _list(value):
    return [s for s in value if isinstance(s, str)] if isinstance(value, list) else None


def read_location(location):
    """
    (settlement, area, streets, region_wide) from either shape — the three slots
    the crawler writes, or the flat (location_name, sublocations) pair that
    /submit-data still passes through and that every pre-split row carries.
    """
    has_slots = "settlement" in location or "area" in location
    streets = _list(location.get("streets"))
    if streets is None:
        streets = _list(location.get("sublocations"))
    return (
        _str(location.get("settlement")) if has_slots else None,
        _str(location.get("area")) if has_slots else _str(location.get("location_name")),
        streets if streets is not None else [],
        location.get("region_wide") is True,
    )


# ── the user queries (db/queries.ts) ──────────────────────────────────────────


def _users_by_region(tables, region_id):
    return [u.user_id for u in tables.users if u.region_id == region_id]


# How far from a settlement's centroid a user with NO region of their own still
# counts as inside it — alert-service.ts's SETTLEMENT_REACH_KM.
SETTLEMENT_REACH_KM = 9


def _users_by_region_wide(tables, region):
    """
    getUserIdsByRegionWide: a region that holds districts is a SETTLEMENT, and
    its audience is everyone under any of them — except the city, which is not an
    audience at all.

    `region_id = ?` is right for a district and close to useless for a settlement
    that holds any. A user inside it reverse-geocodes to their district and
    carries that district's region_id, so a settlement-wide alert reached only
    the residue whose reverse geocode hit no district we seed. Villages are
    unaffected — no district level exists under them — which is also the test: a
    region no seeded row claims as its parent is a leaf.

    **§5.1, decided 10.08.2026: a failed extraction notifies nobody.** A genuine
    whole-city outage is published in words and routed to `city_wide`, so a
    location resolving to the city row with no area and no matched street is a
    district that got lost. Widening that to ~90 districts would be a city-sized
    push decided by an extraction we already know failed.
    """
    if parse_name(region.name)[1].strip().lower() == DEFAULT_SETTLEMENT.lower():
        return [], -1

    districts = [r for r in tables.regions
                 if r.settlement_id == region.id and r.id != region.id]
    if not districts:
        return _users_by_region(tables, region.id), 0

    ids = {region.id} | {d.id for d in districts}
    placed = [u.user_id for u in tables.users if u.region_id in ids]

    unplaced = []
    if region.lat is not None and region.lng is not None:
        for u in tables.users:
            if u.region_id is not None or u.latitude is None or u.longitude is None:
                continue
            if distance_km(u.latitude, u.longitude,
                           region.lat, region.lng) <= SETTLEMENT_REACH_KM:
                unplaced.append(u.user_id)

    return list(dict.fromkeys(placed + unplaced)), len(districts)


def _users_unplaced_in_region(tables, region_id):
    return [u.user_id for u in tables.users if u.region_id == region_id and u.street_id is None]


def _users_by_streets(tables, street_ids, region_id):
    """
    A NULL street_id means "somewhere in this region", so those users stay in
    when a region is paired — the same shape as getUserIdsByStreets.
    """
    if not street_ids:
        return []
    wanted = set(street_ids)
    if region_id is None:
        return [u.user_id for u in tables.users if u.street_id in wanted]
    return [u.user_id for u in tables.users
            if u.region_id == region_id and (u.street_id in wanted or u.street_id is None)]


CITY_WIDE_RADIUS_KM = 15


def city_wide_user_ids(tables):
    """
    Everyone we cannot prove is outside the city. Note the direction: a user is
    dropped only when their position is known AND measures past the radius —
    someone who never set a location has no coordinates and nothing about that
    says "village".
    """
    center = tables.center
    inside, dropped = [], []
    for u in tables.users:
        lat = u.latitude if u.latitude is not None else _region_lat(tables, u.region_id)
        lng = u.longitude if u.longitude is not None else _region_lng(tables, u.region_id)
        if lat is None or lng is None or distance_km(lat, lng, center[0], center[1]) <= CITY_WIDE_RADIUS_KM:
            inside.append(u.user_id)
        else:
            dropped.append(u.user_id)
    return inside, dropped


def _region_row(tables, region_id):
    return None if region_id is None else tables.region_by_id.get(region_id)


def _region_lat(tables, region_id):
    row = _region_row(tables, region_id)
    return row.lat if row else None


def _region_lng(tables, region_id):
    row = _region_row(tables, region_id)
    return row.lng if row else None


# How far outside a ring a user still counts as inside it — alert-service.ts's
# POLYGON_TOLERANCE_M. A ring edge sits a road half-width off an OSM centreline,
# the centreline is sketched, and the point is a phone's GPS fix; a hard in/out
# test against all three errors drops residents standing on their own doorstep.
POLYGON_TOLERANCE_M = 30


def _distance_to_ring_m(lat, lng, ring):
    """Metres to the nearest edge of a ring, 0 inside it — geo.ts's distanceToRingM."""
    if point_in_ring(lat, lng, ring):
        return 0.0
    m_per_lat = 111_320.0
    m_per_lng = 111_320.0 * math.cos(math.radians(lat))
    best = float("inf")
    ax, ay = (ring[-1][0] - lng) * m_per_lng, (ring[-1][1] - lat) * m_per_lat
    for elng, elat in ring:
        bx, by = (elng - lng) * m_per_lng, (elat - lat) * m_per_lat
        dx, dy = bx - ax, by - ay
        len_sq = dx * dx + dy * dy
        t = 0.0 if len_sq == 0 else max(0.0, min(1.0, (-ax * dx - ay * dy) / len_sq))
        best = min(best, math.hypot(ax + t * dx, ay + t * dy))
        ax, ay = bx, by
    return best


def _users_in_polygon(tables, polygon_json):
    ids = set()
    rings = 0
    for geometry in all_geometries(polygon_json):
        ring = outer_ring(geometry)
        if not ring:
            continue
        box = ring_bbox(ring)
        if box is None:
            continue
        rings += 1
        min_lat, max_lat, min_lng, max_lng = box
        # The prefilter is widened by the same tolerance the exact test allows,
        # or the band does nothing at the corners.
        d_lat = POLYGON_TOLERANCE_M / 111_320.0
        d_lng = POLYGON_TOLERANCE_M / (111_320.0 * math.cos(
            math.radians((min_lat + max_lat) / 2)))
        for u in tables.users:
            # The Worker's SQL bbox prefilter; a NULL coordinate never matches
            # a BETWEEN, so an unplaced user is out of a polygon audience.
            if u.latitude is None or u.longitude is None:
                continue
            if not (min_lat - d_lat <= u.latitude <= max_lat + d_lat
                    and min_lng - d_lng <= u.longitude <= max_lng + d_lng):
                continue
            if _distance_to_ring_m(u.latitude, u.longitude, ring) <= POLYGON_TOLERANCE_M:
                ids.add(u.user_id)
    return list(ids), rings


# ── one location's audience, with the reasoning kept ──────────────────────────


def _label(location):
    settlement, area, _, _ = read_location(location)
    name = location.get("location_name") or area or settlement or ""
    return str(name) or "(unnamed)"


def target_location(location, tables, index):
    """
    Who this one location notifies, and by which of the four paths — the same
    decision tree as getUserIdsInRange, with every resolution it makes recorded
    so a reviewer can see *why* an audience is empty.
    """
    result = {
        "index": index,
        "label": _label(location),
        "method": "",
        "settlement": None,
        "region": None,
        "streets": [],
        "note": "",
        "user_ids": [],
    }

    polygon = location.get("polygon_geojson")
    if location.get("is_polygon") is True and isinstance(polygon, dict):
        ids, rings = _users_in_polygon(tables, polygon)
        if ids:
            result["method"] = "polygon"
            result["user_ids"] = ids
            result["note"] = f"everyone inside the ring ±{POLYGON_TOLERANCE_M} m ({rings} ring(s))"
            return result
        # An empty ring is not evidence that nobody is affected — it is equally
        # "the geometry is wrong" or "these residents have not set a location".
        # The Worker falls through to the street/region audience rather than
        # letting the exclusive polygon branch notify nobody.
        #
        # Its own field, not `note`: every branch below assigns `note`, and the
        # ring's verdict is the thing a reviewer most wants beside the audience
        # that replaced it.
        result["polygon"] = (f"no user is inside the ring ({rings} ring(s)) — "
                             f"fell back to street/region targeting")

    settlement_name, area, named, region_wide = read_location(location)
    settlement = settlement_scope(settlement_name, area, tables)
    result["settlement"] = settlement.name if settlement else None

    # The audience is the most specific place named. `_UNSET` when no settlement
    # resolved, mirroring the Worker's `settlement?.id` being `undefined`.
    region = match_region(area or settlement_name or "", tables,
                          in_settlement=settlement.id if settlement else _UNSET)
    result["region"] = region.name if region else None

    # "в района на ул. X" (A6) names streets to say where the outage is, not who
    # is in it — but only when an area resolved, or a bare city plus streets
    # would widen to the whole settlement.
    area_only = region_wide and area is not None and region is not None
    if region_wide:
        result["region_wide"] = True

    if named and not area_only and settlement is not None:
        street_ids = []
        for street_name in named:
            match = match_street(street_name, tables, settlement.id)
            result["streets"].append({"named": street_name,
                                      "matched": match.name if match else None})
            if match and match.id not in street_ids:
                street_ids.append(match.id)

        if street_ids:
            result["method"] = "streets"
            if region is not None and region.id != settlement.id:
                # Pairing the streets with the district narrows a boulevard to
                # the district named and carries its street-less users along.
                result["user_ids"] = _users_by_streets(tables, street_ids, region.id)
                result["note"] = (f"users on the matched street(s) inside {region.name}, "
                                  f"plus that region's users with no street set")
            else:
                # The region IS the settlement: AND-ing it would drop every
                # district-registered user the street list just matched.
                on_street = _users_by_streets(tables, street_ids, None)
                if region is None:
                    result["user_ids"] = on_street
                    result["note"] = "users on the matched street(s); no region resolved"
                else:
                    unplaced = _users_unplaced_in_region(tables, region.id)
                    result["user_ids"] = list(dict.fromkeys(on_street + unplaced))
                    result["note"] = (f"users on the matched street(s), plus users registered "
                                      f"under {region.name} with no street set")
            return result

        # Every named street is unknown to our table — fall through to the
        # region rather than notifying nobody.
        result["note"] = "none of the named streets exist in the streets table"
    elif named and area_only:
        result["streets"] = [{"named": s, "matched": None} for s in named]
        result["note"] = ("the message hedged (в района на …), so the streets locate the "
                          "area rather than bound it — targeting is the whole region")
    elif named and settlement is None:
        result["streets"] = [{"named": s, "matched": None} for s in named]
        result["note"] = ("no settlement resolved, so no street lookup is possible — an "
                          "unscoped one would notify a like-named street elsewhere")

    if region is not None:
        ids, districts = _users_by_region_wide(tables, region)
        result["user_ids"] = ids
        if districts < 0:
            result["method"] = "none"
            under = (f"{region.name} alone is not an audience: a whole-city outage is "
                     f"published as city-wide, so this is a lost district — nobody notified")
        elif districts:
            result["method"] = "settlement"
            under = (f"every user under {region.name} or any of its {districts} district(s), "
                     f"plus anyone unplaced within {SETTLEMENT_REACH_KM} km")
        else:
            result["method"] = result["method"] or "region"
            under = f"every user registered under {region.name}"
        result["note"] = f"{result['note']} → {under}" if result["note"] else under
    else:
        result["method"] = "none"
        result["user_ids"] = []
        result["note"] = ((result["note"] + " → " if result["note"] else "")
                          + "no region matched either, so this location notifies nobody")
    return result


# ── the whole alert ───────────────────────────────────────────────────────────


def _user_view(tables, user_id, via):
    u = tables.by_id.get(user_id)
    if u is None:
        return {"user_id": user_id, "email": "", "region": "", "street": "", "via": via}
    region = _region_row(tables, u.region_id)
    street = tables.street_by_id.get(u.street_id) if u.street_id else None
    return {
        "user_id": u.user_id,
        "email": u.email,
        "region": region.name if region else "",
        "street": street.name if street else "",
        "lat": u.latitude,
        "lng": u.longitude,
        "receives_all": u.receives_all,
        "via": via,
    }


# How many user rows a single answer carries. A city-wide alert's audience is
# the whole user base, and at that size the per-user rows are the payload —
# 50,000 of them is megabytes per alert the reviewer arrows past. The counts are
# computed over everyone and stay exact; only the listing stops, and it says so.
LIST_LIMIT = 2000


def audience(alert, tables):
    """
    The push audience for one stored alert, and how each user got into it.

    Order follows sendUsersNotification: gather per location (or broadcast),
    add the receives-all accounts, then drop everyone who has opted out of the
    category. The bus-line narrowing cannot be reproduced — see the module
    docstring — so it is reported as a caveat instead of silently skipped.
    """
    category = alert.get("category") or ""
    locations = alert.get("locations") or []

    reasons: dict[str, list] = {}
    per_location = []
    notes = []
    ambiguous = False
    city_wide_ids: list = []

    def add(user_ids, why):
        for user_id in user_ids:
            reasons.setdefault(user_id, [])
            if why not in reasons[user_id]:
                reasons[user_id].append(why)

    if alert.get("locations_error"):
        notes.append("locations_json does not parse, so the Worker reads no locations at all "
                     "from this row. What it did at ingest time is not recoverable from here.")

    if locations:
        for index, location in enumerate(locations):
            detail = target_location(location, tables, index)
            per_location.append(detail)
            add(detail["user_ids"], f"{index + 1}. {detail['label']} — {detail['method']}")
    else:
        # city_wide is not stored: both branches are real possibilities and the
        # row cannot tell them apart.
        ambiguous = True
        city_wide_ids, dropped = city_wide_user_ids(tables)
        add(city_wide_ids, "city-wide broadcast")
        notes.append(
            f"This alert has no locations, and `city_wide` is not stored. If the model said "
            f"city-wide, the audience is the {len(city_wide_ids)} user(s) below — everyone we "
            f"cannot place further than {CITY_WIDE_RADIUS_KM} km from the Варна centroid"
            + (f" ({len(dropped)} user(s) excluded by that radius)." if dropped else ".")
            + " If it said city_wide=false, the alert was stored and notified nobody at all.")

    # Debug/monitoring accounts receive every alert regardless of location.
    add([u.user_id for u in tables.users if u.receives_all], "receives_all_alerts")

    disabled = {uid for uid in reasons if category in tables.disabled.get(uid, set())}
    recipient_ids = [uid for uid in reasons if uid not in disabled]
    muted_ids = [uid for uid in reasons if uid in disabled]

    def listing(user_ids):
        """The rows for a list, sorted and capped. Sorting before the cap so the
        first page is the start of the list rather than an arbitrary slice."""
        rows = [_user_view(tables, uid, reasons[uid]) for uid in user_ids]
        rows.sort(key=lambda u: (u["region"], u["email"]))
        return rows[:LIST_LIMIT]

    recipients, muted = listing(recipient_ids), listing(muted_ids)

    # The per-location ids have done their work above and the page only ever
    # reads how many there were — and on a region-wide match "how many" can be
    # the whole user base, twice over if two locations resolve to the same one.
    for loc in per_location:
        loc["count"] = len(loc.pop("user_ids"))

    if category == "vt":
        notes.append("Route alerts are narrowed further to users subscribed to the affected bus "
                     "lines, and the line list is not stored — for vt this audience is an "
                     "upper bound.")

    return {
        "ok": True,
        "ambiguous": ambiguous,
        "category": category,
        # The counts are over everyone; the lists stop at LIST_LIMIT rows. The
        # two are reported separately so the UI can never present a capped list
        # as the whole audience.
        "recipient_count": len(recipient_ids),
        "muted_count": len(muted_ids),
        "recipients": recipients,
        "muted": muted,
        "per_location": per_location,
        "notes": notes,
        "total_users": len(tables.users),
        "scope": tables.scope,
        "loaded_at": tables.loaded_at,
    }
