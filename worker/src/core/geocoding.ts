// Nominatim client (PLAN.MD §1.5). Reverse geocoding backs PUT
// /api/auth/location (one uncached call per request, matching the old
// service — only forward lookups were cached). Forward geocoding backs alert
// enrichment, with the cache moved from process memory to the D1
// geocode_cache table (misses are cached too) and the 1 rps throttle kept as
// ≥1,100 ms spacing between uncached calls within one invocation.

import type { Env } from "../env";

// Nominatim ToS require a descriptive User-Agent.
const USER_AGENT = "CityShieldAPI/1.0";

export interface ReverseAddress {
  regionName: string | null;
  streetName: string | null;
}

function pick(address: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = address[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
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

async function throttleNominatim(): Promise<void> {
  const wait = lastNominatimCallAt + MIN_SPACING_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastNominatimCallAt = Date.now();
}

/**
 * Forward geocode with the D1-backed cache (misses cached too, so repeated
 * alerts for the same unresolvable name don't hammer Nominatim).
 * Never throws — returns null on any failure.
 */
export async function geocode(env: Env, query: string): Promise<GeoPoint | null> {
  if (!query.trim()) return null;

  try {
    const cached = await env.DB.prepare("SELECT lat, lng FROM geocode_cache WHERE query = ?")
      .bind(query).first<{ lat: number | null; lng: number | null }>();
    if (cached) return cached.lat !== null && cached.lng !== null
      ? { lat: cached.lat, lng: cached.lng }
      : null;

    await throttleNominatim();
    const url = `${env.NOMINATIM_URL}/search?format=json&limit=1&countrycodes=bg&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(10_000),
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
export async function reverseGeocode(env: Env, lat: number, lon: number): Promise<ReverseAddress> {
  const none: ReverseAddress = { regionName: null, streetName: null };
  try {
    const url = `${env.NOMINATIM_URL}/reverse?format=json&lat=${lat}&lon=${lon}&addressdetails=1`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(`Nominatim reverse returned ${res.status} for (${lat}, ${lon})`);
      return none;
    }
    const body = (await res.json()) as { address?: Record<string, unknown> };
    if (!body.address) return none;
    return {
      // Same preference order as NominatimGeocodingService.cs.
      regionName: pick(body.address, ["suburb", "neighbourhood", "city_district", "city", "town"]),
      streetName: pick(body.address, ["road", "pedestrian", "path"]),
    };
  } catch (e) {
    console.warn(`Reverse geocoding failed for (${lat}, ${lon}): ${e}`);
    return none;
  }
}
