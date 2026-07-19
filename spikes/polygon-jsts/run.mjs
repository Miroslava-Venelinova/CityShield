// Runs the JSTS polygon pipeline against the four street sets from
// backend/processing/polygon.py's __main__ block. Raw names are resolved
// against the streets.json seed with the trigram matcher (threshold 0.4),
// exactly like the production resolve_street_names step.
//
// Usage: node run.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { bestMatch } from "./fuzzy.mjs";
import { buildBlockPolygon, fetchStreetWays, pointInRing } from "./pipeline.mjs";

const STREETS_SEED = new URL("../../backend/data/postgres/seeding/seeds/streets.json", import.meta.url);
const allStreets = JSON.parse(readFileSync(STREETS_SEED, "utf-8"));

const SETS = [
  { name: "set1-yovkov", raw: ["Йордан Йовков", "Хан Кубрат", "Ивац Войвода", "Тихомир"], extension: 250,
    testPoint: { lat: 43.22191026531218, lng: 27.88398470945895, expectInside: true } },
  { name: "set2-saharov", raw: ["Акад. Андрей Сахаров", "бул. Христо Смирненски", "бул. Сливница", "бул. Цар Освободител"], extension: 200 },
  { name: "set3-varnenchik", raw: ["бул. Владислав Варненчик", "Младежка", "Йордан Йовков", "Фантазия"], extension: 200 },
  { name: "set4-ruse", raw: ["ул.Русе", "ул.Бачо Киро", "ул.Козлодуй", "ул.Ал.Дякович"], extension: 200 },
];

mkdirSync(new URL("./out/", import.meta.url), { recursive: true });

for (const set of SETS) {
  console.log(`\n=== ${set.name} ===`);

  const resolved = [];
  for (const raw of set.raw) {
    const match = bestMatch(raw, allStreets, 0.4);
    console.log(`  resolve: "${raw}" -> ${match ? `"${match}"` : "NO MATCH"}`);
    if (match && !resolved.includes(match)) resolved.push(match);
  }
  if (resolved.length < 3) {
    console.log("  SKIP: fewer than 3 resolved streets (same bail-out as production)");
    continue;
  }

  let waysByName;
  try {
    waysByName = await fetchStreetWays(resolved);
  } catch (err) {
    console.log(`  Overpass FAILED: ${err}`);
    continue;
  }
  for (const name of resolved) {
    console.log(`  OSM ways for "${name}": ${(waysByName.get(name) ?? []).length}`);
  }

  const result = buildBlockPolygon(waysByName, resolved, set.extension);
  if (!result.polygon) {
    console.log(`  NO POLYGON: ${result.reason} (cpu ${result.timings.cpuMs?.toFixed(1)} ms)`);
    continue;
  }

  console.log(`  polygon: ${result.polygon.features[0].geometry.coordinates[0].length - 1} vertices, ` +
              `area ${(result.areaM2 / 1e4).toFixed(2)} ha, bounded by ${result.touchedStreets} streets ` +
              `(${result.candidateCount} candidates, ${result.timings.rawPolygons} raw)`);
  console.log(`  centroid (lat, lng): ${result.centroidLatLng[0].toFixed(6)}, ${result.centroidLatLng[1].toFixed(6)}`);
  const t = result.timings;
  console.log(`  CPU time (JSTS steps): ${t.cpuMs.toFixed(1)} ms ` +
              `(merge ${t.mergeMs.toFixed(1)} + union/polygonize ${t.unionPolygonizeMs.toFixed(1)} + filter ${t.filterMs.toFixed(1)})`);

  // Coarser sampling (10 m) — the first mitigation lever from PLAN.MD §1.9.
  const coarse = buildBlockPolygon(waysByName, resolved, set.extension, 10);
  if (coarse.polygon) {
    const same = coarse.touchedStreets === result.touchedStreets &&
                 Math.abs(coarse.areaM2 - result.areaM2) < 1;
    console.log(`  10 m sampling: ${coarse.timings.cpuMs.toFixed(1)} ms, same winner: ${same}`);
  }

  if (set.testPoint) {
    const ring = result.polygon.features[0].geometry.coordinates[0];
    const inside = pointInRing(set.testPoint.lat, set.testPoint.lng, ring);
    const verdict = inside === set.testPoint.expectInside ? "MATCHES python" : "DIFFERS from python";
    console.log(`  test point (${set.testPoint.lat}, ${set.testPoint.lng}) inside: ${inside} -> ${verdict}`);
  }

  const outFile = new URL(`./out/${set.name}.geojson`, import.meta.url);
  writeFileSync(outFile, JSON.stringify(result.polygon, null, 2));
  console.log(`  written: out/${set.name}.geojson`);
}
