// Geometric sanity checks over regions.json / streets.json.
//
// The 08.08.2026 review found 420 of 2,974 seeded streets belonging to a
// different town — Бяла's from Бяла in Русе 185 km away, Левски's from Левски in
// Плевен, Войводино's from Пловдив — because tools/osm-seed-builder re-resolved
// each settlement BY NAME with no province bound, and settlement names repeat all
// over Bulgaria. The tool no longer can (it sweeps each settlement by its own
// boundary relation id), but a tool fix is a promise and this is a check: the
// seed files are what actually ship, they are bundled into the Worker, and
// nothing before this looked at them.
//
// Both rules are the same rule at two levels — a thing must be near the thing it
// says it is inside — and neither needs any data beyond the two files.
//
//   node seeds/verify.mjs           report, exit 1 if anything fails
//   node seeds/verify.mjs --prune   also rewrite the files without the bad rows
//
// `--prune` exists because a wrong row is worse than a missing one. A street
// filed under the wrong town is targeted confidently: settlementScope resolves,
// the street gate opens, and the alert goes to residents of a place 185 km away.
// Delete it and the gate closes instead, the location falls back to region-wide,
// and the outcome is merely coarse. It is a stopgap either way — only a corrected
// sweep can put the RIGHT streets back.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * How far a street may sit from its settlement's centroid, or a district from
 * its parent's.
 *
 * The same 15 km the sweep's own backstop uses, and measured the same way: the
 * errors it separates were 17–269 km, while Варна — much the largest settlement
 * in the province — keeps its own streets inside 10.7 km at the 95th percentile.
 * Every other seeded settlement is inside 8 km end to end.
 */
export const MAX_SEED_DISTANCE_KM = 15;

const EARTH_RADIUS_KM = 6371;
const RAD = Math.PI / 180;

/** Equirectangular approximation — same shortcut, and same accuracy, as core/geo.ts. */
export function distanceKm(aLat, aLng, bLat, bLng) {
  const dLat = (bLat - aLat) * RAD;
  const dLng = (bLng - aLng) * RAD * Math.cos(((aLat + bLat) / 2) * RAD);
  return Math.hypot(dLat, dLng) * EARTH_RADIUS_KM;
}

const hasPoint = (row) => Number.isFinite(row?.lat) && Number.isFinite(row?.lng);

/**
 * Every problem in a seed pair, as `{ kind, message, row }`.
 *
 * Pure and dependency-free so the vitest suite can assert on it directly rather
 * than shelling out — see test/seeds.spec.ts.
 */
export function verifySeeds(regions, streets) {
  const problems = [];

  // A settlement is a region with no parent. Districts are not somewhere a
  // street can be filed (streets.region_id always points at a settlement,
  // migration 0015), and they are not somewhere a district can be filed either.
  const settlements = new Map();
  for (const r of regions) if (!r.settlement) settlements.set(r.name, r);

  for (const street of streets) {
    const parent = settlements.get(street.settlement ?? "Варна");
    if (!parent) {
      problems.push({
        kind: "street-orphan", row: street,
        message: `street "${street.name}" claims settlement "${street.settlement}", `
          + `which has no settlement-class row in regions.json — it will insert nothing`,
      });
      continue;
    }
    if (!hasPoint(street) || !hasPoint(parent)) continue;
    const km = distanceKm(parent.lat, parent.lng, street.lat, street.lng);
    if (km > MAX_SEED_DISTANCE_KM) {
      problems.push({
        kind: "street-far", row: street, km,
        message: `street "${street.name}" is ${km.toFixed(0)} km from ${parent.name} — `
          + `it belongs to a different town of that name`,
      });
    }
  }

  for (const region of regions) {
    if (!region.settlement) continue;
    const parent = settlements.get(region.settlement);
    if (!parent) {
      problems.push({
        kind: "link-orphan", row: region,
        message: `region "${region.name}" is linked to "${region.settlement}", which has no `
          + `settlement-class row — the link will be left NULL`,
      });
      continue;
    }
    if (!hasPoint(region) || !hasPoint(parent)) continue;
    const km = distanceKm(parent.lat, parent.lng, region.lat, region.lng);
    if (km > MAX_SEED_DISTANCE_KM) {
      problems.push({
        kind: "link-far", row: region, km,
        message: `region "${region.name}" is ${km.toFixed(0)} km from its parent `
          + `${parent.name} — one of them is a different place of that name`,
      });
    }
  }

  return problems;
}

/**
 * The same two rules over street_ways.json (migration 0020): every entry must
 * hang off a street the seed holds, and every point of every way must be near
 * that street's settlement.
 *
 * The second matters more than it did for street rows. A street row is one pin;
 * a way is geometry the polygon builder draws a block from, and the builder now
 * trusts the settlement filing completely — the live Overpass query it replaced
 * carried its own 12 km distance filter, the stored ways carry none. Checked per
 * POINT rather than per first vertex for the same reason: one far-flung way is
 * enough to drag the clip window somewhere else entirely. Measured 26.10.2026:
 * the farthest point in the seed is 13.6 km from its settlement.
 */
export function verifyStreetWays(regions, streets, ways) {
  const problems = [];
  const settlements = new Map();
  for (const r of regions) if (!r.settlement) settlements.set(r.name, r);
  const seeded = new Set(streets.map((s) => `${s.settlement ?? "Варна"}\0${s.name}`));

  for (const entry of ways) {
    const settlement = entry.settlement ?? "Варна";
    if (!seeded.has(`${settlement}\0${entry.name}`)) {
      problems.push({
        kind: "ways-orphan", row: entry,
        message: `street_ways.json has ways for "${entry.name}" in ${settlement}, which `
          + `streets.json does not hold — they will insert nothing`,
      });
      continue;
    }
    const parent = settlements.get(settlement);
    if (!hasPoint(parent)) continue;
    let farthest = 0;
    for (const line of entry.ways) {
      for (const [lng, lat] of line) {
        farthest = Math.max(farthest, distanceKm(parent.lat, parent.lng, lat, lng));
      }
    }
    if (farthest > MAX_SEED_DISTANCE_KM) {
      problems.push({
        kind: "ways-far", row: entry, km: farthest,
        message: `ways of "${entry.name}" reach ${farthest.toFixed(0)} km from ${settlement} — `
          + `the sweep filed geometry from somewhere else under it`,
      });
    }
  }
  return problems;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const read = (f) => JSON.parse(readFileSync(join(here, f), "utf8"));
  const regions = read("regions.json");
  const streets = read("streets.json");
  // Optional, as everywhere else: a seed from before migration 0020 has none.
  const ways = existsSync(join(here, "street_ways.json")) ? read("street_ways.json") : [];
  const wayProblems = verifyStreetWays(regions, streets, ways);
  const problems = [...verifySeeds(regions, streets), ...wayProblems];

  const byKind = new Map();
  for (const p of problems) byKind.set(p.kind, (byKind.get(p.kind) ?? 0) + 1);
  for (const p of problems.slice(0, 40)) console.error(`  ${p.kind}: ${p.message}`);
  if (problems.length > 40) console.error(`  … and ${problems.length - 40} more`);

  if (problems.length === 0) {
    console.log(`seeds verified: ${regions.length} regions, ${streets.length} streets, `
      + `${ways.length} streets' geometry, `
      + `everything within ${MAX_SEED_DISTANCE_KM} km of what it says it is inside`);
    process.exit(0);
  }

  console.error(`\n${problems.length} problem(s): `
    + [...byKind].map(([k, n]) => `${k} ${n}`).join(", "));

  if (!process.argv.includes("--prune")) {
    console.error("Re-run the province sweep to fix these properly, or "
      + "`node seeds/verify.mjs --prune` to drop the bad rows as a stopgap.");
    process.exit(1);
  }

  // Geometry is never pruned: a way in the wrong place is a sweep bug, and
  // deleting it would only turn a wrong block into a missing one. Re-sweep.
  if (wayProblems.length > 0) {
    console.error(`${wayProblems.length} street_ways problem(s) are not pruned — re-run the `
      + "province sweep in tools/osm-seed-builder and promote its geometry.");
  }
  const bad = new Set(problems.map((p) => p.row));
  const keptStreets = streets.filter((s) => !bad.has(s));
  const keptRegions = regions.filter((r) => !bad.has(r));
  writeFileSync(join(here, "streets.json"),
    JSON.stringify(keptStreets, null, 2) + "\n", "utf8");
  writeFileSync(join(here, "regions.json"),
    JSON.stringify(keptRegions, null, 2) + "\n", "utf8");
  console.log(`pruned: streets ${streets.length} → ${keptStreets.length}, `
    + `regions ${regions.length} → ${keptRegions.length}. `
    + `Run seeds/generate-seed.mjs next.`);
}
