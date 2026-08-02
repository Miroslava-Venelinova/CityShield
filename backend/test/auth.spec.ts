// Contract tests for /api/auth/* against local D1 — the §1.4 parity table.

import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  nominatimSlotsGranted, resetNominatimThrottle, reverseGeocode,
} from "../src/core/geocoding";
import { clearRefCaches } from "../src/db/queries";
import { api, jsonInit, registerAndLogin } from "./helpers";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

// The 1,100 ms Nominatim spacing is module-scope state, and the pool runs every
// spec file in ONE isolate (singleWorker), so whatever geocoded last leaves this
// file's lookups already waiting. That is a real delay: it pushed the 5-call
// throttle test past its timeout and starved reverseGeocode of its budget in
// the location test, both of which then failed depending only on what ran
// before them. Start every test from a cold throttle instead.
beforeEach(resetNominatimThrottle);

afterEach(() => fetchMock.assertNoPendingInterceptors());

describe("POST /api/auth/register", () => {
  it("registers with 200 and the exact text body", async () => {
    const res = await api("/api/auth/register",
      jsonInit("POST", { email: "new@example.com", password: "longenough" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("User successfully registered");
  });

  it("returns 409 on duplicate email (case-insensitive)", async () => {
    await api("/api/auth/register",
      jsonInit("POST", { email: "Dup@Example.com", password: "longenough" }));
    const res = await api("/api/auth/register",
      jsonInit("POST", { email: "dup@example.com", password: "longenough" }));
    expect(res.status).toBe(409);
    expect(await res.text()).toBe("An account with this email already exists");
  });

  it("rejects invalid email / short password with 400", async () => {
    expect((await api("/api/auth/register",
      jsonInit("POST", { email: "not-an-email", password: "longenough" }))).status).toBe(400);
    expect((await api("/api/auth/register",
      jsonInit("POST", { email: "ok@example.com", password: "short" }))).status).toBe(400);
    expect((await api("/api/auth/register",
      jsonInit("POST", { email: "ok@example.com" }))).status).toBe(400);
  });
});

describe("POST /api/auth/login", () => {
  it("returns a JWT for valid credentials", async () => {
    const { token } = await registerAndLogin();
    expect(token.split(".")).toHaveLength(3);
  });

  it("returns 401 with the exact text for bad credentials", async () => {
    const { email } = await registerAndLogin();
    const res = await api("/api/auth/login", jsonInit("POST", { email, password: "wrong-password" }));
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("Invalid email or password");
  });

  it("returns 401 for an unknown user", async () => {
    const res = await api("/api/auth/login",
      jsonInit("POST", { email: "ghost@example.com", password: "whatever1" }));
    expect(res.status).toBe(401);
  });

});

describe("rate limiting", () => {
  // Both shapes matter: the old (email, ip) composite key caught neither,
  // because each attempt varied one half of the key into a fresh bucket.

  it("throttles brute force against one account, even from many IPs", async () => {
    const email = `victim-${Date.now()}@example.com`;
    let last: Response | undefined;
    for (let i = 0; i < 11; i++) {
      // Fresh IP each attempt — only the email-keyed limiter can catch this.
      last = await api("/api/auth/login", jsonInit("POST", { email, password: "wrong" }));
    }
    expect(last!.status).toBe(429);
  });

  it("throttles password spraying from one IP across many accounts", async () => {
    const ip = "198.51.100.7";
    let last: Response | undefined;
    for (let i = 0; i < 21; i++) {
      // Fresh email each attempt — only the IP-keyed limiter can catch this.
      last = await api("/api/auth/login",
        jsonInit("POST", { email: `spray-${i}-${Date.now()}@example.com`, password: "wrong" }), ip);
    }
    expect(last!.status).toBe(429);
  });

  it("throttles signup floods per IP", async () => {
    const ip = "198.51.100.8";
    let last: Response | undefined;
    for (let i = 0; i < 6; i++) {
      last = await api("/api/auth/register",
        jsonInit("POST", { email: `flood-${i}-${Date.now()}@example.com`, password: "longenough" }), ip);
    }
    expect(last!.status).toBe(429);
  });

  it("throttles location writes per user, protecting the Nominatim budget", async () => {
    const { token } = await registerAndLogin();

    // Exactly 5 geocode calls are allowed through; the 6th must be rejected
    // before any outbound request. Interceptors are registered `.times(5)`, so
    // a 6th call would fail the test via an unmatched request.
    fetchMock.get("https://nominatim.openstreetmap.org")
      .intercept({ path: (p) => p.startsWith("/reverse") })
      .reply(500, "boom")
      .times(5);

    let last: Response | undefined;
    for (let i = 0; i < 6; i++) {
      // Drop the Nominatim spacing before each call. RL_GEOCODE_USER counts 5
      // per *fixed* 60 s window, and left in place the 1,100 ms throttle
      // stretches these six calls over ~5.5 s — long enough that a run starting
      // near a window boundary rolls over mid-test, hands the 6th call a fresh
      // allowance and gets a 200 instead of the 429. This test is about the
      // limiter, not the throttle, so the delay is only a source of flakes.
      resetNominatimThrottle();
      last = await api("/api/auth/location",
        jsonInit("PUT", { latitude: 43.2, longitude: 27.9 }, token));
    }
    expect(last!.status).toBe(429);
  });
});

describe("GET /api/auth/me", () => {
  it("401s without or with a garbage token", async () => {
    expect((await api("/api/auth/me")).status).toBe(401);
    expect((await api("/api/auth/me",
      { headers: { Authorization: "Bearer garbage" } })).status).toBe(401);
  });

  it("returns the camelCase profile DTO; hasLocation false before location is set", async () => {
    const { token, email } = await registerAndLogin();
    const res = await api("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const dto = await res.json() as Record<string, unknown>;
    expect(dto).toEqual({
      // The app registers this with the push provider as its external_id.
      userId: expect.any(String),
      email,
      latitude: null,
      longitude: null,
      hasLocation: false,
      regionName: null,
      streetName: null,
      emailVerified: false,
      createdOnUTC: dto.createdOnUTC,
      updatedOnUTC: dto.updatedOnUTC,
    });
    expect(String(dto.createdOnUTC)).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });
});

describe("PUT /api/auth/location", () => {
  beforeEach(async () => {
    clearRefCaches(); // module-scope cache survives D1 isolation resets
    await env.DB.prepare(
      `INSERT OR IGNORE INTO regions (region_name) VALUES
       ('Варна'), ('Аспарухово'), ('Владислав Варненчик')`).run();
    // Streets belong to a settlement, never to a district (migration 0015):
    // Аспарухово is a quarter of Варна, and its streets are Варна's.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO streets (street_name, region_id)
       SELECT name, (SELECT id FROM regions WHERE region_name = 'Варна')
         FROM (SELECT 'Народни будители' AS name UNION ALL SELECT 'Александър Дякович')`).run();
  });

  it("reverse-geocodes, fuzzy-matches and persists — then /me reflects it", async () => {
    const { token } = await registerAndLogin();

    fetchMock.get("https://nominatim.openstreetmap.org")
      .intercept({ path: (p) => p.startsWith("/reverse") })
      .reply(200, JSON.stringify({
        // `city` is what scopes the street lookup: a suburb names a district,
        // and a street belongs to the settlement behind it, not to the district.
        address: { suburb: "кв. Аспарухово", city: "Варна", road: "ул. Народни будители" },
      }), { headers: { "Content-Type": "application/json" } });

    const res = await api("/api/auth/location",
      jsonInit("PUT", { latitude: 43.1864, longitude: 27.9151 }, token));
    expect(res.status).toBe(204);

    const me = await api("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } });
    const dto = await me.json() as Record<string, unknown>;
    expect(dto.latitude).toBeCloseTo(43.1864);
    expect(dto.longitude).toBeCloseTo(27.9151);
    expect(dto.hasLocation).toBe(true);
    expect(dto.regionName).toBe("Аспарухово");
    expect(dto.streetName).toBe("Народни будители");
  });

  // The city centre is the case this exists for: Nominatim labels it with a
  // city_district we do not seed, and the region we do have sits one level
  // further out. Matching only the most specific name left it unmatched.
  it("falls back through the address levels when the finest one is unknown", async () => {
    const { token } = await registerAndLogin();
    await env.DB.prepare("INSERT OR IGNORE INTO regions (region_name) VALUES ('Варна')").run();
    clearRefCaches();

    fetchMock.get("https://nominatim.openstreetmap.org")
      .intercept({ path: (p) => p.startsWith("/reverse") })
      .reply(200, JSON.stringify({
        address: { city_district: "Одесос", city: "Варна", road: "бул. Сливница" },
      }), { headers: { "Content-Type": "application/json" } });

    const res = await api("/api/auth/location",
      jsonInit("PUT", { latitude: 43.2065, longitude: 27.9147 }, token));
    expect(res.status).toBe(204);

    const dto = await (await api("/api/auth/me",
      { headers: { Authorization: `Bearer ${token}` } })).json() as Record<string, unknown>;
    expect(dto.hasLocation).toBe(true);
    expect(dto.regionName).toBe("Варна");
  });

  // hasLocation tracks the stored coordinates, not the region lookup: polygon
  // targeting runs off lat/lng, so an unnamed district is still a located user.
  it("still 204s (lat/lng saved, no region) when Nominatim fails", async () => {
    const { token } = await registerAndLogin();

    fetchMock.get("https://nominatim.openstreetmap.org")
      .intercept({ path: (p) => p.startsWith("/reverse") })
      .reply(500, "boom");

    const res = await api("/api/auth/location",
      jsonInit("PUT", { latitude: 43.2, longitude: 27.9 }, token));
    expect(res.status).toBe(204);

    const me = await api("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } });
    const dto = await me.json() as Record<string, unknown>;
    expect(dto.latitude).toBeCloseTo(43.2);
    expect(dto.hasLocation).toBe(true);
    expect(dto.regionName).toBeNull();
  });

  // region_id/street_id ARE the targeting (getUserIdsInRange), so writing the
  // empty result of a lookup that never ran is how a working account goes
  // silent. A failed lookup knows nothing about the point — it must not speak.
  it("keeps the existing region and street when Nominatim fails", async () => {
    const { token } = await registerAndLogin();

    fetchMock.get("https://nominatim.openstreetmap.org")
      .intercept({ path: (p) => p.startsWith("/reverse") })
      .reply(200, JSON.stringify({
        // `city` is what scopes the street lookup: a suburb names a district,
        // and a street belongs to the settlement behind it, not to the district.
        address: { suburb: "кв. Аспарухово", city: "Варна", road: "ул. Народни будители" },
      }), { headers: { "Content-Type": "application/json" } });

    await api("/api/auth/location", jsonInit("PUT", { latitude: 43.1864, longitude: 27.9151 }, token));

    // Same user moves a few metres; this time Nominatim is down.
    resetNominatimThrottle();
    fetchMock.get("https://nominatim.openstreetmap.org")
      .intercept({ path: (p) => p.startsWith("/reverse") })
      .reply(429, "rate limited");

    const res = await api("/api/auth/location",
      jsonInit("PUT", { latitude: 43.1865, longitude: 27.9152 }, token));
    expect(res.status).toBe(204);

    const dto = await (await api("/api/auth/me",
      { headers: { Authorization: `Bearer ${token}` } })).json() as Record<string, unknown>;
    expect(dto.latitude).toBeCloseTo(43.1865); // the new point IS saved
    expect(dto.regionName).toBe("Аспарухово"); // the assignment survives
    expect(dto.streetName).toBe("Народни будители");
  });

  // The other half: a lookup that COMPLETED and matched nothing is a real
  // answer about a real point, and must still be able to clear the columns.
  it("clears the region when a completed lookup matches nothing", async () => {
    const { token } = await registerAndLogin();

    fetchMock.get("https://nominatim.openstreetmap.org")
      .intercept({ path: (p) => p.startsWith("/reverse") })
      .reply(200, JSON.stringify({
        // `city` is what scopes the street lookup: a suburb names a district,
        // and a street belongs to the settlement behind it, not to the district.
        address: { suburb: "кв. Аспарухово", city: "Варна", road: "ул. Народни будители" },
      }), { headers: { "Content-Type": "application/json" } });

    await api("/api/auth/location", jsonInit("PUT", { latitude: 43.1864, longitude: 27.9151 }, token));

    resetNominatimThrottle();
    fetchMock.get("https://nominatim.openstreetmap.org")
      .intercept({ path: (p) => p.startsWith("/reverse") })
      .reply(200, JSON.stringify({ address: { village: "Някъде другаде" } }),
        { headers: { "Content-Type": "application/json" } });

    await api("/api/auth/location", jsonInit("PUT", { latitude: 42.9, longitude: 27.7 }, token));

    const dto = await (await api("/api/auth/me",
      { headers: { Authorization: `Bearer ${token}` } })).json() as Record<string, unknown>;
    expect(dto.regionName).toBeNull();
    expect(dto.streetName).toBeNull();
  });

  // Migration 0015. Before it, `streets` held city streets only, so a village
  // resident's road name could only ever match a Varna street — and that stale
  // id is worse than none: getUserIdsByStreets selects `street_id IN (…) OR
  // street_id IS NULL`, so once their village's streets are seeded, a user
  // holding a city street id is neither, and drops out of their own alerts.
  it("assigns a village user their own village's street, not the city's", async () => {
    const { token, email } = await registerAndLogin();
    await env.DB.prepare("INSERT OR IGNORE INTO regions (region_name) VALUES ('Аврен')").run();
    // The same street name in both settlements — the common case: 52% of the
    // names around the villages are also Varna street names.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO streets (street_name, region_id)
       SELECT 'Тича', id FROM regions WHERE region_name IN ('Варна', 'Аврен')`).run();
    clearRefCaches();

    fetchMock.get("https://nominatim.openstreetmap.org")
      .intercept({ path: (p) => p.startsWith("/reverse") })
      .reply(200, JSON.stringify({ address: { village: "Аврен", road: "ул. Тича" } }),
        { headers: { "Content-Type": "application/json" } });

    const res = await api("/api/auth/location",
      jsonInit("PUT", { latitude: 43.1138, longitude: 27.6658 }, token));
    expect(res.status).toBe(204);

    // /me reports only the street NAME, which is identical in both settlements
    // — the settlement behind it is the whole question, so read the row itself.
    const assigned = await env.DB.prepare(
      `SELECT s.street_name, r.region_name FROM users u
         JOIN streets s ON s.id = u.street_id
         JOIN regions r ON r.id = s.region_id
        WHERE u.email = ?`).bind(email).first<{ street_name: string; region_name: string }>();
    expect(assigned).not.toBeNull();
    expect(assigned!.street_name).toBe("Тича");
    expect(assigned!.region_name).toBe("Аврен");
  });

  it("rejects out-of-range coordinates with 400", async () => {
    const { token } = await registerAndLogin();
    const res = await api("/api/auth/location",
      jsonInit("PUT", { latitude: 91, longitude: 27.9 }, token));
    expect(res.status).toBe(400);
  });

  it("401s without a token", async () => {
    expect((await api("/api/auth/location",
      jsonInit("PUT", { latitude: 43.2, longitude: 27.9 }))).status).toBe(401);
  });
});

// The ≥1,100 ms spacing is how we hold up the ≤1 rps side of OSMF's usage
// policy, which the privacy policy commits us to. It used to wrap forward
// geocoding only, leaving reverse — the direction an actual user triggers, and
// the one with no cache in front of it — going out unspaced. RL_GEOCODE_USER
// does not substitute: it bounds one user's calls per minute, not how many
// users call at once.
describe("Nominatim rate policy", () => {
  // Asserted on the slot counter rather than on elapsed time: the throttle's
  // effect is a wall-clock delay, and `Date.now()` inside workerd advances at
  // I/O boundaries instead of continuously, so a stopwatch assertion here passes
  // whether or not the throttle is wired up (it did, before this was rewritten).
  it("takes a throttle slot for a reverse lookup", async () => {
    resetNominatimThrottle();
    fetchMock.get("https://nominatim.openstreetmap.org")
      .intercept({ path: (p) => p.startsWith("/reverse") })
      .reply(200, JSON.stringify({ address: { city: "Варна" } }),
        { headers: { "Content-Type": "application/json" } });

    const address = await reverseGeocode(env, 43.20, 27.91, Date.now() + 60_000);

    expect(nominatimSlotsGranted()).toBe(1);
    // Throttled, not dropped — the lookup still resolves.
    expect(address.regionNames).toContain("Варна");
  });
});
