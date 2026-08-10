// Nominatim client (SPEC.md §1.5). Reverse geocoding backs PUT
// /api/auth/location (one uncached call per request, matching the old
// service — only forward lookups were cached). Forward geocoding backs alert
// enrichment, with the cache moved from process memory to the D1
// geocode_cache table (misses are cached too).
//
// Both directions go through the same ≥1,100 ms slot reservation, because OSMF's
// 1 rps limit counts requests, not lookup directions. Reverse used to skip it on
// the grounds that it is uncached and user-driven — but "user-driven" is exactly
// what makes it unbounded: PUT /location is rate limited per *user*
// (RL_GEOCODE_USER), which says nothing about how many users call it at once, so
// a busy minute could put an arbitrary number of reverse lookups on the wire
// while forward lookups politely queued behind each other.

import type { Env } from "../env";
import { abortIn, msLeft } from "../shared/deadline";

// Nominatim ToS require a descriptive User-Agent.
const USER_AGENT = "CityShieldAPI/1.0";

const REQUEST_TIMEOUT_MS = 8_000;

export interface ReverseAddress {
  /**
   * Whether the lookup actually completed. False means Nominatim was throttled,
   * timed out, or the budget ran out — NOT "this point has no address".
   *
   * The two used to be the same empty result, and the caller
   * (PUT /api/auth/location) wrote the empty match straight to the user's
   * region_id/street_id. So a Nominatim blip during signup produced an account
   * with coordinates but no targeting — invisible to every region and street
   * alert — and a blip for an existing user ERASED an assignment that was
   * already correct. A failed lookup must leave the columns alone.
   */
  ok: boolean;
  /**
   * Region candidates, most specific first — every populated address field,
   * not just the first one. Nominatim labels the same place at several
   * granularities and only some of them exist in our `regions` table: the
   * city centre comes back as a `city_district` ("Одесос") that we have never
   * heard of, while the `city` right behind it ("Варна") is a region we seed.
   * Returning one name meant that address matched nothing at all.
   */
  regionNames: string[];
  /** Street candidates, most specific first. */
  streetNames: string[];
  /**
   * Settlement candidates only — the city/town/village this point is in, never
   * a district of one.
   *
   * A subset of `regionNames`, kept separate because it answers a different
   * question: which settlement's streets is this address on. `regionNames`
   * leads with suburb/quarter precisely because that is the most specific
   * *region* for targeting, and a suburb is exactly what a street scope must
   * not be — `streets.region_id` always points at a settlement (migration 0015).
   */
  settlementNames: string[];
}

/** Every populated field among `keys`, in order, deduped. */
function pickAll(address: Record<string, unknown>, keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const value = address[key];
    if (typeof value === "string" && value && !out.includes(value)) out.push(value);
  }
  return out;
}

export interface GeoPoint {
  lat: number;
  lng: number;
}

// Module-scope timestamp: spaces out consecutive uncached Nominatim calls
// inside one invocation (isolate); across isolates the structural throttle of
// §1.5 applies (geocoding only happens on ingest + location updates).
let lastNominatimCallAt = 0;
const MIN_SPACING_MS = 1_100;

// Serializing tail. Reading a shared timestamp was only correct while callers
// were strictly sequential: two concurrent geocodes both saw the same
// `lastNominatimCallAt`, waited the same interval, and then fired
// simultaneously — exactly the 1 rps breach the throttle exists to prevent.
// Chaining the waits makes the spacing hold under concurrency too.
let throttleChain: Promise<void> = Promise.resolve();

/**
 * How many slots have been granted, i.e. how many requests this isolate has
 * actually put on the wire under the throttle.
 *
 * A test hook, in the same spirit as clearRefCaches: "was this lookup throttled"
 * is otherwise only observable as elapsed wall-clock, and `Date.now()` inside
 * workerd advances at I/O boundaries rather than continuously, so timing it
 * measures nothing reliable.
 */
let slotsGranted = 0;

export function nominatimSlotsGranted(): number {
  return slotsGranted;
}

/** Test hook: forget the spacing, so one test's calls don't delay the next's. */
export function resetNominatimThrottle(): void {
  lastNominatimCallAt = 0;
  slotsGranted = 0;
  throttleChain = Promise.resolve();
}

/**
 * Reserve the next Nominatim slot. Resolves false when the wait would not fit
 * inside the caller's budget — a skipped geocode (alert stored without
 * coordinates) is strictly better than sleeping into a mid-flight kill.
 */
function reserveNominatimSlot(deadline?: number): Promise<boolean> {
  const result = throttleChain.then(async () => {
    const wait = Math.max(0, lastNominatimCallAt + MIN_SPACING_MS - Date.now());
    // Needs room for the throttle wait AND the request that follows it.
    if (msLeft(deadline) < wait + 1_000) return false;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastNominatimCallAt = Date.now();
    slotsGranted++;
    return true;
  });
  // The chain must not stall on a failed link, and must not surface unhandled
  // rejections to whoever happens to be next in line.
  throttleChain = result.then(() => undefined, () => undefined);
  return result;
}

interface NominatimHit {
  lat?: string;
  lon?: string;
  class?: string;
  type?: string;
}

// Enough results to skip past the point-of-interest noise and still reach the
// place; the response is small and this is one request either way.
const SEARCH_LIMIT = 5;

// OSM tags a bus stop, a shop and a monument with the same `name` as the
// district or street they sit in, and Nominatim happily ranks one of those
// first: "Вилна зона" came back as the bus stop "Вилна зона /Виница/" and
// pinned an outage in five Provadia villages onto a shelter in Варна.
//
// A denylist rather than an allowlist, because the same function geocodes both
// districts and streets and the shapes they legitimately come back as are
// open-ended (place/*, boundary/administrative, landuse/*, leisure/resort for
// к.к. Св. св. Константин и Елена, highway/residential for a street). What is
// never meant is a single addressable object.
const NON_PLACE_CLASSES = new Set([
  "amenity", "shop", "office", "craft", "tourism", "historic",
  "railway", "aeroway", "emergency", "healthcare", "man_made",
]);
const NON_PLACE_HIGHWAY_TYPES = new Set([
  "bus_stop", "platform", "crossing", "traffic_signals", "stop", "give_way",
  "street_lamp", "turning_circle", "milestone", "speed_camera",
]);

/** Whether a Nominatim hit is a place (or a street) rather than an object standing in one. */
function namesAPlace(hit: NominatimHit): boolean {
  if (hit.class && NON_PLACE_CLASSES.has(hit.class)) return false;
  if (hit.class === "highway" && hit.type && NON_PLACE_HIGHWAY_TYPES.has(hit.type)) return false;
  return true;
}

/**
 * Forward geocode with the D1-backed cache (misses cached too, so repeated
 * alerts for the same unresolvable name don't hammer Nominatim).
 * Never throws — returns null on any failure.
 */
export async function geocode(env: Env, query: string, deadline?: number): Promise<GeoPoint | null> {
  if (!query.trim()) return null;

  try {
    const cached = await env.DB.prepare("SELECT lat, lng FROM geocode_cache WHERE query = ?")
      .bind(query).first<{ lat: number | null; lng: number | null }>();
    if (cached) return cached.lat !== null && cached.lng !== null
      ? { lat: cached.lat, lng: cached.lng }
      : null;

    if (!(await reserveNominatimSlot(deadline))) {
      console.warn(`Skipping uncached geocode of '${query}' — not enough time budget left.`);
      return null;
    }
    const url = `${env.NOMINATIM_URL}/search?format=json&limit=${SEARCH_LIMIT}&countrycodes=bg&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: abortIn(REQUEST_TIMEOUT_MS, deadline),
    });
    if (!res.ok) {
      console.warn(`Nominatim returned ${res.status} for '${query}'`);
      return null; // transient failure — not cached
    }

    const body = (await res.json()) as NominatimHit[];
    let point: GeoPoint | null = null;
    if (Array.isArray(body)) {
      for (const hit of body) {
        if (!namesAPlace(hit)) continue;
        const lat = Number(hit?.lat);
        const lng = Number(hit?.lon);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          point = { lat, lng };
          break;
        }
      }
    }

    await env.DB.prepare(
      "INSERT OR REPLACE INTO geocode_cache (query, lat, lng, resolved_at) VALUES (?, ?, ?, ?)",
    ).bind(query, point?.lat ?? null, point?.lng ?? null, new Date().toISOString()).run();

    return point;
  } catch (e) {
    console.warn(`Geocoding failed for '${query}': ${e}`);
    return null;
  }
}

/**
 * A Nominatim query for a place name, scoped to the settlement it sits in.
 *
 * `anchor` used to be hardcoded to Варна, on the stated grounds that every
 * source we crawl is Varna-scoped. That is true of the *province* and false of
 * the city: vik publishes outages in Долни чифлик, Аврен and Тополи, so their
 * streets were being looked for in a city 40 km away — and Nominatim is happy
 * to answer with a Varna street of the same name (30.07.2026 review, the
 * Долни чифлик alert). Callers pass the settlement instead.
 *
 * A name that already contains its own anchor is not repeated, which is what
 * keeps a settlement's own lookup from becoming "Долни чифлик, Долни чифлик".
 */
export function buildGeocodeQuery(name: string, anchor = "Варна"): string {
  const scope = anchor.trim();
  if (!scope || name.toLowerCase().includes(scope.toLowerCase())) return `${name}, България`;
  return `${name}, ${scope}, България`;
}

/** Never throws — geocoding failure degrades to "no region/street matched". */
export async function reverseGeocode(
  env: Env, lat: number, lon: number, deadline?: number,
): Promise<ReverseAddress> {
  const failed: ReverseAddress =
    { ok: false, regionNames: [], streetNames: [], settlementNames: [] };
  try {
    if (!(await reserveNominatimSlot(deadline))) {
      console.warn(`Skipping reverse geocode of (${lat}, ${lon}) — not enough time budget left.`);
      return failed;
    }
    const url = `${env.NOMINATIM_URL}/reverse?format=json&lat=${lat}&lon=${lon}&addressdetails=1`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: abortIn(REQUEST_TIMEOUT_MS, deadline),
    });
    if (!res.ok) {
      console.warn(`Nominatim reverse returned ${res.status} for (${lat}, ${lon})`);
      return failed;
    }
    const body = (await res.json()) as { address?: Record<string, unknown> };
    // A 200 with no address is a real answer about a real point — open sea, or
    // somewhere OSM has nothing for. Nothing matched, but the lookup worked.
    if (!body.address) {
      return { ok: true, regionNames: [], streetNames: [], settlementNames: [] };
    }
    return {
      ok: true,
      // Same preference order as NominatimGeocodingService.cs, but every
      // level is kept so the caller can fall back down the list.
      // `locality` sits with the other sub-settlement levels because the seed now
      // carries them: the province sweep's DISTRICT_PLACES gained `locality` so
      // that м-т (местност) names get a `regions` row at all, and ~90 of them do.
      // Seeding one is only half the job — a region can be matched by an alert's
      // name and still notify nobody, because a user's `region_id` comes from
      // THIS list. Without the level here, every locality row would be a place
      // alerts can resolve to and no user can ever be registered under.
      regionNames: pickAll(body.address,
        ["suburb", "neighbourhood", "locality", "quarter", "city_district",
          "city", "town", "village"]),
      streetNames: pickAll(body.address, ["road", "pedestrian", "path"]),
      settlementNames: pickAll(body.address, ["city", "town", "village"]),
    };
  } catch (e) {
    console.warn(`Reverse geocoding failed for (${lat}, ${lon}): ${e}`);
    return failed;
  }
}
