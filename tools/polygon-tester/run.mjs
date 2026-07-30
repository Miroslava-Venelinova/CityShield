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
 * Raw names → seeded street names, exactly as buildPolygonForStreets does it:
 * same matcher, same threshold, same "first match wins, duplicates dropped"
 * rule. A name the tool resolves differently from ingestion would make every
 * polygon below an answer to the wrong question.
 */
function resolveNames(names, seedPath) {
  const streets = JSON.parse(readFileSync(seedPath, "utf-8"));
  const resolved = [];
  const seen = new Set();
  for (const raw of names) {
    const match = worker.bestMatch(raw, streets, (s) => s.name, worker.POLYGON_RESOLVE_THRESHOLD);
    const name = match ? match.name : null;
    resolved.push({ raw, name, duplicate: !!name && seen.has(name) });
    if (name) seen.add(name);
  }
  return resolved;
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

  const resolved = job.seedPath ? resolveNames(names, job.seedPath) : null;
  // Unresolved names are dropped rather than passed through: Overpass matches
  // `name` exactly, so an unresolved name can only ever return nothing, and
  // leaving it in would make the "fewer than 3 streets" bail read as a geometry
  // failure instead of a naming one.
  const queryNames = resolved
    ? [...new Set(resolved.filter((r) => r.name).map((r) => r.name))]
    : names;

  if (action === "fetch") {
    if (queryNames.length < 1) fail("Nothing resolved to fetch.");
    worker.clearOverpassCache();
    const ways = await worker.fetchStreetWays(
      { OVERPASS_URL: job.overpassUrl }, queryNames, Date.now() + 60_000);
    done({
      resolved,
      queryNames,
      document: toOverpassDocument(ways),
      summary: waySummary(ways, queryNames),
    });
  }

  if (action === "build") {
    const ways = worker.groupWaysByName(job.document || {});
    const result = await worker.buildBlockPolygon(ways, queryNames, { ...job.options, debug: true });
    done({
      resolved,
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
