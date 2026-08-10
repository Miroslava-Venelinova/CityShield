// Port of AlertService.cs (SPEC.md §1.5): store + enrich + match + notify.
// Preserves every behavioral guard — store before notify, the city_wide=false
// store-only rule, the bus-line narrowing, the 1,000-char push-body cap.

import * as q from "../db/queries";
import { cityCenter, matchRegion, matchStreet, parseName, placeClass } from "./place-names";
import { buildGeocodeQuery, geocode, type GeoPoint } from "./geocoding";
import { distanceKm, distanceToRingM, type Ring, ringBBox, ringCentroid } from "./geo";
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
  /** The settlement slot (schemas.ts): "гр. Варна", "с. Аврен", or null. */
  settlement: string | null;
  /** The area inside it — "кв. Виница", "м-т Ваялар" — or null. */
  area: string | null;
  /**
   * Derived display fields, kept because the shipped app reads them
   * (frontend/src/services/api.ts) and every alert stored before the three-slot
   * split holds this pair inside locations_json. `location_name` is the most
   * specific place named, which is what the flat schema always meant by it, so
   * old rows and old clients keep rendering unchanged.
   */
  location_name: string;
  sublocations: string[];
  is_polygon: boolean;
  /** Set when the message hedged ("в района на …") and the streets below were
   *  used to locate the area rather than to bound it (normalize.ts A6). Display
   *  is unchanged; this records why targeting was region-wide. */
  region_wide?: boolean;
  /**
   * A polygon was asked for and the build produced none.
   *
   * `is_polygon` has to be cleared in that case — every reader downstream treats
   * it as "there is geometry here", and targeting an empty ring notifies nobody
   * — but clearing it alone erased the fact that a block was ever requested. The
   * stored row then read exactly like a message that never mentioned one, which
   * is how the 08.08.2026 review came to blame the AI for four failures the
   * deterministic A2 guard had gotten right: 252 of 252 stored locations carried
   * `is_polygon: false`, and nothing distinguished the two populations.
   *
   * Rides inside `locations_json`, so it needs no migration, and it is what
   * makes the review tool's `polygon flagged, no geometry` badge reachable.
   */
  polygon_failed?: boolean;
  /** Why the build failed, from BlockPolygonResult.reason — "only 2/4 street
   *  names resolved", "the streets enclose no block". Paired with the flag
   *  above so a reviewer gets the cause, not just the fact. */
  polygon_failure?: string;
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

/** One location's three slots, plus the A6 marker. */
interface LocationSlots {
  settlement: string | null;
  area: string | null;
  streets: string[];
  region_wide: boolean;
}

/**
 * Read a location in either shape.
 *
 * Targeting runs on whatever the caller sent: the crawler hands over
 * normalize.ts's three slots, but /api/alerts/submit-data passes
 * `processed_data.locations` straight through (api/alerts.ts), so the flat
 * (location_name, sublocations) pair is still a live input and not merely a
 * historical one. It maps on without a guess — a flat `location_name` was the
 * most specific place the message named, which is what `area` is.
 */
function readLocation(location: Json): LocationSlots {
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() !== "" ? v : null;
  const list = (v: unknown): string[] | null =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : null;

  const hasSlots = "settlement" in location || "area" in location;
  return {
    settlement: hasSlots ? str(location.settlement) : null,
    area: hasSlots ? str(location.area) : str(location.location_name),
    // `sublocations` is also the fallback for an enriched DTO fed back in, which
    // carries the slots but keeps its street list under the display name.
    streets: list(location.streets) ?? list(location.sublocations) ?? [],
    region_wide: location.region_wide === true,
  };
}

/**
 * Why one location's audience came out the way it did.
 *
 * Deliberately the same shape tools/alert-review/targeting.py records, because
 * the two are meant to stay comparable: that simulator recomputed the 08.08.2026
 * review's reach numbers offline, weeks after the fact, against a 5-row users
 * table — and it could, only because the Worker itself had never said a word
 * about any of it. Every failure in ACCURACY.md terminates in an empty audience
 * and a pipeline that reports success.
 *
 * Built unconditionally (it is four fields and a string), logged only when the
 * audience is empty or the resolution escaped its settlement.
 */
interface TargetTrace {
  label: string;
  method: "polygon" | "streets" | "region" | "settlement" | "none";
  settlement: string | null;
  region: string | null;
  streets: Array<{ named: string; matched: string | null }>;
  note: string;
}

/** One line per location, compact enough to read in `wrangler tail`. */
function formatTrace(t: TargetTrace): string {
  const streets = t.streets.length === 0 ? "" : "; streets " + t.streets
    .map((s) => `${s.named}→${s.matched ?? "✗"}`).join(", ");
  return `[${t.method}] "${t.label}" settlement=${t.settlement ?? "∅"} `
    + `region=${t.region ?? "∅"}${streets} — ${t.note}`;
}

async function getUserIdsInRange(
  env: Env, location: Json, trace: TargetTrace,
): Promise<string[]> {
  const { settlement: settlementName, area, streets: named, region_wide } = readLocation(location);
  const regions = await q.getRegions(env);

  // The settlement is resolved first because the area's resolution depends on
  // it: since migration 0017 two settlements can hold a district of the same
  // name, and the slot is the only thing that says which one is meant.
  const settlement = settlementScope(settlementName, area, regions);
  trace.settlement = settlement?.name ?? null;

  // The audience is the most specific place named. That is what the flat schema
  // put in location_name, so splitting the slots left this resolution identical
  // apart from the scope.
  const region = matchRegion(
    area ?? settlementName ?? "", regions, undefined, settlement?.id);
  trace.region = region?.name ?? null;

  // `matchRegion` treats its scope as a preference and retries unscoped when the
  // scope matches nothing — it has to, because 171 of 260 seeded regions carry no
  // settlement link and a hard filter would make them unreachable. The cost is
  // §2.4: "гр. Вълчи дол – улиците: Васил Левски" filed the street as the area,
  // matched nothing in Вълчи дол, and the retry found VARNA's Васил Левски, 50 km
  // away. That is a mis-target, not an under-target, which is the worse
  // direction, and nothing said it had happened.
  //
  // Detected here rather than inside the matcher deliberately: the retry itself
  // is routine and on a hot path, while a retry whose answer landed in ANOTHER
  // settlement is both rare and always worth reading. The three shapes below are
  // all legitimately "inside this settlement" — the settlement's own row, a
  // district linked to it, and a row with no link at all (pre-0016 data, which
  // cannot be judged either way).
  if (settlement !== null && region !== null
    && region.id !== settlement.id
    && region.settlement_id !== null && region.settlement_id !== undefined
    && region.settlement_id !== settlement.id) {
    const parent = regions.find((r) => r.id === region.settlement_id);
    console.warn(
      `[targeting] "${area ?? settlementName}" resolved to "${region.name}" in `
      + `${parent?.name ?? `settlement ${region.settlement_id}`}, outside the stated `
      + `settlement ${settlement.name} — scoped match found nothing and the unscoped retry won.`);
  }

  // "в района на ул. X, ул. Y" (A6) names streets to say where the outage is,
  // not who is in it: a resident one street over is affected just as much, and
  // the message never says how far it reaches. Target the whole region instead.
  //
  // Only when an AREA resolved, though. Vik routinely names streets under a bare
  // city, and widening those to the entire settlement is not what the hedge
  // claimed — before the split the city simply failed to resolve and the streets
  // were kept, which is the behaviour worth preserving now that a settlement is
  // present on every entry.
  const areaOnly = region_wide && area !== null && region !== null;

  // Streets resolve independently of the *region*: scraped alerts often name
  // only a street, so an unmatched region must not discard an otherwise
  // perfectly good street match.
  //
  // They do not resolve independently of the settlement. Street names repeat
  // across settlements (52% of the names around Тополи, Аврен and Долни чифлик
  // are also Varna street names), and this is the path where that used to go
  // wrong: with no region resolved — routine for vik, which names streets and no
  // district — the query became `street_id IN (…)` over the whole table, so an
  // outage on a Долни чифлик street notified Varna residents of the like-named
  // one 30 km away.
  //
  // An unresolvable settlement scopes to nothing rather than to everything:
  // falling back to an unscoped match here would restore exactly that bug, on
  // exactly the inputs that trigger it. The alert still reaches the region below.
  if (named.length > 0 && !areaOnly && settlement !== null) {
    const streets = await q.getStreets(env);
    const streetIds = new Set<number>();
    for (const streetName of named) {
      const street = matchStreet(streetName, streets, settlement.id);
      trace.streets.push({ named: streetName, matched: street?.name ?? null });
      if (street) streetIds.add(street.id);
    }
    // All matched streets resolve in one query rather than one query each.
    if (streetIds.size > 0) {
      trace.method = "streets";
      trace.note = `${streetIds.size} of ${named.length} named street(s) matched`;
      const ids = [...streetIds];
      // Pairing the street list with the region narrows a boulevard that runs
      // through several districts to the one named, and carries that region's
      // street-less users along. Right when the region IS a district — and wrong
      // when it is the settlement, because users register under districts and
      // never under "Варна", so `region_id = Варна` would drop every
      // district-registered user the street list just matched.
      if (region !== null && region.id !== settlement.id) {
        return q.getUserIdsByStreets(env, ids, region.id);
      }
      // So the settlement case takes the two halves apart instead of losing one.
      // The street match stands alone — the ids were resolved inside this
      // settlement's scope, so they cannot reach a like-named street elsewhere —
      // and the street-less users are added back by region rather than used to
      // constrain it. Villages are why that second half matters: there the
      // settlement row IS the region people register under, so AND-ing it was
      // harmless and dropping it silently stopped notifying them.
      const onStreet = await q.getUserIdsByStreets(env, ids, null);
      if (region === null) return onStreet;
      return [...new Set([...onStreet, ...await q.getUserIdsUnplacedInRegion(env, region.id)])];
    }
    // None of the named streets exist in our table — the street detail is
    // unusable, so fall through to region-wide rather than notifying nobody.
    trace.note = "none of the named streets exist in the streets table";
  } else if (named.length > 0 && areaOnly) {
    trace.streets = named.map((s) => ({ named: s, matched: null }));
    trace.note = "the message hedged (в района на …), so the streets locate the area "
      + "rather than bound it";
  } else if (named.length > 0 && settlement === null) {
    trace.streets = named.map((s) => ({ named: s, matched: null }));
    trace.note = "no settlement resolved, so no street lookup is possible";
  }

  // No usable street: region-wide, or nothing if the region is unknown too.
  if (region === null) {
    trace.method = "none";
    trace.note = (trace.note ? trace.note + " → " : "") + "no region matched either";
    return [];
  }
  return getUserIdsByRegionWide(env, region, regions, trace);
}

/**
 * How far from a settlement's centroid a user with NO region of their own still
 * counts as inside it.
 *
 * Only ever applied to users we cannot place any other way — see
 * getUnplacedUsersInBBox — so the risk it carries is a village resident with no
 * region hearing about a city outage, not a wrong audience for anyone we can
 * already place.
 *
 * 9 km is the same number place-names.ts's in-city tie-break uses, and it is
 * measured the same way: Варна's own seeded streets sit at a median of 3.5 km
 * from the centroid, and their 95th percentile is 10.7. Deliberately tighter
 * than CITY_WIDE_RADIUS_KM (15 km), which answers a different question — that
 * one decides how far a stated city-wide broadcast reaches, this one decides who
 * counts as being in the city at all.
 */
const SETTLEMENT_REACH_KM = 9;

/**
 * The audience for a region, widened to the whole settlement when the region IS
 * one that holds districts — except for the city, which is not an audience at
 * all (see below).
 *
 * `getUserIdsByRegion` is `WHERE region_id = ?`, which is exactly right for a
 * district and close to useless for a settlement that holds any. A user's
 * region_id comes from reverse geocoding most-specific-first — suburb,
 * neighbourhood, quarter, city_district, city, … (core/geocoding.ts) — so
 * anyone inside a settlement we seed districts for resolves to their DISTRICT
 * and never to the settlement. The settlement row matched only the residue whose
 * reverse geocode hit no district we seed, so a settlement-wide alert reached
 * almost nobody, silently (§3.1).
 *
 * Villages were never affected: there is no district level under them, so the
 * settlement row is what their residents register under and `region_id = ?` is
 * the whole answer. That is also the test — a region that no seeded row claims
 * as its parent is a leaf, and the plain query stands. For a small town like
 * Белослав, where we hold three districts and most of the town is not in one,
 * the union of the settlement row and its districts is both correct and
 * complete.
 *
 * The two halves are unioned rather than swapped because they catch different
 * people: the region set reaches everyone we placed, and the radius reaches the
 * residue we could not place but can still measure.
 */
async function getUserIdsByRegionWide(
  env: Env, region: q.NamedRow, regions: readonly q.NamedRow[], trace: TargetTrace,
): Promise<string[]> {
  // §5.1, decided 10.08.2026: **a failed extraction notifies nobody.**
  //
  // The city is the one settlement where "the settlement, and nothing more
  // specific" is never a statement the sources make. A genuine whole-city outage
  // is published in words ("всички абонати", "цялата Варна") and A3/A8 route it
  // to `city_wide`, which has its own fan-out. So a location that resolves to
  // the city row with no area and no matched street is, by construction, a
  // district that got lost — either the model dropped it (§2.7) or every named
  // street failed to match — and A3's own docblock has said so since 28.07:
  // "region-wide Варна reaches far fewer people than it should, but never people
  // the message was not about."
  //
  // Widening it to the city's ~90 districts would have inverted exactly that
  // trade: a city-sized push decided by an extraction we already know failed.
  // Reaching nobody is the wrong outcome too — but it is the recoverable one,
  // and it is now loud (F1) instead of silent, which is the difference that
  // matters. Villages and towns are unaffected; only the settlement that owns
  // the city-wide path is excluded from being an audience by name alone.
  if (parseName(region.name).core.toLowerCase() === DEFAULT_SETTLEMENT.toLowerCase()) {
    trace.method = "none";
    trace.note = (trace.note ? trace.note + " → " : "")
      + `${region.name} alone is not an audience: a whole-city outage is published as `
      + `city-wide, so this is a lost district. Notifying nobody.`;
    return [];
  }

  const districts = regions.filter((r) => r.settlement_id === region.id && r.id !== region.id);
  if (districts.length === 0) {
    trace.method = "region";
    trace.note = (trace.note ? trace.note + " → " : "") + `every user under ${region.name}`;
    return q.getUserIdsByRegion(env, region.id);
  }

  // Aliases make one region id appear under several names (migration 0013), so
  // the id list is deduped before it is chunked into IN clauses.
  const ids = [...new Set([region.id, ...districts.map((d) => d.id)])];
  const placed = await q.getUserIdsByRegions(env, ids);

  const unplaced: string[] = [];
  if (region.lat !== null && region.lng !== null) {
    // A degree of latitude is ~111.32 km everywhere; a degree of longitude
    // shrinks with the cosine. Both are widened into the bbox SQL can filter on,
    // and the exact radius is applied to what comes back.
    const dLat = SETTLEMENT_REACH_KM / 111.32;
    const dLng = SETTLEMENT_REACH_KM / (111.32 * Math.cos(region.lat * Math.PI / 180));
    for (const u of await q.getUnplacedUsersInBBox(
      env, region.lat - dLat, region.lat + dLat, region.lng - dLng, region.lng + dLng)) {
      if (distanceKm(u.latitude, u.longitude, region.lat, region.lng) <= SETTLEMENT_REACH_KM) {
        unplaced.push(u.user_id);
      }
    }
  }

  trace.method = "settlement";
  trace.note = (trace.note ? trace.note + " → " : "")
    + `${region.name} is a settlement with ${districts.length} seeded district(s): `
    + `users under any of them, plus ${unplaced.length} with no region inside `
    + `${SETTLEMENT_REACH_KM} km`;
  return [...new Set([...placed, ...unplaced])];
}

/**
 * How far from the Варна centroid a "city-wide" alert still reaches.
 *
 * `city_wide` was designed when the whole product was the city, so "city-wide"
 * and "every row in `users`" were the same set and `getAllUserIds` was a correct
 * implementation of both. Seeding the province broke that equivalence and
 * nothing downstream noticed: the regions table now spans 69 km, so a
 * Топлофикация "всички абонати" message — district heating, a city-only network
 * — was waking up villagers 40 km out who are not on it.
 *
 * 15 km is where the data separates rather than a round number: every
 * settlement in община Варна is inside it (Каменар 3.8, Тополи 7.6, Аксаково
 * 9.3, Константиново 12.2 — the farthest), and the next municipalities out start
 * at Белослав 16.5, Аврен 23.1 and Долни чифлик 29.3. It is deliberately wider
 * than place-names' IN_CITY_RADIUS_KM (9 km): that one breaks a near-tie between
 * two candidate places, where being wrong costs one pin, and this one decides
 * whether a person hears about an outage at all.
 */
const CITY_WIDE_RADIUS_KM = 15;

/**
 * The audience for a city-wide alert: everyone we cannot place outside the city.
 *
 * Note the direction — a user is dropped only when their position is known AND
 * measures past the radius. Someone who registered and never set a location has
 * no coordinates and no region, and nothing about that says "village": excluding
 * them would silently stop a broadcast that reaches them today, on no evidence.
 * The rule that earns the change is the one that removes only users we can prove
 * are far away, which is the same shape as getUserIdsByStreets keeping its
 * `street_id IS NULL` rows.
 */
async function getUserIdsCityWide(env: Env): Promise<string[]> {
  const center = cityCenter(await q.getRegions(env));
  const ids: string[] = [];
  let dropped = 0;
  for (const u of await q.getUsersForBroadcast(env)) {
    // Their own point first; the region centroid is the coarse stand-in for
    // someone who has a region but no point of their own.
    const lat = u.latitude ?? u.region_lat;
    const lng = u.longitude ?? u.region_lng;
    if (lat === null || lng === null
      || distanceKm(lat, lng, center.lat, center.lng) <= CITY_WIDE_RADIUS_KM) {
      ids.push(u.user_id);
    } else {
      dropped++;
    }
  }
  if (dropped > 0) {
    console.log(`[targeting] City-wide: ${dropped} user(s) outside ${CITY_WIDE_RADIUS_KM} km excluded.`);
  }
  return ids;
}

/**
 * How far outside a block's ring a user still counts as inside it.
 *
 * A ring is not a survey line. Its edges sit `ROAD_HALF_WIDTH_M` (12 m) off the
 * OSM centrelines they were cut from, those centrelines are themselves sketched,
 * and the point being tested is a phone's GPS fix — a consumer receiver is good
 * to perhaps 10 m in the open and much worse between buildings. A hard in/out
 * test against all three of those errors at once drops residents of the block
 * standing on their own doorstep.
 *
 * 30 m is roughly one building depth: wide enough to absorb the three errors
 * above, narrow enough that it cannot reach across the street into the next
 * block, whose own alert would be a different message. It only ever widens an
 * audience, and the failure it prevents — a water outage nobody was told about —
 * costs more than one neighbour hearing about the block next door.
 */
const POLYGON_TOLERANCE_M = 30;

async function getUserIdsInPolygonRange(env: Env, polygonJson: Json): Promise<string[]> {
  const ids = new Set<string>();
  for (const geometry of allGeometries(polygonJson)) {
    const ring = outerRing(geometry);
    if (!ring) continue;
    const bbox = ringBBox(ring);
    if (!bbox) continue;
    // The bbox prefilter has to be widened by the same tolerance the exact test
    // allows, or a user inside the band but outside the box is never a candidate
    // and the band does nothing at the corners.
    const dLat = POLYGON_TOLERANCE_M / 111_320;
    const dLng = POLYGON_TOLERANCE_M
      / (111_320 * Math.cos((bbox.minLat + bbox.maxLat) / 2 * Math.PI / 180));
    // SQL bbox prefilter, exact ray-cast on the survivors (§1.3).
    const candidates = await q.getUsersInBBox(
      env, bbox.minLat - dLat, bbox.maxLat + dLat, bbox.minLng - dLng, bbox.maxLng + dLng);
    for (const u of candidates) {
      if (distanceToRingM(u.latitude, u.longitude, ring) <= POLYGON_TOLERANCE_M) {
        ids.add(u.user_id);
      }
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
  const traces: TargetTrace[] = [];

  if (locationArray.length > 0) {
    for (const raw of locationArray) {
      const location = asObject(raw);
      if (!location) continue;
      const slots = readLocation(location);
      const trace: TargetTrace = {
        label: slots.area ?? slots.settlement ?? "(unnamed)",
        method: "none", settlement: null, region: null, streets: [], note: "",
      };
      traces.push(trace);

      const polygonJson = asObject(location.polygon_geojson);
      if (location.is_polygon === true && polygonJson) {
        const inRing = await getUserIdsInPolygonRange(env, polygonJson);
        trace.method = "polygon";
        trace.note = `${inRing.length} user(s) inside the ring (±${POLYGON_TOLERANCE_M} m)`;
        if (inRing.length > 0) {
          userIds.push(...inRing);
          continue;
        }
        // An empty ring is not evidence that nobody is affected — it is equally
        // "the geometry is wrong" or "these residents have not set a location".
        // The polygon branch is exclusive, so before this there was no floor
        // under it at all: a built polygon that matched nobody notified nobody,
        // where the same alert with NO polygon would have reached the whole
        // district. Every polygon in the 08.08.2026 window failed to build, so
        // that exposure never fired — luck, not design.
        trace.note += " → falling back to the street/region audience";
        // Its own trace: getUserIdsInRange overwrites method and note with the
        // path it actually took, and the ring's own verdict is worth keeping.
        const fallback: TargetTrace = {
          label: `${trace.label} (polygon fallback)`,
          method: "none", settlement: null, region: null, streets: [], note: "",
        };
        traces.push(fallback);
        userIds.push(...await getUserIdsInRange(env, location, fallback));
      } else {
        userIds.push(...await getUserIdsInRange(env, location, trace));
      }
    }
  } else if (cityWide === false) {
    // The scraper explicitly said this is NOT city-wide, yet no locations
    // arrived — almost certainly an LLM misparse of a street-level outage.
    // Store-only; never escalate it into a broadcast to the whole user base.
    console.warn(`Alert '${title}' (${category}) has no locations and city_wide=false — skipping notifications.`);
    return { recipients: [], delivered: true };
  } else {
    // city_wide=true or a legacy payload without the flag: broadcast to the
    // city and its own municipality, not to the whole province
    // (getUserIdsCityWide). The per-category preference filter below still
    // applies on top.
    //
    // Logged at warn because this is the widest thing the pipeline can do, and
    // the decision behind it was made by an LLM reading a third-party page —
    // so a source that starts publishing differently (or is tampered with)
    // shows up here as a broadcast that should not have been one, rather than
    // as an unexplained push to the whole user base.
    userIds = await getUserIdsCityWide(env);
    console.warn(
      `Alert '${clamp(title, 80)}' (${category}) is city-wide — broadcasting to `
      + `${userIds.length} user(s) within ${CITY_WIDE_RADIUS_KM} km.`);
  }

  // A location that resolves to nothing at all is invisible in the totals: the
  // 08.08.2026 review found 20 of 248 locations targeting nobody *by
  // construction*, and every one of them sat inside an alert that reached
  // someone through a different location. So they are reported per location,
  // not only when the whole alert comes back empty.
  for (const t of traces) {
    if (t.method === "none") {
      console.warn(`[targeting] ${category}: location targets nobody — ${formatTrace(t)}`);
    }
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
  // Nobody to notify is a delivered outcome, not a failure to retry — but it is
  // the outcome EVERY failure in this pipeline produces, and until now it was
  // silent. The alert is stored, notified_at is stamped, the cursor advances,
  // and "correctly reached nobody" was byte-identical to "the matcher lost the
  // district and the whole city was not told the water is off". Reach failures
  // are the dangerous class precisely because they leave no trace anywhere else:
  // a wrong pin shows on a map, an unsent push looks exactly like a sent one.
  //
  // Warn, not error: a genuinely empty audience is a normal outcome for a
  // village we hold no users in. The per-location traces are what separate the
  // two, so they are printed rather than summarised.
  if (filteredIds.length === 0) {
    const before = allIds.length;
    console.warn(
      `[targeting] Alert '${clamp(title, 80)}' (${category}) notified NOBODY`
      + (before > 0 ? ` — ${before} user(s) matched but all have ${category} disabled` : "")
      + (traces.length === 0 ? " — no locations resolved at all" : "")
      + traces.map((t) => `\n  ${formatTrace(t)}`).join(""));
    return { recipients: filteredIds, delivered: true };
  }

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

    const slots = readLocation(location);
    const dto: AlertLocationDTO = {
      settlement: slots.settlement,
      area: slots.area,
      // The display pair, derived: the most specific place named, and the
      // streets under it. Byte-identical to what the flat schema stored for
      // every shape it could express.
      location_name: slots.area ?? slots.settlement ?? "",
      sublocations: slots.streets,
      is_polygon: location.is_polygon === true,
    };
    if (slots.region_wide) dto.region_wide = true;

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
      // `is_polygon` still has to go: getUserIdsInPolygonRange would target an
      // empty ring, and every downstream reader takes the flag as a promise that
      // geometry is present. What must NOT go with it is the fact that a block
      // was asked for — see AlertLocationDTO.polygon_failed.
      if (dto.is_polygon) {
        dto.polygon_failed = true;
        const why = typeof location.polygon_failure === "string" ? location.polygon_failure : null;
        if (why) dto.polygon_failure = why;
        console.warn(
          `[polygon] requested but not built for "${dto.location_name}" `
          + `[${dto.sublocations.join(", ")}]${why ? `: ${why}` : ""}`);
      }
      dto.is_polygon = false;
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
 * The city every source we crawl is written against, and so the scope for any
 * location we cannot place in a settlement of its own.
 */
const DEFAULT_SETTLEMENT = "Варна";

/**
 * The settlement a name sits in, from the written kind alone.
 *
 * A "гр." or "с." names a settlement in its own right, so it *is* the scope —
 * Долни чифлик is not inside Варна, and scoping it there is what sent an
 * unseeded village street to a like-named street in the city. Everything else
 * (кв., ж.к., м-т, к.к., or a bare name we cannot classify) keeps the Варна
 * scope the sources are written against.
 *
 * All the schema could answer before migration 0016, and still the answer for a
 * region we hold no parent link for — see settlementScope.
 */
function settlementOf(locationName: string): string {
  const { kind, core } = parseName(locationName);
  const cls = placeClass(kind);
  return (cls === "city" || cls === "village") && core ? core : DEFAULT_SETTLEMENT;
}

/**
 * The regions row for a location's settlement — the scope its street lookups
 * take (`streets.region_id`, migration 0015).
 *
 * Deliberately not the same thing as the `region` a location matches. For
 * "кв. Виница" the region is the district and the settlement is Варна; only the
 * latter can scope a street, because `streets.region_id` always points at a
 * settlement-class region and never at a district.
 *
 * Both slots are offered because either can carry the answer: the settlement
 * slot when the message stated one, the area slot when it named only a district
 * and migration 0016 knows which settlement that district is in. The link is
 * what makes "ж.к. Младост (Белослав)" scope to Белослав — the written kind
 * cannot, and answering Варна for it is a district of the wrong town.
 *
 * A region with no link falls back to the written kind, which is exactly the
 * pre-0016 behaviour: unlinked data cannot tell a district from a settlement
 * (both have a NULL parent), so the guess stays the conservative one.
 *
 * Null means we could not place the location in any settlement we know, and
 * every caller treats that as "no street lookup is possible here" rather than
 * as "search everywhere".
 *
 * Exported for ingestion/pipeline.ts, which needs the same answer to scope a
 * polygon build. Two spellings of "which settlement is this in" would drift, and
 * the polygon path's whole problem was that it had no answer at all.
 */
export function settlementScope(
  settlement: string | null, area: string | null, regions: readonly q.NamedRow[],
): q.NamedRow | null {
  for (const name of [settlement, area]) {
    if (name === null) continue;

    // A written "гр."/"с." names a settlement in its own right, so it IS the
    // scope and the parent-link branch below must not get to it first. That
    // ordering is what §1.2 actually turned on: Варна province holds two places
    // called Припек 10 km apart — the village, and a suburb of Константиново —
    // and an unscoped `matchRegion("с. Припек")` can land on either. Landing on
    // the suburb used to mean following its parent link and answering with
    // Константиново's centroid, which is how two alerts came to pin a village
    // 1.7 km off. A name that states its own settlement kind is never a district
    // of something else, so resolve it as a settlement first.
    //
    // Settlement-class rows only, for the reason below: since migration 0017 a
    // district may carry the same name, and resolving to it would hand
    // `matchStreet` a district id as its scope — `streets.region_id` never
    // points at a district (0015), so every street lookup under it would
    // silently find nothing.
    const written = settlementOf(name);
    if (written !== DEFAULT_SETTLEMENT) {
      const scope = matchRegion(written, regions, undefined, null);
      // §3.4: a settlement the seed does not hold. The street path is gated on a
      // non-null scope — rightly, since an unscoped street match is what used to
      // notify Varna about a Долни чифлик outage — so unless the area itself
      // matches a region, this location's audience is exactly zero. ViK publishes
      // for the whole province, and nothing said a word about it.
      if (scope === null) {
        console.warn(
          `[targeting] No seeded settlement for "${name}" — no street lookup is `
          + `possible, so this location can only be reached by its area.`);
      }
      return scope;
    }

    // No settlement kind was written, so this is a district (or a bare name we
    // cannot classify). Migration 0016's link is what says which settlement it
    // sits in — the written kind cannot, and answering Варна for "ж.к. Младост
    // (Белослав)" is a district of the wrong town.
    const row = matchRegion(name, regions);
    if (row && row.settlement_id !== null && row.settlement_id !== undefined) {
      const parent = regions.find((r) => r.id === row.settlement_id);
      if (parent) return parent;
    }
  }
  return matchRegion(DEFAULT_SETTLEMENT, regions, undefined, null);
}

// ── Geocode plausibility (§2.5) ──────────────────────────────────────────────

/**
 * The radius a settlement's own places must fall inside, derived from the
 * settlement's own seeded streets.
 *
 * A single global number cannot do this job, and the seed data says why. Varna's
 * 1,333 streets sit at a median of 3.5 km from its centroid with a 95th
 * percentile of 10.7 km — the city really is that big. Долни чифлик's 42 streets
 * all lie within 1.2 km. Nominatim answered "ул. Синчец, Долни чифлик" with a
 * point 6.4 km east of the town (alert 803a51e4, still in geocode_cache), and
 * there is no constant that rejects 6.4 km while keeping Varna's legitimate
 * 10.7 — so the threshold has to be the settlement's own extent.
 *
 * The 95th percentile rather than the maximum, because a maximum is one bad row
 * away from useless: Varna's farthest "own" street is currently 58 km out (§1.1),
 * and a max-based radius would wave the whole province through. A quarter's
 * margin on top, so a legitimate street just past the ones we happen to have
 * seeded is not rejected.
 *
 * The floor is what makes it safe on thin data — с. Аврен has exactly one seeded
 * street, and its extent is not 0.9 km. Fails open by design: a settlement with
 * no seeded streets at all gets the floor, and the check can only ever reject an
 * answer that is further out than the town plausibly reaches.
 */
const SETTLEMENT_EXTENT_PERCENTILE = 0.95;
const SETTLEMENT_EXTENT_MARGIN = 1.25;
const SETTLEMENT_EXTENT_MIN_KM = 2;

/**
 * Memoized per (streets array, settlement id). The streets array is the 6-hour
 * module-scope ref cache, so the WeakMap drops every extent when the rows behind
 * them turn over — the same keying `prepare` and `candidateGrams` use, and for
 * the same 10 ms budget.
 */
const extents = new WeakMap<object, Map<number, number>>();

function settlementExtentKm(scope: q.NamedRow, streets: readonly q.NamedRow[]): number {
  if (scope.lat === null || scope.lng === null) return SETTLEMENT_EXTENT_MIN_KM;
  let memo = extents.get(streets as object);
  if (!memo) {
    memo = new Map();
    extents.set(streets as object, memo);
  }
  const cached = memo.get(scope.id);
  if (cached !== undefined) return cached;

  const distances: number[] = [];
  for (const s of streets) {
    if (s.region_id !== scope.id || s.lat === null || s.lng === null) continue;
    distances.push(distanceKm(scope.lat, scope.lng, s.lat, s.lng));
  }
  distances.sort((a, b) => a - b);
  const p = distances.length === 0
    ? 0
    : distances[Math.min(distances.length - 1,
      Math.floor(distances.length * SETTLEMENT_EXTENT_PERCENTILE))]!;
  const km = Math.max(SETTLEMENT_EXTENT_MIN_KM, p * SETTLEMENT_EXTENT_MARGIN);
  memo.set(scope.id, km);
  return km;
}

/**
 * A geocoded point, or null when it cannot plausibly be in the settlement it was
 * looked up inside.
 *
 * Nothing used to compare a Nominatim answer against the place it was anchored
 * to, so a confident wrong answer was accepted and — because misses are cached
 * too — kept. Rejecting it lets `resolveCoordinates` try the next candidate and
 * ultimately the settlement centroid, which is a coarse pin rather than a wrong
 * one. The rejection is logged: an anchor that keeps failing is a `region_aliases`
 * row waiting to be written, and it can only be noticed if it is said out loud.
 */
function plausible(
  point: GeoPoint | null, scope: q.NamedRow | null, streets: readonly q.NamedRow[], what: string,
): GeoPoint | null {
  if (point === null || scope === null || scope.lat === null || scope.lng === null) return point;
  const limit = settlementExtentKm(scope, streets);
  const km = distanceKm(point.lat, point.lng, scope.lat, scope.lng);
  if (km <= limit) return point;
  console.warn(
    `[geocode] rejected '${what}' — Nominatim answered ${km.toFixed(1)} km from `
    + `${scope.name}, past its ${limit.toFixed(1)} km extent.`);
  return null;
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
 * Area-first for the pin: when a location names a district/locality it usually
 * lists several streets within it, and dropping the pin on one of them reads as
 * "the outage is here" when it spans the whole area — so the region centroid is
 * the better marker. Streets are only used when no area was given (or the named
 * area resolves to nothing). This is the pin only; notification targeting stays
 * street-first — see getUserIdsInRange.
 *
 * The settlement is the LAST resort, below the streets, and that ordering is
 * what keeps the three-slot split from moving every pin. Under the flat schema
 * a street-only city alert arrived with location_name "" and went straight to
 * its streets; now the city is stated on every entry, so pinning the settlement
 * at step 1 would answer "гр. Варна, ул. Дубровник" with the city centre. A
 * street inside the named settlement is strictly the better marker, and falling
 * back to the settlement centroid still beats no pin at all.
 */
async function resolveCoordinates(env: Env, dto: AlertLocationDTO, deadline?: number) {
  // Everything this location looks up is searched inside its own settlement,
  // so a village street is never resolved against the like-named city one.
  const regions = await q.getRegions(env);
  // The settlement as a row, for scoping the street table. Null when we hold no
  // region for it, which means no seeded street can be trusted to be this
  // location's — Nominatim answers those, as it did for every village street
  // before they could be seeded at all.
  const scope = settlementScope(dto.settlement, dto.area ?? dto.location_name, regions);
  // The same thing as a string, for the Nominatim anchor. The resolved row's
  // name is the canonical spelling; settlementOf only sees what was written.
  const settlement = scope?.name ?? settlementOf(dto.settlement ?? dto.area ?? dto.location_name);
  // Hoisted above step 1: the plausibility check needs the settlement's extent,
  // which is derived from its own streets. Served by the same 6-hour ref cache
  // every other read here uses, so asking for it early costs nothing.
  const streets = await q.getStreets(env);

  // The plausibility check measures against the settlement the MESSAGE stated,
  // never against DEFAULT_SETTLEMENT. `settlementScope` answers "Варна" for
  // anything it cannot place, which is the right scope to search in and the
  // wrong thing to judge an answer by: alert 8360abda names only "Вилна зона",
  // and the correct point for it is 40 km away in Провадия. Judging that against
  // a Варна we merely assumed would reject a right answer, which is the failure
  // this guard exists to prevent, pointed the other way.
  const anchor = dto.settlement?.trim() ? scope : null;

  // 1. District / locality level: a named area pins the whole of it — the one
  // inside this location's settlement, which is the whole point of scoping here:
  // Варна's "Цветен квартал" and Белослав's are 17.5 km apart and share a name.
  if (dto.area?.trim()) {
    const match = matchRegion(dto.area, regions, undefined, scope?.id);
    const seeded = seededPoint(match);
    if (seeded) return seeded;

    const name = match?.name ?? geocodableName(dto.area);
    const point = plausible(
      await geocode(env, buildGeocodeQuery(name, settlement), deadline), anchor, streets, name);
    if (point) return point;
    // Area named but unresolvable — fall through to the streets rather than
    // leaving the alert with no pin at all.
  }

  // 2. Street-level fallback: first sublocation that resolves wins.
  const candidates = dto.sublocations.slice(0, 3);
  if (candidates.length > 0) {
    for (const raw of candidates) {
      // Scoped to this location's settlement, so a matched row IS this
      // location's street — which is what lets its seeded coordinate be used
      // directly. The old code had to refuse any match outside Варна, because a
      // seeded row could only be a city street; that guard is what sent every
      // village street to Nominatim, one 1,100 ms throttle slot plus an
      // up-to-8 s request at a time, on the ingest deadline.
      const match = scope === null ? null : matchStreet(raw, streets, scope.id);
      const seeded = seededPoint(match);
      if (seeded) return seeded;

      const name = match?.name ?? geocodableName(raw);
      const point = plausible(
        await geocode(env, buildGeocodeQuery(name, settlement), deadline), anchor, streets, name);
      if (point) return point;
    }
  }

  // 3. Settlement level: no area and no street resolved, so the city or village
  // centroid is all that is left. Below the streets deliberately — see above.
  if (dto.settlement?.trim()) {
    const seeded = seededPoint(scope);
    if (seeded) return seeded;

    const point = await geocode(
      env, buildGeocodeQuery(scope?.name ?? geocodableName(dto.settlement), settlement), deadline);
    if (point) return point;
  }

  return null;
}
