// Contract + targeting tests for /api/alerts/* — the decision-tree guards
// from the xUnit suite (city_wide, bus lines, preferences, polygon vs region).

import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearAlertFeedCache } from "../src/api/alerts";
import { clearFcmTokenCache } from "../src/core/fcm";
import { clearRefCaches } from "../src/db/queries";
import { api, jsonInit } from "./helpers";

const INGEST_KEY = "test-ingest-key";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

beforeEach(async () => {
  clearRefCaches(); // module caches outlive per-test D1 resets
  await clearAlertFeedCache(); // as does the edge-cached /recent feed
  await env.DB.prepare(
    "INSERT INTO regions (region_name) VALUES ('Аспарухово'), ('Левски')").run();
  await env.DB.prepare(
    "INSERT INTO streets (street_name) VALUES ('Дубровник'), ('Розова долина')").run();
});

interface TestUser {
  userId: string;
  region?: string;
  street?: string;
  lat?: number;
  lng?: number;
  receivesAll?: boolean;
  busLines?: string[];
  fcmToken?: string;
}

let seq = 0;

async function createUser(opts: Omit<TestUser, "userId"> = {}): Promise<string> {
  const userId = crypto.randomUUID();
  const regionId = opts.region
    ? (await env.DB.prepare("SELECT id FROM regions WHERE region_name = ?")
        .bind(opts.region).first<{ id: number }>())!.id
    : null;
  const streetId = opts.street
    ? (await env.DB.prepare("SELECT id FROM streets WHERE street_name = ?")
        .bind(opts.street).first<{ id: number }>())!.id
    : null;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users (user_id, email, password_hash, latitude, longitude, region_id, street_id,
                        receives_all_alerts, subscribed_bus_lines, created_on_utc, updated_on_utc)
     VALUES (?, ?, 'x', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(userId, `alerts-user-${++seq}@example.com`, opts.lat ?? null, opts.lng ?? null,
    regionId, streetId, opts.receivesAll ? 1 : 0,
    JSON.stringify(opts.busLines ?? []), now, now).run();
  if (opts.fcmToken) {
    await env.DB.prepare(
      `INSERT INTO device_tokens (user_id, token, created_at, last_seen_at) VALUES (?, ?, ?, ?)`,
    ).bind(userId, opts.fcmToken, now, now).run();
  }
  return userId;
}

function submit(body: Record<string, unknown>, apiKey: string | null = INGEST_KEY) {
  return api("/api/alerts/submit-data", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "X-Api-Key": apiKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

const basePayload = (overrides: Record<string, unknown> = {}) => ({
  category: "vik",
  original_message: { title: "Авария", content: "Спиране на водата" },
  processed_data: { locations: [], start_time: null, end_time: null, ...(overrides.processed_data as object ?? {}) },
  ...overrides,
});

interface SubmitResponse { alert_id: string; notified_count: number; user_ids: string[]; }

describe("POST /api/alerts/submit-data — gate & validation", () => {
  it("401s without or with a wrong X-Api-Key", async () => {
    expect((await submit(basePayload(), null)).status).toBe(401);
    expect((await submit(basePayload(), "wrong")).status).toBe(401);
  });

  it("400s on unknown category with the exact error shape", async () => {
    const res = await submit(basePayload({ category: "foo" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown category: foo" });
  });

  it("400s when locations is not an array", async () => {
    const res = await submit({
      category: "vik",
      original_message: { title: "t" },
      processed_data: { locations: null },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "processed_data.locations must be an array." });
  });
});

describe("targeting decision tree", () => {
  it("city_wide=false with no locations stores but never broadcasts (LLM-misparse guard)", async () => {
    await createUser(); // would receive a broadcast if the guard failed
    const res = await submit(basePayload({
      processed_data: { locations: [], city_wide: false },
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as SubmitResponse;
    expect(body.notified_count).toBe(0);

    const stored = await env.DB.prepare("SELECT id FROM alerts WHERE id = ?").bind(body.alert_id).first();
    expect(stored).not.toBeNull();
  });

  it("city_wide=true (or absent) broadcasts to everyone", async () => {
    const a = await createUser();
    const b = await createUser();
    const res = await submit(basePayload({
      processed_data: { locations: [], city_wide: true },
    }));
    const body = await res.json() as SubmitResponse;
    expect(new Set(body.user_ids)).toEqual(new Set([a, b]));
  });

  it("region+street location targets only matching users; receives_all and disabled-preference users handled", async () => {
    const match = await createUser({ region: "Аспарухово", street: "Дубровник" });
    // No street set = "somewhere in Аспарухово" — still in scope for a street alert.
    const regionOnlyUser = await createUser({ region: "Аспарухово" });
    const sameRegionOtherStreet = await createUser({ region: "Аспарухово", street: "Розова долина" });
    const otherRegion = await createUser({ region: "Левски", street: "Дубровник" });
    const debugUser = await createUser({ receivesAll: true });
    const disabled = await createUser({ region: "Аспарухово", street: "Дубровник" });
    await env.DB.prepare(
      `INSERT INTO user_notification_preferences (user_id, category, is_enabled, updated_at)
       VALUES (?, 'vik', 0, ?)`).bind(disabled, new Date().toISOString()).run();

    const res = await submit(basePayload({
      processed_data: {
        locations: [{ location_name: "кв. Аспарухово", sublocations: ["ул. Дубровник"], is_polygon: false }],
      },
    }));
    const body = await res.json() as SubmitResponse;
    expect(new Set(body.user_ids)).toEqual(new Set([match, regionOnlyUser, debugUser]));
    expect(body.user_ids).not.toContain(sameRegionOtherStreet);
    expect(body.user_ids).not.toContain(otherRegion);
    expect(body.user_ids).not.toContain(disabled);
  });

  it("street-only location (unmatched region) still targets that street's users", async () => {
    const onStreet = await createUser({ region: "Аспарухово", street: "Дубровник" });
    const sameStreetOtherRegion = await createUser({ region: "Левски", street: "Дубровник" });
    const otherStreet = await createUser({ region: "Аспарухово", street: "Розова долина" });
    const noLocation = await createUser();

    const res = await submit(basePayload({
      processed_data: {
        // location_name empty — the scraper only recognized a street.
        locations: [{ location_name: "", sublocations: ["ул. Дубровник"], is_polygon: false }],
      },
    }));
    const body = await res.json() as SubmitResponse;
    // Region-agnostic: both users on the street, regardless of their region.
    expect(new Set(body.user_ids)).toEqual(new Set([onStreet, sameStreetOtherRegion]));
    expect(body.user_ids).not.toContain(otherStreet);
    expect(body.user_ids).not.toContain(noLocation);
  });

  it("streets that match nothing in our table fall back to region-wide targeting", async () => {
    const onOtherStreet = await createUser({ region: "Аспарухово", street: "Розова долина" });
    const regionOnly = await createUser({ region: "Аспарухово" });
    const otherRegion = await createUser({ region: "Левски" });

    const res = await submit(basePayload({
      processed_data: {
        locations: [{ location_name: "Аспарухово", sublocations: ["ул. Няма такава"], is_polygon: false }],
      },
    }));
    const body = await res.json() as SubmitResponse;
    // The street detail is unusable, so the region alone decides.
    expect(new Set(body.user_ids)).toEqual(new Set([onOtherStreet, regionOnly]));
    expect(body.user_ids).not.toContain(otherRegion);
  });

  it("unmatched region and unmatched street notifies nobody", async () => {
    await createUser({ region: "Аспарухово", street: "Дубровник" });
    await createUser();

    const res = await submit(basePayload({
      processed_data: {
        locations: [{ location_name: "Несъществуващ квартал", sublocations: ["ул. Няма такава"], is_polygon: false }],
      },
    }));
    const body = await res.json() as SubmitResponse;
    expect(body.user_ids).toEqual([]);
    expect(body.notified_count).toBe(0);
  });

  it("region-only location targets the whole region", async () => {
    const a = await createUser({ region: "Аспарухово", street: "Дубровник" });
    const b = await createUser({ region: "Аспарухово" });
    const c = await createUser({ region: "Левски" });

    const res = await submit(basePayload({
      processed_data: {
        locations: [{ location_name: "Аспарухово", sublocations: [], is_polygon: false }],
      },
    }));
    const body = await res.json() as SubmitResponse;
    expect(new Set(body.user_ids)).toEqual(new Set([a, b]));
    expect(body.user_ids).not.toContain(c);
  });

  it("polygon location targets users by bbox + ray-cast on lat/lng", async () => {
    const inside = await createUser({ lat: 43.205, lng: 27.905 });
    const outside = await createUser({ lat: 43.30, lng: 27.99 });
    const noLocation = await createUser();

    const res = await submit(basePayload({
      processed_data: {
        locations: [{
          location_name: "кв. Гръцка махала",
          sublocations: [],
          is_polygon: true,
          polygon_geojson: {
            type: "FeatureCollection",
            features: [{
              type: "Feature",
              properties: { streets: [] },
              geometry: {
                type: "Polygon",
                coordinates: [[[27.90, 43.20], [27.91, 43.20], [27.91, 43.21], [27.90, 43.21], [27.90, 43.20]]],
              },
            }],
          },
        }],
      },
    }));
    const body = await res.json() as SubmitResponse;
    expect(body.user_ids).toEqual([inside]);
    expect(body.user_ids).not.toContain(outside);
    expect(body.user_ids).not.toContain(noLocation);
  });

  it("bus-line alerts narrow the broadcast to subscribed-or-unfiltered users", async () => {
    const subscribedAffected = await createUser({ busLines: ["18"] });
    const subscribedOther = await createUser({ busLines: ["31A"] });
    const noFilter = await createUser();

    const res = await submit(basePayload({
      category: "vt",
      processed_data: { locations: [], city_wide: true, bus_lines: ["18", "0"] },
    }));
    const body = await res.json() as SubmitResponse;
    expect(new Set(body.user_ids)).toEqual(new Set([subscribedAffected, noFilter]));
    expect(body.user_ids).not.toContain(subscribedOther);
  });
});

describe("GET /api/alerts/recent", () => {
  async function authToken(): Promise<string> {
    await api("/api/auth/register",
      jsonInit("POST", { email: `recent-${++seq}@example.com`, password: "longenough" }));
    const login = await api("/api/auth/login",
      jsonInit("POST", { email: `recent-${seq}@example.com`, password: "longenough" }));
    return ((await login.json()) as { token: string }).token;
  }

  it("requires auth", async () => {
    expect((await api("/api/alerts/recent")).status).toBe(401);
  });

  it("returns the snake_case DTO with normalized polygon geometry + centroid", async () => {
    const sub = await submit(basePayload({
      processed_data: {
        start_time: "09:00",
        end_time: "17:00",
        locations: [{
          location_name: "кв. Гръцка махала",
          sublocations: ["ул. Дубровник"],
          is_polygon: true,
          polygon_geojson: {
            type: "FeatureCollection",
            features: [{
              type: "Feature",
              properties: { streets: ["Дубровник"] },
              geometry: {
                type: "Polygon",
                coordinates: [[[27.90, 43.20], [27.92, 43.20], [27.92, 43.22], [27.90, 43.22], [27.90, 43.20]]],
              },
            }],
          },
        }],
      },
    }));
    expect(sub.status).toBe(200);

    const res = await api("/api/alerts/recent", { headers: { Authorization: `Bearer ${await authToken()}` } });
    expect(res.status).toBe(200);
    const alerts = await res.json() as Array<Record<string, any>>;
    expect(alerts).toHaveLength(1);
    const a = alerts[0]!;
    expect(a.original_message).toEqual({ title: "Авария", content: "Спиране на водата" });
    expect(a.source).toBe("vik");
    expect(a.severity).toBe("warning");
    expect(a.processed_data.start_time).toBe("09:00");
    expect(a.processed_data.end_time).toBe("17:00");
    expect(String(a.created_at)).toMatch(/Z$/);

    const loc = a.processed_data.locations[0];
    expect(loc.is_polygon).toBe(true);
    // FeatureCollection was normalized to the bare geometry.
    expect(loc.polygon_geojson.type).toBe("Polygon");
    expect(loc.polygon_geojson.coordinates[0]).toHaveLength(5);
    expect(loc.lat).toBeCloseTo(43.208, 2); // vertex-average centroid
    expect(loc.lng).toBeCloseTo(27.908, 2);
  });

  it("applies the 48 h window and tolerates corrupt locations JSON", async () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
    await env.DB.prepare(
      `INSERT INTO alerts (id, category, title, content, severity, locations_json, created_on_utc) VALUES
       ('old-alert', 'vik', 'old', '', 'warning', '[]', ?),
       ('corrupt-alert', 'vik', 'corrupt', '', 'warning', 'not-json{', ?)`,
    ).bind(old, now).run();

    const res = await api("/api/alerts/recent", { headers: { Authorization: `Bearer ${await authToken()}` } });
    const alerts = await res.json() as Array<Record<string, any>>;
    expect(alerts.map((a) => a.id)).toEqual(["corrupt-alert"]);
    expect(alerts[0]!.processed_data.locations).toEqual([]);
  });
});

describe("geocoding enrichment (forward geocode + D1 cache)", () => {
  it("resolves a street-level pin via Nominatim and caches the result", async () => {
    fetchMock.get("https://nominatim.openstreetmap.org")
      .intercept({ path: (p) => p.startsWith("/search") })
      .reply(200, JSON.stringify([{ lat: "43.2141", lon: "27.9147" }]),
        { headers: { "Content-Type": "application/json" } });

    const sub = await submit(basePayload({
      processed_data: {
        locations: [{ location_name: "Аспарухово", sublocations: ["ул. Дубровник"], is_polygon: false }],
      },
    }));
    const { alert_id } = await sub.json() as SubmitResponse;

    const row = await env.DB.prepare("SELECT locations_json FROM alerts WHERE id = ?")
      .bind(alert_id).first<{ locations_json: string }>();
    const [loc] = JSON.parse(row!.locations_json);
    expect(loc.lat).toBeCloseTo(43.2141);
    expect(loc.lng).toBeCloseTo(27.9147);

    // Canonical street name (fuzzy-matched) was used, Varna-anchored, and cached in D1.
    const cache = await env.DB.prepare("SELECT * FROM geocode_cache").all();
    expect(cache.results).toHaveLength(1);
    expect((cache.results[0] as any).query).toBe("Дубровник, Варна, България");
    fetchMock.assertNoPendingInterceptors();

    // Second submit with the same street hits the D1 cache — no new Nominatim
    // interceptor registered, so a real call would throw and drop the pin.
    const sub2 = await submit(basePayload({
      processed_data: {
        locations: [{ location_name: "Аспарухово", sublocations: ["Дубровник"], is_polygon: false }],
      },
    }));
    const { alert_id: id2 } = await sub2.json() as SubmitResponse;
    const row2 = await env.DB.prepare("SELECT locations_json FROM alerts WHERE id = ?")
      .bind(id2).first<{ locations_json: string }>();
    expect(JSON.parse(row2!.locations_json)[0].lat).toBeCloseTo(43.2141);
  });
});

describe("FCM send + stale-token cleanup", () => {
  it("sends via HTTP v1 and deletes definitively-dead tokens", async () => {
    clearFcmTokenCache();

    // Generate a throwaway RSA key so the OAuth JWT can really be signed.
    const keyPair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true, ["sign", "verify"]) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey) as ArrayBuffer);
    let bin = "";
    for (const b of pkcs8) bin += String.fromCharCode(b);
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(bin)}\n-----END PRIVATE KEY-----\n`;

    (env as { FCM_SERVICE_ACCOUNT?: string }).FCM_SERVICE_ACCOUNT = JSON.stringify({
      project_id: "test-proj",
      client_email: "svc@test-proj.iam.gserviceaccount.com",
      private_key: pem,
      token_uri: "https://oauth2.googleapis.com/token",
    });

    try {
      fetchMock.get("https://oauth2.googleapis.com")
        .intercept({ path: "/token", method: "POST" })
        .reply(200, JSON.stringify({ access_token: "test-access-token", expires_in: 3600 }),
          { headers: { "Content-Type": "application/json" } });

      // Sends run concurrently — match interceptors on the token in the body
      // so the 200/404 replies can't race onto the wrong request.
      const fcm = fetchMock.get("https://fcm.googleapis.com");
      fcm.intercept({
        path: "/v1/projects/test-proj/messages:send", method: "POST",
        body: (b) => String(b).includes("token-alive"),
      }).reply(200, JSON.stringify({ name: "projects/test-proj/messages/1" }));
      fcm.intercept({
        path: "/v1/projects/test-proj/messages:send", method: "POST",
        body: (b) => String(b).includes("token-dead"),
      }).reply(404, JSON.stringify({
        error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] },
      }));

      await createUser({ fcmToken: "token-alive" });
      await createUser({ fcmToken: "token-dead" });

      const res = await submit(basePayload({
        processed_data: { locations: [], city_wide: true },
      }));
      expect((await res.json() as SubmitResponse).notified_count).toBe(2);
      fetchMock.assertNoPendingInterceptors();

      const remaining = await env.DB.prepare("SELECT token FROM device_tokens").all();
      expect(remaining.results.map((r) => (r as any).token)).toEqual(["token-alive"]);
    } finally {
      delete (env as { FCM_SERVICE_ACCOUNT?: string }).FCM_SERVICE_ACCOUNT;
      clearFcmTokenCache();
    }
  });
});
