// Port of AlertService.cs (PLAN.MD §1.5): store + enrich + match + notify.
// Preserves every behavioral guard — store before notify, the city_wide=false
// store-only rule, the bus-line narrowing, the 1,000-char push-body cap.

import * as q from "../db/queries";
import { bestMatch, SIMILARITY_THRESHOLD } from "./fuzzy";
import { buildGeocodeQuery, geocode } from "./geocoding";
import { pointInRing, type Ring, ringBBox, ringCentroid } from "./geo";
import { normalizeBusLine } from "./bus-lines";
import { type PushNotification, sendPushToTokens } from "./fcm";
import type { Env } from "../env";

// FCM's total message limit is 4 KB; keep push bodies well under it.
const MAX_NOTIFICATION_BODY_LENGTH = 1000;

// Marker color bucket per source category (danger | warning | info).
const CATEGORY_SEVERITY: Record<string, string> = {
  vik: "warning",
  epro: "warning",
  heating: "warning",
  vt: "info",
};

export interface AlertLocationDTO {
  location_name: string;
  sublocations: string[];
  is_polygon: boolean;
  polygon_geojson?: unknown; // bare GeoJSON Polygon geometry
  lat?: number;
  lng?: number;
}

export interface AlertDTO {
  id: string;
  original_message: { title: string; content: string };
  processed_data: {
    locations: AlertLocationDTO[];
    start_time: string | null;
    end_time: string | null;
  };
  source: string;
  severity: string;
  created_at: string;
}

type Json = Record<string, unknown>;

const asObject = (v: unknown): Json | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;

// ── Polygon geometry handling ─────────────────────────────────────────────────

/** Returns the Polygon geometry from either a FeatureCollection or a bare geometry (ExtractPolygonGeometry). */
function extractPolygonGeometry(location: Json): Json | null {
  const poly = asObject(location.polygon_geojson);
  if (!poly) return null;

  if ("coordinates" in poly) return poly;

  const features = poly.features;
  if (Array.isArray(features) && features.length > 0) {
    const geometry = asObject(asObject(features[0])?.geometry);
    if (geometry && "coordinates" in geometry) return geometry;
  }
  return null;
}

/** Outer ring of a GeoJSON Polygon geometry as [lng, lat] pairs, or null. */
function outerRing(geometry: Json): Ring | null {
  const coordinates = geometry.coordinates;
  if (!Array.isArray(coordinates) || !Array.isArray(coordinates[0])) return null;
  const ring: Ring = [];
  for (const coord of coordinates[0] as unknown[]) {
    if (!Array.isArray(coord) || typeof coord[0] !== "number" || typeof coord[1] !== "number")
      return null;
    ring.push([coord[0], coord[1]]);
  }
  return ring;
}

/**
 * All geometries SendUsersNotification should target: every feature geometry
 * of a FeatureCollection, or the bare geometry itself (GetUsersInPolygonRangeAsync).
 */
function allGeometries(polygonJson: Json): Json[] {
  const features = polygonJson.features;
  if (Array.isArray(features)) {
    return features
      .map((f) => asObject(asObject(f)?.geometry))
      .filter((g): g is Json => g !== null);
  }
  return "coordinates" in polygonJson ? [polygonJson] : [];
}

// ── Targeting ─────────────────────────────────────────────────────────────────

async function getUserIdsInRange(env: Env, location: Json): Promise<string[]> {
  const locationName = typeof location.location_name === "string" ? location.location_name : "";
  const region = bestMatch(locationName, await q.getRegions(env), (r) => r.name, SIMILARITY_THRESHOLD);

  const sublocations = Array.isArray(location.sublocations)
    ? location.sublocations.filter((s): s is string => typeof s === "string")
    : [];

  // Streets resolve independently of the region: scraped alerts often name only
  // a street, and street_name is globally unique, so an unmatched region must
  // not discard an otherwise perfectly good street match.
  if (sublocations.length > 0) {
    const ids = new Set<string>();
    const streets = await q.getStreets(env);
    let matchedAnyStreet = false;
    for (const streetName of sublocations) {
      const street = bestMatch(streetName, streets, (s) => s.name, SIMILARITY_THRESHOLD);
      if (!street) continue;
      matchedAnyStreet = true;
      // A boulevard can run through several regions — when we do have a region,
      // pairing the two stays the narrower (and safer) targeting.
      const matched = region
        ? await q.getUserIdsByRegionAndStreet(env, region.id, street.id)
        : await q.getUserIdsByStreet(env, street.id);
      for (const id of matched) ids.add(id);
    }
    if (matchedAnyStreet) return [...ids];
    // None of the named streets exist in our table — the street detail is
    // unusable, so fall through to region-wide rather than notifying nobody.
  }

  // No usable street: region-wide, or nothing if the region is unknown too.
  return region ? q.getUserIdsByRegion(env, region.id) : [];
}

async function getUserIdsInPolygonRange(env: Env, polygonJson: Json): Promise<string[]> {
  const ids = new Set<string>();
  for (const geometry of allGeometries(polygonJson)) {
    const ring = outerRing(geometry);
    if (!ring) continue;
    const bbox = ringBBox(ring);
    if (!bbox) continue;
    // SQL bbox prefilter, exact ray-cast on the survivors (§1.3).
    const candidates = await q.getUsersInBBox(env, bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng);
    for (const u of candidates) {
      if (pointInRing(u.latitude, u.longitude, ring)) ids.add(u.user_id);
    }
  }
  return [...ids];
}

/**
 * Port of SendUsersNotificationAsync — same decision tree, returns the
 * notified user ids. `selfUrl` enables >30-token fan-out chaining (§1.6).
 */
export async function sendUsersNotification(
  env: Env,
  locations: unknown,
  title: string,
  body: string,
  category: string,
  startTime: string | null,
  endTime: string | null,
  cityWide: boolean | null,
  busLines: string[] | null,
  selfUrl?: string,
): Promise<string[]> {
  // ── 1. Gather target users ─────────────────────────────────────────────
  let userIds: string[] = [];
  const locationArray = Array.isArray(locations) ? locations : [];

  if (locationArray.length > 0) {
    for (const raw of locationArray) {
      const location = asObject(raw);
      if (!location) continue;
      const polygonJson = asObject(location.polygon_geojson);
      if (location.is_polygon === true && polygonJson) {
        userIds.push(...await getUserIdsInPolygonRange(env, polygonJson));
      } else {
        userIds.push(...await getUserIdsInRange(env, location));
      }
    }
  } else if (cityWide === false) {
    // The scraper explicitly said this is NOT city-wide, yet no locations
    // arrived — almost certainly an LLM misparse of a street-level outage.
    // Store-only; never escalate it into a broadcast to the whole user base.
    console.warn(`Alert '${title}' (${category}) has no locations and city_wide=false — skipping notifications.`);
    return [];
  } else {
    // city_wide=true or a legacy payload without the flag: broadcast to
    // everyone; the per-category preference filter below still applies.
    userIds = await q.getAllUserIds(env);
  }

  // Alerts naming specific bus lines (vt route changes) go only to users
  // subscribed to an affected line. No subscription = no filter.
  const lines = [...new Set(
    (busLines ?? []).map(normalizeBusLine).filter((l): l is string => l !== null))];
  if (lines.length > 0 && userIds.length > 0) {
    const subscriptions = await q.getBusLineSubscriptions(env, [...new Set(userIds)]);
    userIds = subscriptions
      .filter((u) => {
        let subscribed: string[] = [];
        try {
          const parsed = JSON.parse(u.subscribed_bus_lines);
          if (Array.isArray(parsed)) subscribed = parsed.filter((x): x is string => typeof x === "string");
        } catch { /* corrupt JSON → treat as no filter */ }
        return subscribed.length === 0 || subscribed.some((l) => lines.includes(l));
      })
      .map((u) => u.user_id);
  }

  // Debug/monitoring accounts receive every alert regardless of location.
  userIds.push(...await q.getReceivesAllUserIds(env));

  // ── 2. Filter to users who have this category enabled ─────────────────
  const allIds = [...new Set(userIds)];
  const disabled = new Set(await q.getDisabledUserIds(env, allIds, category));
  const filteredIds = allIds.filter((id) => !disabled.has(id));
  if (filteredIds.length === 0) return filteredIds;

  // ── 3. FCM data payload — all values must be strings ───────────────────
  const fcmData = {
    category,
    startTime: startTime ?? "",
    endTime: endTime ?? "",
  };

  // ── 4. Notification body with time info appended ───────────────────────
  let fullBody = body;
  if (startTime || endTime) {
    fullBody += startTime && endTime ? ` (${startTime} – ${endTime})`
      : startTime ? ` (from ${startTime})`
      : ` (until ${endTime})`;
  }
  // Scraped content is unbounded, but FCM rejects oversized payloads —
  // cap the push body.
  if (fullBody.length > MAX_NOTIFICATION_BODY_LENGTH)
    fullBody = fullBody.slice(0, MAX_NOTIFICATION_BODY_LENGTH - 1) + "…";

  // ── 5. Send ────────────────────────────────────────────────────────────
  const notification: PushNotification = { title, body: fullBody, data: fcmData };
  const tokens = await q.getTokensForUsers(env, filteredIds);
  if (tokens.length > 0) await sendPushToTokens(env, tokens, notification, selfUrl);

  return filteredIds;
}

// ── Alert storage (map/read side) ─────────────────────────────────────────────

export async function storeAlert(
  env: Env,
  category: string,
  title: string,
  content: string,
  startTime: string | null,
  endTime: string | null,
  locations: unknown,
): Promise<string> {
  const enriched = await enrichLocations(env, locations);
  const id = crypto.randomUUID();
  await q.insertAlert(env, {
    id,
    category,
    title,
    content,
    severity: CATEGORY_SEVERITY[category] ?? "info",
    start_time: startTime,
    end_time: endTime,
    locations_json: JSON.stringify(enriched),
    created_on_utc: new Date().toISOString(),
  });
  return id;
}

export async function getRecentAlerts(env: Env, maxAgeMs: number, limit: number): Promise<AlertDTO[]> {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const rows = await q.getRecentAlertRows(env, cutoff, limit);
  return rows.map((row) => ({
    id: row.id,
    original_message: { title: row.title, content: row.content },
    processed_data: {
      locations: deserializeLocations(row),
      start_time: row.start_time,
      end_time: row.end_time,
    },
    source: row.category,
    severity: row.severity,
    created_at: row.created_on_utc,
  }));
}

function deserializeLocations(row: q.AlertRow): AlertLocationDTO[] {
  // Tolerate corrupt locations JSON by returning [] for that alert.
  try {
    const parsed = JSON.parse(row.locations_json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    console.warn(`Corrupt locations JSON on alert ${row.id}`);
    return [];
  }
}

// ── Location enrichment ───────────────────────────────────────────────────────

/**
 * Converts the raw scraper locations into DTOs carrying coordinates: polygon
 * locations get their centroid, everything else is resolved by fuzzy-matching
 * names against the regions/streets tables and forward-geocoding the
 * canonical name via Nominatim. Never throws — an alert without coordinates
 * is still worth storing.
 */
async function enrichLocations(env: Env, locations: unknown): Promise<AlertLocationDTO[]> {
  const result: AlertLocationDTO[] = [];
  if (!Array.isArray(locations)) return result;

  for (const raw of locations) {
    const location = asObject(raw);
    if (!location) continue;

    const dto: AlertLocationDTO = {
      location_name: typeof location.location_name === "string" ? location.location_name : "",
      sublocations: Array.isArray(location.sublocations)
        ? location.sublocations.filter((s): s is string => typeof s === "string")
        : [],
      is_polygon: location.is_polygon === true,
    };

    // Normalize the polygon to a bare GeoJSON geometry — the scraper sends a
    // FeatureCollection, the app expects {type, coordinates}.
    const geometry = extractPolygonGeometry(location);
    if (geometry) {
      dto.polygon_geojson = geometry;
      const ring = outerRing(geometry);
      const centroid = ring ? ringCentroid(ring) : null;
      if (centroid) {
        dto.lat = centroid.lat;
        dto.lng = centroid.lng;
      }
    } else {
      dto.is_polygon = false; // polygon was requested but not built
      const point = await resolveCoordinates(env, dto);
      if (point) {
        dto.lat = point.lat;
        dto.lng = point.lng;
      }
    }

    result.push(dto);
  }

  return result;
}

const LOCATION_PREFIXES = ["ул. ", "бул. ", "ж.к. ", "кв. ", "с. ", "гр. ", "м-т ", "к.к. "];

function stripLocationPrefix(name: string): string {
  const lower = name.toLowerCase();
  for (const prefix of LOCATION_PREFIXES)
    if (lower.startsWith(prefix)) return name.slice(prefix.length).trim();
  return name.trim();
}

/**
 * Geocoding strategy (ResolveCoordinatesAsync): canonicalize names against
 * our own DB first (trigram fuzzy match), then ask Nominatim. Street-level
 * pin when a street is listed, otherwise district/locality-level.
 */
async function resolveCoordinates(env: Env, dto: AlertLocationDTO) {
  // 1. Street-level: first sublocation that geocodes wins
  for (const raw of dto.sublocations.slice(0, 3)) {
    const street = bestMatch(raw, await q.getStreets(env), (s) => s.name, SIMILARITY_THRESHOLD)?.name
      ?? stripLocationPrefix(raw);
    const point = await geocode(env, buildGeocodeQuery(street));
    if (point) return point;
  }

  // 2. District / locality level
  if (dto.location_name.trim()) {
    const region = bestMatch(dto.location_name, await q.getRegions(env), (r) => r.name, SIMILARITY_THRESHOLD)?.name
      ?? stripLocationPrefix(dto.location_name);
    return geocode(env, buildGeocodeQuery(region));
  }

  return null;
}
