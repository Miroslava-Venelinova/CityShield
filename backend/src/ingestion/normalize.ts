// Deterministic guards over the AI parse, run between aiParse and polygon
// building (SPEC.md §1.7's tail).
//
// Everything here answers a failure the review of 28.07.2026 caught in
// production output, and every rule is decided from the source text plus the
// seeded reference rows — never from what the model happened to emit. The
// prompt gets the same rules as a second line of defence, but the prompt is
// nondeterministic and these are not, so this module is what actually holds:
//
//   A1  a bare kind ("м-т", "местност"), a generic noun ("карето", "зона") or
//       a shop/company/substation is not a place — drop it before enrichment,
//       or it fuzzy-matches something 40 km away and pins the alert there.
//   A2  "в карето между …" means the streets form a polygon, whatever
//       is_polygon says — the model ignored the rule and the pin fell back to
//       the first street, 1.4 km off.
//   A3  a lone "Варна" only means city-wide when the message SAYS city-wide.
//       It used to mean it unconditionally, which turned every lost district
//       into a push to the entire user base.
//   A4  epro publishes "гр. Варна - кв. Младост, ул. X"; the district can still
//       land in the street array even though the schema now has an `area` slot
//       for it. Move it into that slot — or, when the slot is taken or the
//       ordering says the districts are siblings rather than owners, split it
//       into its own entry. Absorbed the old A7, which existed only because the
//       two-level schema forced a promoted district into a NEW location and
//       then had to guess whether the leftover streets went with it; the
//       ordering test survives as the fill-vs-sibling decision, because
//       "гр. Варна - част от: ул. Пловдив и м-т Фичоза" is a flat list of
//       siblings and attaching that street to the locality would narrow the
//       locality's audience to it.
//   A5  "ул. Пловдив 25" is the street ул. Пловдив — the house number was
//       never stripped and dragged the match around.
//   A6  "в района на ул. X, ул. Y" names streets to say *where* the affected
//       area is, not to bound it. Nothing in the message says how far it
//       reaches, so targeting only those exact streets is a precision the
//       source never claimed — mark the location region-wide instead.
//   A8  a city_wide=true the model invented had nothing checking it — A3 only
//       ever promoted INTO city-wide, so the widest action in the system was
//       taken on the prompt's word alone. Demote it unless the message says so.
//   A9  "с. Аврен" + "кв. Виница" is incoherent, and the two slots disagreeing
//       silently notifies the wrong settlement: targeting follows the area,
//       street scope follows the settlement. `regions` holds no parent link to
//       check containment with, but every row has carried coordinates since
//       migration 0005 — so measure them instead and drop the settlement when
//       it is nowhere near.

import { cleanName, matchRegion, matchStreet, parseName, placeClass } from "../core/place-names";
import { distanceKm } from "../core/geo";
import type { NamedRow } from "../db/queries";
import type { ProcessedData } from "../shared/schemas";

type Location = ProcessedData["locations"][number];

/** The seeded rows A4 needs to tell a district from a street, and A9 to place both. */
export interface ReferenceRows {
  regions: readonly NamedRow[];
  streets: readonly NamedRow[];
}

// ── A1 · placeless names ─────────────────────────────────────────────────────

/**
 * Nouns that describe a kind of place without naming one. The model reaches for
 * these when the sentence around the location is doing the work — "в карето
 * между ул. X и ул. Y", "местност и прилежащите …" — and the noun ends up in
 * location_name on its own.
 */
const GENERIC_NAMES = new Set([
  "карето", "каре", "каретата",
  "зона", "зоната", "район", "районa", "района", "квартал", "квартала",
  "комплекс", "комплекса", "жилищен комплекс",
  "улица", "улици", "улиците", "булевард", "булеварди",
  "град", "града", "село", "селото", "местност", "местността",
  "блок", "блокове", "блоковете", "сграда", "сградата",
]);

// Kinds that name a business or a piece of infrastructure rather than a place:
// "м-н Бурлекс" (магазин), "ТП 726" (трафопост), a company name.
const NON_PLACE_PREFIX = /^(?:м\s*-\s*н|магазин|фирма|тп|бкти|кту|подстанция)(?![\p{L}])/iu;
const COMPANY_SUFFIX = /(?:^|\s)(?:оод|еоод|ад|еад|ет)\s*\.?$/iu;

/**
 * True when a written name does not name a place and must not be enriched.
 *
 * The pipeline used to hand these straight to the fuzzy matcher, which always
 * answers with *something*: "м-т" scored 0.364 on "м-т Фичоза" and pinned an
 * outage in five villages onto a locality 40 km away, and "местност" matched
 * nothing at all so Nominatim was asked instead and returned a nature reserve.
 */
export function isPlaceless(raw: string): boolean {
  const cleaned = cleanName(raw);
  if (!cleaned) return true;
  if (NON_PLACE_PREFIX.test(cleaned) || COMPANY_SUFFIX.test(cleaned)) return true;
  // A kind abbreviation with nothing after it: "м-т", "местност", "кв.".
  const { core } = parseName(cleaned);
  if (!core) return true;
  return GENERIC_NAMES.has(core.toLowerCase());
}

// ── A5 · trailing address detail ─────────────────────────────────────────────

/**
 * Address detail hanging off the end of a street name. Applied repeatedly, so
 * "бул. Чаталджа 20 вх. Б." peels back to "бул. Чаталджа" and the range
 * "бл 66 до бл 70" peels off entirely.
 *
 * The вх./бл./ет./ап. branch demands its own whitespace and then a separator,
 * so "ул. Иван Етърски" is not read as "ул. Иван" + "ет" + "ърски"; the bare
 * number branch demands whitespace too, so the ordinals ("25-та", "1-ва") and
 * the truncated "ул.7" have nothing to strip.
 */
const TRAILING_DETAIL =
  /(?:\s+(?:вх|бл|ет|ап)\s*(?:\.\s*|\s+)[\p{L}\d]{0,3}\s*\.?|\s+№?\s*\d+\s*[\p{L}]?\s*\.?|\s+до)$/iu;

/**
 * "ул. Пловдив 25" → "ул. Пловдив". A no-op unless the name carries an explicit
 * ул./бул. kind: no seeded street with one ends in a bare number, no region name
 * carries a street prefix, and every numeric street name is an ordinal — so
 * "ал. 1", "ж.к. Възраждане 1" and "Зеленика 9" are all left alone.
 */
export function stripAddressDetail(raw: string): string {
  const { kind, core } = parseName(raw);
  if (kind !== "ул." && kind !== "бул.") return raw;

  let stripped = core;
  for (;;) {
    const next = stripped.replace(TRAILING_DETAIL, "").trim();
    if (next === stripped) break;
    stripped = next;
  }
  // "ул.7" is a truncated ordinal, not a house number: a strip that empties the
  // core has misread the name, so leave it exactly as it came.
  if (!stripped || stripped === core) return raw;
  return `${kind} ${stripped}`;
}

// ── A2/A3 · cues read off the source message ─────────────────────────────────

/** "в карето между ул. X, ул. Y и ул. Z" — the streets bound a block. */
const POLYGON_CUE = /кар[еe]то|затворен|между/iu;

/**
 * Phrases that actually mean every customer, as opposed to a message whose
 * district the model simply lost. Without one of these a lone "Варна" is an
 * extraction failure, not a broadcast.
 */
const CITY_WIDE_PHRASES = [
  /всички\s+(?:абонати|клиенти|потребители|жители)/iu,
  /ц[ея]л(?:ата|ият|ия|а|о)?\s+(?:град|варна|община)/iu,
  /на\s+територията\s+на\s+(?:цялата\s+)?община/iu,
];

/**
 * Phrases that place an outage *around* the streets they name rather than on
 * them: "в района на ул. X", "…и прилежащите улици", "в близост до".
 *
 * No word boundaries: JS `\b` is ASCII-only and never fires between Cyrillic
 * letters, so `\bрайона` would silently match nothing. `район[аъ]?` is followed
 * by a required "на"/"около", which is what keeps it off the standalone noun
 * A1 already drops.
 */
const AREA_CUE =
  /район[аъ]?\s+(?:на|около)|прилежащ|в\s+близост\s+до|(?:околн|съседн)ите\s+улици/iu;

export const hasPolygonCue = (message: string): boolean => POLYGON_CUE.test(message);

export const hasAreaCue = (message: string): boolean => AREA_CUE.test(message);

export const hasCityWidePhrase = (message: string): boolean =>
  CITY_WIDE_PHRASES.some((re) => re.test(message));

// ── A3 · the city-wide guard ─────────────────────────────────────────────────

const LONE_VARNA = /^(?:гр\.\s*|град\s+)?варна$/iu;

/**
 * Both directions of the city-wide decision, gated on the same evidence: the
 * message has to SAY city-wide, in words, for the alert to be one.
 *
 * **Promotion** covers spike 2's known qwen3 deviation: ~1/5 runs the model
 * emits a single location "град Варна" with no sublocations instead of
 * city_wide=true + empty locations.
 *
 * Narrowed after the 28.07 review: it needs the phrase, because the same shape
 * is what a *dropped district* produces ("гр. Варна - кв. Владислав Варненчик"
 * parsed to just "Варна") — and five such extraction failures went out as
 * broadcasts. Absent the phrase, keep the location: region-wide Варна reaches
 * far fewer people than it should, but never people the message was not about.
 *
 * **Demotion** is the missing half, and it is the one that costs. Everything
 * above only ever narrows a parse the model got too wide in ONE shape; a
 * `city_wide: true` the model invented outright was passed straight through,
 * and `sendUsersNotification` answers an empty location list with a broadcast.
 * So the widest action in the system had no deterministic guard on it at all —
 * only the prompt, which is exactly the nondeterministic thing this module
 * exists to backstop. If the message never says city-wide, it is not: fall back
 * to `city_wide: false` with no locations, which the notify side already treats
 * as store-only.
 *
 * The asymmetry with promotion is deliberate. Promotion widens the audience, so
 * it demands a narrow shape AND the phrase. Demotion narrows it, so the phrase
 * alone decides.
 *
 * The name tested is `area ?? settlement`, which is exactly what the flat schema
 * held in `location_name` — so the three-slot split left this guard's behaviour
 * unchanged. Testing `settlement` alone would not: the prompt used to SUPPRESS
 * the city ("it must NOT become a location of its own"), so "Варна and nothing
 * else" only ever came out of a failed extraction. Now the city is on every
 * Varna entry, and a correctly parsed "гр. Варна - кв. Виница" would become a
 * broadcast candidate needing only a stray city-wide phrase in the boilerplate.
 */
export function applyCityWideGuard(output: ProcessedData, message: string): ProcessedData {
  const saysCityWide = hasCityWidePhrase(message);

  if (output.locations.length === 0) {
    // Nothing to target and no phrase to justify reaching everyone.
    return output.city_wide && !saysCityWide ? { ...output, city_wide: false } : output;
  }

  if (output.locations.length !== 1) return output;
  const only = output.locations[0]!;
  const name = cleanName(only.area ?? only.settlement ?? "");
  if (only.streets.length > 0 || only.is_polygon || !LONE_VARNA.test(name)) return output;
  if (!saysCityWide) return output;
  return { ...output, locations: [], city_wide: true };
}

// ── A4 · region-like entries in the street list ──────────────────────────────

const ZONE_SUFFIX = /зона$/iu;

/** True for "гр. Варна"/"Варна" — the settlement half of epro's "гр. X - кв. Y". */
function isBareCity(name: string | null): boolean {
  if (name === null) return false;
  const { kind, core } = parseName(name);
  if (!core) return false;
  return kind === "гр." || core.toLowerCase() === "варна";
}

/**
 * Whether a street-list entry is really a place in its own right.
 *
 * An explicit region kind (кв., ж.к., м-т, с., к.к., с.о., гр.) settles it. So
 * does a "… зона" name, unless the streets table already knows it — the seed
 * carries "за вододайната зона" as an actual street.
 *
 * Unprefixed names are the hard case, and they are only lifted when the entry
 * is a bare city with its `area` still empty, which is epro's "гр. Варна -
 * кв. Младост" with the district misfiled. The street table is deliberately NOT
 * consulted there: "Младост" and "Възраждане" are both district names AND
 * street names, and under a lone "Варна" the district is what the message
 * meant. Once an `area` HAS been stated, that reading is gone — the message
 * already named its district, so a bare "Младост" beside it is the street.
 */
function isPromotable(sub: string, parentIsCity: boolean, refs: ReferenceRows): boolean {
  const { kind, core } = parseName(sub);
  if (!core) return false;

  const cls = placeClass(kind);
  if (cls === "street") return false;
  if (cls !== null) return true;

  if (ZONE_SUFFIX.test(core)) return matchStreet(sub, refs.streets) === null;
  return parentIsCity && matchRegion(sub, refs.regions) !== null;
}

// ── A9 · settlement/area coherence ───────────────────────────────────────────

/**
 * How far apart a settlement and an area may resolve before the pair is read as
 * a mis-extraction rather than a place.
 *
 * Generous on purpose: община Варна's own settlements reach 12.2 km from the
 * centre (Константиново), and an area named against a neighbouring municipality
 * is not necessarily wrong. What it has to catch is the two slots naming
 * genuinely different places — "с. Аврен" is 23 km out, Долни чифлик 29 — where
 * targeting would follow the area and street scope the settlement, and the
 * alert would reach the wrong settlement entirely with nothing logging that it
 * had.
 */
const COHERENCE_MAX_KM = 20;

/**
 * Drop a settlement that cannot contain its own area.
 *
 * Answered two ways, best first. Migration 0016 gives a district the settlement
 * it sits in, so where that link is populated containment is a fact rather than
 * an estimate — Виница either points at Варна or it does not.
 *
 * Without a link the coordinates decide instead: both slots resolve through
 * `matchRegion` to rows carrying centroids (migration 0005), and two places 20
 * km apart are not one inside the other. Kept as the fallback rather than
 * replaced, because the link is only as complete as the last seed run and a
 * region extracted before 0016 has none.
 *
 * Only the settlement is dropped: `area` is the more specific name and the one
 * the flat schema would have kept, and a null settlement lands back on
 * settlementScope's "Варна" default, which is the pre-split behaviour rather
 * than a new guess.
 *
 * The area is looked up INSIDE the settlement being tested, or this rule would
 * fire on exactly the pairs migration 0017 exists to express: with two rows
 * named "Цветен квартал", an unscoped lookup answers with Варна's whatever the
 * message said, and "гр. Белослав + Цветен квартал" — a real, coherent pair —
 * would be judged incoherent and lose its settlement. Scoping is a preference,
 * so a district with no link still falls through to the distance test below.
 */
function coherentSettlement(location: Location, refs: ReferenceRows): string | null {
  const { settlement, area } = location;
  if (settlement === null || area === null) return settlement;

  const s = matchRegion(settlement, refs.regions, undefined, null);
  const a = matchRegion(area, refs.regions, undefined, s?.id);
  if (!s || !a) return settlement;

  if (a.settlement_id !== null && a.settlement_id !== undefined) {
    return a.settlement_id === s.id ? settlement : null;
  }
  if (s.lat === null || s.lng === null || a.lat === null || a.lng === null) return settlement;
  return distanceKm(s.lat, s.lng, a.lat, a.lng) > COHERENCE_MAX_KM ? null : settlement;
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Apply every deterministic guard to one parsed message.
 *
 * Pure: `message` is the raw source text (title + content) the cues are read
 * from, `refs` the cached reference rows. Returns a new ProcessedData; the input
 * is not mutated.
 */
export function normalizeParse(
  output: ProcessedData, message: string, refs: ReferenceRows,
): ProcessedData {
  const polygonCue = hasPolygonCue(message);
  // Both cues are read once per message, so a message that hedges marks every
  // location it produced — the same coarseness A2 and A3 already accept. The
  // sources publish one outage per message, so a hedge in it is about all of it.
  const areaCue = hasAreaCue(message);
  const locations: Location[] = [];

  for (const original of output.locations) {
    const location: Location = { ...original, streets: [...original.streets] };

    // A5 then A1 over the street list.
    location.streets = location.streets
      .map(stripAddressDetail)
      .filter((s) => !isPlaceless(s));

    // Same over each name slot, independently. A placeless name above a real
    // street list is still a usable location — the streets are the location —
    // so only that slot goes, never the entry.
    for (const slot of ["settlement", "area"] as const) {
      const raw = location[slot];
      if (raw === null) continue;
      const stripped = stripAddressDetail(raw);
      location[slot] = isPlaceless(stripped) ? null : stripped;
    }

    // A9, before anything reads the two slots together.
    location.settlement = coherentSettlement(location, refs);

    // A2. A polygon's streets are streets by definition, so there is nothing
    // here for A4 to lift out.
    //
    // The keep-test is the street list alone, not "any slot filled". Under the
    // flat schema a junk polygon ("в карето между …" with nothing parsed out)
    // arrived as location_name "карето", which A1 nulled and this dropped. Now
    // the settlement survives A1, so the entry would live on with no geometry to
    // build from: buildPolygonForStreets needs three resolved streets, the build
    // fails, enrichLocations clears is_polygon, and what was a dropped alert
    // becomes a region-wide push to the whole city.
    location.is_polygon = location.is_polygon || (polygonCue && location.streets.length >= 3);
    if (location.is_polygon) {
      if (location.streets.length > 0) locations.push(location);
      continue;
    }

    // A4. Positions are kept because the fill-vs-sibling decision below reads
    // the order the source listed them in — that is what separates a district's
    // own streets from a flat list.
    //
    // Only a bare settlement with no area yet: under a stated area the street
    // list is already where it belongs, and a nested lift would move it
    // somewhere worse.
    const parentIsCity = isBareCity(location.settlement) && location.area === null;
    const promoted: string[] = [];
    const streets: string[] = [];
    let firstPromotedAt = -1;
    let firstStreetAt = -1;
    location.streets.forEach((sub, i) => {
      if (isPromotable(sub, parentIsCity, refs)) {
        if (firstPromotedAt < 0) firstPromotedAt = i;
        promoted.push(sub);
      } else {
        if (firstStreetAt < 0) firstStreetAt = i;
        streets.push(sub);
      }
    });
    location.streets = streets;

    // Where the lifted districts go. epro writes "гр. Варна - кв. Виница, ул. A,
    // ул. B": one district, stated before its own streets, so it fills the empty
    // `area` slot and keeps them.
    //
    // Anything else makes them siblings. "гр. Варна - част от: ул. Арх. Стоян
    // Доков, м-ст Ваялар и м-ст Свети Никола" is a flat list, street first, and
    // filling `area` there would attach that street to the locality and drop
    // everyone else living in it; two districts at once makes ownership
    // unknowable from a flat list, and guessing wrong silences everyone in the
    // one that did not get them. Siblings repeat the settlement, so nothing is
    // lost by leaving the streets behind: region-first pinning keeps the marker
    // off an arbitrary street, and getUserIdsInRange still targets by street id
    // within the settlement rather than city-wide.
    const districtOwnsStreets = location.area === null && promoted.length === 1
      && (streets.length === 0 || firstPromotedAt < firstStreetAt);
    if (districtOwnsStreets) {
      location.area = promoted.pop()!;
    }
    const siblings: Location[] = promoted.map((name) => ({
      settlement: location.settlement, area: name, streets: [], is_polygon: false,
    }));

    // A6. Kept as a marker rather than by clearing `streets`: the streets are
    // still the most specific thing the message said, so they stay in the feed
    // and on the pin — only targeting widens. Set after the A2 `continue` so a
    // block polygon (the more specific claim) is never overridden by the vaguer
    // one. Streets no longer move between entries, so this always lands on the
    // entry that holds them.
    if (areaCue && location.streets.length > 0) location.region_wide = true;

    // A settlement that only introduced its districts is context, not a place of
    // its own: keeping it would drop a second pin on the city centre and widen
    // targeting from the district to the whole settlement. The siblings carry it
    // forward, so this holds under a village the same way it does under a city.
    const wasContext = siblings.length > 0 && location.area === null
      && location.streets.length === 0;
    if (!wasContext
      && (location.settlement !== null || location.area !== null || location.streets.length > 0)) {
      locations.push(location);
    }
    locations.push(...siblings);
  }

  return applyCityWideGuard({ ...output, locations }, message);
}
