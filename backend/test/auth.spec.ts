// Contract tests for /api/auth/* against local D1 — the §1.4 parity table.

import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearRefCaches } from "../src/db/queries";
import { api, jsonInit, registerAndLogin } from "./helpers";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

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
      // Fresh IP each call, so this can only be the per-user limiter firing.
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
    await env.DB.prepare("INSERT OR IGNORE INTO regions (region_name) VALUES ('Аспарухово'), ('Владислав Варненчик')").run();
    await env.DB.prepare("INSERT OR IGNORE INTO streets (street_name) VALUES ('Народни будители'), ('Александър Дякович')").run();
  });

  it("reverse-geocodes, fuzzy-matches and persists — then /me reflects it", async () => {
    const { token } = await registerAndLogin();

    fetchMock.get("https://nominatim.openstreetmap.org")
      .intercept({ path: (p) => p.startsWith("/reverse") })
      .reply(200, JSON.stringify({
        address: { suburb: "кв. Аспарухово", road: "ул. Народни будители" },
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
