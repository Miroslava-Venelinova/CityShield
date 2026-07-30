// Port of AlertService.cs (SPEC.md §1.5): store + enrich + match + notify.
// Preserves every behavioral guard — store before notify, the city_wide=false
// store-only rule, the bus-line narrowing, the 1,000-char push-body cap.

import * as q from "../db/queries";
import { matchRegion, matchStreet, parseName, placeClass } from "./place-names";
import { buildGeocodeQuery, geocode, type GeoPoint } from "./geocoding";
import { pointInRing, type Ring, ringBBox, ringCentroid } from "./geo";
import { normalizeBusLine } from "./bus-lines";
import { type PushNotification, sendPushToUsers } from "./onesignal";
import { type AlertWindows, formatWindow, parseWindows } from "../shared/datetime";
import type { Env } from "../env";

// Push payloads are size-limited by the provider (and by Android below it);
// keep bodies well under any of those ceilings.
const MAX_NOTIFICATION_BODY_LENGTH = 1000;

// The title is scraped straight off the source page — an <h1> or an accordion
// header — so its length is whatever that page says it is. The body has been
// capped since the port; the title was not, which left one unbounded field in
// a payload the provider rejects wholesale if it gets too big. A notification
// heading is a single line on a phone either way.
const MAX_NOTIFICATION_TITLE_LENGTH = 120;

/** Trim to `max` characters, marking the cut so a clipped value doesn't read as the whole thing. */
function clamp(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

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
  /** Set when the message hedged ("в района на …") and the streets below were
   *  used to locate the area rather than to bound it (normalize.ts A6). Display
   *  is unchanged; this records why targeting was region-wide. */
  region_wide?: boolean;
  polygon_geojson?: unknown; // bare GeoJSON Polygon geometry
  lat?: number;
  lng?: number;
}

export interface AlertDTO {
  id: string;
  original_message: { title: string; content: string };
  processed_data: {
    locations: AlertLocationDTO[];
    /** Envelope — what a client that ignores `windows` still gets right for a
     *  single-day alert, and approximately right for anything else. */
    start_time: string | null;
    end_time: string | null;
    /** Present (non-null) only when the envelope loses detail: a window that
     *  repeats each day of a range, or several windows in one day. */
    windows: AlertWindows | null;
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
  const region = matchRegion(locationName, await q.getRegions(env));

  const sublocations = Array.isArray(location.sublocations)
    ? location.sublocations.filter((s): s is string => typeof s === "string")
    : [];

  // "в района на ул. X, ул. Y" (A6) names streets to say where the outage is,
  // not who is in it: a resident one street over is affected just as much, and
  // the message never says how far it reaches. Target the whole region instead.
  //
  // Only when a region actually resolved, though. Vik routinely names streets
  // and no district at all, and there is no street→region link in the schema to
  // recover one — so with nothing to widen *to*, the named streets are still a
  // far better audience than nobody.
  const areaOnly = location.region_wide === true && region !== null;

  // Streets resolve independently of the region: scraped alerts often name only
  // a street, and street_name is globally unique, so an unmatched region must
  // not discard an otherwise perfectly good street match.
  if (sublocations.length > 0 && !areaOnly) {
    const streets = await q.getStreets(env);
    const streetIds = new Set<number>();
    for (const streetName of sublocations) {
      const street = matchStreet(streetName, streets);
      if (street) streetIds.add(street.id);
    }
    // All matched streets resolve in one query rather than one query each.
    if (streetIds.size > 0) return q.getUserIdsByStreets(env, [...streetIds], region?.id ?? null);
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

export interface NotifyResult {
  /** The post-filter audience the push was addressed to. */
  recipients: string[];
  /** false only when a send to a non-empty audience hit a retryable transport
   *  failure and is worth re-driving. True when there was nobody to notify or
   *  OneSignal accepted the send (see PushResult.ok). */
  delivered: boolean;
}

/**
 * One alert, as both halves of the store-then-notify pair see it.
 *
 * An object rather than the positional list this used to be: the two functions
 * take the same nine values, `windows` made it ten, and four of them are
 * `string | null` in a row — a swapped pair would have typechecked.
 */
export interface AlertPayload {
  category: string;
  title: string;
  content: string;
  /** Raw scraper locations; enriched on store, matched on notify. */
  locations: unknown;
  /** Envelope bounds — ISO local datetimes (shared/datetime.ts). */
  startTime: string | null;
  endTime: string | null;
  /** Daily recurrence / multiple windows, when the envelope loses them. */
  windows: AlertWindows | null;
  /** Notify-only: null means "legacy payload", which broadcasts. */
  cityWide: boolean | null;
  /** Notify-only: narrows a route-change alert to subscribers of those lines. */
  busLines: string[] | null;
}

/**
 * Port of SendUsersNotificationAsync — same decision tree, returns the
 * notified user ids plus whether delivery succeeded (so a caller that owns
 * retry can distinguish "sent" from "send failed, try again").
 */
export async function sendUsersNotification(env: Env, alert: AlertPayload): Promise<NotifyResult> {
  const { category, title, content: body, locations, cityWide, busLines } = alert;

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
    return { recipients: [], delivered: true };
  } else {
    // city_wide=true or a legacy payload without the flag: broadcast to
    // everyone; the per-category preference filter below still applies.
    //
    // Logged at warn because this is the widest thing the pipeline can do, and
    // the decision behind it was made by an LLM reading a third-party page —
    // so a source that starts publishing differently (or is tampered with)
    // shows up here as a broadcast that should not have been one, rather than
    // as an unexplained push to the whole user base.
    userIds = await q.getAllUserIds(env);
    console.warn(
      `Alert '${clamp(title, 80)}' (${category}) is city-wide — broadcasting to `
      + `${userIds.length} user(s).`);
  }

  // Alerts naming specific bus lines (vt route changes) go only to users
  // subscribed to an affected line. No subscription = no filter.
  const lines = [...new Set(
    (busLines ?? []).map(normalizeBusLine).filter((l): l is string => l !== null))];
  if (lines.length > 0 && userIds.length > 0) {
    const affected = new Set(lines);
    // Only users who actually picked lines are returned; everyone else has no
    // filter and stays in the audience.
    const excluded = new Set<string>();
    for (const u of await q.getBusLineSubscriptions(env, [...new Set(userIds)])) {
      let subscribed: string[] = [];
      try {
        const parsed = JSON.parse(u.subscribed_bus_lines);
        if (Array.isArray(parsed)) subscribed = parsed.filter((x): x is string => typeof x === "string");
      } catch { /* corrupt JSON → treat as no filter */ }
      if (subscribed.length > 0 && !subscribed.some((l) => affected.has(l))) excluded.add(u.user_id);
    }
    userIds = userIds.filter((id) => !excluded.has(id));
  }

  // Debug/monitoring accounts receive every alert regardless of location.
  userIds.push(...await q.getReceivesAllUserIds(env));

  // ── 2. Filter to users who have this category enabled ─────────────────
  const allIds = [...new Set(userIds)];
  const disabled = new Set(await q.getDisabledUserIds(env, allIds, category));
  const filteredIds = allIds.filter((id) => !disabled.has(id));
  // Nobody to notify is a delivered outcome, not a failure to retry.
  if (filteredIds.length === 0) return { recipients: filteredIds, delivered: true };

  // ── 3. Push data payload — all values must be strings ──────────────────
  const pushData = {
    category,
    startTime: alert.startTime ?? "",
    endTime: alert.endTime ?? "",
  };

  // ── 4. Notification body with time info appended ───────────────────────
  // start/end are ISO local datetimes; render them compactly (e.g.
  // "27.07 08:00 – 17:00") rather than pasting the raw ISO into the push. A
  // daily recurrence renders from `windows` instead — its envelope would read
  // as one 55-hour outage.
  let fullBody = body;
  const window = formatWindow(alert.startTime, alert.endTime, alert.windows);
  if (window) fullBody += ` (${window})`;
  // Scraped content is unbounded, but oversized payloads are rejected —
  // cap both fields the source controls.
  fullBody = clamp(fullBody, MAX_NOTIFICATION_BODY_LENGTH);

  // ── 5. Send ────────────────────────────────────────────────────────────
  // Users are addressed by id (OneSignal external_id), so there is no device
  // lookup here — the provider resolves users to devices.
  const notification: PushNotification = {
    title: clamp(title, MAX_NOTIFICATION_TITLE_LENGTH),
    body: fullBody,
    data: pushData,
  };
  const result = await sendPushToUsers(env, filteredIds, notification);

  return { recipients: filteredIds, delivered: result.ok };
}

// ── Alert storage (map/read side) ─────────────────────────────────────────────

/**
 * Store an alert, idempotent per source message when a sourceRef is given.
 *
 * A stable sourceRef ("<category>:id=<n>") lets a re-driven message find its
 * already-stored alert instead of duplicating it — the read side of the
 * lost-push fix (see ingestAlert). Manual /submit-data injections pass null:
 * they have no source message and always store a fresh row.
 */
export async function storeAlert(
  env: Env, alert: AlertPayload, sourceRef: string | null, deadline?: number,
): Promise<q.StoredAlert> {
  const enriched = await enrichLocations(env, alert.locations, deadline);
  return q.insertAlert(env, {
    id: crypto.randomUUID(),
    category: alert.category,
    title: alert.title,
    content: alert.content,
    severity: CATEGORY_SEVERITY[alert.category] ?? "info",
    start_time: alert.startTime,
    end_time: alert.endTime,
    windows_json: alert.windows === null ? null : JSON.stringify(alert.windows),
    locations_json: JSON.stringify(enriched),
    created_on_utc: new Date().toISOString(),
    source_ref: sourceRef,
    notified_at: null,
  });
}

/** Stamp an alert's delivery time once its push has landed (idempotency flag). */
export function markAlertNotified(env: Env, alertId: string): Promise<void> {
  return q.markAlertNotified(env, alertId);
}

/** Record a failed push attempt for an alert; returns the running total. */
export function incrementPushAttempts(env: Env, alertId: string): Promise<number> {
  return q.incrementPushAttempts(env, alertId);
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
      windows: parseWindows(row.windows_json),
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
async function enrichLocations(
  env: Env, locations: unknown, deadline?: number,
): Promise<AlertLocationDTO[]> {
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
    if (location.region_wide === true) dto.region_wide = true;

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
      const point = await resolveCoordinates(env, dto, deadline);
      if (point) {
        dto.lat = point.lat;
        dto.lng = point.lng;
      }
    }

    result.push(dto);
  }

  return result;
}

/**
 * The name to hand Nominatim when our own tables did not recognise it.
 *
 * Nominatim indexes places by their plain name, so the written kind is noise
 * that costs matches — and `parseName` knows every spelling the sources use,
 * where the old hardcoded prefix list only knew the canonical eight.
 */
function geocodableName(name: string): string {
  const { core } = parseName(name);
  return core || name.trim();
}

/**
 * The settlement a location sits in, as a scope for Nominatim.
 *
 * A "гр." or "с." names a settlement in its own right, so it *is* the scope —
 * Долни чифлик is not inside Варна, and scoping it there is what sent an
 * unseeded village street to a like-named street in the city. Everything else
 * (кв., ж.к., м-т, к.к., or a bare name we cannot classify) keeps the Варна
 * scope the sources are written against, which is also the previous behaviour
 * for every location that has one.
 */
function settlementOf(locationName: string): string {
  const { kind, core } = parseName(locationName);
  const cls = placeClass(kind);
  return (cls === "city" || cls === "village") && core ? core : "Варна";
}

/**
 * The seeded centroid for a matched reference row, when it has one.
 *
 * Reference rows carry coordinates since migration 0005, so a name we already
 * recognize needs no network call at all — which keeps Nominatim's 1,100 ms
 * throttle and 8 s timeout off the ingest deadline budget on the common path.
 * A row seeded before the coordinates existed returns null and falls through
 * to Nominatim exactly as before.
 */
function seededPoint(row: q.NamedRow | null): GeoPoint | null {
  return row && row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : null;
}

/**
 * Geocoding strategy (ResolveCoordinatesAsync): canonicalize names against
 * our own DB first (trigram fuzzy match), then ask Nominatim.
 *
 * Region-first for the pin: when a location names a district/locality it
 * usually lists several streets within it, and dropping the pin on one of
 * them reads as "the outage is here" when it spans the whole area — so the
 * region centroid is the better marker. Streets are only used when no region
 * was given (or the named region resolves to nothing). This is the pin only;
 * notification targeting stays street-first — see getUserIdsInRange.
 */
async function resolveCoordinates(env: Env, dto: AlertLocationDTO, deadline?: number) {
  // Everything this location looks up is searched inside its own settlement,
  // so a village street is never resolved against the like-named city one.
  const settlement = settlementOf(dto.location_name);

  // 1. District / locality level: a named region pins the whole area.
  if (dto.location_name.trim()) {
    const match = matchRegion(dto.location_name, await q.getRegions(env));
    const seeded = seededPoint(match);
    if (seeded) return seeded;

    const point = await geocode(
      env, buildGeocodeQuery(match?.name ?? geocodableName(dto.location_name), settlement), deadline);
    if (point) return point;
    // Region named but unresolvable — fall through to the streets rather than
    // leaving the alert with no pin at all.
  }

  // 2. Street-level fallback: first sublocation that resolves wins.
  const candidates = dto.sublocations.slice(0, 3);
  if (candidates.length > 0) {
    const streets = await q.getStreets(env); // hoisted: constant across the loop
    for (const raw of candidates) {
      const match = matchStreet(raw, streets);
      const seeded = seededPoint(match);
      // A seeded street row is a *Варна* street (the streets seed covers the
      // city only), so it is not this location's street when the location is
      // some other settlement — take the name but let Nominatim place it.
      if (seeded && settlement === "Варна") return seeded;

      const point = await geocode(
        env, buildGeocodeQuery(match?.name ?? geocodableName(raw), settlement), deadline);
      if (point) return point;
    }
  }

  return null;
}
