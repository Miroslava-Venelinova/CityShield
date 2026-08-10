// Contract + targeting tests for /api/alerts/* — the decision-tree guards
// from the xUnit suite (city_wide, bus lines, preferences, polygon vs region).

import { env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearAlertFeedCache } from "../src/api/alerts";
import { resetNominatimThrottle } from "../src/core/geocoding";
import { sendPushToUsers } from "../src/core/onesignal";
import { clearRefCaches } from "../src/db/queries";
import { api, jsonInit, registerAndLogin } from "./helpers";

const INGEST_KEY = "test-ingest-key";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

beforeEach(async () => {
  clearRefCaches(); // module caches outlive per-test D1 resets
  await clearAlertFeedCache(); // as does the edge-cached /recent feed
  // The geocoding tests below put real calls through the 1,100 ms Nominatim
  // spacing, which is module-scope and shared with every other spec file in
  // this isolate. Left hot, it delays whatever runs next (see auth.spec.ts).
  resetNominatimThrottle();
  // Варна carries its centroid because it is both the city-wide fan-out's
  // origin and, since migration 0015, the settlement every street below belongs
  // to — a location that names no settlement of its own scopes its streets here.
  await env.DB.prepare(
    `INSERT INTO regions (region_name, lat, lng) VALUES
       ('Варна', 43.2073873, 27.9166653), ('Аспарухово', NULL, NULL), ('Левски', NULL, NULL)`).run();
  await env.DB.prepare(
    `INSERT INTO streets (street_name, region_id)
     SELECT name, (SELECT id FROM regions WHERE region_name = 'Варна')
       FROM (SELECT 'Дубровник' AS name UNION ALL SELECT 'Розова долина')`).run();
});

interface TestUser {
  userId: string;
  region?: string;
  street?: string;
  /** The street's settlement — only needed when the name exists in more
   *  than one (migration 0015). Defaults to Варна, where every street the
   *  outer beforeEach seeds lives. */
  streetIn?: string;
  lat?: number;
  lng?: number;
  receivesAll?: boolean;
  busLines?: string[];
}

let seq = 0;

async function createUser(opts: Omit<TestUser, "userId"> = {}): Promise<string> {
  const userId = crypto.randomUUID();
  const regionId = opts.region
    ? (await env.DB.prepare("SELECT id FROM regions WHERE region_name = ?")
        .bind(opts.region).first<{ id: number }>())!.id
    : null;
  const streetId = opts.street
    ? (await env.DB.prepare(
        `SELECT s.id FROM streets s JOIN regions r ON r.id = s.region_id
         WHERE s.street_name = ? AND r.region_name = ?`)
        .bind(opts.street, opts.streetIn ?? "Варна").first<{ id: number }>())!.id
    : null;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users (user_id, email, password_hash, latitude, longitude, region_id, street_id,
                        receives_all_alerts, subscribed_bus_lines, created_on_utc, updated_on_utc)
     VALUES (?, ?, 'x', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(userId, `alerts-user-${++seq}@example.com`, opts.lat ?? null, opts.lng ?? null,
    regionId, streetId, opts.receivesAll ? 1 : 0,
    JSON.stringify(opts.busLines ?? []), now, now).run();
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

  it("city_wide=true (or absent) broadcasts to everyone we cannot place", async () => {
    const a = await createUser();
    const b = await createUser();
    const res = await submit(basePayload({
      processed_data: { locations: [], city_wide: true },
    }));
    const body = await res.json() as SubmitResponse;
    expect(new Set(body.user_ids)).toEqual(new Set([a, b]));
  });

  // "City-wide" used to mean getAllUserIds, which was correct only while the
  // product was one city. The regions seed now spans 69 km of province, so a
  // heating alert for the city network was reaching villages not on it.
  describe("city_wide is bounded to the city and its own municipality", () => {
    beforeEach(async () => {
      // The two settlements the radius has to separate; Варна (the origin) is
      // seeded with its centroid by the outer beforeEach.
      await env.DB.prepare(
        `INSERT INTO regions (region_name, lat, lng) VALUES
           ('Тополи', 43.2164126, 27.8212023),
           ('Долни чифлик', 42.9925676, 27.7187564)`).run();
      clearRefCaches(); // seeded after the outer beforeEach already cleared
    });

    const broadcast = async () => {
      const res = await submit(basePayload({
        processed_data: { locations: [], city_wide: true },
      }));
      return new Set(((await res.json()) as SubmitResponse).user_ids);
    };

    it("reaches the city and its municipality villages, not the next one over", async () => {
      const inCity = await createUser({ region: "Варна" });
      const inMunicipality = await createUser({ region: "Тополи" }); // 7.6 km
      const farVillage = await createUser({ region: "Долни чифлик" }); // 29.3 km

      const notified = await broadcast();
      expect(notified).toEqual(new Set([inCity, inMunicipality]));
      expect(notified.has(farVillage)).toBe(false);
    });

    // Their own point is the precise answer and outranks the region centroid —
    // the region is only the stand-in for someone who never set one.
    it("measures from the user's own coordinates when they have them", async () => {
      const nearby = await createUser({ lat: 43.2164126, lng: 27.8212023 });
      const distant = await createUser({ lat: 42.9925676, lng: 27.7187564 });

      const notified = await broadcast();
      expect(notified).toEqual(new Set([nearby]));
      expect(notified.has(distant)).toBe(false);
    });

    // Only users we can PROVE are out of range are dropped. No location at all
    // is not evidence of a village, and excluding them would silently cut off
    // people who receive these alerts today.
    it("keeps users with no position at all", async () => {
      const placeless = await createUser();
      expect(await broadcast()).toEqual(new Set([placeless]));
    });
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

  // A6 — "в района на ул. X": the streets say where the area is, not who is in
  // it. normalize.ts sets region_wide from the source text; this is the half
  // that acts on it.
  it("region_wide location ignores its streets and targets the whole region", async () => {
    const onNamedStreet = await createUser({ region: "Аспарухово", street: "Дубровник" });
    const otherStreet = await createUser({ region: "Аспарухово", street: "Розова долина" });
    const regionOnly = await createUser({ region: "Аспарухово" });
    const otherRegion = await createUser({ region: "Левски", street: "Дубровник" });

    const res = await submit(basePayload({
      processed_data: {
        locations: [{
          location_name: "кв. Аспарухово", sublocations: ["ул. Дубровник"],
          is_polygon: false, region_wide: true,
        }],
      },
    }));
    const body = await res.json() as SubmitResponse;
    // The neighbour on Розова долина is exactly who this rule exists for.
    expect(new Set(body.user_ids)).toEqual(new Set([onNamedStreet, otherStreet, regionOnly]));
    expect(body.user_ids).not.toContain(otherRegion);
  });

  it("region_wide with no region to widen to keeps street targeting", async () => {
    const onStreet = await createUser({ region: "Аспарухово", street: "Дубровник" });
    const otherStreet = await createUser({ region: "Аспарухово", street: "Розова долина" });

    const res = await submit(basePayload({
      processed_data: {
        // Vik's shape: streets and no district at all. There is no street→region
        // link to widen through, so the streets beat notifying nobody.
        locations: [{
          location_name: "", sublocations: ["ул. Дубровник"],
          is_polygon: false, region_wide: true,
        }],
      },
    }));
    const body = await res.json() as SubmitResponse;
    expect(new Set(body.user_ids)).toEqual(new Set([onStreet]));
    expect(body.user_ids).not.toContain(otherStreet);
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

  // The bug migration 0015 exists to close. `streets` was Varna-only and
  // street_name was globally UNIQUE, so matchStreet had nothing to scope on:
  // an outage on a village street resolved to the like-named Varna row and
  // notified people 25 km away. Half the street names around Тополи, Аврен and
  // Долни чифлик are also Varna street names, so this is the common case, not
  // an unlucky one.
  describe("a street name that exists in two settlements", () => {
    beforeEach(async () => {
      await env.DB.prepare(
        "INSERT INTO regions (region_name, lat, lng) VALUES ('Аврен', 43.1138714, 27.6658571)").run();
      await env.DB.prepare(
        `INSERT INTO streets (street_name, region_id, lat, lng)
         SELECT 'Тича', id, 43.1138, 27.6658 FROM regions WHERE region_name = 'Аврен'`).run();
      await env.DB.prepare(
        `INSERT INTO streets (street_name, region_id, lat, lng)
         SELECT 'Тича', id, 43.2166, 27.9166 FROM regions WHERE region_name = 'Варна'`).run();
      clearRefCaches();
    });

    it("notifies the village street's residents, not the city street's", async () => {
      const inVillage = await createUser({ region: "Аврен", street: "Тича", streetIn: "Аврен" });
      const inCity = await createUser({ region: "Варна", street: "Тича", streetIn: "Варна" });

      const res = await submit(basePayload({
        processed_data: {
          locations: [{
            location_name: "с. Аврен", sublocations: ["ул. Тича"], is_polygon: false,
          }],
        },
      }));
      const body = await res.json() as SubmitResponse;
      expect(new Set(body.user_ids)).toEqual(new Set([inVillage]));
      expect(body.user_ids).not.toContain(inCity);
    });

    // The shape the bug actually fired in, and the one the region_id in
    // getUserIdsByStreets cannot mask: vik routinely names streets and no
    // district at all, so nothing narrows the audience but the street itself.
    // Unscoped, "ул. Тича" resolved to whichever of the two rows the seed
    // happened to hold first — here the village's — and an outage in the city
    // notified a village 25 km away instead. A location that names no
    // settlement of its own is the city's, which is what every source we crawl
    // is written against.
    it("defaults a district-less alert to the city, not to whichever row came first", async () => {
      const inVillage = await createUser({ region: "Аврен", street: "Тича", streetIn: "Аврен" });
      const inCity = await createUser({ region: "Варна", street: "Тича", streetIn: "Варна" });

      const res = await submit(basePayload({
        processed_data: {
          locations: [{ location_name: "", sublocations: ["ул. Тича"], is_polygon: false }],
        },
      }));
      const body = await res.json() as SubmitResponse;
      expect(new Set(body.user_ids)).toEqual(new Set([inCity]));
      expect(body.user_ids).not.toContain(inVillage);
    });

    // Same two decisions, stated rather than inferred: the settlement slot says
    // which Тича is meant instead of settlementOf() having to guess it.
    it("scopes the streets to the named settlement slot", async () => {
      const inVillage = await createUser({ region: "Аврен", street: "Тича", streetIn: "Аврен" });
      const inCity = await createUser({ region: "Варна", street: "Тича", streetIn: "Варна" });

      const res = await submit(basePayload({
        processed_data: {
          locations: [{
            settlement: "с. Аврен", area: null, streets: ["ул. Тича"], is_polygon: false,
          }],
        },
      }));
      const body = await res.json() as SubmitResponse;
      expect(new Set(body.user_ids)).toEqual(new Set([inVillage]));
      expect(body.user_ids).not.toContain(inCity);
    });

    it("still defaults to the city when all three slots are empty", async () => {
      const inVillage = await createUser({ region: "Аврен", street: "Тича", streetIn: "Аврен" });
      const inCity = await createUser({ region: "Варна", street: "Тича", streetIn: "Варна" });

      const res = await submit(basePayload({
        processed_data: {
          locations: [{
            settlement: null, area: null, streets: ["ул. Тича"], is_polygon: false,
          }],
        },
      }));
      const body = await res.json() as SubmitResponse;
      expect(new Set(body.user_ids)).toEqual(new Set([inCity]));
      expect(body.user_ids).not.toContain(inVillage);
    });

    // The saving the change was really for: a village street used to be
    // unpinnable from our own tables. A seeded row could only be a Varna
    // street, so enrichment refused it and every village street went to
    // Nominatim — a 1,100 ms throttle slot plus an up-to-8 s request each, on
    // the ingest deadline. Scoped, the row IS this location's street.
    it("pins a village street from its own seeded row, with no Nominatim call", async () => {
      // No coordinates on the region, so the region step cannot pin it and
      // enrichment falls through to the streets — the path being tested.
      await env.DB.prepare(
        "UPDATE regions SET lat = NULL, lng = NULL WHERE region_name = 'Аврен'").run();
      clearRefCaches();

      const res = await submit(basePayload({
        processed_data: {
          locations: [{
            location_name: "с. Аврен", sublocations: ["ул. Тича"], is_polygon: false,
          }],
        },
      }));
      const { alert_id } = await res.json() as SubmitResponse;

      const row = await env.DB.prepare("SELECT locations_json FROM alerts WHERE id = ?")
        .bind(alert_id).first<{ locations_json: string }>();
      const [loc] = JSON.parse(row!.locations_json);
      // The village's Тича (27.6658), not the city's (27.9166).
      expect(loc.lat).toBeCloseTo(43.1138);
      expect(loc.lng).toBeCloseTo(27.6658);

      const cache = await env.DB.prepare("SELECT COUNT(*) AS n FROM geocode_cache")
        .first<{ n: number }>();
      expect(cache!.n).toBe(0);
    });

    // The other half of the same change: the pin. The village row carries its
    // own centroid, so no Nominatim call happens at all — no interceptor is
    // registered here, and net connect is disabled, so one would throw.
    it("pins the village street's own centroid, with no Nominatim call", async () => {
      // Аврен's region row would pin the alert first, so name no region: this
      // is vik's shape anyway — streets, and the town in the free text.
      const res = await submit(basePayload({
        processed_data: {
          locations: [{
            location_name: "гр. Аврен", sublocations: ["ул. Тича"], is_polygon: false,
          }],
        },
      }));
      const { alert_id } = await res.json() as SubmitResponse;

      const row = await env.DB.prepare("SELECT locations_json FROM alerts WHERE id = ?")
        .bind(alert_id).first<{ locations_json: string }>();
      const [loc] = JSON.parse(row!.locations_json);
      // The region matched first and pinned its centroid — the village's, and
      // nowhere near the city street's 27.9166.
      expect(loc.lng).toBeCloseTo(27.6658571);

      const cache = await env.DB.prepare("SELECT COUNT(*) AS n FROM geocode_cache")
        .first<{ n: number }>();
      expect(cache!.n).toBe(0);
    });
  });

  // The three-slot shape (schemas.ts). Every test above feeds the flat
  // (location_name, sublocations) pair, which readLocation still accepts and
  // which is what the shipped app and every stored alert hold — so those
  // passing unchanged IS the compatibility evidence. These are their twins in
  // the new shape, and they answer identically.
  //
  // Two of them would not, without the fixes that go with an always-present
  // settlement: the flat schema left location_name empty on vik's street-only
  // messages, so the city never resolved and neither the region pairing nor the
  // A6 widening had anything to fire on. Both fire now.
  describe("the three-slot location shape", () => {
    it("targets a settlement+area+streets entry exactly as the flat pair did", async () => {
      const match = await createUser({ region: "Аспарухово", street: "Дубровник" });
      const regionOnlyUser = await createUser({ region: "Аспарухово" });
      const sameRegionOtherStreet = await createUser({ region: "Аспарухово", street: "Розова долина" });
      const otherRegion = await createUser({ region: "Левски", street: "Дубровник" });

      const res = await submit(basePayload({
        processed_data: {
          locations: [{
            settlement: "гр. Варна", area: "кв. Аспарухово",
            streets: ["ул. Дубровник"], is_polygon: false,
          }],
        },
      }));
      const body = await res.json() as SubmitResponse;
      // The area is a district, so pairing it with the street list still narrows
      // a street that runs through several of them.
      expect(new Set(body.user_ids)).toEqual(new Set([match, regionOnlyUser]));
      expect(body.user_ids).not.toContain(sameRegionOtherStreet);
      expect(body.user_ids).not.toContain(otherRegion);
    });

    // Users register under districts, never under "Варна". Pairing the street
    // list with the settlement would filter on region_id = Варна and exclude
    // every one of them — an alert that reaches nobody.
    it("does not pair a street list with the settlement itself", async () => {
      const onStreet = await createUser({ region: "Аспарухово", street: "Дубровник" });
      const sameStreetOtherRegion = await createUser({ region: "Левски", street: "Дубровник" });
      const otherStreet = await createUser({ region: "Аспарухово", street: "Розова долина" });
      // Street-less, and under the settlement itself rather than a district —
      // the half that the pairing used to carry and must not lose.
      const unplacedInSettlement = await createUser({ region: "Варна" });
      const unplacedInDistrict = await createUser({ region: "Аспарухово" });

      const res = await submit(basePayload({
        processed_data: {
          locations: [{
            settlement: "гр. Варна", area: null, streets: ["ул. Дубровник"], is_polygon: false,
          }],
        },
      }));
      const body = await res.json() as SubmitResponse;
      expect(new Set(body.user_ids))
        .toEqual(new Set([onStreet, sameStreetOtherRegion, unplacedInSettlement]));
      expect(body.user_ids).not.toContain(otherStreet);
      // Their district was not named, so nothing places them on these streets.
      expect(body.user_ids).not.toContain(unplacedInDistrict);
    });

    // A village is where the settlement row IS the region people register under,
    // so a street-less resident of it must still hear about its street outage.
    // The settlement/district asymmetry is invisible in the schema — `regions`
    // mixes both with no kind column — which is exactly why this is a test.
    it("keeps a street-less villager in a village street's audience", async () => {
      await env.DB.prepare(
        "INSERT INTO regions (region_name, lat, lng) VALUES ('Тополи', 43.2416, 27.8236)").run();
      await env.DB.prepare(
        `INSERT INTO streets (street_name, region_id, lat, lng)
         SELECT 'Бреза', id, 43.1976, 27.8170 FROM regions WHERE region_name = 'Тополи'`).run();
      clearRefCaches();

      const onStreet = await createUser({ region: "Тополи", street: "Бреза", streetIn: "Тополи" });
      const streetless = await createUser({ region: "Тополи" });
      const inCity = await createUser({ region: "Варна", street: "Дубровник" });

      const res = await submit(basePayload({
        processed_data: {
          locations: [{
            settlement: "с. Тополи", area: null, streets: ["ул. Бреза"], is_polygon: false,
          }],
        },
      }));
      const body = await res.json() as SubmitResponse;
      expect(new Set(body.user_ids)).toEqual(new Set([onStreet, streetless]));
      expect(body.user_ids).not.toContain(inCity);
    });

    // A6 widens to a named area, not to the whole settlement. "в района на
    // ул. X" under a bare city is still about those streets; widening it to
    // every Varna user is a claim the message never made.
    it("does not widen a hedged street list to the whole settlement", async () => {
      const onNamedStreet = await createUser({ region: "Аспарухово", street: "Дубровник" });
      const otherStreet = await createUser({ region: "Аспарухово", street: "Розова долина" });

      const res = await submit(basePayload({
        processed_data: {
          locations: [{
            settlement: "гр. Варна", area: null, streets: ["ул. Дубровник"],
            is_polygon: false, region_wide: true,
          }],
        },
      }));
      const body = await res.json() as SubmitResponse;
      expect(new Set(body.user_ids)).toEqual(new Set([onNamedStreet]));
      expect(body.user_ids).not.toContain(otherStreet);
    });

    // The wire contract: the app reads location_name/sublocations, and so does
    // every alert stored before the split.
    it("stores the slots and the derived display pair together", async () => {
      const res = await submit(basePayload({
        processed_data: {
          locations: [{
            settlement: "гр. Варна", area: "кв. Аспарухово",
            streets: ["ул. Дубровник"], is_polygon: false,
          }],
        },
      }));
      const { alert_id } = await res.json() as SubmitResponse;
      const row = await env.DB.prepare("SELECT locations_json FROM alerts WHERE id = ?")
        .bind(alert_id).first<{ locations_json: string }>();
      const [loc] = JSON.parse(row!.locations_json);

      expect(loc.settlement).toBe("гр. Варна");
      expect(loc.area).toBe("кв. Аспарухово");
      expect(loc.location_name).toBe(loc.area);          // most specific place named
      expect(loc.sublocations).toEqual(["ул. Дубровник"]);
    });

    // Migration 0016. A district of another town is the case the written kind
    // can never get right: "ж.к." says district and says nothing about which
    // settlement, so settlementOf answers Варна and the streets are looked up
    // 20 km from the outage. The link is the only thing that knows.
    it("scopes streets to the settlement a district is linked to", async () => {
      await env.DB.prepare(
        "INSERT INTO regions (region_name, lat, lng) VALUES ('Белослав', 43.1958, 27.7042)").run();
      await env.DB.prepare(
        `INSERT INTO regions (region_name, lat, lng, settlement_id)
         SELECT 'ж.к. Младост', 43.1961, 27.7050, id FROM regions WHERE region_name = 'Белослав'`).run();
      // The same street name in both settlements — the whole point of the scope.
      for (const s of ["Белослав", "Варна"]) {
        await env.DB.prepare(
          `INSERT INTO streets (street_name, region_id) SELECT 'Тест', id
             FROM regions WHERE region_name = ?`).bind(s).run();
      }
      clearRefCaches();

      const inDistrict = await createUser({
        region: "ж.к. Младост", street: "Тест", streetIn: "Белослав",
      });
      const inCity = await createUser({ region: "Варна", street: "Тест", streetIn: "Варна" });

      const res = await submit(basePayload({
        processed_data: {
          locations: [{
            settlement: null, area: "ж.к. Младост", streets: ["ул. Тест"], is_polygon: false,
          }],
        },
      }));
      const body = await res.json() as SubmitResponse;
      expect(new Set(body.user_ids)).toEqual(new Set([inDistrict]));
      expect(body.user_ids).not.toContain(inCity);
    });

    // Migration 0017 lets the table hold both real "Цветен квартал"s — Варна's
    // node and Белослав's, 17.5 km apart — instead of renaming one of them
    // "Цветен квартал (Белослав)", a name no source ever writes. Nothing in the
    // name separates them, so the settlement slot is the only thing that can,
    // and this is the end of that chain: two audiences, one written name.
    it("targets the district in the settlement the message named", async () => {
      const parent = async (name: string, lat: number, lng: number) => {
        await env.DB.prepare(
          "INSERT OR IGNORE INTO regions (region_name, lat, lng) VALUES (?, ?, ?)")
          .bind(name, lat, lng).run();
        return (await env.DB.prepare(
          "SELECT id FROM regions WHERE region_name = ? AND settlement_id IS NULL")
          .bind(name).first<{ id: number }>())!.id;
      };
      const varna = await parent("Варна", 43.2073873, 27.9166653);
      const beloslav = await parent("Белослав", 43.1958, 27.7042);
      // Same name, different parent — impossible before 0017.
      const district = async (settlementId: number, lat: number, lng: number) => {
        await env.DB.prepare(
          "INSERT INTO regions (region_name, lat, lng, settlement_id) VALUES ('Цветен квартал', ?, ?, ?)")
          .bind(lat, lng, settlementId).run();
        return (await env.DB.prepare(
          "SELECT id FROM regions WHERE region_name = 'Цветен квартал' AND settlement_id = ?")
          .bind(settlementId).first<{ id: number }>())!.id;
      };
      const inVarna = await district(varna, 43.2238681, 27.9138306);
      const inBeloslav = await district(beloslav, 43.1816837, 27.7038);
      clearRefCaches();

      // createUser resolves a region by name, which is exactly the ambiguity
      // under test — so these two are placed by id.
      const place = async (regionId: number) => {
        const id = await createUser();
        await env.DB.prepare("UPDATE users SET region_id = ? WHERE user_id = ?")
          .bind(regionId, id).run();
        return id;
      };
      const varnaUser = await place(inVarna);
      const beloslavUser = await place(inBeloslav);

      const audience = async (settlement: string) => {
        const res = await submit(basePayload({
          processed_data: {
            locations: [{
              settlement, area: "Цветен квартал", streets: [], is_polygon: false,
            }],
          },
        }));
        return new Set((await res.json() as SubmitResponse).user_ids);
      };

      expect(await audience("гр. Белослав")).toEqual(new Set([beloslavUser]));
      expect(await audience("гр. Варна")).toEqual(new Set([varnaUser]));
    });

    // The pin is area → streets → settlement. Settlement last is what stops a
    // street-only alert, which used to arrive with location_name "", from
    // answering with the city centre now that the city is always stated.
    it("pins the street rather than the city centre when no area is named", async () => {
      await env.DB.prepare(
        `UPDATE streets SET lat = 43.1900, lng = 27.8971
          WHERE street_name = 'Дубровник'`).run();
      clearRefCaches();

      const res = await submit(basePayload({
        processed_data: {
          locations: [{
            settlement: "гр. Варна", area: null, streets: ["ул. Дубровник"], is_polygon: false,
          }],
        },
      }));
      const { alert_id } = await res.json() as SubmitResponse;
      const row = await env.DB.prepare("SELECT locations_json FROM alerts WHERE id = ?")
        .bind(alert_id).first<{ locations_json: string }>();
      const [loc] = JSON.parse(row!.locations_json);

      // The street (27.8971), not the Варна centroid (27.9166653).
      expect(loc.lat).toBeCloseTo(43.1900);
      expect(loc.lng).toBeCloseTo(27.8971);
    });
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
  // Street fallback path: with no region named, the street is what pins the
  // alert (region-first only kicks in when a location_name is present).
  it("resolves a street-level pin via Nominatim and caches the result", async () => {
    fetchMock.get("https://nominatim.openstreetmap.org")
      .intercept({ path: (p) => p.startsWith("/search") })
      .reply(200, JSON.stringify([{ lat: "43.2141", lon: "27.9147" }]),
        { headers: { "Content-Type": "application/json" } });

    const sub = await submit(basePayload({
      processed_data: {
        locations: [{ location_name: "", sublocations: ["ул. Дубровник"], is_polygon: false }],
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
        locations: [{ location_name: "", sublocations: ["Дубровник"], is_polygon: false }],
      },
    }));
    const { alert_id: id2 } = await sub2.json() as SubmitResponse;
    const row2 = await env.DB.prepare("SELECT locations_json FROM alerts WHERE id = ?")
      .bind(id2).first<{ locations_json: string }>();
    expect(JSON.parse(row2!.locations_json)[0].lat).toBeCloseTo(43.2141);
  });

  // e197d20f (30.07.2026 review): vik covers the Варна *province*, so an outage
  // in гр. Долни чифлик lists that town's streets — and ул. Камчия exists in
  // Варна too. Anchoring every lookup to the city asked Nominatim for the wrong
  // one, in a town 40 km away, and got an answer.
  it("scopes a street lookup to the settlement the alert named, not to Варна", async () => {
    // The street lookup answers; the town itself does not, so enrichment falls
    // through the region step to the streets — the path the anchor governs.
    // Registered first, because undici takes the first matching interceptor.
    fetchMock.get("https://nominatim.openstreetmap.org")
      .intercept({ path: (p) => decodeURIComponent(p).includes("Камчия") })
      .reply(200, JSON.stringify([{ lat: "42.9925", lon: "27.7187" }]),
        { headers: { "Content-Type": "application/json" } });
    fetchMock.get("https://nominatim.openstreetmap.org")
      .intercept({ path: (p) => p.startsWith("/search") })
      .reply(200, "[]", { headers: { "Content-Type": "application/json" } });
    const sub = await submit(basePayload({
      processed_data: {
        locations: [{
          location_name: "гр. Долни чифлик",
          sublocations: ["ул. Камчия"],
          is_polygon: false,
        }],
      },
    }));
    const { alert_id } = await sub.json() as SubmitResponse;

    const queries = (await env.DB.prepare("SELECT query FROM geocode_cache").all())
      .results.map((r) => (r as { query: string }).query);
    // The town, never ", Варна," — and a seeded Варна street row must not
    // short-circuit it, because that row is the city's street, not this one's.
    expect(queries).toContain("Камчия, Долни чифлик, България");
    // The town's own lookup is not anchored into the city either.
    expect(queries).toContain("Долни чифлик, България");
    expect(queries.join(" ")).not.toContain("Варна");

    const row = await env.DB.prepare("SELECT locations_json FROM alerts WHERE id = ?")
      .bind(alert_id).first<{ locations_json: string }>();
    expect(JSON.parse(row!.locations_json)[0].lat).toBeCloseTo(42.9925);
  });

  // 8360abda: OSM tags a bus shelter with the same name as the area around it,
  // and Nominatim ranked it first — an outage across five Provadia villages was
  // pinned on a shelter in Варна. The area behind it is what the alert means.
  it("skips a Nominatim hit that names an object rather than a place", async () => {
    fetchMock.get("https://nominatim.openstreetmap.org")
      .intercept({ path: (p) => p.startsWith("/search") })
      .reply(200, JSON.stringify([
        { lat: "43.2394368", lon: "27.9881014", class: "highway", type: "bus_stop" },
        { lat: "43.1786369", lon: "27.4438702", class: "boundary", type: "administrative" },
      ]), { headers: { "Content-Type": "application/json" } });

    const sub = await submit(basePayload({
      processed_data: {
        locations: [{ location_name: "Вилна зона", sublocations: [], is_polygon: false }],
      },
    }));
    const { alert_id } = await sub.json() as SubmitResponse;

    const row = await env.DB.prepare("SELECT locations_json FROM alerts WHERE id = ?")
      .bind(alert_id).first<{ locations_json: string }>();
    const [loc] = JSON.parse(row!.locations_json);
    expect(loc.lat).toBeCloseTo(43.1786369); // the boundary, not the bus stop
    fetchMock.assertNoPendingInterceptors();
  });

  // The user-facing rule this priority exists for: an alert that names a region
  // pins the region even when it also lists streets, because several streets in
  // one district read better as a single region pin than as one arbitrary street.
  it("pins the region, not a listed street, when both are present", async () => {
    await env.DB.prepare(
      "UPDATE regions SET lat = 43.1741, lng = 27.9147 WHERE region_name = 'Аспарухово'").run();
    await env.DB.prepare(
      "UPDATE streets SET lat = 43.1953, lng = 27.9021 WHERE street_name = 'Дубровник'").run();
    clearRefCaches();

    // No Nominatim interceptor: a seeded region needs no network call, and the
    // street must not be consulted at all — either would throw here.
    const sub = await submit(basePayload({
      processed_data: {
        locations: [{ location_name: "кв. Аспарухово", sublocations: ["ул. Дубровник"], is_polygon: false }],
      },
    }));
    const { alert_id } = await sub.json() as SubmitResponse;

    const row = await env.DB.prepare("SELECT locations_json FROM alerts WHERE id = ?")
      .bind(alert_id).first<{ locations_json: string }>();
    const [loc] = JSON.parse(row!.locations_json);
    expect(loc.lat).toBeCloseTo(43.1741); // region centroid, not the street's 43.1953
    expect(loc.lng).toBeCloseTo(27.9147);

    const cache = await env.DB.prepare("SELECT COUNT(*) AS n FROM geocode_cache").first<{ n: number }>();
    expect(cache!.n).toBe(0);
  });

  // Migration 0005 + tools/osm-seed-builder: a matched reference row that
  // carries its own centroid must not reach Nominatim at all. No interceptor is
  // registered in these tests, and fetchMock has net connect disabled, so any
  // outbound call throws and the assertions below fail.
  it("pins a seeded street centroid without calling Nominatim", async () => {
    await env.DB.prepare("UPDATE streets SET lat = 43.1953, lng = 27.9021 WHERE street_name = 'Дубровник'").run();
    clearRefCaches(); // the row was cached without coordinates by an earlier read

    // No region named, so the street pins the alert (region-first would win otherwise).
    const sub = await submit(basePayload({
      processed_data: {
        locations: [{ location_name: "", sublocations: ["ул. Дубровник"], is_polygon: false }],
      },
    }));
    const { alert_id } = await sub.json() as SubmitResponse;

    const row = await env.DB.prepare("SELECT locations_json FROM alerts WHERE id = ?")
      .bind(alert_id).first<{ locations_json: string }>();
    const [loc] = JSON.parse(row!.locations_json);
    expect(loc.lat).toBeCloseTo(43.1953);
    expect(loc.lng).toBeCloseTo(27.9021);

    // Nothing was geocoded, so nothing was cached.
    const cache = await env.DB.prepare("SELECT COUNT(*) AS n FROM geocode_cache").first<{ n: number }>();
    expect(cache!.n).toBe(0);
  });

  it("pins the region centroid from a seeded row without calling Nominatim", async () => {
    await env.DB.prepare("UPDATE regions SET lat = 43.1741, lng = 27.9147 WHERE region_name = 'Аспарухово'").run();
    clearRefCaches();

    const sub = await submit(basePayload({
      processed_data: { locations: [{ location_name: "кв. Аспарухово", sublocations: [], is_polygon: false }] },
    }));
    const { alert_id } = await sub.json() as SubmitResponse;

    const row = await env.DB.prepare("SELECT locations_json FROM alerts WHERE id = ?")
      .bind(alert_id).first<{ locations_json: string }>();
    const [loc] = JSON.parse(row!.locations_json);
    expect(loc.lat).toBeCloseTo(43.1741);
    expect(loc.lng).toBeCloseTo(27.9147);
  });

  it("still geocodes a street whose seeded row has no coordinates", async () => {
    // The pre-0005 state: names are known, coordinates are not.
    fetchMock.get("https://nominatim.openstreetmap.org")
      .intercept({ path: (p) => p.startsWith("/search") })
      .reply(200, JSON.stringify([{ lat: "43.2000", lon: "27.9000" }]),
        { headers: { "Content-Type": "application/json" } });

    const sub = await submit(basePayload({
      processed_data: {
        locations: [{ location_name: "", sublocations: ["Розова долина"], is_polygon: false }],
      },
    }));
    const { alert_id } = await sub.json() as SubmitResponse;

    const row = await env.DB.prepare("SELECT locations_json FROM alerts WHERE id = ?")
      .bind(alert_id).first<{ locations_json: string }>();
    expect(JSON.parse(row!.locations_json)[0].lat).toBeCloseTo(43.2);
    fetchMock.assertNoPendingInterceptors();
  });
});

// Push credentials are absent in every other test, which is what keeps them
// off the network (sendPushToUsers warns and skips). These tests supply them.
type PushEnv = { ONESIGNAL_APP_ID?: string; ONESIGNAL_API_KEY?: string };

function withPushCredentials(): () => void {
  (env as PushEnv).ONESIGNAL_APP_ID = "test-app-id";
  (env as PushEnv).ONESIGNAL_API_KEY = "test-api-key";
  return () => {
    delete (env as PushEnv).ONESIGNAL_APP_ID;
    delete (env as PushEnv).ONESIGNAL_API_KEY;
  };
}

interface CapturedBody {
  app_id: string;
  include_aliases: { external_id: string[] };
  headings: { en: string };
  contents: { en: string };
  data: Record<string, string>;
}

/**
 * Intercepts `times` push sends and records their parsed bodies. Recording
 * happens in the reply callback, not in a body matcher — undici may run a
 * matcher more than once per request, which would double-count.
 */
function interceptPush(times: number): CapturedBody[] {
  const captured: CapturedBody[] = [];
  fetchMock.get("https://api.onesignal.com")
    .intercept({ path: "/notifications", method: "POST" })
    .reply((opts) => {
      captured.push(JSON.parse(String(opts.body)) as CapturedBody);
      return {
        statusCode: 200,
        data: JSON.stringify({ id: "notif-1", recipients: 1 }),
        responseOptions: { headers: { "Content-Type": "application/json" } },
      };
    })
    .times(times);
  return captured;
}

describe("push send", () => {
  it("addresses users by external_id in a single request", async () => {
    const restore = withPushCredentials();
    try {
      const captured = interceptPush(1);
      const alice = await createUser({ region: "Аспарухово" });
      const bob = await createUser({ region: "Аспарухово" });

      const res = await submit(basePayload({
        processed_data: { locations: [], city_wide: true },
      }));
      expect((await res.json() as SubmitResponse).notified_count).toBe(2);
      fetchMock.assertNoPendingInterceptors();

      // One request, not one per device: this is the whole point of the
      // provider — fan-out happens on their side, not in the Worker.
      expect(captured).toHaveLength(1);
      expect(captured[0]!.app_id).toBe("test-app-id");
      expect([...captured[0]!.include_aliases.external_id].sort())
        .toEqual([alice, bob].sort());
      expect(captured[0]!.headings.en).toBe("Авария");
      expect(captured[0]!.contents.en).toContain("Спиране на водата");
    } finally {
      restore();
    }
  });

  it("does not touch the network when credentials are unset", async () => {
    // No interceptor and net connect is disabled, so any outbound call throws.
    await createUser({ region: "Аспарухово" });
    const res = await submit(basePayload({
      processed_data: { locations: [], city_wide: true },
    }));
    // The alert is still stored and the audience still reported.
    expect((await res.json() as SubmitResponse).notified_count).toBe(1);
  });
});

describe("POST /api/alerts/test-push", () => {
  function testPush(body: unknown, apiKey: string | null = INGEST_KEY) {
    return api("/api/alerts/test-push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "X-Api-Key": apiKey } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  const payload = { title: "Тест", body: "Проверка на доставката" };

  it("401s without or with a wrong X-Api-Key", async () => {
    expect((await testPush(payload, null)).status).toBe(401);
    expect((await testPush(payload, "wrong")).status).toBe(401);
  });

  it("400s on missing or empty title/body", async () => {
    expect((await testPush({ body: "b" })).status).toBe(400);
    expect((await testPush({ title: "t" })).status).toBe(400);
    expect((await testPush({ title: "", body: "b" })).status).toBe(400);
    const res = await testPush({ title: "t", body: 7 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "title and body must be non-empty strings." });
  });

  it("sends to just the named user, ignoring every other registration", async () => {
    const restore = withPushCredentials();
    try {
      const captured = interceptPush(1);
      const target = await createUser({ region: "Аспарухово" });
      await createUser({ region: "Аспарухово" }); // must not be addressed

      const res = await testPush({ ...payload, userId: target });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ sent: 1, failed: 0, target: "user" });
      fetchMock.assertNoPendingInterceptors();

      expect(captured).toHaveLength(1);
      expect(captured[0]!.include_aliases.external_id).toEqual([target]);
      expect(captured[0]!.headings.en).toBe(payload.title);
      expect(captured[0]!.contents.en).toBe(payload.body);
    } finally {
      restore();
    }
  });

  it("broadcasts to every registered user when userId is omitted", async () => {
    const restore = withPushCredentials();
    try {
      const captured = interceptPush(1);
      const alice = await createUser({ region: "Аспарухово" });
      // No region and category preferences off would both drop a real alert;
      // a test push must reach them anyway.
      const bob = await createUser();

      const res = await testPush(payload);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ sent: 1, failed: 1, target: "broadcast" });
      fetchMock.assertNoPendingInterceptors();

      expect([...captured[0]!.include_aliases.external_id].sort())
        .toEqual([alice, bob].sort());
    } finally {
      restore();
    }
  });

  it("stores no alert — the test push never enters the feed", async () => {
    const restore = withPushCredentials();
    try {
      interceptPush(1);
      await createUser({ region: "Аспарухово" });
      await testPush(payload);
      fetchMock.assertNoPendingInterceptors();

      const { count } = (await env.DB.prepare("SELECT COUNT(*) AS count FROM alerts")
        .first<{ count: number }>())!;
      expect(count).toBe(0);
    } finally {
      restore();
    }
  });
});

describe("push chunking", () => {
  // The migration rests on this: an audience larger than one request's alias
  // cap must split cleanly, with nobody dropped at the boundary. Driven
  // directly rather than through D1 so the boundary can be tested at its real
  // size without seeding thousands of users.
  it("splits a >2,000-user audience into whole, disjoint chunks", async () => {
    const restore = withPushCredentials();
    try {
      const userIds = Array.from({ length: 2_500 }, (_, i) => `user-${i}`);
      const captured = interceptPush(2);

      const result = await sendPushToUsers(
        env, userIds, { title: "t", body: "b", data: { category: "vik" } });

      fetchMock.assertNoPendingInterceptors();
      expect(captured).toHaveLength(2);

      const chunks = captured.map((c) => c.include_aliases.external_id);
      expect(chunks.map((c) => c.length).sort((a, b) => a - b)).toEqual([500, 2_000]);

      // Every user appears exactly once across the chunks.
      const all = chunks.flat();
      expect(all).toHaveLength(2_500);
      expect(new Set(all).size).toBe(2_500);
      expect([...new Set(all)].sort()).toEqual([...userIds].sort());

      // `recipients: 1` per stubbed response — 2 reached, the rest unconfirmed.
      expect(result.sent).toBe(2);
      expect(result.failed).toBe(2_498);
    } finally {
      restore();
    }
  });

  // Both fields are scraped verbatim off a third-party page, so their length is
  // whatever that page says. The body has been capped since the port; the title
  // was the one field left unbounded in a payload the provider rejects whole.
  it("caps the title and the body it sends to the provider", async () => {
    const restore = withPushCredentials();
    try {
      const captured = interceptPush(1);
      await createUser({ receivesAll: true });

      await submit(basePayload({
        original_message: { title: "Т".repeat(500), content: "С".repeat(4000) },
        processed_data: { locations: [], city_wide: true },
      }));
      fetchMock.assertNoPendingInterceptors();

      const { headings, contents } = captured[0]!;
      expect(headings.en.length).toBe(120);
      expect(headings.en.endsWith("…")).toBe(true);
      expect(contents.en.length).toBe(1000);
      expect(contents.en.endsWith("…")).toBe(true);
    } finally {
      restore();
    }
  });
});

// Targeting moved to external_id aliases, so the provider — not D1 — holds the
// device registrations for an account. Deleting only our row would leave them,
// which is not what /privacy promises.
describe("account erasure reaches the push provider", () => {
  it("deletes the OneSignal user by external_id", async () => {
    const restore = withPushCredentials();
    try {
      const deleted: string[] = [];
      fetchMock.get("https://api.onesignal.com")
        .intercept({ path: (p) => p.includes("/users/by/external_id/"), method: "DELETE" })
        .reply((opts) => {
          deleted.push(String(opts.path));
          return { statusCode: 200, data: "{}" };
        });

      const { token } = await registerAndLogin();
      const me = await api("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } });
      const { userId } = await me.json() as { userId: string };

      const res = await api("/api/auth/me",
        { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(204);

      fetchMock.assertNoPendingInterceptors();
      expect(deleted).toHaveLength(1);
      expect(deleted[0]).toBe(`/apps/test-app-id/users/by/external_id/${userId}`);
    } finally {
      restore();
    }
  });
});

// ── F17 / §3.1 · the settlement-wide audience ────────────────────────────────
//
// `getUserIdsByRegion` is `WHERE region_id = ?`, which is right for a district
// and close to useless for a city. A user inside Варна reverse-geocodes to their
// DISTRICT (suburb, neighbourhood, quarter, city_district, … — core/geocoding.ts)
// and carries that district's region_id, never the city's, so every
// settlement-wide alert for Варна reached only the residue whose reverse geocode
// hit no district we seed. Silently: an alert that reached nobody is stored,
// stamped notified, and looks exactly like one that reached everyone.
describe("settlement-wide targeting (§3.1)", () => {
  beforeEach(async () => {
    clearRefCaches();
    // Two districts linked to Варна (migration 0016) and one unrelated village,
    // which is what makes this a containment test rather than a radius test.
    await env.DB.prepare(
      `INSERT INTO regions (region_name, lat, lng, settlement_id)
       SELECT 'кв. Виница', 43.2419122, 27.9603219, id FROM regions WHERE region_name = 'Варна'`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO regions (region_name, lat, lng, settlement_id)
       SELECT 'кв. Чайка', 43.2159044, 27.9397023, id FROM regions WHERE region_name = 'Варна'`,
    ).run();
    await env.DB.prepare(
      "INSERT INTO regions (region_name, lat, lng) VALUES ('Долни чифлик', 42.9930, 27.7180)",
    ).run();
    clearRefCaches();
  });

  const targeted = async (locations: unknown[]) => {
    const res = await submit(basePayload({ processed_data: { locations, city_wide: false } }));
    return new Set(((await res.json()) as SubmitResponse).user_ids);
  };

  // §5.1, decided 10.08.2026: a failed extraction notifies nobody. A genuine
  // whole-city outage is published in words and routed to `city_wide`, so a
  // location that resolves to the city row and nothing more specific is a
  // district that got lost — and a city-sized push decided by an extraction we
  // already know failed is the wrong trade.
  it("notifies nobody for a bare city with no area and no matched street", async () => {
    await createUser({ region: "кв. Виница" });
    await createUser({ region: "кв. Чайка" });
    await createUser({ region: "Варна" });
    await createUser({ lat: 43.2100, lng: 27.9200 });

    const ids = await targeted([
      { settlement: "гр. Варна", area: null, streets: [], is_polygon: false },
    ]);
    expect(ids.size).toBe(0);
  });

  it("notifies nobody for a city whose every named street failed to match", async () => {
    await createUser({ region: "кв. Виница" });
    const ids = await targeted([
      { settlement: "гр. Варна", area: null, streets: ["ул. Няма такава"], is_polygon: false },
    ]);
    expect(ids.size).toBe(0);
  });

  // The exclusion is the city alone. A town where we hold a few districts is a
  // place the sources really do publish for as a whole, and there the union of
  // the settlement row and its districts is both correct and complete.
  it("still reaches a small town's districts and its own row", async () => {
    await env.DB.prepare(
      "INSERT INTO regions (region_name, lat, lng) VALUES ('Белослав', 43.1958, 27.7042)",
    ).run();
    await env.DB.prepare(
      `INSERT INTO regions (region_name, lat, lng, settlement_id)
       SELECT 'кв. Акациите', 43.1970, 27.7060, id FROM regions WHERE region_name = 'Белослав'`,
    ).run();
    clearRefCaches();

    const inDistrict = await createUser({ region: "кв. Акациите" });
    const onTownRow = await createUser({ region: "Белослав" });
    const inVarna = await createUser({ region: "кв. Виница" });

    const ids = await targeted([
      { settlement: "гр. Белослав", area: null, streets: [], is_polygon: false },
    ]);
    expect(ids.has(inDistrict)).toBe(true);
    expect(ids.has(onTownRow)).toBe(true);
    expect(ids.has(inVarna)).toBe(false);
  });

  // A village has no district level under it, so the settlement row IS what its
  // residents register under and the plain region query is the whole answer.
  it("leaves a leaf settlement on the plain region query", async () => {
    const villager = await createUser({ region: "Долни чифлик" });
    const cityDweller = await createUser({ region: "кв. Виница" });

    const ids = await targeted([
      { settlement: "гр. Долни чифлик", area: null, streets: [], is_polygon: false },
    ]);
    expect(ids.has(villager)).toBe(true);
    expect(ids.has(cityDweller)).toBe(false);
  });

  // A district is still a district: naming one must NOT widen to its city.
  it("does not widen a named district to its whole settlement", async () => {
    const inViniza = await createUser({ region: "кв. Виница" });
    const inChayka = await createUser({ region: "кв. Чайка" });

    const ids = await targeted([
      { settlement: "гр. Варна", area: "кв. Виница", streets: [], is_polygon: false },
    ]);
    expect(ids.has(inViniza)).toBe(true);
    expect(ids.has(inChayka)).toBe(false);
  });
});

// ── F18 / §3.5 · polygons get a floor and a tolerance ────────────────────────

describe("polygon targeting (§3.5)", () => {
  // A ~600 m square over central Варна.
  const ring = [
    [27.9100, 43.2050], [27.9175, 43.2050], [27.9175, 43.2105],
    [27.9100, 43.2105], [27.9100, 43.2050],
  ];
  const polygonLocation = {
    settlement: "гр. Варна", area: null, streets: ["ул. Дубровник"], is_polygon: true,
    polygon_geojson: { type: "Polygon", coordinates: [ring] },
  };

  const targeted = async (locations: unknown[]) => {
    const res = await submit(basePayload({ processed_data: { locations, city_wide: false } }));
    return new Set(((await res.json()) as SubmitResponse).user_ids);
  };

  it("notifies users inside the ring", async () => {
    const inside = await createUser({ lat: 43.2080, lng: 27.9140 });
    const faraway = await createUser({ lat: 43.1800, lng: 27.8900 });
    const ids = await targeted([polygonLocation]);
    expect(ids.has(inside)).toBe(true);
    expect(ids.has(faraway)).toBe(false);
  });

  // A ring edge sits a road half-width off an OSM centreline and the point being
  // tested is a phone's GPS fix. A resident on their own doorstep was outside.
  it("keeps a user a few metres outside the ring", async () => {
    // ~22 m north of the top edge (1 degree of latitude ≈ 111.3 km).
    const justOutside = await createUser({ lat: 43.2105 + 0.0002, lng: 27.9140 });
    const ids = await targeted([polygonLocation]);
    expect(ids.has(justOutside)).toBe(true);
  });

  it("still excludes a user well outside the tolerance band", async () => {
    // ~110 m north — past the 30 m band.
    const wellOutside = await createUser({ lat: 43.2105 + 0.001, lng: 27.9140 });
    const ids = await targeted([polygonLocation]);
    expect(ids.has(wellOutside)).toBe(false);
  });

  // The exposure that never fired only because every polygon in the window
  // failed to build: the polygon branch is exclusive, so a ring matching nobody
  // notified nobody — where the same alert with no polygon would have reached
  // the whole street list.
  it("falls back to the street/region audience when the ring matches nobody", async () => {
    const onStreet = await createUser({ street: "Дубровник" });
    const ids = await targeted([polygonLocation]);
    expect(ids.has(onStreet)).toBe(true);
  });
});

// ── F2 / §2.1 · a failed polygon build stops being invisible ─────────────────
//
// `is_polygon` has to be cleared when no geometry was produced — targeting an
// empty ring notifies nobody and every reader takes the flag as a promise that
// geometry is present. Clearing it ALONE erased the fact that a block was ever
// asked for: 252 of 252 stored locations in the 08.08.2026 window carried
// `is_polygon: false`, so a build failure and a message that never mentioned a
// block were byte-identical once stored. All four ★ notes in that review blamed
// the AI for missing the "каре" cue; the deterministic A2 guard had fired
// correctly every time.
describe("polygon build failures are recorded (§2.1)", () => {
  it("stores polygon_failed instead of a row that looks like plain streets", async () => {
    const res = await submit(basePayload({
      processed_data: {
        locations: [{
          settlement: "гр. Варна", area: null, streets: ["ул. Дубровник"],
          is_polygon: true, polygon_failure: "only 1/4 street names resolved in Варна",
        }],
        city_wide: false,
      },
    }));
    const { alert_id } = await res.json() as SubmitResponse;
    const row = await env.DB.prepare("SELECT locations_json FROM alerts WHERE id = ?")
      .bind(alert_id).first<{ locations_json: string }>();
    const [loc] = JSON.parse(row!.locations_json);

    // Still false, so nothing downstream targets an empty ring…
    expect(loc.is_polygon).toBe(false);
    // …and still discoverable, which is what the review tool's dedicated
    // "polygon flagged, no geometry" badge needs in order to fire at all.
    expect(loc.polygon_failed).toBe(true);
    expect(loc.polygon_failure).toContain("street names resolved");
  });

  it("leaves the flag off a location that never asked for one", async () => {
    const res = await submit(basePayload({
      processed_data: {
        locations: [{ settlement: "гр. Варна", area: null, streets: ["ул. Дубровник"], is_polygon: false }],
        city_wide: false,
      },
    }));
    const { alert_id } = await res.json() as SubmitResponse;
    const row = await env.DB.prepare("SELECT locations_json FROM alerts WHERE id = ?")
      .bind(alert_id).first<{ locations_json: string }>();
    const [loc] = JSON.parse(row!.locations_json);
    expect(loc.polygon_failed).toBeUndefined();
  });
});

// ── F9 / §2.5 · a geocoded point has to be in the settlement it was asked about ─
//
// 803a51e4 (ViK, гр. Долни чифлик, six flower-named streets) pinned 6.4 km east
// of the town: none of the six was seeded, so resolveCoordinates fell through to
// Nominatim, which answered "Синчец, Долни чифлик" with a point outside it. The
// answer was accepted, cached, and nothing compared it against the town.
//
// The threshold cannot be a constant — Варна's own streets reach 10.7 km from
// its centroid at the 95th percentile, while Долни чифлик's 42 seeded streets
// all lie within 1.2 km — so it is the settlement's own extent.
describe("geocode plausibility (§2.5)", () => {
  beforeEach(async () => {
    await env.DB.prepare(
      "INSERT INTO regions (region_name, lat, lng) VALUES ('Долни чифлик', 42.9930, 27.7180)",
    ).run();
    await env.DB.prepare(
      `INSERT INTO streets (street_name, region_id, lat, lng)
       SELECT 'Камчия', id, 42.9940, 27.7190 FROM regions WHERE region_name = 'Долни чифлик'`,
    ).run();
    clearRefCaches();
  });

  it("rejects an answer far outside the settlement the message named", async () => {
    fetchMock.get("https://nominatim.openstreetmap.org")
      .intercept({ path: (p) => p.startsWith("/search") })
      .reply(200, JSON.stringify([{ lat: "43.0500", lon: "27.7900", class: "highway", type: "residential" }]),
        { headers: { "Content-Type": "application/json" } });

    const res = await submit(basePayload({
      processed_data: {
        locations: [{
          settlement: "гр. Долни чифлик", area: null, streets: ["ул. Синчец"], is_polygon: false,
        }],
        city_wide: false,
      },
    }));
    const { alert_id } = await res.json() as SubmitResponse;
    const row = await env.DB.prepare("SELECT locations_json FROM alerts WHERE id = ?")
      .bind(alert_id).first<{ locations_json: string }>();
    const [loc] = JSON.parse(row!.locations_json);

    // Falls through to the settlement centroid — a coarse pin, not a wrong one.
    expect(loc.lat).toBeCloseTo(42.9930, 3);
    expect(loc.lng).toBeCloseTo(27.7180, 3);
  });

  // The other direction, and the reason the check is measured against a STATED
  // settlement only: settlementScope answers "Варна" for anything it cannot
  // place, and judging an answer against a city we merely assumed would reject
  // correct points 40 km away (8360abda's "Вилна зона", in Провадия).
  it("accepts an answer when the message named no settlement to judge it by", async () => {
    fetchMock.get("https://nominatim.openstreetmap.org")
      .intercept({ path: (p) => p.startsWith("/search") })
      .reply(200, JSON.stringify([{ lat: "43.1786369", lon: "27.4438702", class: "place", type: "locality" }]),
        { headers: { "Content-Type": "application/json" } });

    const res = await submit(basePayload({
      processed_data: {
        locations: [{ settlement: null, area: "Вилна зона", streets: [], is_polygon: false }],
        city_wide: false,
      },
    }));
    const { alert_id } = await res.json() as SubmitResponse;
    const row = await env.DB.prepare("SELECT locations_json FROM alerts WHERE id = ?")
      .bind(alert_id).first<{ locations_json: string }>();
    const [loc] = JSON.parse(row!.locations_json);
    expect(loc.lat).toBeCloseTo(43.1786369, 4);
  });
});
