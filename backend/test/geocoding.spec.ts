// Nominatim query scoping, and the Photon fallback behind it.
//
// The sources are Varna-*province* scoped, not Varna-city scoped: vik publishes
// outages in Долни чифлик, Аврен and Тополи. Every lookup used to be anchored
// to "Варна" regardless, so a village street was searched for in the city — and
// since Bulgarian settlements reuse street names freely (ул. Камчия and
// ул. Плевен exist both in Варна and elsewhere), Nominatim answered with the
// wrong one rather than nothing. Caught by the 30.07.2026 review's
// Долни чифлик alert.

import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildGeocodeQuery, geocode, nominatimSlotsGranted, photonSlotsGranted, resetGeocodeThrottles,
} from "../src/core/geocoding";

describe("buildGeocodeQuery", () => {
  it("anchors to Варна by default, as every district-level lookup wants", () => {
    expect(buildGeocodeQuery("Чайка")).toBe("Чайка, Варна, България");
    expect(buildGeocodeQuery("ул. Дубровник")).toBe("ул. Дубровник, Варна, България");
  });

  it("does not repeat an anchor the name already carries", () => {
    expect(buildGeocodeQuery("Варна")).toBe("Варна, България");
    // Case-insensitively, because the sources capitalise inconsistently.
    expect(buildGeocodeQuery("ВАРНА")).toBe("ВАРНА, България");
    expect(buildGeocodeQuery("Долни чифлик", "Долни чифлик")).toBe("Долни чифлик, България");
  });

  it("scopes a street to the settlement it was named under", () => {
    // The whole point: this is a Долни чифлик street, and ул. Камчия also
    // exists in Варна. Anchoring to the city returned the city's one.
    expect(buildGeocodeQuery("Камчия", "Долни чифлик")).toBe("Камчия, Долни чифлик, България");
  });

  it("drops the scope entirely when given an empty anchor", () => {
    expect(buildGeocodeQuery("Аврен", "")).toBe("Аврен, България");
    expect(buildGeocodeQuery("Аврен", "   ")).toBe("Аврен, България");
  });
});

// ── Photon fallback (§1.5) ───────────────────────────────────────────────────
//
// `geocode` used to return null whenever Nominatim was down, and every unseeded
// name in that window was stored with no pin — or, under a named settlement,
// fell to its centroid. Photon serves the same OSM data from another operator,
// so a transient Nominatim failure now asks it once.

const NOMINATIM = "https://nominatim.openstreetmap.org";
const PHOTON = "https://photon.komoot.io";
const JSON_HEADERS = { headers: { "Content-Type": "application/json" } };
const QUERY = "Дубровник, Варна, България";

function photonFeature(lat: number, lng: number, props: Record<string, unknown> = {}) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lng, lat] },
    properties: { countrycode: "BG", osm_key: "highway", osm_value: "residential", ...props },
  };
}

async function cacheRows() {
  return (await env.DB.prepare("SELECT query, lat, lng, provider FROM geocode_cache").all()).results as
    Array<{ query: string; lat: number | null; lng: number | null; provider: string | null }>;
}

describe("geocode — Photon fallback", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  beforeEach(async () => {
    resetGeocodeThrottles();
    await env.DB.prepare("DELETE FROM geocode_cache").run();
  });
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  for (const [label, status] of [["a 503", 503], ["a 429", 429]] as const) {
    it(`asks Photon when Nominatim answers ${label}, and records Photon as the provider`, async () => {
      fetchMock.get(NOMINATIM).intercept({ path: (p) => p.startsWith("/search") }).reply(status, "down");
      fetchMock.get(PHOTON).intercept({ path: (p) => p.startsWith("/api/") })
        .reply(200, JSON.stringify({ features: [photonFeature(43.2141, 27.9147)] }), JSON_HEADERS);

      expect(await geocode(env, QUERY)).toEqual({ lat: 43.2141, lng: 27.9147, provider: "photon" });

      // Cached WITH its provider: a later read must still say where it came
      // from, or the fallback leaves no trace after its first use.
      expect(await cacheRows()).toEqual([{ query: QUERY, lat: 43.2141, lng: 27.9147, provider: "photon" }]);
      resetGeocodeThrottles();
      expect(await geocode(env, QUERY)).toEqual({ lat: 43.2141, lng: 27.9147, provider: "photon" });
      expect(nominatimSlotsGranted() + photonSlotsGranted()).toBe(0); // served from D1
    });
  }

  it("asks Photon when the Nominatim request itself fails (network error / timeout)", async () => {
    fetchMock.get(NOMINATIM).intercept({ path: (p) => p.startsWith("/search") })
      .replyWithError(new Error("connection reset"));
    fetchMock.get(PHOTON).intercept({ path: (p) => p.startsWith("/api/") })
      .reply(200, JSON.stringify({ features: [photonFeature(43.2, 27.9)] }), JSON_HEADERS);

    expect(await geocode(env, QUERY)).toEqual({ lat: 43.2, lng: 27.9, provider: "photon" });
  });

  it("identifies itself, bounds to the province and asks for Bulgaria only", async () => {
    fetchMock.get(NOMINATIM).intercept({ path: (p) => p.startsWith("/search") }).reply(502, "bad gateway");
    let asked = "";
    fetchMock.get(PHOTON).intercept({
      path: (p) => { asked = decodeURIComponent(p); return p.startsWith("/api/"); },
      headers: { "User-Agent": "CityShieldAPI/1.0" },
    }).reply(200, JSON.stringify({ features: [] }), JSON_HEADERS);

    await geocode(env, QUERY);
    expect(asked).toContain("bbox=27.05,42.78,28.15,43.60");
    expect(asked).toContain("countrycode=BG");
    // The country is the bbox's job; the settlement stays as context.
    expect(asked).toContain("q=Дубровник, Варна&");
  });

  it("skips foreign answers and objects, as it does Nominatim's", async () => {
    fetchMock.get(NOMINATIM).intercept({ path: (p) => p.startsWith("/search") }).reply(503, "down");
    fetchMock.get(PHOTON).intercept({ path: (p) => p.startsWith("/api/") })
      .reply(200, JSON.stringify({
        features: [
          photonFeature(44.17, 28.63, { countrycode: "RO" }),
          // 8360abda's shape: a bus shelter carrying the area's name.
          photonFeature(43.2394, 27.9881, { osm_key: "highway", osm_value: "bus_stop" }),
          photonFeature(43.1786, 27.4438, { osm_key: "place", osm_value: "locality" }),
        ],
      }), JSON_HEADERS);

    expect(await geocode(env, QUERY)).toEqual({ lat: 43.1786, lng: 27.4438, provider: "photon" });
  });

  it("does not ask Photon when Nominatim answered 'no such place' — a miss is an answer", async () => {
    fetchMock.get(NOMINATIM).intercept({ path: (p) => p.startsWith("/search") })
      .reply(200, "[]", JSON_HEADERS);

    expect(await geocode(env, QUERY)).toBeNull();
    expect(photonSlotsGranted()).toBe(0);
    expect(await cacheRows()).toEqual([{ query: QUERY, lat: null, lng: null, provider: "nominatim" }]);
  });

  it("does not ask Photon about a request Nominatim refused for what it was", async () => {
    fetchMock.get(NOMINATIM).intercept({ path: (p) => p.startsWith("/search") }).reply(400, "bad request");

    expect(await geocode(env, QUERY)).toBeNull();
    expect(photonSlotsGranted()).toBe(0);
    expect(await cacheRows()).toEqual([]);
  });

  it("caches nothing when Photon finds nothing either — Nominatim must get asked again", async () => {
    fetchMock.get(NOMINATIM).intercept({ path: (p) => p.startsWith("/search") }).reply(503, "down");
    fetchMock.get(PHOTON).intercept({ path: (p) => p.startsWith("/api/") })
      .reply(200, JSON.stringify({ features: [] }), JSON_HEADERS);

    expect(await geocode(env, QUERY)).toBeNull();
    expect(await cacheRows()).toEqual([]);
  });

  it("returns null and caches nothing when both providers are down", async () => {
    fetchMock.get(NOMINATIM).intercept({ path: (p) => p.startsWith("/search") }).reply(503, "down");
    fetchMock.get(PHOTON).intercept({ path: (p) => p.startsWith("/api/") }).reply(500, "also down");

    expect(await geocode(env, QUERY)).toBeNull();
    expect(await cacheRows()).toEqual([]);
  });

  it("reads a pre-0021 cache row (no provider) as Nominatim's", async () => {
    await env.DB.prepare(
      "INSERT INTO geocode_cache (query, lat, lng, resolved_at) VALUES (?, 43.1, 27.8, ?)",
    ).bind(QUERY, new Date().toISOString()).run();
    expect(await geocode(env, QUERY)).toEqual({ lat: 43.1, lng: 27.8, provider: "nominatim" });
  });
});
