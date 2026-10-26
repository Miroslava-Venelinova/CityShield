/**
 * The Node half of the polygon tester: run one job against the real Worker code
 * and print the answer as JSON.
 *
 *     node run.mjs <bundle.mjs> < job.json
 *
 * The bundle is `entry.ts` put through esbuild by app.py, so every function
 * called below is the one ingestion calls. This file does no geometry of its
 * own — it reads a job, hands it to the Worker's functions, and serialises what
 * comes back.
 *
 * One process per job, deliberately: the module-scope Overpass cache and the
 * fuzzy matcher's gram tables are rebuilt each time, so a run can never be
 * influenced by the previous one's state. It costs ~200 ms and buys the ability
 * to trust a comparison between two runs.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [, , bundlePath] = process.argv;
if (!bundlePath) fail("run.mjs needs the path to the esbuild bundle.");

const worker = await import(pathToFileURL(bundlePath).href);

let job;
try {
  job = JSON.parse(readFileSync(0, "utf-8") || "{}");
} catch (e) {
  fail(`The job on stdin is not JSON: ${e.message}`);
}

/**
 * Way geometries back in the shape Overpass sent them.
 *
 * `groupWaysByName` reads exactly these three fields, so a document written
 * from its own output round-trips through it unchanged — which is what lets a
 * cached fetch be replayed, and what lets one be dropped straight into
 * backend/test/fixtures as a regression test.
 */
function toOverpassDocument(waysByName) {
  const elements = [];
  for (const [name, lines] of waysByName) {
    for (const line of lines) {
      elements.push({
        type: "way",
        tags: { name },
        geometry: line.map(([lon, lat]) => ({ lat, lon })),
      });
    }
  }
  return { elements };
}

/**
 * The backend seed as the Worker sees it: street rows with ids and a settlement
 * id, so the Worker's own `matchStreet` and `loadStreetWays` can run on them.
 * Ids are synthetic — only consistent within this run, which is all they need.
 */
function loadSeed(seedDir, settlement) {
  const streets = JSON.parse(readFileSync(join(seedDir, "streets.json"), "utf-8"));
  const settlementIds = new Map();
  const idOf = new Map();
  const rows = streets.map((s, i) => {
    const place = s.settlement || "Варна";
    if (!settlementIds.has(place)) settlementIds.set(place, settlementIds.size + 1);
    idOf.set(`${place}\0${s.name}`, i + 1);
    return { id: i + 1, name: s.name, lat: s.lat ?? null, lng: s.lng ?? null,
             region_id: settlementIds.get(place) };
  });
  const scopeId = settlementIds.get(settlement);
  if (scopeId === undefined) fail(`The street seed holds no streets in "${settlement}".`);
  return { rows, scopeId, idOf };
}

/**
 * Raw names → seeded street rows, exactly as buildPolygonForStreets does it:
 * same matcher, same settlement scope, same threshold, same "first match wins,
 * duplicates dropped" rule. With `resolve` off, a name is taken as the OSM name
 * it is and only looked up verbatim in the settlement.
 */
function resolveNames(names, seed, resolve) {
  const resolved = [];
  const seen = new Set();
  for (const raw of names) {
    const row = resolve
      ? worker.matchStreet(raw, seed.rows, seed.scopeId, worker.POLYGON_RESOLVE_THRESHOLD)
      : seed.rows.find((r) => r.region_id === seed.scopeId && r.name === raw) ?? null;
    resolved.push({ raw, name: row ? row.name : null, duplicate: !!row && seen.has(row.id), row });
    if (row) seen.add(row.id);
  }
  return resolved;
}

/**
 * The street_ways table, in memory: just enough of a D1 binding for the
 * Worker's `loadStreetWays` (getStreetWays prepares, binds the ids, reads all).
 */
function seedWaysDb(seedDir, seed) {
  const entries = JSON.parse(readFileSync(join(seedDir, "street_ways.json"), "utf-8"));
  const byStreet = new Map();
  for (const e of entries) {
    const id = seed.idOf.get(`${e.settlement || "Варна"}\0${e.name}`);
    if (id !== undefined) byStreet.set(id, e.ways.map((w) => ({ street_id: id, coords: JSON.stringify(w) })));
  }
  return {
    prepare: () => ({
      bind: (...ids) => ({ all: async () => ({ results: ids.flatMap((id) => byStreet.get(id) ?? []) }) }),
    }),
  };
}

/** What came back per street — the first place a province-wide fetch shows. */
function waySummary(waysByName, names) {
  return names.map((name) => {
    const lines = waysByName.get(name) || [];
    let vertices = 0;
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const line of lines) {
      vertices += line.length;
      for (const [lng, lat] of line) {
        minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
        minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
      }
    }
    // Metres, so "this street spans 26 km" reads as the problem it is.
    const spanKm = vertices
      ? {
          x: ((maxLng - minLng) * 111.32 * Math.cos((minLat * Math.PI) / 180)),
          y: ((maxLat - minLat) * 111.32),
        }
      : null;
    return { name, ways: lines.length, vertices, spanKm };
  });
}

function fail(message) {
  process.stdout.write(JSON.stringify({ ok: false, error: message }));
  process.exit(0); // the message is the result; a non-zero exit hides it
}

try {
  const action = job.action || "build";

  if (action === "defaults") {
    done({ defaults: worker.BLOCK_POLYGON_DEFAULTS });
  }

  const names = (job.names || []).map((n) => String(n).trim()).filter(Boolean);
  if (!names.length) fail("No street names given.");

  const seed = job.seedDir ? loadSeed(job.seedDir, job.settlement || "Варна") : null;
  const resolved = seed ? resolveNames(names, seed, job.resolve !== false) : null;
  // Unresolved names are dropped rather than passed through: the stored
  // geometry is keyed by street row, so a name with no row can only ever have
  // no ways, and leaving it in would make the "fewer than 3 streets" bail read
  // as a geometry failure instead of a naming one.
  const queryNames = resolved
    ? [...new Set(resolved.filter((r) => r.name).map((r) => r.name))]
    : names;

  if (action === "fetch") {
    if (!seed) fail("Loading ways needs the backend seed (seedDir).");
    const rows = [...new Map(resolved.filter((r) => r.row).map((r) => [r.row.id, r.row])).values()];
    if (rows.length < 1) fail("Nothing resolved to load.");
    // The Worker's own read, variant folding included — only the binding is ours.
    const ways = await worker.loadStreetWays(
      { DB: seedWaysDb(job.seedDir, seed) }, rows, seed.rows, seed.scopeId);
    done({
      resolved: resolved.map(({ row, ...r }) => r),
      queryNames,
      document: toOverpassDocument(ways),
      summary: waySummary(ways, queryNames),
    });
  }

  if (action === "build") {
    const ways = worker.groupWaysByName(job.document || {});
    const result = await worker.buildBlockPolygon(ways, queryNames, { ...job.options, debug: true });
    done({
      resolved: resolved && resolved.map(({ row, ...r }) => r),
      queryNames,
      summary: waySummary(ways, queryNames),
      // Every name the document holds, not only the ones asked for: a fixture
      // saved from a wider query still shows what else is in it.
      available: [...ways.keys()].sort(),
      polygon: result.polygon,
      reason: result.reason || "",
      debug: result.debug || null,
    });
  }

  fail(`Unknown action: ${action}`);
} catch (e) {
  fail(String((e && e.stack) || e));
}

function done(payload) {
  process.stdout.write(JSON.stringify({ ok: true, ...payload }));
  process.exit(0);
}
