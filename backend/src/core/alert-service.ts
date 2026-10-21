// Alert service (docs/specification.md §1.5): store + match + notify.
// The behavioural guards live here — store before notify, the city_wide=false
// store-only rule, the bus-line narrowing, the 1,000-char push-body cap. The
// location model is in locations.ts, and giving stored locations a coordinate
// is enrichment.ts.

import * as q from "../db/queries";
import { cityCenter, matchRegion, matchStreet, parseName } from "./place-names";
import { distanceKm, distanceToRingM, ringBBox } from "./geo";
import { enrichLocations } from "./enrichment";
import {
  type AlertLocationDTO, asObject, DEFAULT_SETTLEMENT, type Json, outerRing, readLocation,
  settlementScope,
} from "./locations";
import { normalizeBusLine, parseBusLines } from "./bus-lines";
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

/**
 * Wording that marks an alert as HEDGED rather than confirmed.
 *
 * 477 of 479 stored alerts were `warning`, so severity carried no information at
 * all. The sources do draw the distinction themselves and draw it consistently:
 * "ще бъде прекъснато електрозахранването" is a confirmed outage, "възможни са
 * смущения" is a disruption that may not happen, and 92 alerts corpus-wide are
 * the hedged kind. Mapping the hedged form to `info` is just carrying a
 * distinction the source already made through to the marker colour.
 *
 * Matched on the source text rather than asked of the model, for the same
 * reason the normalize.ts guards are: it is deterministic, and it cannot
 * regress silently when a prompt is edited.
 *
 * Deliberately conservative. Anything not recognised as hedged keeps the
 * category's own severity, so the failure mode is "a hedged alert still looks
 * confirmed" — the direction that over-warns rather than under-warns.
 */
const HEDGE_PATTERNS: RegExp[] = [
  // Bulgarian puts the copula either side of the adjective, and the sources use
  // both — "възможни са смущения" and "смущения са възможни" — so each order is
  // written out rather than guessed at with a loose gap.
  /възможн[аио]?\s+(?:са\s+|е\s+)?(?:смущени|прекъсван|затруднени|спиран)/iu,
  /(?:са|е)\s+възможн[аиои]?/iu,
  /възможн[оаи]\s+е(?![\p{L}])/iu,
  /вероятн[оаи](?![\p{L}])/iu,
  /може\s+да\s+(?:има|бъде|се|настъп)/iu,
];

/** Whether the message hedges — "смущения са възможни" rather than "ще бъде спряно". */
export function isHedged(title: string, content: string): boolean {
  const text = `${title}
${content}`;
  return HEDGE_PATTERNS.some((re) => re.test(text));
}

/**
 * Severity for a stored alert: the category's own, unless the source hedged.
 *
 * `vt` is already `info` and stays there — a route change is not an outage, and
 * hedging cannot make it less severe than it already is.
 */
function severityFor(category: string, title: string, content: string): string {
  const base = CATEGORY_SEVERITY[category] ?? "info";
  return base === "warning" && isHedged(title, content) ? "info" : base;
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


/**
 * All geometries SendUsersNotification should target: every feature geometry
 * of a FeatureCollection, or the bare geometry itself.
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


/**
 * Why one location's audience came out the way it did.
 *
 * Deliberately the same shape tools/alert-review/targeting.py records, because
 * the two are meant to stay comparable: that simulator recomputed the 08.08.2026
 * review's reach numbers offline, weeks after the fact, against a 5-row users
 * table — and it could, only because the Worker itself had never said a word
 * about any of it. Every failure in docs/accuracy.md terminates in an empty audience
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
 * Decide who an alert reaches and push it. Returns the
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
      const subscribed = parseBusLines(u.subscribed_bus_lines);
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
    severity: severityFor(alert.category, alert.title, alert.content),
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
