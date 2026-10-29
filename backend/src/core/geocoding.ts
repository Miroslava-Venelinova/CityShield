// Nominatim client (docs/specification.md §1.5). Reverse geocoding backs PUT
// /api/auth/location (one uncached call per request, matching the old
// service — only forward lookups were cached). Forward geocoding backs alert
// enrichment, with the cache moved from process memory to the D1
// geocode_cache table (misses are cached too).
//
// Forward lookups fall back to Photon when Nominatim fails transiently: the same
// OSM data behind a different operator, so an OSMF outage or a 429 no longer
// leaves every unseeded name unlocated. Reverse lookups do not (§1.5 says why).
//
// Both directions go through the same ≥1,100 ms slot reservation, because OSMF's
// 1 rps limit counts requests, not lookup directions. Reverse used to skip it on
// the grounds that it is uncached and user-driven — but "user-driven" is exactly
// what makes it unbounded: PUT /location is rate limited per *user*
// (RL_GEOCODE_USER), which says nothing about how many users call it at once, so
// a busy minute could put an arbitrary number of reverse lookups on the wire
// while forward lookups politely queued behind each other.

import { getCachedGeocode, putCachedGeocode } from "../db/queries";
import type { Env } from "../env";
import { abortIn, msLeft } from "../shared/deadline";

// Nominatim ToS require a descriptive User-Agent. Photon is sent the same one:
// its demo server asks only for "reasonable" volume, and an operator deciding
// what to throttle can only be fair to a caller it can tell apart.
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

/** Which geocoder answered a forward lookup (§1.5, migration 0021). */
export type GeocodeProvider = "nominatim" | "photon";

/**
 * A forward-geocoded point and the provider that produced it. The provider rides
 * along so enrichment can record it as `coords_source`: a fallback answer that
 * leaves no trace is indistinguishable from the primary one.
 */
export interface GeocodeHit extends GeoPoint {
  provider: GeocodeProvider;
}

const MIN_SPACING_MS = 1_100;

/**
 * One outbound geocoder's slot reservation. Module scope, so it spaces out
 * consecutive uncached calls inside one isolate; across isolates the structural
 * throttle of §1.5 applies (geocoding only happens on ingest + location updates).
 *
 * A serializing tail rather than a timestamp check. Reading a shared timestamp
 * was only correct while callers were strictly sequential: two concurrent
 * geocodes both saw the same last-call time, waited the same interval, and then
 * fired simultaneously — exactly the 1 rps breach the throttle exists to
 * prevent. Chaining the waits makes the spacing hold under concurrency too.
 *
 * Photon gets a chain of its own, at the same spacing: it is a different
 * operator, and it is only asked right after Nominatim failed, so sharing
 * Nominatim's chain would make every fallback sit out the spacing of the very
 * call that just failed.
 */
function slotChain() {
  let lastCallAt = 0;
  let granted = 0;
  let tail: Promise<void> = Promise.resolve();
  return {
    /**
     * Reserve the next slot. Resolves false when the wait would not fit inside
     * the caller's budget — a skipped geocode (alert stored without
     * coordinates) is strictly better than sleeping into a mid-flight kill.
     */
    reserve(deadline?: number): Promise<boolean> {
      const result = tail.then(async () => {
        const wait = Math.max(0, lastCallAt + MIN_SPACING_MS - Date.now());
        // Needs room for the throttle wait AND the request that follows it.
        if (msLeft(deadline) < wait + 1_000) return false;
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        lastCallAt = Date.now();
        granted++;
        return true;
      });
      // The chain must not stall on a failed link, and must not surface
      // unhandled rejections to whoever happens to be next in line.
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
    granted: () => granted,
    reset(): void {
      lastCallAt = 0;
      granted = 0;
      tail = Promise.resolve();
    },
  };
}

const nominatimSlots = slotChain();
const photonSlots = slotChain();

/**
 * How many slots have been granted, i.e. how many requests this isolate has
 * actually put on the wire under the throttle.
 *
 * A test hook, in the same spirit as clearRefCaches: "was this lookup throttled"
 * is otherwise only observable as elapsed wall-clock, and `Date.now()` inside
 * workerd advances at I/O boundaries rather than continuously, so timing it
 * measures nothing reliable.
 */
export function nominatimSlotsGranted(): number {
  return nominatimSlots.granted();
}

/** As nominatimSlotsGranted, for the Photon fallback. */
export function photonSlotsGranted(): number {
  return photonSlots.granted();
}

/** Test hook: forget both geocoders' spacing, so one test's calls don't delay the next's. */
export function resetGeocodeThrottles(): void {
  nominatimSlots.reset();
  photonSlots.reset();
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
 * What one provider said about a query.
 *
 *   `answered`   a real answer: a place, or definitely none
 *   `transient`  network error, timeout, 429 or 5xx — says nothing about the
 *                query, so it is never cached and is worth asking the fallback
 *   `failed`     nothing worth retrying elsewhere: out of budget, or a request
 *                the provider refused for what it was
 */
type Answer =
  | { kind: "answered"; point: GeoPoint | null }
  | { kind: "transient"; why: string }
  | { kind: "failed" };

/** 429 and 5xx are the provider's state, not the query's. */
const isTransientStatus = (status: number): boolean => status === 429 || status >= 500;

/**
 * Forward geocode with the D1-backed cache (misses cached too, so repeated
 * alerts for the same unresolvable name don't hammer Nominatim).
 * Never throws — returns null on any failure.
 *
 * Nominatim first. Photon is asked only when Nominatim failed *transiently*: a
 * Nominatim that answered "no such place" has answered, and asking a second
 * index until one says yes is how a fuzzy match gets promoted to a pin.
 *
 * Caching keeps its semantics across both. A hit is cached with the provider
 * that produced it, so a later read still reports `photon`. Nominatim's miss is
 * cached as before. A Photon MISS is not: the primary never answered, so the
 * name is still unresolved rather than unresolvable, and caching it would keep
 * Nominatim from ever being asked again for 180 days.
 */
export async function geocode(env: Env, query: string, deadline?: number): Promise<GeocodeHit | null> {
  if (!query.trim()) return null;

  try {
    const cached = await getCachedGeocode(env, query);
    if (cached) return cached.lat !== null && cached.lng !== null
      // A row written before migration 0021 has no provider; Nominatim was the only one then.
      ? { lat: cached.lat, lng: cached.lng, provider: cached.provider ?? "nominatim" }
      : null;

    const primary = await searchNominatim(env, query, deadline);
    if (primary.kind === "answered") {
      await putCachedGeocode(env, query, primary.point, "nominatim");
      return primary.point && { ...primary.point, provider: "nominatim" };
    }
    if (primary.kind === "failed") return null;

    console.warn(`[geocode] Nominatim failed for '${query}' (${primary.why}); asking Photon.`);
    const fallback = await searchPhoton(env, query, deadline);
    if (fallback.kind === "answered" && fallback.point) {
      await putCachedGeocode(env, query, fallback.point, "photon");
      return { ...fallback.point, provider: "photon" };
    }
    if (fallback.kind === "answered") {
      console.warn(`[geocode] Photon found no place for '${query}' either; not caching the miss.`);
    }
    return null; // both down, or Photon unsure — not cached
  } catch (e) {
    console.warn(`Geocoding failed for '${query}': ${e}`);
    return null;
  }
}

async function searchNominatim(env: Env, query: string, deadline?: number): Promise<Answer> {
  if (!(await nominatimSlots.reserve(deadline))) {
    console.warn(`Skipping uncached geocode of '${query}' — not enough time budget left.`);
    return { kind: "failed" };
  }
  const url = `${env.NOMINATIM_URL}/search?format=json&limit=${SEARCH_LIMIT}&countrycodes=bg&q=${encodeURIComponent(query)}`;
  let body: unknown;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: abortIn(REQUEST_TIMEOUT_MS, deadline),
    });
    if (!res.ok) {
      console.warn(`Nominatim returned ${res.status} for '${query}'`);
      return isTransientStatus(res.status) ? { kind: "transient", why: `HTTP ${res.status}` } : { kind: "failed" };
    }
    body = await res.json();
  } catch (e) {
    // A dropped connection, the 8 s timeout, or an error page served with a 200
    // that is not JSON — symptoms of the service, not of the query.
    return { kind: "transient", why: String(e) };
  }

  if (Array.isArray(body)) {
    for (const hit of body as NominatimHit[]) {
      if (!namesAPlace(hit)) continue;
      const lat = Number(hit?.lat);
      const lng = Number(hit?.lon);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { kind: "answered", point: { lat, lng } };
    }
  }
  return { kind: "answered", point: null };
}

/**
 * Varna province, as minLon,minLat,maxLon,maxLat — the order Photon's `bbox`
 * takes. The seeded rows span 42.834–43.543 N and 27.122–28.065 E (350 regions,
 * 2,565 streets); this pads that by ~5 km. Every source we crawl publishes for
 * this province, so an answer outside it is a like-named place elsewhere —
 * the same failure the settlement anchor in buildGeocodeQuery exists to stop.
 */
const PHOTON_BBOX = "27.05,42.78,28.15,43.60";

interface PhotonFeature {
  geometry?: { coordinates?: unknown };
  properties?: { countrycode?: unknown; osm_key?: unknown; osm_value?: unknown };
}

/**
 * Photon (photon.komoot.io): OSM data like Nominatim's, behind a different
 * operator. Its demo server asks for "reasonable" volume and states no number;
 * we ask only after a Nominatim failure, one request per name, spaced like
 * Nominatim's, bounded to the province and filtered to Bulgaria.
 */
async function searchPhoton(env: Env, query: string, deadline?: number): Promise<Answer> {
  const base = env.PHOTON_URL?.trim();
  if (!base) return { kind: "failed" }; // fallback not configured
  if (!(await photonSlots.reserve(deadline))) {
    console.warn(`Skipping Photon fallback for '${query}' — not enough time budget left.`);
    return { kind: "failed" };
  }
  // The trailing country is noise here — the bbox and countrycode already say
  // it — and Photon matches every term of a query, where Nominatim parses the
  // comma list as an address.
  const q = query.replace(/,\s*България\s*$/u, "");
  const url = `${base}/api/?q=${encodeURIComponent(q)}&limit=${SEARCH_LIMIT}&bbox=${PHOTON_BBOX}&countrycode=BG`;
  let body: { features?: unknown };
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: abortIn(REQUEST_TIMEOUT_MS, deadline),
    });
    if (!res.ok) {
      console.warn(`Photon returned ${res.status} for '${query}'`);
      return { kind: "transient", why: `HTTP ${res.status}` };
    }
    body = (await res.json()) as { features?: unknown };
  } catch (e) {
    console.warn(`Photon failed for '${query}': ${e}`);
    return { kind: "transient", why: String(e) };
  }

  const features = Array.isArray(body?.features) ? (body.features as PhotonFeature[]) : [];
  for (const feature of features) {
    const props = feature?.properties ?? {};
    // Filtered here as well as asked for: a server version that ignores the
    // countrycode parameter must not be able to hand us a foreign answer.
    if (String(props.countrycode ?? "").toUpperCase() !== "BG") continue;
    // Photon's osm_key/osm_value are Nominatim's class/type under other names.
    if (!namesAPlace({ class: String(props.osm_key ?? ""), type: String(props.osm_value ?? "") })) continue;
    const coords = feature?.geometry?.coordinates;
    if (!Array.isArray(coords)) continue;
    const lng = Number(coords[0]); // GeoJSON order: [lon, lat]
    const lat = Number(coords[1]);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { kind: "answered", point: { lat, lng } };
  }
  return { kind: "answered", point: null };
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

/**
 * Never throws — geocoding failure degrades to "no region/street matched".
 *
 * Nominatim only, deliberately: the answer here is written to the user's
 * region_id/street_id, which ARE the targeting, and Photon labels address
 * levels differently (`district`/`locality` rather than `suburb`/`quarter`).
 * A mapping guessed without measurements could write a wrong region — and a
 * failed lookup already leaves the stored one standing (`ok: false`), so the
 * fallback would buy little and risk the one thing this route must not do.
 */
export async function reverseGeocode(
  env: Env, lat: number, lon: number, deadline?: number,
): Promise<ReverseAddress> {
  const failed: ReverseAddress =
    { ok: false, regionNames: [], streetNames: [], settlementNames: [] };
  try {
    if (!(await nominatimSlots.reserve(deadline))) {
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
      // Most specific level first, and every level is kept so the caller can
      // fall back down the list.
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
