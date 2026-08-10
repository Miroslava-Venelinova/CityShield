// Polygon builder against the real Overpass fixture from spike 3 (street set
// 1: Йовков/Кубрат/Ивац Войвода/Тихомир) — the same structural validation the
// spike used, including polygon.py's __main__ test point.

import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pointInRing, type Ring } from "../src/core/geo";
import { clearRefCaches } from "../src/db/queries";
import {
  buildBlockPolygon, buildPolygonForStreets, clearOverpassCache, fetchStreetWays, groupWaysByName,
} from "../src/ingestion/polygon";

const SET1 = ["Йордан Йовков", "Хан Кубрат", "Ивац Войвода", "Тихомир"];
const TEST_POINT = { lat: 43.22191026531218, lng: 27.88398470945895 };

const overpassSet1Raw = env.TEST_FIXTURES["overpass-set1.json"]!;
const overpassSet1 = JSON.parse(overpassSet1Raw);

describe("buildBlockPolygon (fixture ways)", () => {
  it("builds a closed block bounded by the 4 streets; the known test point is inside", async () => {
    const ways = groupWaysByName(overpassSet1);
    for (const name of SET1) expect(ways.has(name), `OSM ways for ${name}`).toBe(true);

    const result = await buildBlockPolygon(ways, SET1);
    expect(result.polygon, result.reason).not.toBeNull();

    const feature = result.polygon!.features[0]!;
    expect(feature.properties.streets.sort()).toEqual([...SET1].sort());

    const ring = feature.geometry.coordinates[0] as Ring;
    expect(ring.length).toBeGreaterThan(3);
    // Ring is closed.
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    // polygon.py __main__ expectation: this point lies inside the block.
    expect(pointInRing(TEST_POINT.lat, TEST_POINT.lng, ring)).toBe(true);
  });

  it("bails out with fewer than 3 streets in OSM", async () => {
    const ways = groupWaysByName(overpassSet1);
    const result = await buildBlockPolygon(ways, ["Йордан Йовков", "Тихомир"]);
    expect(result.polygon).toBeNull();
    expect(result.reason).toContain("2 streets");
  });
});

// ── Dual-carriageway slivers (30.07.2026 alert review) ───────────────────────
//
// A boulevard reaches OSM as two parallel centrelines under one name. Cutting
// blocks straight out of centrelines therefore treats the gap between a
// boulevard's carriageways as a block: a 10–16 m strip of roadway, bounded by
// ≥2 "distinct" streets (the boulevard, plus whatever cross-streets cap its
// ends) and spanning more cross-streets than any real block, so it won. The
// resulting polygon enclosed tarmac with no addresses on it, and since
// alert-service.ts targets polygon locations purely by point-in-polygon with no
// fallback to the street names, it notified nobody.
//
// Widening each centreline into a road band first (ROAD_HALF_WIDTH_M) closes
// that gap into the road it is, and MAX_SINGLE_STREET_COVERAGE rejects what
// survives. Every set below still produces such a strip, and every one of them
// is thrown away — which is the point of asserting on the losers as well as the
// winner. The two are the same fixtures the bug was reported on, so a change
// that reintroduces the sliver fails here rather than in production.
//
// Getting the block *back* is a separate mechanism, EXTENSION_DIST_M, and
// conflating the two is how these three sets briefly came to assert that they
// enclosed nothing at all. They enclose 17–30 ha each.
//
// Fixtures are the real Overpass responses, trimmed to the fields the parser
// reads. levski and ruse are the two alerts the review flagged; varnenchik is
// Phase 0 spike set 3, which was silently producing a sliver too.

const BLOCK_SETS: Array<{ id: string; streets: string[]; minAreaHa: number }> = [
  {
    // Also pins the clip window. Anchored on the shortest street's bbox alone,
    // this set lost Подвис entirely — it sits ~800 m west of Дубровник, outside
    // the 500 m margin — and no ring could close with an edge missing.
    id: "levski", minAreaHa: 15,
    streets: ["бул. Васил Левски", "Дубровник", "Железни врата", "Подвис"],
  },
  {
    id: "ruse", minAreaHa: 25,
    streets: ["Русе", "Александър Дякович", "Девня", "Преслав"],
  },
  {
    id: "varnenchik", minAreaHa: 14,
    streets: ["бул. Владислав Варненчик", "Младежка", "Йордан Йовков", "Фантазия"],
  },
  {
    // Four boulevards, 267 ways: the guard against over-correcting in the other
    // direction, where a rule strict enough to kill slivers kills this too.
    id: "saharov", minAreaHa: 32,
    streets: ["Акад. Андрей Сахаров", "бул. Христо Смирненски", "бул. Сливница", "бул. Цар Освободител"],
  },
];

/** Mean width of a WGS84 ring (2·area/perimeter) — a sliver's is ~10 m. */
function meanWidthM(ring: Ring): number {
  const kx = 111_320 * Math.cos((ring[0]![1]! * Math.PI) / 180);
  const xy = ring.map(([lon, lat]) => [lon * kx, lat * 111_320]);
  let area2 = 0, perim = 0;
  for (let i = 0; i < xy.length - 1; i++) {
    const [x1, y1] = xy[i]!, [x2, y2] = xy[i + 1]!;
    area2 += x1! * y2! - x2! * y1!;
    perim += Math.hypot(x2! - x1!, y2! - y1!);
  }
  return perim > 0 ? Math.abs(area2) / perim : 0;
}

describe("buildBlockPolygon rejects dual-carriageway slivers", () => {
  for (const { id, streets, minAreaHa } of BLOCK_SETS) {
    it(`${id}: keeps the block, throws away the carriageway gap`, async () => {
      const ways = groupWaysByName(JSON.parse(env.TEST_FIXTURES[`overpass-${id}.json`]!));
      const result = await buildBlockPolygon(ways, streets, { debug: true });

      expect(result.polygon, result.reason).not.toBeNull();
      const feature = result.polygon!.features[0]!;
      // A block is enclosed by its streets, so all of them bound it.
      expect(feature.properties.streets.sort()).toEqual([...streets].sort());
      // Nothing sliver-shaped: these blocks run 200–270 m wide, a carriageway
      // gap 10–16 m. The bound is loose on purpose — this asserts the shape
      // class, not the exact geometry, which moves whenever OSM does.
      expect(meanWidthM(feature.geometry.coordinates[0] as Ring)).toBeGreaterThan(50);

      const candidates = result.debug!.candidates;
      const winner = candidates.find((c) => c.verdict === "winner")!;
      expect(winner.areaM2 / 10_000).toBeGreaterThan(minAreaHa);

      // The reported bug, still expressible and still caught: every one of
      // these sets produces at least one strip of roadway, and every one of
      // them is rejected for being wrapped around a single street. Asserting
      // only on the winner would pass just as well with the rule deleted.
      const rejected = candidates.filter((c) => c.verdict === "dominated");
      expect(rejected.length, "no sliver was produced — the rule is untested here").toBeGreaterThan(0);
      for (const sliver of rejected) {
        expect(Math.max(...sliver.coverage.map((s) => s.share))).toBeGreaterThan(0.7);
      }
    });
  }

  // tools/polygon-tester turns `debug` on to draw what was cut and to read the
  // exact coverage shares, and everything it claims rests on that being an
  // observation rather than a second code path. It nearly isn't: debug drops
  // the two early exits in countSamplesNearStreet and the dominated-face break,
  // so a threshold compared against a lower bound in one mode and an exact
  // count in the other would have the tool disagreeing with production about
  // the alerts it exists to explain.
  it("reaches the same verdict with the debug channel on", async () => {
    for (const { id, streets } of BLOCK_SETS) {
      const ways = groupWaysByName(JSON.parse(env.TEST_FIXTURES[`overpass-${id}.json`]!));
      const plain = await buildBlockPolygon(ways, streets);
      const traced = await buildBlockPolygon(ways, streets, { debug: true });
      expect(traced.polygon, id).toEqual(plain.polygon);
      expect(traced.reason, id).toBe(plain.reason);
    }

    const ways = groupWaysByName(overpassSet1);
    const traced = await buildBlockPolygon(ways, SET1, { debug: true });
    expect(traced.polygon).toEqual((await buildBlockPolygon(ways, SET1)).polygon);
    // And the shares it reports are the ones the rule is decided on: every
    // street the winner is credited to must clear the floor, and none of them
    // may pass the cap that would have rejected the face.
    const winner = traced.debug!.candidates.find((c) => c.verdict === "winner")!;
    for (const { name, hits, share } of winner.coverage) {
      expect(winner.bounding.includes(name), name).toBe(hits >= 2);
      expect(share, name).toBeLessThanOrEqual(0.7);
    }
  });

  it("reports the streets that bound the winner, not every street fetched", async () => {
    const ways = groupWaysByName(overpassSet1);
    // Йовков bounds only 12% of the block, so it is genuinely one of the four.
    const result = await buildBlockPolygon(ways, SET1);
    expect(result.polygon!.features[0]!.properties.streets.sort()).toEqual([...SET1].sort());
  });
});

describe("buildPolygonForStreets (fuzzy resolve + Overpass)", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  // The settlement the block is being built in. It is now an input rather than
  // the hardcoded "Варна" the Overpass query used to carry: the street lookup
  // scopes to `id`, and the fetch measures the returned ways against `lat/lng`
  // so a same-named street in another town cannot reach the geometry.
  let varna: { id: number; name: string; lat: number | null; lng: number | null };

  beforeEach(async () => {
    clearRefCaches();
    clearOverpassCache();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO regions (region_name, lat, lng) VALUES ('Варна', 43.2073873, 27.9166653)",
    ).run();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO streets (street_name, region_id)
       SELECT name, (SELECT id FROM regions WHERE region_name = 'Варна') FROM (
         SELECT 'Йордан Йовков' AS name UNION ALL SELECT 'Хан Кубрат'
         UNION ALL SELECT 'Ивац Войвода' UNION ALL SELECT 'Тихомир'
         UNION ALL SELECT 'Розова долина')`,
    ).run();
    varna = (await env.DB.prepare(
      "SELECT id, region_name AS name, lat, lng FROM regions WHERE region_name = 'Варна'",
    ).first())! as typeof varna;
  });

  it("resolves prefixed/abbreviated names and builds the polygon", async () => {
    fetchMock.get("https://overpass-api.de")
      .intercept({ path: "/api/interpreter", method: "POST" })
      .reply(200, overpassSet1Raw, { headers: { "Content-Type": "application/json" } });

    const { polygon } = await buildPolygonForStreets(env, [
      "ул. Йордан Йовков", "ул.Хан Кубрат", "Ивац Войвода", "ул. Тихомир",
    ], varna);
    expect(polygon).not.toBeNull();
    expect(polygon!.features[0]!.properties.streets.sort()).toEqual([...SET1].sort());
    fetchMock.assertNoPendingInterceptors();

    // Second call hits the module-scope Overpass cache (no interceptor left).
    const again = await buildPolygonForStreets(env, SET1, varna);
    expect(again.polygon).not.toBeNull();
  });

  it("returns null (no Overpass call) when fewer than 3 names resolve", async () => {
    const result = await buildPolygonForStreets(
      env, ["ул. Йордан Йовков", "Несъществуваща", "Друга измислена"], varna);
    expect(result.polygon).toBeNull();
    // The names that failed, so a source typo is distinguishable from a street
    // that resolved fine and then found no OSM way (F6 / §2.1).
    expect(result.reason).toContain("Несъществуваща");
  });

  // §2.1 Cause B, reproduced against the local Overpass instance on 10.08.2026:
  // `бул. Януш Хуняди` carries exactly ONE 118 m way inside Варна, while the rest
  // of the same boulevard continues as `бул. Янош Хунияди`. One fragment is not a
  // side of a block, which is why 5d34f795 could not close a ring although all
  // four of its streets resolved to genuine Варна rows. Folding the variant's
  // ways under the canonical name turned 1 way into 16 and the block closed.
  //
  // The mapping is curated rather than computed, and that is measured: the two
  // spellings score 0.389 on their cores while `Младост 1`/`Младост 2` score
  // 0.667, so no similarity threshold separates them.
  it("folds an OSM spelling variant's ways under the street they belong to", async () => {
    const variant = JSON.stringify({
      elements: [
        { type: "way", tags: { name: "бул. Януш Хуняди" },
          geometry: [{ lon: 27.8700, lat: 43.2228 }, { lon: 27.8689, lat: 43.2235 }] },
        { type: "way", tags: { name: "бул. Янош Хунияди" },
          geometry: [{ lon: 27.8689, lat: 43.2235 }, { lon: 27.8696, lat: 43.2311 }] },
      ],
    });
    fetchMock.get("https://overpass-api.de")
      .intercept({ path: "/api/interpreter", method: "POST" })
      .reply(200, variant, { headers: { "Content-Type": "application/json" } });

    const ways = await fetchStreetWays(env, ["бул. Януш Хуняди"], varna);
    // Both ways arrive under the canonical name, and the variant is not a
    // street of its own — buildBlockPolygon counts distinct streets to decide
    // whether a face is a block, so a second entry would inflate that count.
    expect(ways.get("бул. Януш Хуняди")?.length).toBe(2);
    expect(ways.has("бул. Янош Хунияди")).toBe(false);
  });

  // §2.1 Cause A. The resolver used to compare whole WRITTEN names against whole
  // STORED names over the entire table, so a stored kind prefix decided the
  // winner and no settlement bounded the search: "ул. Никола Вапцаров" resolved
  // to Горица's "ул.Никола Вапцаров" rather than Varna's bare "Никола Вапцаров",
  // and that resolved name — sent to a Варна-scoped Overpass query — matched zero
  // ways. Three of the window's four ★ polygon failures are this.
  it("resolves inside its own settlement, not to a like-named row elsewhere", async () => {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO regions (region_name, lat, lng) VALUES ('Горица', 42.920, 27.830)",
    ).run();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO streets (street_name, region_id)
       VALUES ('ул.Никола Вапцаров', (SELECT id FROM regions WHERE region_name = 'Горица')),
              ('Никола Вапцаров', (SELECT id FROM regions WHERE region_name = 'Варна'))`,
    ).run();
    clearRefCaches();

    fetchMock.get("https://overpass-api.de")
      .intercept({ path: "/api/interpreter", method: "POST" })
      .reply(200, "{}", { headers: { "Content-Type": "application/json" } });

    // Two more Varna streets so the set reaches the three-street floor and the
    // assertion is about which row won, not about the count.
    const result = await buildPolygonForStreets(
      env, ["ул. Никола Вапцаров", "ул. Хан Кубрат", "ул. Тихомир"], varna);
    // No OSM geometry came back, so there is no polygon — but the failure is now
    // "no OSM geometry", which means all three names resolved to Varna rows.
    expect(result.reason).not.toContain("street names resolved");
  });
});
