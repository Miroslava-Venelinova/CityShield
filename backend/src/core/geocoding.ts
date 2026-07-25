// Nominatim client (PLAN.MD §1.5). Reverse geocoding backs PUT
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
    const url = `${env.NOMINATIM_URL}/search?format=json&limit=1&countrycodes=bg&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: abortIn(REQUEST_TIMEOUT_MS, deadline),
    });
    if (!res.ok) {
      console.warn(`Nominatim returned ${res.status} for '${query}'`);
      return null; // transient failure — not cached
    }

    const body = (await res.json()) as Array<{ lat?: string; lon?: string }>;
    let point: GeoPoint | null = null;
    if (Array.isArray(body) && body.length > 0) {
      const lat = Number(body[0]?.lat);
      const lng = Number(body[0]?.lon);
      if (Number.isFinite(lat) && Number.isFinite(lng)) point = { lat, lng };
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

/** All current sources are Varna-scoped, so anchor every query there (AlertService.BuildQuery). */
export function buildGeocodeQuery(name: string): string {
  return name.toLowerCase().includes("варна")
    ? `${name}, България`
    : `${name}, Варна, България`;
}

/** Never throws — geocoding failure degrades to "no region/street matched". */
export async function reverseGeocode(
  env: Env, lat: number, lon: number, deadline?: number,
): Promise<ReverseAddress> {
  const none: ReverseAddress = { regionNames: [], streetNames: [] };
  try {
    if (!(await reserveNominatimSlot(deadline))) {
      // No region/street match, coordinates still saved — the same degradation
      // the caller already handles for an unreachable Nominatim.
      console.warn(`Skipping reverse geocode of (${lat}, ${lon}) — not enough time budget left.`);
      return none;
    }
    const url = `${env.NOMINATIM_URL}/reverse?format=json&lat=${lat}&lon=${lon}&addressdetails=1`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: abortIn(REQUEST_TIMEOUT_MS, deadline),
    });
    if (!res.ok) {
      console.warn(`Nominatim reverse returned ${res.status} for (${lat}, ${lon})`);
      return none;
    }
    const body = (await res.json()) as { address?: Record<string, unknown> };
    if (!body.address) return none;
    return {
      // Same preference order as NominatimGeocodingService.cs, but every
      // level is kept so the caller can fall back down the list.
      regionNames: pickAll(body.address,
        ["suburb", "neighbourhood", "quarter", "city_district", "city", "town", "village"]),
      streetNames: pickAll(body.address, ["road", "pedestrian", "path"]),
    };
  } catch (e) {
    console.warn(`Reverse geocoding failed for (${lat}, ${lon}): ${e}`);
    return none;
  }
}
