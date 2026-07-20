// Port of processing/polygon.py via the Phase 0 JSTS spike
// (spikes/polygon-jsts/pipeline.mjs), PLAN.MD §1.9. Overpass fetch (I/O) is
// separated from the JSTS geometry pipeline (CPU). Spike 3's CPU verdict is
// baked in: 10 m ring sampling (halves cost, identical winners) and street
// geometries clipped to a bbox around the shortest street (kills the
// boulevard blow-up on city-spanning street sets).

import GeometryFactory from "jsts/org/locationtech/jts/geom/GeometryFactory.js";
import Coordinate from "jsts/org/locationtech/jts/geom/Coordinate.js";
import LineMerger from "jsts/org/locationtech/jts/operation/linemerge/LineMerger.js";
import Polygonizer from "jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js";
import UnaryUnionOp from "jsts/org/locationtech/jts/operation/union/UnaryUnionOp.js";
import DistanceOp from "jsts/org/locationtech/jts/operation/distance/DistanceOp.js";
import { bestMatch, POLYGON_RESOLVE_THRESHOLD } from "../core/fuzzy";
import { getStreets } from "../db/queries";
import type { Env } from "../env";

const factory = new GeometryFactory();

const EXTENSION_DIST_M = 200;
const SAMPLE_STEP_M = 10;   // spike 3: same winner as 5 m at half the CPU
const CLIP_MARGIN_M = 500;  // bbox margin around the shortest street

// ── Overpass fetch (replaces ox.features_from_place) ─────────────────────────

// Spike 1: browser UA gets a 406 from overpass-api.de — a descriptive UA is
// required and is also what their usage policy asks for.
const OVERPASS_HEADERS = {
  "User-Agent": "CityShieldAPI/1.0 (cityshield.varna@gmail.com)",
  "Content-Type": "application/x-www-form-urlencoded",
};

export type WaysByName = Map<string, [number, number][][]>; // street → lines of [lon, lat]

// Module-memory cache keyed by sorted street list (replaces ox.settings.use_cache).
const overpassCache = new Map<string, WaysByName>();
const OVERPASS_CACHE_MAX = 50;

function escapeOverpassRegex(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

export async function fetchStreetWays(env: Env, streetNames: string[]): Promise<WaysByName> {
  const cacheKey = [...streetNames].sort().join("|");
  const cached = overpassCache.get(cacheKey);
  if (cached) return cached;

  const pattern = streetNames.map(escapeOverpassRegex).join("|");
  const query =
    `[out:json][timeout:25];` +
    `area["name"="Варна"]["boundary"="administrative"]->.a;` +
    `way(area.a)["highway"]["name"~"^(${pattern})$"];` +
    `out geom;`;

  let data: OverpassResponse | undefined;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(env.OVERPASS_URL, {
      method: "POST",
      headers: OVERPASS_HEADERS,
      body: "data=" + encodeURIComponent(query),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) {
      data = await res.json();
      break;
    }
    // Overpass rate-limits aggressive retries (429) — a retry needs a real
    // pause (slot freeing). One retry; the cron's deadline guard is upstream.
    if (attempt === 2) throw new Error(`Overpass HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }

  const byName = groupWaysByName(data ?? {});

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

// Candidate filter (§1.9 step 5): sample the exterior ring; a street
// "touches" the polygon when a contiguous run of samples longer than 5 m
// stays within 1 m of the street geometry.
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

function streetTouchesRing(ring: any, streetGeom: any, step: number, tolerance = 1.0, minRun = 5): boolean {
  const samples = samplesAlongRing(ring, step);
  let run = 0;
  for (const c of samples) {
    if (DistanceOp.distance(factory.createPoint(c), streetGeom) <= tolerance) {
      run += step;
      if (run > minRun) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

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
}

export function buildBlockPolygon(
  waysByName: WaysByName,
  streetNames: string[],
  extensionDist = EXTENSION_DIST_M,
  sampleStep = SAMPLE_STEP_M,
): BlockPolygonResult {
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

  // CPU mitigation (spike 3): a block polygon is always near the shortest
  // street — drop ways outside a bbox around it before merge/extend/union so
  // a city-spanning boulevard doesn't multiply the polygonize/filter work.
  let shortestLines: XY[][] | null = null;
  let shortestLen = Infinity;
  for (const lines of localLines.values()) {
    const len = lines.reduce((sum, line) => sum + lineLength(line), 0);
    if (len < shortestLen) {
      shortestLen = len;
      shortestLines = lines;
    }
  }
  const box = linesBBox(shortestLines!);
  const clipBox: Box = {
    minX: box.minX - CLIP_MARGIN_M, maxX: box.maxX + CLIP_MARGIN_M,
    minY: box.minY - CLIP_MARGIN_M, maxY: box.maxY + CLIP_MARGIN_M,
  };

  const streetGeoms = new Map<string, any>();
  for (const [name, lines] of localLines) {
    const kept = lines.filter((line) => boxesOverlap(linesBBox([line]), clipBox));
    if (kept.length > 0) streetGeoms.set(name, mergeLines(kept.map(lineStringFromXY)));
  }
  if (streetGeoms.size < 3) {
    return { polygon: null, reason: `only ${streetGeoms.size} streets near the block after clipping` };
  }

  // 3. Extend, 4. union + polygonize.
  const extended = new Map<string, any>();
  for (const [name, geom] of streetGeoms) extended.set(name, extendGeometry(geom, extensionDist));

  const union = UnaryUnionOp.union(factory.createGeometryCollection([...extended.values()]));
  const polygonizer = new Polygonizer();
  polygonizer.add(union);
  const rawPolygons = jstsCollectionToArray(polygonizer.getPolygons());

  // 5. Keep polygons bounded by ≥2 distinct streets; best = (touchCount, area).
  const candidates: Array<{ poly: any; touched: number }> = [];
  for (const poly of rawPolygons) {
    let touched = 0;
    for (const geom of extended.values()) {
      if (streetTouchesRing(poly.getExteriorRing(), geom, sampleStep)) touched++;
    }
    if (touched >= 2) candidates.push({ poly, touched });
  }
  candidates.sort((a, b) => b.touched - a.touched || b.poly.getArea() - a.poly.getArea());

  if (!candidates.length) {
    return { polygon: null, reason: "no polygon bounded by ≥2 distinct streets" };
  }

  // 6. Reproject winner to WGS84 + FeatureCollection (streets_to_geojson shape).
  const ringWgs84: [number, number][] = candidates[0]!.poly
    .getExteriorRing()
    .getCoordinates()
    .map((c: any) => proj.toWgs84([c.x, c.y]));

  return {
    polygon: {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: { streets: [...streetGeoms.keys()] },
        geometry: { type: "Polygon", coordinates: [ringWgs84] },
      }],
    },
  };
}

// ── Entry point used by the pipeline ─────────────────────────────────────────

/**
 * Resolve raw street names against the streets table (threshold 0.4 — the
 * `similarity_threshold` of streets_to_geojson) and build the block polygon.
 * Any failure → null, never throws (port of build_polygons' catch-all).
 */
export async function buildPolygonForStreets(env: Env, rawStreetNames: string[]): Promise<BlockPolygonResult["polygon"]> {
  try {
    const streets = await getStreets(env);
    const resolved: string[] = [];
    for (const raw of rawStreetNames) {
      const match = bestMatch(raw, streets, (s) => s.name, POLYGON_RESOLVE_THRESHOLD);
      if (match && !resolved.includes(match.name)) resolved.push(match.name);
    }
    if (resolved.length < 3) {
      console.warn(`[polygon] only ${resolved.length}/${rawStreetNames.length} street names resolved — skipping polygon.`);
      return null;
    }

    const ways = await fetchStreetWays(env, resolved);
    const result = buildBlockPolygon(ways, resolved);
    if (!result.polygon) console.warn(`[polygon] no polygon: ${result.reason}`);
    return result.polygon;
  } catch (e) {
    console.error(`[polygon] failed for [${rawStreetNames.join(", ")}]: ${e}`);
    return null;
  }
}
