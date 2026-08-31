// Port of processing/polygon.py via the Phase 0 JSTS spike
// (spikes/polygon-jsts/pipeline.mjs), SPEC.md §1.9. Overpass fetch (I/O) is
// separated from the JSTS geometry pipeline (CPU). Spike 3's CPU verdict is
// baked in: 10 m ring sampling (halves cost, identical winners) and street
// geometries clipped to a bbox around the shortest street (kills the
// boulevard blow-up on city-spanning street sets).

import GeometryFactory from "jsts/org/locationtech/jts/geom/GeometryFactory.js";
import Coordinate from "jsts/org/locationtech/jts/geom/Coordinate.js";
import LineMerger from "jsts/org/locationtech/jts/operation/linemerge/LineMerger.js";
import BufferOp from "jsts/org/locationtech/jts/operation/buffer/BufferOp.js";
import UnaryUnionOp from "jsts/org/locationtech/jts/operation/union/UnaryUnionOp.js";
import DistanceOp from "jsts/org/locationtech/jts/operation/distance/DistanceOp.js";
import { POLYGON_RESOLVE_THRESHOLD } from "../core/fuzzy";
import { matchStreet } from "../core/place-names";
import { distanceKm } from "../core/geo";
import { getStreets } from "../db/queries";
import type { Env } from "../env";
import { abortIn, expired, sleepWithin, yieldBurst } from "../shared/deadline";

const factory = new GeometryFactory();

/**
 * How far each centreline is stretched past its ends before the blocks are cut.
 *
 * OSM fragments do not always reach the junction they belong to, and a block
 * left open at one corner is not a block at all. This is the reach that closes
 * those gaps, inherited from the centreline pipeline.
 *
 * It was briefly cut to 25 m, on the argument that a road band already bridges
 * 2·ROAD_HALF_WIDTH_M by itself and that a long stub — swept from a street's
 * end in whatever direction its last segment happened to point, then widened —
 * fabricates blocks out of empty space. The first half is true. The second was
 * measured *before* the clip window was fixed to reach every street: with an
 * edge of the block clipped away, a long stub really did sweep into nothing.
 * Once no edge is missing it only closes corners, and the shorter reach turned
 * out to destroy three real blocks while fixing nothing — бул. Левски
 * (18.7 ha), Русе (30.4 ha) and Владислав Варненчик (17.4 ha), each bounded
 * 17–35% by every one of its four streets. The dual-carriageway slivers those
 * same alerts used to produce are killed by ROAD_HALF_WIDTH_M and
 * MAX_SINGLE_STREET_COVERAGE, neither of which depends on this number.
 *
 * 200 m is where every fixture closes — Левски needs 50, Русе 150, Варненчик
 * 200 — and the blocks it finds are stable: over a 50–500 m sweep each winner's
 * area moves by under 2%, which is what distinguishes a real block from one a
 * stub invented. Going longer only costs area, since the extensions are
 * buffered too and eat into the edges they close.
 */
const EXTENSION_DIST_M = 200;
const SAMPLE_STEP_M = 10;   // spike 3: same winner as 5 m at half the CPU
const CLIP_MARGIN_M = 500;  // bbox margin around the shortest street

/**
 * Half-width given to every street before the blocks are cut out of it.
 *
 * OSM gives us centrelines, and a dual carriageway is two of them under one
 * name. Polygonizing centrelines therefore treats the gap between a boulevard's
 * carriageways as a block — a 10–16 m strip of roadway with no addresses on it,
 * which is what the 30.07.2026 review caught (see MAX_SINGLE_STREET_COVERAGE).
 * Widening each centreline into a band first makes that gap close up into the
 * road it is, so the failure cannot be expressed: what is left enclosed by the
 * road network is a real block, and its edges sit at the kerb rather than in the
 * middle of the carriageway.
 *
 * 12 m closes every carriageway gap measured over the review's alerts and the
 * Phase 0 spike sets (widest: 15.4 m, so 24 m of fill clears it) while leaving
 * the genuine blocks intact — set 1 keeps 2.06 of its 2.98 ha, Сахаров 39.2 of
 * 42.8. Going wider starts eating small blocks for no further gain.
 */
const ROAD_HALF_WIDTH_M = 12;

/**
 * Slack on top of `ROAD_HALF_WIDTH_M` when asking which streets bound a block.
 *
 * Block edges are now offset a road half-width from the centrelines they came
 * from, so the old "within 1 m of the street" test would match nothing at all.
 * A sample on a block's edge sits almost exactly `ROAD_HALF_WIDTH_M` from the
 * centreline that put it there; the slack absorbs the buffer's polygonal
 * approximation of the round end caps and joins.
 */
const TOUCH_SLACK_M = 1.5;

// ── Overpass fetch (replaces ox.features_from_place) ─────────────────────────

// Spike 1: browser UA gets a 406 from overpass-api.de — a descriptive UA is
// required and is also what their usage policy asks for.
const OVERPASS_HEADERS = {
  "User-Agent": "CityShieldAPI/1.0 (cityshield.varna@gmail.com)",
  "Content-Type": "application/x-www-form-urlencoded",
};

export type WaysByName = Map<string, [number, number][][]>; // street → lines of [lon, lat]

// Module-memory cache keyed by settlement + sorted street list (replaces
// ox.settings.use_cache). The settlement is part of the key because it is now
// part of the query: two settlements naming the same three streets are two
// different sets of ways, and keying on the names alone would serve one town's
// geometry for the other's block.
const overpassCache = new Map<string, WaysByName>();
const OVERPASS_CACHE_MAX = 50;

/**
 * The settlement a polygon is being built in — its name, for the Overpass area,
 * and its centroid, for everything the area cannot bound.
 */
export interface PolygonScope {
  name: string;
  lat: number | null;
  lng: number | null;
}

/**
 * How far from a settlement's centroid a way may lie and still be one of its
 * streets.
 *
 * The backstop for the Overpass scope bug, and the thing that finally closes it.
 * `area["name"="Варна"]["boundary"="administrative"]` unions EVERY
 * administrative area of that name, including the province, so a query for one
 * street name came back with geometry spanning 26 km (`Железни врата`), 23 km
 * (`Русе`) and 38 km (`Преслав`) — fragments from towns all over област Варна,
 * which then decided where CLIP_MARGIN_M centred its window.
 *
 * Pinning `admin_level` is now done — measured against the local Overpass
 * instance on 10.08.2026, level 8 in Bulgaria is the **населено място**:
 * `rel(13477567)` ("Варна", level 8) contains exactly one `place` settlement,
 * the city itself. (The repo previously carried two contradictory records of
 * this; the seed tool's "it is the община" was the wrong one.) That removes the
 * province from the union outright.
 *
 * It is NOT sufficient on its own, which is why this constant still exists.
 * Level 8 relations repeat by name across provinces exactly as the seed sweep
 * found — there are two `Бяла`, two `Левски`, four `Горица` — so a pinned query
 * still unions a town 185 km away. And most villages have no boundary relation
 * at any level, so they need the `around:` fallback regardless. A distance from
 * a centroid we already hold covers both, and bounds the damage the same way
 * for a city and for a hamlet.
 *
 * 12 km is Varna-sized: the city's own 1,333 seeded streets have a 95th
 * percentile of 10.7 km from its centroid. The province is 69 km across and the
 * nearest same-named intruder measured (Старо Оряхово) is 35 km out, so this
 * separates them with room to spare. It is deliberately not tighter — the clip
 * window downstream does the precise work, and this only has to keep another
 * town out of the input.
 */
const SETTLEMENT_STREET_REACH_KM = 12;

/**
 * OSM's admin_level for a Bulgarian settlement (населено място).
 *
 * Measured, not assumed: `rel(13477567)` is the level-8 relation named "Варна",
 * and it contains exactly one `place` settlement — the city. Same value the seed
 * sweep uses, and the two are meant to agree.
 */
const SETTLEMENT_ADMIN_LEVEL = "8";

/**
 * Make a street name safe to drop inside `["name"~"^(…)$"]`.
 *
 * Two layers, both required. The regex metacharacters would otherwise make
 * "Боровец-юг 9-та (бул. Тих кът)" — a real seeded name — match on its
 * parenthesised group instead of literally. The double quote is the one that
 * matters more: it closes the Overpass QL string literal, so a name containing
 * one turns the rest of the query into syntax errors (or, with enough care,
 * something else entirely). No seeded name carries one today, but Bulgarian
 * street names are routinely written with quotes — ул. "Отец Паисий" — so a
 * reseed is one dataset away from producing them.
 */
function escapeOverpassRegex(name: string): string {
  return name
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/"/g, '\\"');
}

export interface OverpassResponse {
  elements?: Array<{ type: string; tags?: { name?: string }; geometry?: Array<{ lon: number; lat: number }> }>;
}

/** Group returned way geometries by street name → arrays of [lon, lat] lines. */
export function groupWaysByName(data: OverpassResponse): WaysByName {
  const byName: WaysByName = new Map();
  for (const el of data.elements ?? []) {
    if (el.type !== "way" || !el.tags?.name || !Array.isArray(el.geometry)) continue;
    if (!byName.has(el.tags.name)) byName.set(el.tags.name, []);
    byName.get(el.tags.name)!.push(el.geometry.map((pt) => [pt.lon, pt.lat]));
  }
  return byName;
}

/** Test hook: drop the module-scope Overpass cache. */
export function clearOverpassCache(): void {
  overpassCache.clear();
}

// Server-side and client-side caps. The old pair (25 s server / 30 s client,
// plus a 15 s pause before the single retry) added up to 75 s — more than twice
// the cron's entire wall clock, so a slow Overpass guaranteed a mid-flight kill.
const OVERPASS_QUERY_TIMEOUT_S = 12;
const OVERPASS_FETCH_TIMEOUT_MS = 15_000;
const OVERPASS_RETRY_PAUSE_MS = 5_000;

/**
 * Statuses where trying the SAME endpoint again is pointless.
 *
 * A 521/522/523 is Cloudflare in front of Overpass saying the origin is down or
 * unreachable; a 502/503/504 says much the same. Six of the eight polygon
 * failures in the 08.2026 review were `Overpass HTTP 521`/`504` — the public
 * endpoint being down, not our geometry. Proof that the builder itself is fine:
 * the identical four-street set failed on 08-18 and built a byte-identical
 * 66-point ring twice on 08-20. Against a dead origin the right retry is a
 * different *endpoint*, not a second attempt at the same one; the existing
 * pause-and-retry is tuned for 429 rate-limiting and cannot help here.
 */
const ORIGIN_DOWN_STATUS = new Set([502, 503, 504, 520, 521, 522, 523, 524]);

/** Endpoints in preference order — the fallback only when one is configured. */
function overpassEndpoints(env: Env): string[] {
  const endpoints = [env.OVERPASS_URL];
  if (env.OVERPASS_FALLBACK_URL && env.OVERPASS_FALLBACK_URL !== env.OVERPASS_URL)
    endpoints.push(env.OVERPASS_FALLBACK_URL);
  return endpoints;
}

/** POST one Overpass query, with the single budgeted retry and endpoint failover. */
async function overpassQuery(
  env: Env, query: string, deadline?: number,
): Promise<OverpassResponse> {
  const endpoints = overpassEndpoints(env);
  let lastError: Error | undefined;

  for (const [index, endpoint] of endpoints.entries()) {
    for (let attempt = 1; ; attempt++) {
      if (expired(deadline, 1_000)) {
        throw lastError ?? new Error("No time budget left for Overpass");
      }
      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: "POST",
          headers: OVERPASS_HEADERS,
          body: "data=" + encodeURIComponent(query),
          signal: abortIn(OVERPASS_FETCH_TIMEOUT_MS, deadline),
        });
      } catch (e) {
        // A refused connection or a timeout is the same story as a 521: this
        // endpoint is not answering, so move to the next one.
        lastError = e instanceof Error ? e : new Error(String(e));
        break;
      }
      if (res.ok) {
        if (index > 0) console.warn(`[polygon] Overpass served by fallback endpoint ${endpoint}.`);
        return await res.json();
      }

      lastError = new Error(
        `Overpass HTTP ${res.status} from ${endpoint}: ${(await res.text()).slice(0, 200)}`);

      // The origin is down — another attempt here buys nothing, so go straight
      // to the next endpoint and keep the budget for it.
      if (ORIGIN_DOWN_STATUS.has(res.status)) break;

      // Otherwise it is most likely 429: Overpass rate-limits aggressive
      // retries, and a retry needs a real pause for a slot to free up. One
      // retry, and only if it fits the budget — a polygon is an enhancement,
      // never worth losing the message over.
      if (attempt === 2 || !(await sleepWithin(OVERPASS_RETRY_PAUSE_MS, deadline))) break;
    }
  }
  throw lastError ?? new Error("Overpass produced no response");
}

/**
 * OSM spellings that denote one and the same street.
 *
 * A street is only as long as the name OSM gives it, and a boulevard named after
 * a foreign figure gets transliterated inconsistently. `бул. Януш Хуняди` carries
 * exactly **one** 118 m way inside Варна; the rest of the same boulevard
 * continues as `бул. Янош Хунияди`, and both are seeded because the sweep takes
 * OSM at its word. One 118 m fragment is not a side of a block, which is why
 * alert `5d34f795` could not close a ring even though all four of its streets
 * resolved to genuine Варна rows (§2.1 Cause B — measured against the local
 * Overpass instance on 10.08.2026, against 84 ways for бул. Сливница and 55 each
 * for Република and Владислав Варненчик).
 *
 * **Curated, never computed**, and that is a measurement rather than a
 * preference: the two spellings score **0.389** on their cores, while
 * `Младост 1` and `Младост 2` score 0.667 and `Възраждане 1`/`Възраждане 2`
 * score 0.733. Any similarity threshold loose enough to merge the Хуняди pair
 * merges two genuinely different numbered places first. There is no separating
 * value, so the mapping has to be written down.
 *
 * Applies to the Overpass fetch ONLY. The extra names are queried and their ways
 * folded under the canonical one, so everything downstream still sees one street
 * — which matters, because `buildBlockPolygon` counts distinct streets to decide
 * whether a face is a block.
 */
const OSM_NAME_VARIANTS: Record<string, readonly string[]> = {
  "бул. Януш Хуняди": ["бул. Янош Хунияди"],
};

/** Drop ways whose geometry sits outside the settlement — see SETTLEMENT_STREET_REACH_KM. */
function nearSettlement(byName: WaysByName, scope: PolygonScope): WaysByName {
  if (scope.lat === null || scope.lng === null) return byName;
  const near: WaysByName = new Map();
  for (const [name, lines] of byName) {
    // A way counts as this settlement's when any part of it is inside the reach:
    // a boulevard genuinely runs out of town, and clipping it here would cost the
    // block one of its sides. Testing the first vertex alone is enough at this
    // grain — the intruders are whole towns 35–185 km away, not overhanging ends.
    const kept = lines.filter((line) => line.length > 0
      && distanceKm(line[0]![1], line[0]![0], scope.lat!, scope.lng!)
        <= SETTLEMENT_STREET_REACH_KM);
    if (kept.length > 0) near.set(name, kept);
  }
  return near;
}

export async function fetchStreetWays(
  env: Env, streetNames: string[], scope: PolygonScope, deadline?: number,
): Promise<WaysByName> {
  const cacheKey = `${scope.name} ${[...streetNames].sort().join("|")}`;
  const cached = overpassCache.get(cacheKey);
  if (cached) return cached;

  // Every name to ASK Overpass for, and which resolved street each answers for.
  // A street with no variants is just itself.
  const canonicalOf = new Map<string, string>();
  for (const name of streetNames) {
    canonicalOf.set(name, name);
    for (const variant of OSM_NAME_VARIANTS[name] ?? []) canonicalOf.set(variant, name);
  }
  const pattern = [...canonicalOf.keys()].map(escapeOverpassRegex).join("|");
  const ways = `["highway"]["name"~"^(${pattern})$"]`;

  /** Fold each variant's ways under the street they belong to. */
  const fold = (byName: WaysByName): WaysByName => {
    const folded: WaysByName = new Map();
    for (const [name, lines] of byName) {
      const key = canonicalOf.get(name) ?? name;
      const into = folded.get(key);
      if (into) into.push(...lines);
      else folded.set(key, [...lines]);
    }
    return folded;
  };

  // The settlement's own administrative area, when OSM has one — pinned to
  // `SETTLEMENT_ADMIN_LEVEL`, which keeps the province out of the union. It
  // cannot keep a same-named settlement in another province out (there are two
  // level-8 `Бяла`), so `nearSettlement` still has the last word.
  const areaQuery =
    `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT_S}];` +
    `area["name"="${escapeOverpassRegex(scope.name)}"]["boundary"="administrative"]` +
    `["admin_level"="${SETTLEMENT_ADMIN_LEVEL}"]->.a;` +
    `way(area.a)${ways};` +
    `out geom;`;

  let byName = fold(nearSettlement(groupWaysByName(
    await overpassQuery(env, areaQuery, deadline)), scope));

  // Most villages are a bare `place` node with no boundary relation at all, so
  // the area lookup above matches nothing and returns nothing. A radius around
  // the centroid is the only container available for them — the same fallback,
  // and the same reasoning, as the seed sweep's `around:` path.
  if (byName.size === 0 && scope.lat !== null && scope.lng !== null) {
    const aroundQuery =
      `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT_S}];` +
      `way(around:${Math.round(SETTLEMENT_STREET_REACH_KM * 1000)},${scope.lat},${scope.lng})` +
      `${ways};out geom;`;
    byName = fold(groupWaysByName(await overpassQuery(env, aroundQuery, deadline)));
  }

  if (overpassCache.size >= OVERPASS_CACHE_MAX) overpassCache.clear();
  overpassCache.set(cacheKey, byName);
  return byName;
}

// ── Local equirectangular projection (replaces project_gdf) ──────────────────

function makeProjection(lon0: number, lat0: number) {
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 111_320;
  return {
    toLocal: ([lon, lat]: [number, number]): [number, number] => [(lon - lon0) * kx, (lat - lat0) * ky],
    toWgs84: ([x, y]: [number, number]): [number, number] => [lon0 + x / kx, lat0 + y / ky],
  };
}

// ── JSTS helpers (straight port of the spike) ────────────────────────────────

function jstsCollectionToArray(collection: any): any[] {
  if (Array.isArray(collection)) return collection;
  if (typeof collection.toArray === "function") return collection.toArray();
  const out: any[] = [];
  for (const it = collection.iterator(); it.hasNext();) out.push(it.next());
  return out;
}

function lineStringFromXY(coords: [number, number][]): any {
  return factory.createLineString(coords.map(([x, y]) => new Coordinate(x, y)));
}

/**
 * A hole of the road network as a standalone polygon, wound counter-clockwise.
 *
 * Interior rings come out clockwise, which is the opposite of what RFC 7946
 * asks of an exterior ring. Nothing downstream reads the winding today —
 * `pointInRing` ray-casts, and Leaflet does not care — but the ring leaves here
 * as GeoJSON for consumers we do not control, so it is worth the one pass.
 */
function ringToPolygon(ring: any): any {
  const coords = ring.getCoordinates();
  let area2 = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    area2 += coords[i]!.x * coords[i + 1]!.y - coords[i + 1]!.x * coords[i]!.y;
  }
  return factory.createPolygon(area2 < 0 ? [...coords].reverse() : coords);
}

/** A JSTS ring's coordinates as plain local-metre pairs. */
function ringXY(ring: any): XY[] {
  return ring.getCoordinates().map((c: any): XY => [c.x, c.y]);
}

function mergeLines(lineStrings: any[]): any {
  const merger = new LineMerger();
  for (const ls of lineStrings) merger.add(ls);
  const merged = jstsCollectionToArray(merger.getMergedLineStrings());
  if (merged.length === 1) return merged[0];
  return factory.createMultiLineString(merged);
}

// Port of extend_line: extend both ends along the end-segment direction.
function extendLineString(line: any, distance: number): any {
  const coords = line.getCoordinates();
  if (coords.length < 2) return line;
  const [p0, p1] = [coords[0], coords[1]];
  const len0 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const start = len0
    ? new Coordinate(p0.x - ((p1.x - p0.x) / len0) * distance, p0.y - ((p1.y - p0.y) / len0) * distance)
    : p0;
  const [pn1, pn] = [coords[coords.length - 2], coords[coords.length - 1]];
  const lenn = Math.hypot(pn.x - pn1.x, pn.y - pn1.y);
  const end = lenn
    ? new Coordinate(pn.x + ((pn.x - pn1.x) / lenn) * distance, pn.y + ((pn.y - pn1.y) / lenn) * distance)
    : pn;
  return factory.createLineString([start, ...coords, end]);
}

// Port of extend_geometry: handles LineString and MultiLineString.
function extendGeometry(geom: any, distance: number): any {
  if (geom.isEmpty()) return geom;
  const type = geom.getGeometryType();
  if (type === "LineString") return extendLineString(geom, distance);
  if (type === "MultiLineString") {
    const parts: any[] = [];
    for (let i = 0; i < geom.getNumGeometries(); i++) parts.push(extendLineString(geom.getGeometryN(i), distance));
    return mergeLines(parts);
  }
  return geom;
}

type XY = [number, number];

interface Box { minX: number; maxX: number; minY: number; maxY: number; }

function lineLength(line: XY[]): number {
  let len = 0;
  for (let i = 1; i < line.length; i++)
    len += Math.hypot(line[i]![0] - line[i - 1]![0], line[i]![1] - line[i - 1]![1]);
  return len;
}

function linesBBox(lines: XY[][]): Box {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const line of lines) for (const [x, y] of line) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}

const boxesOverlap = (a: Box, b: Box): boolean =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

const unionBox = (a: Box, b: Box): Box => ({
  minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX),
  minY: Math.min(a.minY, b.minY), maxY: Math.max(a.maxY, b.maxY),
});

/** Euclidean distance from a point to a box; 0 when the point is inside it. */
function boxDistanceToPoint(box: Box, [x, y]: XY): number {
  const dx = Math.max(box.minX - x, 0, x - box.maxX);
  const dy = Math.max(box.minY - y, 0, y - box.maxY);
  return Math.hypot(dx, dy);
}

// Candidate filter (§1.9 step 5): walk the exterior ring at a fixed spacing, so
// "how much of this block does that street bound" becomes a sample count. See
// countSamplesNearStreet for what the counts are then asked.
function samplesAlongRing(ring: any, step: number): any[] {
  const coords = ring.getCoordinates();
  const samples: any[] = [];
  let carried = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen === 0) continue;
    let d = step - carried;
    if (i === 0) samples.push(a);
    while (d <= segLen) {
      const t = d / segLen;
      samples.push(new Coordinate(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
      d += step;
    }
    carried = segLen - (d - step);
  }
  return samples;
}

/**
 * Samples a street must cover before it counts as bounding the polygon at all.
 *
 * A deliberate tightening of the "contiguous run longer than 5 m" test this
 * replaces. That rule was written against the spike's original 5 m sample step,
 * where clearing 5 m took two samples; when spike 3 doubled the step to 10 m it
 * quietly became *one* — a single sample within a metre of the ring, which is
 * what a street merely crossing the block registers. Since `touched` is the
 * ranking key, every such crossing inflated a face's score, and inflating
 * scores on long faces is precisely how the slivers below came to win.
 *
 * Two samples is 20 m of shared boundary. Nothing real is near that line: over
 * the sets in the tests, the least-involved genuine bounding street still covers
 * 12% of its ring (~10 samples).
 */
const MIN_TOUCH_SAMPLES = 2;

/**
 * The largest share of a block's boundary one street may account for.
 *
 * The backstop against the dual-carriageway sliver, not the primary defence —
 * `ROAD_HALF_WIDTH_M` is, by closing the gap before anything is cut out of it.
 * This states the requirement the geometry only implies: a block is *enclosed*
 * by several streets, not wrapped around one. It still catches a face nobody
 * anticipated — the Русе/Преслав set produces one bounded end to end by
 * ул. Девня alone, which no buffer width removes.
 *
 * Measured over the 30.07.2026 review's two bad alerts plus three of the Phase 0
 * spike sets, the split is total: real blocks give their busiest street 28–39%
 * of the ring, every carriageway sliver gives it 97–100%. 0.7 sits in the empty
 * middle with room on both sides.
 */
const MAX_SINGLE_STREET_COVERAGE = 0.7;

/**
 * How many of the ring samples lie within `tolerance` of the street.
 *
 * Was a boolean "does a contiguous run longer than 5 m touch this street",
 * which answered the wrong question: it cannot tell a block bounded by four
 * streets from the strip *between the two carriageways of one* — both "touch"
 * two or more streets. The count answers both at once (see the caller), and a
 * street bounding one edge of a real block still lands far above the 2-sample
 * floor that replaces the run test.
 *
 * Takes pre-built sample points rather than the ring: samples used to be
 * recomputed (and re-wrapped into JSTS Points) once per street per candidate
 * polygon, which multiplied the most CPU-heavy loop in the Worker by the street
 * count for no gain. This is the code the 10 ms free-plan budget is tightest
 * against (SPEC.md §1.9).
 *
 * The count is exact only when it has to be. Both things the caller asks of it
 * — "does this street bound the face at all" and "does it bound too much of
 * it" — are often decided before the samples run out, and the return then stops
 * at a lower bound that answers both identically. Without that, dropping the
 * old boolean's early exit would have made every real block pay a full scan per
 * street.
 *
 * `exact` gives up that saving to return the true total, which is what the
 * share-of-the-ring percentages in tools/polygon-tester are read off. It cannot
 * change a verdict — the early exits only ever fire once both thresholds are
 * settled — so the tool tunes against the same decisions production makes.
 */
function countSamplesNearStreet(
  samples: any[], streetGeom: any, maxHits: number, tolerance: number,
  minTouch: number, exact: boolean,
): number {
  // Cheap envelope reject before any distance work: a street whose bounding
  // box is nowhere near this polygon cannot bound it.
  const streetEnv = streetGeom.getEnvelopeInternal();
  let hits = 0;
  for (let i = 0; i < samples.length; i++) {
    const point = samples[i];
    const c = point.getCoordinate();
    const nearBox = c.x >= streetEnv.getMinX() - tolerance && c.x <= streetEnv.getMaxX() + tolerance
      && c.y >= streetEnv.getMinY() - tolerance && c.y <= streetEnv.getMaxY() + tolerance;
    if (nearBox && DistanceOp.distance(point, streetGeom) <= tolerance) hits++;
    if (exact) continue;
    // Over the cap: the face is rejected, so nothing further is worth measuring.
    if (hits > maxHits) return hits;
    // Bounded out the other way — even if every remaining sample hit, this
    // street could not reach the cap, and it has already cleared the touch
    // floor. Both tests are settled; the exact total is of no interest.
    if (hits >= minTouch && hits + (samples.length - i - 1) <= maxHits) return hits;
  }
  return hits;
}

// ── Degenerate-block guard ───────────────────────────────────────────────────
//
// A failed build is loud; a degenerate build is SILENT, and silently
// under-reaches everyone in the real block. Alert `15a862fb` stored a 4-point
// ring of 0.004 km² — a ~110 m triangle — for a block bounded by arteries a
// kilometre apart. It passed every existing check, `is_polygon` stayed true and
// `polygon_failed` was never set, so nothing on the row said the outline was
// nonsense.
//
// Both numbers are fitted against the five Overpass fixtures rather than
// picked, and the range that works is reported rather than the single value
// (the 200→25 m extension mistake). Measured winners:
//
//   fixture       vertices   area km²   mean width
//   set1              22      0.0206       57 m
//   varnenchik        72      0.1742      199 m
//   levski            82      0.1869      208 m
//   ruse             182      0.3041      209 m
//   saharov          177      0.3849      242 m
//
// So the smallest genuine block is 20,600 m² / 22 vertices, and the degenerate
// one is 4,000 m² / 4 vertices.
//
// Area: anything in **5,000–15,000 m²** separates them. 20,000 is already too
// close to set1 to be safe. 10,000 is essentially the geometric mean of the two
// (9,077), leaving 2.5× clearance above the sliver and 2.1× below the smallest
// real block — the balance point rather than an edge of the range.
const MIN_BLOCK_AREA_M2 = 10_000;

// Vertices: anything in **5–22** separates them. 8 sits clear of a triangle or
// quadrilateral without approaching set1's 22. Rejected faces in the fixtures
// run 6–27 vertices, so this is a weaker signal than area on its own — it is
// here because the two catch different pathologies, and a ring with almost no
// vertices is not a shape the road-band cutter produces for a real block.
const MIN_RING_VERTICES = 8;

// A rejected polygon is NOT a lost alert: clearing is_polygon drops the location
// back to a pin, which still notifies. Under-reaching a whole block silently is
// the worse failure, so this errs toward rejecting.

// ── Main pipeline (port of extract_city_block + streets_to_geojson) ──────────

export interface BlockPolygonResult {
  polygon: {
    type: "FeatureCollection";
    features: Array<{
      type: "Feature";
      properties: { streets: string[] };
      geometry: { type: "Polygon"; coordinates: [number, number][][] };
    }>;
  } | null;
  reason?: string;
  debug?: BlockPolygonDebug;
}

/**
 * Every number the block builder is fitted to, in one place.
 *
 * They exist as a record because five real Overpass fixtures is a small sample
 * to have fitted them on, and the next bad polygon is going to be argued about
 * by moving one of them. tools/polygon-tester overrides them per run and draws
 * the result, so that argument can be had against geometry instead of against
 * a rerun test suite. Ingestion never passes any of these — production is
 * whatever is written above.
 */
export const BLOCK_POLYGON_DEFAULTS = {
  extensionDist: EXTENSION_DIST_M,
  sampleStep: SAMPLE_STEP_M,
  roadHalfWidth: ROAD_HALF_WIDTH_M,
  clipMargin: CLIP_MARGIN_M,
  maxSingleStreetCoverage: MAX_SINGLE_STREET_COVERAGE,
  minTouchSamples: MIN_TOUCH_SAMPLES,
  minBlockAreaM2: MIN_BLOCK_AREA_M2,
  minRingVertices: MIN_RING_VERTICES,
};

export type BlockPolygonOptions = Partial<typeof BLOCK_POLYGON_DEFAULTS> & {
  /**
   * Report the intermediate geometry — what was clipped, what the road network
   * came out as, every enclosed area and why it lost. Ingestion leaves this off
   * and pays nothing for it; the tester turns it on, which also switches the
   * sample counts to exact (see countSamplesNearStreet).
   */
  debug?: boolean;
};

/** WGS84 `[lng, lat]`, so the tester can draw any of this without converting. */
type LngLat = [number, number];

export interface BlockPolygonDebug {
  /** The street the clip window is anchored on — the shortest of the set. */
  anchorStreet: string;
  /**
   * Milliseconds of synchronous work in each stretch between the yields, in
   * order. The free plan caps the *largest* of these at 10 ms, not their sum,
   * so this is the number the pipeline lives or dies by — measured wherever the
   * tester happens to run, which is not workerd, so read it as a shape rather
   * than as the platform's own accounting. `wrangler tail` gives that.
   */
  bursts: number[];
  clipRing: LngLat[];
  streets: Array<{ name: string; kept: LngLat[][]; dropped: LngLat[][] }>;
  /** Exterior rings of the buffered road network the blocks are cut from. */
  roads: LngLat[][];
  candidates: Array<{
    ring: LngLat[];
    areaM2: number;
    /** 2·area/perimeter — a carriageway gap's is ~10 m, a real block's ~300 m. */
    meanWidthM: number;
    samples: number;
    coverage: Array<{ name: string; hits: number; share: number }>;
    bounding: string[];
    verdict: "winner" | "runner-up" | "dominated" | "too-few-streets" | "degenerate";
  }>;
}

/**
 * Async purely to fit the CPU budget, never for I/O — every input is already in
 * memory by the time it is called.
 *
 * This is the most CPU-heavy code in the Worker and the free plan caps one
 * uninterrupted synchronous stretch at 10 ms (§1.1). Cutting blocks out of
 * buffered road bands rather than bare centrelines roughly doubled the cost —
 * measured on the Сахаров fixture, 4.2 → 8.6 ms p90 — which left the whole
 * pipeline inside a single burst with about a millisecond to spare, on a warm
 * dev machine. A cold isolate has less, and an exceeded burst kills the tick
 * silently: the logs array is dropped with it.
 *
 * So the pipeline `await`s between its expensive stages. Nothing waits on
 * anything; each yield just ends a burst and starts a new one, and the invocation
 * has minutes of wall clock to spend. See yieldBurst, and §1.9 for what a paid
 * plan would let us delete.
 */
export async function buildBlockPolygon(
  waysByName: WaysByName,
  streetNames: string[],
  options: BlockPolygonOptions = {},
): Promise<BlockPolygonResult> {
  const {
    extensionDist, sampleStep, roadHalfWidth, clipMargin,
    maxSingleStreetCoverage, minTouchSamples, minBlockAreaM2, minRingVertices,
  } = { ...BLOCK_POLYGON_DEFAULTS, ...options };
  // Block edges sit a road half-width off the centrelines that produced them,
  // so the touch test has to reach exactly that far — plus the slack.
  const touchTolerance = roadHalfWidth + TOUCH_SLACK_M;
  const dbg: BlockPolygonDebug | null = options.debug
    ? { anchorStreet: "", bursts: [], clipRing: [], streets: [], roads: [], candidates: [] }
    : null;

  // Close the current burst and open the next, recording what the closed one
  // cost when the tester is watching. `Date.now()` advances at I/O boundaries
  // in workerd rather than continuously, so the reading is only meaningful in
  // the tester's Node process — which is the only place that asks for it.
  let burstStart = Date.now();
  const breakBurst = async () => {
    if (dbg) dbg.bursts.push(Date.now() - burstStart);
    await yieldBurst();
    burstStart = Date.now();
  };
  /** Close the final stretch. Every return that carries `debug` goes through it. */
  const sealed = (): { debug: BlockPolygonDebug } | Record<string, never> => {
    if (!dbg) return {};
    dbg.bursts.push(Date.now() - burstStart);
    return { debug: dbg };
  };
  // Anchor projection at the first coordinate seen.
  let anchor: [number, number] | null = null;
  for (const lines of waysByName.values()) {
    if (lines.length && lines[0]!.length) { anchor = lines[0]![0]!; break; }
  }
  if (!anchor) return { polygon: null, reason: "no OSM geometry" };
  const proj = makeProjection(anchor[0], anchor[1]);

  // 1. Project each street's ways into local metric space.
  const localLines = new Map<string, XY[][]>();
  for (const name of streetNames) {
    const lines = waysByName.get(name);
    if (!lines || !lines.length) continue;
    localLines.set(name, lines.map((line) => line.map(proj.toLocal)));
  }

  // 2. Safety check: need at least 3 streets to close a block.
  if (localLines.size < 3) {
    return { polygon: null, reason: `only ${localLines.size} streets found in OSM` };
  }

  // CPU mitigation (spike 3): drop ways far from the block before
  // merge/extend/union, so a city-spanning boulevard — or, thanks to the
  // province-wide Overpass area, a same-named street in another town entirely —
  // does not multiply the work downstream.
  //
  // The window is anchored on the shortest street, which is the most local of
  // the set and so the most reliable pointer at the block. It used to *be* that
  // street's bbox plus a margin, which quietly assumed the block is no wider
  // than the margin. It is not: for the бул. Левски alert of the 30.07.2026
  // review the shortest street (Дубровник, 676 m) is the block's east edge, and
  // the west edge (Подвис) sits ~800 m away — outside a 500 m margin. Clipping
  // it off left a ring that could never close, so a real ~650 × 356 m block came
  // back as no polygon at all.
  //
  // So the window is grown to reach every street before the margin is applied:
  // each street contributes the one fragment nearest the anchor, which is the
  // fragment that could plausibly bound the block, and never the same-named
  // stretch two towns over.
  let shortestLines: XY[][] | null = null;
  let shortestName = "";
  let shortestLen = Infinity;
  for (const [name, lines] of localLines) {
    const len = lines.reduce((sum, line) => sum + lineLength(line), 0);
    if (len < shortestLen) {
      shortestLen = len;
      shortestLines = lines;
      shortestName = name;
    }
  }
  const anchorBox = linesBBox(shortestLines!);
  const anchorPoint: XY = [(anchorBox.minX + anchorBox.maxX) / 2, (anchorBox.minY + anchorBox.maxY) / 2];

  let reach: Box = anchorBox;
  for (const lines of localLines.values()) {
    let nearest: Box | null = null;
    let nearestDist = Infinity;
    for (const line of lines) {
      const b = linesBBox([line]);
      const d = boxDistanceToPoint(b, anchorPoint);
      if (d < nearestDist) { nearestDist = d; nearest = b; }
    }
    if (nearest) reach = unionBox(reach, nearest);
  }

  const clipBox: Box = {
    minX: reach.minX - clipMargin, maxX: reach.maxX + clipMargin,
    minY: reach.minY - clipMargin, maxY: reach.maxY + clipMargin,
  };

  const toWgs84Line = (line: XY[]): LngLat[] => line.map(proj.toWgs84);
  if (dbg) {
    dbg.anchorStreet = shortestName;
    const { minX, maxX, minY, maxY } = clipBox;
    dbg.clipRing = toWgs84Line(
      [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]]);
  }

  const streetGeoms = new Map<string, any>();
  for (const [name, lines] of localLines) {
    const kept = lines.filter((line) => boxesOverlap(linesBBox([line]), clipBox));
    if (kept.length > 0) streetGeoms.set(name, mergeLines(kept.map(lineStringFromXY)));
    if (dbg) {
      const keptSet = new Set(kept);
      dbg.streets.push({
        name,
        kept: kept.map(toWgs84Line),
        dropped: lines.filter((line) => !keptSet.has(line)).map(toWgs84Line),
      });
    }
  }
  if (streetGeoms.size < 3) {
    return {
      polygon: null,
      reason: `only ${streetGeoms.size} streets near the block after clipping`,
      ...sealed(),
    };
  }

  await breakBurst();

  // 3. Extend the centrelines so they cross rather than stop short.
  const extended = new Map<string, any>();
  for (const [name, geom] of streetGeoms) extended.set(name, extendGeometry(geom, extensionDist));

  // 4. Widen each street into a band and union them into one road network. The
  //    blocks are then its holes — see ROAD_HALF_WIDTH_M for why this replaced
  //    polygonizing the bare centrelines.
  //
  //    Buffering is the single most expensive step, and it is per street, so a
  //    burst boundary goes between them: a set of four boulevards costs about
  //    the same as everything else in this function put together, and a street
  //    is the smallest slice that can be taken without holding a half-built
  //    band across the yield.
  const bands: any[] = [];
  for (const geom of extended.values()) {
    bands.push(BufferOp.bufferOp(geom, roadHalfWidth));
    await breakBurst();
  }

  //    Unioned by folding rather than in one cascaded call over the collection.
  //    Cascading is the faster of the two in total, and that is the wrong thing
  //    to optimise: on a cold isolate the single call was the largest burst in
  //    the whole pipeline (12 ms on Сахаров, over the ceiling on its own).
  //    Folding costs more overall and the invocation has minutes of wall clock
  //    to pay it out of.
  let roads = bands[0];
  for (let i = 1; i < bands.length; i++) {
    roads = UnaryUnionOp.union(factory.createGeometryCollection([roads, bands[i]]));
    await breakBurst();
  }

  const rawPolygons: any[] = [];
  for (let i = 0; i < roads.getNumGeometries(); i++) {
    const part = roads.getGeometryN(i);
    // A union of buffers is a Polygon or MultiPolygon, but an empty or
    // degenerate input can yield something without rings at all.
    if (typeof part.getNumInteriorRing !== "function") continue;
    if (dbg) dbg.roads.push(ringXY(part.getExteriorRing()).map(proj.toWgs84));
    for (let h = 0; h < part.getNumInteriorRing(); h++) {
      rawPolygons.push(ringToPolygon(part.getInteriorRingN(h)));
    }
  }

  // 5. Keep blocks enclosed by ≥2 distinct streets, none of which wraps most
  //    of the ring on its own; best = (touchCount, area).
  const candidates: Array<{ poly: any; touched: number; streets: string[] }> = [];
  const extendedEntries = [...extended.entries()];
  let slivers = 0;
  let degenerate = 0; // rejected for single-street dominance — reported below
  for (const poly of rawPolygons) {
    // A burst per face *and* per street within it. This is the other half of
    // the cost — a boulevard-long face carries the most samples and is measured
    // against every street — and unlike buffering it scales with how many areas
    // the streets happen to enclose, which the input cannot be checked for in
    // advance. One face against four streets took 11 ms cold; one street's
    // worth of it is a quarter of that.
    await breakBurst();

    // Sample (and wrap into Points) once per polygon, then reuse across streets.
    const samples = samplesAlongRing(poly.getExteriorRing(), sampleStep)
      .map((c) => factory.createPoint(c));
    if (samples.length === 0) continue;

    // One pass yields both tests: which streets bound this face at all, and
    // whether any single one of them accounts for too much of its boundary.
    const maxHits = maxSingleStreetCoverage * samples.length;
    const streets: string[] = [];
    const coverage: BlockPolygonDebug["candidates"][number]["coverage"] = [];
    let dominated = false;
    let first = true;
    for (const [name, geom] of extendedEntries) {
      if (!first) await breakBurst();
      first = false;
      const hits = countSamplesNearStreet(
        samples, geom, maxHits, touchTolerance, minTouchSamples, !!dbg);
      if (dbg) coverage.push({ name, hits, share: hits / samples.length });
      // A dominated face is rejected outright, so there is nothing left to
      // learn from the remaining streets — stop paying for them. This is the
      // one path where the CPU budget was already worst-case (a sliver runs
      // the length of a boulevard, so it carries the most samples). The tester
      // reads every street's share, so there it keeps going after the verdict.
      if (hits > maxHits) {
        dominated = true;
        if (!dbg) break;
        continue;
      }
      if (hits >= minTouchSamples) streets.push(name);
    }
    if (dbg) {
      const ring = ringXY(poly.getExteriorRing());
      let perimeter = 0;
      for (let i = 1; i < ring.length; i++)
        perimeter += Math.hypot(ring[i]![0] - ring[i - 1]![0], ring[i]![1] - ring[i - 1]![1]);
      const areaM2 = poly.getArea();
      dbg.candidates.push({
        ring: ring.map(proj.toWgs84),
        areaM2,
        meanWidthM: perimeter > 0 ? (2 * areaM2) / perimeter : 0,
        samples: samples.length,
        coverage: coverage.sort((a, b) => b.hits - a.hits),
        bounding: streets,
        // Overwritten for whichever one wins the sort below.
        verdict: dominated ? "dominated" : streets.length >= 2 ? "runner-up" : "too-few-streets",
      });
    }
    if (dominated) { slivers++; continue; }
    if (streets.length < 2) continue;

    // Degenerate faces are dropped HERE rather than after the sort: the sort
    // ranks on how many streets a face touches, so a 110 m triangle that
    // happens to touch three of them would win outright over the real block.
    const faceArea = poly.getArea();
    const faceVertices = poly.getExteriorRing().getCoordinates().length;
    if (faceArea < minBlockAreaM2 || faceVertices < minRingVertices) {
      degenerate++;
      if (dbg) dbg.candidates[dbg.candidates.length - 1]!.verdict = "degenerate";
      continue;
    }
    candidates.push({ poly, touched: streets.length, streets });
  }
  candidates.sort((a, b) => b.touched - a.touched || b.poly.getArea() - a.poly.getArea());

  if (!candidates.length) {
    // Each of these says something different about *why* there is no polygon,
    // and they are the only signal the review tool gets when an alert comes
    // back pinned rather than outlined.
    return {
      polygon: null,
      reason: rawPolygons.length === 0
        ? "the streets enclose no block"
        : slivers === rawPolygons.length
          ? `all ${slivers} enclosed area(s) were bounded by a single street`
          : degenerate > 0
            // Named separately from the ≥2-streets case because it means
            // something different and actionable: a ring DID close and was
            // thrown away for being too small to be a block. Before this, that
            // ring was stored and quietly under-reached everyone inside it.
            ? `${degenerate} of ${rawPolygons.length} enclosed area(s) closed but were degenerate `
              + `(under ${minBlockAreaM2} m² or ${minRingVertices} vertices)`
            : `none of ${rawPolygons.length} enclosed area(s) was bounded by ≥2 distinct streets`,
      ...sealed(),
    };
  }

  // 6. Reproject winner to WGS84 + FeatureCollection (streets_to_geojson shape).
  const winner = candidates[0]!;
  const ringWgs84: LngLat[] = ringXY(winner.poly.getExteriorRing()).map(proj.toWgs84);

  if (dbg) {
    // Matched on area rather than by index: the debug list holds every enclosed
    // area in build order, the candidate list only the survivors, re-sorted.
    const area = winner.poly.getArea();
    const won = dbg.candidates.find((c) => c.verdict === "runner-up" && c.areaM2 === area);
    if (won) won.verdict = "winner";
  }

  return {
    ...sealed(),
    polygon: {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        // The streets that actually bound the winning face, not every name we
        // fetched: the two differed whenever the block was built from a subset,
        // and the review tool prints this as "the polygon is bounded by …".
        properties: { streets: winner.streets },
        geometry: { type: "Polygon", coordinates: [ringWgs84] },
      }],
    },
  };
}

// ── Entry point used by the pipeline ─────────────────────────────────────────

/**
 * Resolve raw street names against the streets table and build the block
 * polygon. Any failure → a null polygon with a reason, never throws (port of
 * build_polygons' catch-all).
 *
 * `scope` is the settlement the location was written in, and threading it here
 * is what the 08.08.2026 review's four ★ failures turned out to be. This used to
 * resolve names with `bestMatch(raw, streets, (s) => s.name, …)` — the whole
 * WRITTEN name against the whole STORED name, over the entire nationwide table,
 * with no settlement scope. It was the only street lookup in the codebase that
 * did not scope; `matchStreet` has taken one since 31.07 precisely because street
 * names repeat across settlements.
 *
 * Both halves of that were load-bearing. Comparing whole names makes a stored
 * kind prefix decide the winner, so "ул. Никола Вапцаров" resolved to Горица's
 * "ул.Никола Вапцаров" (0.8 on the literal spelling) over Варна's bare "Никола
 * Вапцаров" (0.58) — and that resolved NAME is what gets sent to Overpass, where
 * "ул.Никола Вапцаров" matches zero ways inside Варна and the bare form matches
 * eleven. Alert 9e9d7a9e had three sides of a four-sided block and could not
 * close a ring; d29913c5 had three of seven, 15af34ef two of four.
 *
 * `matchStreet` fixes both at once: it compares parsed cores, so the prefix stops
 * voting, and it refuses rows outside the settlement, so a town 185 km away is
 * not a candidate at all.
 */
export async function buildPolygonForStreets(
  env: Env, rawStreetNames: string[], scope: PolygonScope & { id: number },
  deadline?: number,
): Promise<BlockPolygonResult> {
  try {
    const streets = await getStreets(env);
    const resolved: string[] = [];
    const unresolved: string[] = [];
    for (const raw of rawStreetNames) {
      const match = matchStreet(raw, streets, scope.id, POLYGON_RESOLVE_THRESHOLD);
      if (!match) unresolved.push(raw);
      else if (!resolved.includes(match.name)) resolved.push(match.name);
    }
    if (resolved.length < 3) {
      // Which names failed, not just how many: "ул. Звзда" is a source typo for
      // Звезда and wants a region_aliases row, where a name that resolves fine
      // but finds no OSM way is a different problem entirely.
      const reason = `only ${resolved.length}/${rawStreetNames.length} street names `
        + `resolved in ${scope.name}`
        + (unresolved.length > 0 ? ` (no match: ${unresolved.join(", ")})` : "");
      console.warn(`[polygon] ${reason} — skipping polygon.`);
      return { polygon: null, reason };
    }

    const ways = await fetchStreetWays(env, resolved, scope, deadline);
    const result = await buildBlockPolygon(ways, resolved);
    if (!result.polygon) {
      console.warn(`[polygon] no polygon in ${scope.name} for [${resolved.join(", ")}]: ${result.reason}`);
    }
    return result;
  } catch (e) {
    console.error(`[polygon] failed for [${rawStreetNames.join(", ")}]: ${e}`);
    return { polygon: null, reason: String(e) };
  }
}

// ── Warm-up ──────────────────────────────────────────────────────────────────

/**
 * Run the whole JSTS pipeline once, on a 100 m square, at module evaluation.
 *
 * The 30.07.2026 outage was first-execution cost, not per-row cost: code that
 * runs in 0.1 ms warm cost 6.8 ms the first time an isolate reached it, which
 * on its own exceeded the burst ceiling. JSTS behaves the same way here — cold,
 * the first `BufferOp` costs 9 ms against 3 ms for the next one, and the union
 * and the distance loop are worse. Splitting the pipeline into bursts cannot
 * help with that, because the warm-up lands inside whichever burst happens to
 * touch a code path first.
 *
 * Module evaluation is charged against the separate **400 ms startup budget**
 * that `wrangler deploy` reports, not against a tick, so paying it here is a
 * real fix rather than a shuffle — the same reasoning that moved the place
 * matcher's per-name setup to module scope in 9a5776e.
 *
 * The square is chosen to reach every operation the real pipeline uses,
 * including the interior ring the blocks come from. It must never be able to
 * break the module: a Worker that fails to evaluate serves nothing at all,
 * and an unwarmed pipeline is merely slower.
 */
function warmJstsPipeline(): void {
  try {
    const corners = [[0, 0], [100, 0], [100, 100], [0, 100]] as const;
    const sides = corners.map((from, i) => {
      const to = corners[(i + 1) % corners.length]!;
      return lineStringFromXY([[from[0], from[1]], [to[0], to[1]]]);
    });

    const extended = sides.map((side) => extendGeometry(mergeLines([side]), EXTENSION_DIST_M));
    let roads = BufferOp.bufferOp(extended[0]!, ROAD_HALF_WIDTH_M);
    for (let i = 1; i < extended.length; i++) {
      roads = UnaryUnionOp.union(factory.createGeometryCollection(
        [roads, BufferOp.bufferOp(extended[i]!, ROAD_HALF_WIDTH_M)]));
    }

    for (let i = 0; i < roads.getNumGeometries(); i++) {
      const part = roads.getGeometryN(i);
      if (typeof part.getNumInteriorRing !== "function") continue;
      for (let h = 0; h < part.getNumInteriorRing(); h++) {
        const hole = ringToPolygon(part.getInteriorRingN(h));
        const samples = samplesAlongRing(hole.getExteriorRing(), SAMPLE_STEP_M)
          .map((c) => factory.createPoint(c));
        countSamplesNearStreet(samples, extended[0]!, samples.length,
          ROAD_HALF_WIDTH_M + TOUCH_SLACK_M, MIN_TOUCH_SAMPLES, true);
      }
    }
  } catch {
    // Nothing to do and nothing to report: the pipeline is correct either way.
  }
}

warmJstsPipeline();
