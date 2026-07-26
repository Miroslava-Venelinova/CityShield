// Phase 0 spike: JSTS port of backend/processing/polygon.py per SPEC.md §1.9.
// Overpass fetch (I/O) is separated from the JSTS geometry pipeline (CPU) so
// the 10 ms CPU budget question gets a clean measurement.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import GeometryFactory from "jsts/org/locationtech/jts/geom/GeometryFactory.js";
import Coordinate from "jsts/org/locationtech/jts/geom/Coordinate.js";
import LineMerger from "jsts/org/locationtech/jts/operation/linemerge/LineMerger.js";
import Polygonizer from "jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js";
import UnaryUnionOp from "jsts/org/locationtech/jts/operation/union/UnaryUnionOp.js";
import DistanceOp from "jsts/org/locationtech/jts/operation/distance/DistanceOp.js";

const jsts = {
  geom: { Coordinate },
  operation: {
    linemerge: { LineMerger },
    polygonize: { Polygonizer },
    union: { UnaryUnionOp },
  },
};

const factory = new GeometryFactory();

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const OVERPASS_HEADERS = {
  // Browser UA gets a 406 from overpass-api.de (verified in spike 1) — a
  // descriptive UA is required and also what their usage policy asks for.
  "User-Agent": "CityShieldAPI/1.0 (migration spike; stunnybg@gmail.com)",
  "Content-Type": "application/x-www-form-urlencoded",
};
const CACHE_DIR = new URL("./cache/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

// --- Overpass fetch (equivalent of ox.features_from_place) -----------------

function escapeOverpassRegex(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function fetchStreetWays(streetNames) {
  const pattern = streetNames.map(escapeOverpassRegex).join("|");
  const query =
    `[out:json][timeout:25];` +
    `area["name"="Варна"]["boundary"="administrative"]->.a;` +
    `way(area.a)["highway"]["name"~"^(${pattern})$"];` +
    `out geom;`;

  // Disk cache keyed by sorted street list (mirrors ox.settings.use_cache).
  mkdirSync(CACHE_DIR, { recursive: true });
  const key = createHash("sha256").update([...streetNames].sort().join("|")).digest("hex").slice(0, 16);
  const cacheFile = `${CACHE_DIR}/overpass-${key}.json`;
  let data;
  if (existsSync(cacheFile)) {
    data = JSON.parse(readFileSync(cacheFile, "utf-8"));
  } else {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(OVERPASS_URL, {
        method: "POST",
        headers: OVERPASS_HEADERS,
        body: "data=" + encodeURIComponent(query),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        data = await res.json();
        writeFileSync(cacheFile, JSON.stringify(data));
        break;
      }
      if (attempt === 3) throw new Error(`Overpass HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, 15_000 * attempt)); // 429s need a real pause (slot freeing)
    }
  }

  // Group way geometries by street name → arrays of [lon, lat] lines.
  const byName = new Map();
  for (const el of data.elements ?? []) {
    if (el.type !== "way" || !el.tags?.name || !Array.isArray(el.geometry)) continue;
    if (!byName.has(el.tags.name)) byName.set(el.tags.name, []);
    byName.get(el.tags.name).push(el.geometry.map((pt) => [pt.lon, pt.lat]));
  }
  return byName;
}

// --- Local equirectangular projection (replaces project_gdf) ---------------

export function makeProjection(lon0, lat0) {
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 111_320;
  return {
    toLocal: ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toWgs84: ([x, y]) => [lon0 + x / kx, lat0 + y / ky],
  };
}

// --- JSTS helpers -----------------------------------------------------------

function jstsCollectionToArray(collection) {
  if (Array.isArray(collection)) return collection;
  if (typeof collection.toArray === "function") return collection.toArray();
  const out = [];
  for (const it = collection.iterator(); it.hasNext(); ) out.push(it.next());
  return out;
}

function lineStringFromXY(coords) {
  return factory.createLineString(coords.map(([x, y]) => new jsts.geom.Coordinate(x, y)));
}

function mergeLines(lineStrings) {
  const merger = new jsts.operation.linemerge.LineMerger();
  for (const ls of lineStrings) merger.add(ls);
  const merged = jstsCollectionToArray(merger.getMergedLineStrings());
  if (merged.length === 1) return merged[0];
  return factory.createMultiLineString(merged);
}

// Port of extend_line: extend both ends along the end-segment direction.
function extendLineString(line, distance) {
  const coords = line.getCoordinates();
  if (coords.length < 2) return line;
  const [p0, p1] = [coords[0], coords[1]];
  const len0 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const start = len0
    ? new jsts.geom.Coordinate(p0.x - ((p1.x - p0.x) / len0) * distance, p0.y - ((p1.y - p0.y) / len0) * distance)
    : p0;
  const [pn1, pn] = [coords[coords.length - 2], coords[coords.length - 1]];
  const lenn = Math.hypot(pn.x - pn1.x, pn.y - pn1.y);
  const end = lenn
    ? new jsts.geom.Coordinate(pn.x + ((pn.x - pn1.x) / lenn) * distance, pn.y + ((pn.y - pn1.y) / lenn) * distance)
    : pn;
  return factory.createLineString([start, ...coords, end]);
}

// Port of extend_geometry: handles LineString and MultiLineString.
function extendGeometry(geom, distance) {
  if (geom.isEmpty()) return geom;
  const type = geom.getGeometryType();
  if (type === "LineString") return extendLineString(geom, distance);
  if (type === "MultiLineString") {
    const parts = [];
    for (let i = 0; i < geom.getNumGeometries(); i++) parts.push(extendLineString(geom.getGeometryN(i), distance));
    return mergeLines(parts);
  }
  return geom;
}

// Candidate filter (§1.9 step 5): sample the exterior ring every ~5 m; a
// street "touches" the polygon when a contiguous run of samples longer than
// 5 m stays within 1 m of the street geometry.
function samplesAlongRing(ring, step) {
  const coords = ring.getCoordinates();
  const samples = [];
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
      samples.push(new jsts.geom.Coordinate(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
      d += step;
    }
    carried = segLen - (d - step);
  }
  return samples;
}

function streetTouchesRing(ring, streetGeom, step = 5, tolerance = 1.0, minRun = 5) {
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

// --- Main pipeline (port of extract_city_block + streets_to_geojson) -------

export function buildBlockPolygon(waysByName, streetNames, extensionDist = 200, sampleStep = 5) {
  const timings = {};
  const t0 = performance.now();

  // Anchor projection at the first coordinate seen.
  let anchor = null;
  for (const lines of waysByName.values()) {
    if (lines.length && lines[0].length) { anchor = lines[0][0]; break; }
  }
  if (!anchor) return { polygon: null, reason: "no OSM geometry", timings };
  const proj = makeProjection(anchor[0], anchor[1]);

  // 1. Merge segments per street (only requested streets).
  const streetGeoms = new Map();
  for (const name of streetNames) {
    const lines = waysByName.get(name);
    if (!lines || !lines.length) continue;
    streetGeoms.set(name, mergeLines(lines.map((line) => lineStringFromXY(line.map(proj.toLocal)))));
  }

  // 2. Safety check: need at least 3 streets to close a block.
  if (streetGeoms.size < 3) {
    return { polygon: null, reason: `only ${streetGeoms.size} streets found in OSM`, timings };
  }

  // 3. Extend, 4. union + polygonize.
  const tMerged = performance.now();
  const extended = new Map();
  for (const [name, geom] of streetGeoms) extended.set(name, extendGeometry(geom, extensionDist));

  const union = jsts.operation.union.UnaryUnionOp.union(factory.createGeometryCollection([...extended.values()]));
  const polygonizer = new jsts.operation.polygonize.Polygonizer();
  polygonizer.add(union);
  const rawPolygons = jstsCollectionToArray(polygonizer.getPolygons());
  const tPolygonized = performance.now();

  // 5. Keep polygons bounded by ≥2 distinct streets; best = (touchCount, area).
  const candidates = [];
  for (const poly of rawPolygons) {
    let touched = 0;
    for (const geom of extended.values()) {
      if (streetTouchesRing(poly.getExteriorRing(), geom, sampleStep)) touched++;
    }
    if (touched >= 2) candidates.push({ poly, touched });
  }
  candidates.sort((a, b) => b.touched - a.touched || b.poly.getArea() - a.poly.getArea());

  timings.cpuMs = performance.now() - t0;
  timings.mergeMs = tMerged - t0;
  timings.unionPolygonizeMs = tPolygonized - tMerged;
  timings.filterMs = performance.now() - tPolygonized;
  timings.rawPolygons = rawPolygons.length;

  if (!candidates.length) {
    return { polygon: null, reason: "no polygon bounded by ≥2 distinct streets", timings };
  }

  const winner = candidates[0];

  // 6. Reproject winner to WGS84 + FeatureCollection (streets_to_geojson shape).
  const ringWgs84 = winner.poly
    .getExteriorRing()
    .getCoordinates()
    .map((c) => proj.toWgs84([c.x, c.y]));

  // Centroid contract from AlertService.PolygonCentroid: average of outer-ring
  // vertices (skip the closing duplicate).
  const openRing = ringWgs84.slice(0, -1);
  const centroid = [
    openRing.reduce((s, c) => s + c[1], 0) / openRing.length,
    openRing.reduce((s, c) => s + c[0], 0) / openRing.length,
  ];

  return {
    polygon: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { streets: [...streetGeoms.keys()] },
          geometry: { type: "Polygon", coordinates: [ringWgs84] },
        },
      ],
    },
    centroidLatLng: centroid,
    areaM2: winner.poly.getArea(),
    touchedStreets: winner.touched,
    candidateCount: candidates.length,
    timings,
  };
}

// Standard ray-casting point-in-polygon (the §1.3 geo.ts algorithm) — used to
// verify the known test point from polygon.py's __main__.
export function pointInRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
