// Polygon builder against the real Overpass fixture from spike 3 (street set
// 1: Йовков/Кубрат/Ивац Войвода/Тихомир) — the same structural validation the
// spike used, including polygon.py's __main__ test point.

import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pointInRing, type Ring } from "../src/core/geo";
import { clearRefCaches } from "../src/db/queries";
import {
  buildBlockPolygon, buildPolygonForStreets, clearOverpassCache, groupWaysByName,
} from "../src/ingestion/polygon";

const SET1 = ["Йордан Йовков", "Хан Кубрат", "Ивац Войвода", "Тихомир"];
const TEST_POINT = { lat: 43.22191026531218, lng: 27.88398470945895 };

const overpassSet1Raw = env.TEST_FIXTURES["overpass-set1.json"]!;
const overpassSet1 = JSON.parse(overpassSet1Raw);

describe("buildBlockPolygon (fixture ways)", () => {
  it("builds a closed block bounded by the 4 streets; the known test point is inside", () => {
    const ways = groupWaysByName(overpassSet1);
    for (const name of SET1) expect(ways.has(name), `OSM ways for ${name}`).toBe(true);

    const result = buildBlockPolygon(ways, SET1, 250);
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

  it("bails out with fewer than 3 streets in OSM", () => {
    const ways = groupWaysByName(overpassSet1);
    const result = buildBlockPolygon(ways, ["Йордан Йовков", "Тихомир"]);
    expect(result.polygon).toBeNull();
    expect(result.reason).toContain("2 streets");
  });
});

describe("buildPolygonForStreets (fuzzy resolve + Overpass)", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  beforeEach(async () => {
    clearRefCaches();
    clearOverpassCache();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO streets (street_name) VALUES
       ('Йордан Йовков'), ('Хан Кубрат'), ('Ивац Войвода'), ('Тихомир'), ('Розова долина')`,
    ).run();
  });

  it("resolves prefixed/abbreviated names and builds the polygon", async () => {
    fetchMock.get("https://overpass-api.de")
      .intercept({ path: "/api/interpreter", method: "POST" })
      .reply(200, overpassSet1Raw, { headers: { "Content-Type": "application/json" } });

    const polygon = await buildPolygonForStreets(env, [
      "ул. Йордан Йовков", "ул.Хан Кубрат", "Ивац Войвода", "ул. Тихомир",
    ]);
    expect(polygon).not.toBeNull();
    expect(polygon!.features[0]!.properties.streets.sort()).toEqual([...SET1].sort());
    fetchMock.assertNoPendingInterceptors();

    // Second call hits the module-scope Overpass cache (no interceptor left).
    const again = await buildPolygonForStreets(env, SET1);
    expect(again).not.toBeNull();
  });

  it("returns null (no Overpass call) when fewer than 3 names resolve", async () => {
    const polygon = await buildPolygonForStreets(env, ["ул. Йордан Йовков", "Несъществуваща", "Друга измислена"]);
    expect(polygon).toBeNull();
  });
});
