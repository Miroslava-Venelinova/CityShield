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
//   A4  epro publishes "гр. Варна - кв. Младост"; the flat
//       (location_name, sublocations) schema has no slot for that, so the
//       district landed in the street array and targeted nobody. Lift it out.
//   A5  "ул. Пловдив 25" is the street ул. Пловдив — the house number was
//       never stripped and dragged the match around.
//   A6  "в района на ул. X, ул. Y" names streets to say *where* the affected
//       area is, not to bound it. Nothing in the message says how far it
//       reaches, so targeting only those exact streets is a precision the
//       source never claimed — mark the location region-wide instead.

import { cleanName, matchRegion, matchStreet, parseName, placeClass } from "../core/place-names";
import type { NamedRow } from "../db/queries";
import type { ProcessedData } from "../shared/schemas";

type Location = ProcessedData["locations"][number];

/** The seeded rows A4 needs to tell a district from a street. */
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
 * Deterministic guard for spike 2's known qwen3 deviation: ~1/5 runs the model
 * emits a single location "град Варна" with no sublocations instead of
 * city_wide=true + empty locations.
 *
 * Narrowed after the 28.07 review: the rewrite now needs the message to say
 * city-wide in words. The guard fires on the same shape a *dropped district*
 * produces ("гр. Варна - кв. Владислав Варненчик" parsed to just "Варна"), and
 * `sendUsersNotification` answers city_wide with `getAllUserIds` — so five
 * extraction failures went out as pushes to the whole user base. Absent the
 * phrase, keep the location: region-wide Варна reaches far fewer people than it
 * should, but it never reaches people the message was not about.
 */
export function applyCityWideGuard(output: ProcessedData, message: string): ProcessedData {
  if (output.locations.length !== 1) return output;
  const only = output.locations[0]!;
  const name = cleanName(only.location_name ?? "");
  if (only.sublocations.length > 0 || only.is_polygon || !LONE_VARNA.test(name)) return output;
  if (!hasCityWidePhrase(message)) return output;
  return { ...output, locations: [], city_wide: true };
}

// ── A4 · region-like sublocations ────────────────────────────────────────────

const ZONE_SUFFIX = /зона$/iu;

/** True for "гр. Варна"/"Варна" — the context half of epro's "гр. X - кв. Y". */
function isBareCity(name: string | null): boolean {
  if (name === null) return false;
  const { kind, core } = parseName(name);
  if (!core) return false;
  return kind === "гр." || core.toLowerCase() === "варна";
}

/**
 * Whether a sublocation is really a place in its own right rather than a street.
 *
 * An explicit region kind (кв., ж.к., м-т, с., к.к., с.о., гр.) settles it. So
 * does a "… зона" name, unless the streets table already knows it — the seed
 * carries "за вододайната зона" as an actual street.
 *
 * Unprefixed names are the hard case, and they are only promoted underneath a
 * bare city, which is epro's "гр. Варна - кв. Младост" flattened into the
 * schema. The street table is deliberately NOT consulted there: "Младост" and
 * "Възраждане" are both district names AND street names, and under a lone
 * "Варна" the district is what the message meant.
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
    const location: Location = { ...original, sublocations: [...original.sublocations] };

    // A5 then A1 over the street list.
    location.sublocations = location.sublocations
      .map(stripAddressDetail)
      .filter((s) => !isPlaceless(s));

    // Same over the name. A placeless name above a real street list is still a
    // usable location — the streets are the location — so only the name goes.
    if (location.location_name !== null) {
      const stripped = stripAddressDetail(location.location_name);
      location.location_name = isPlaceless(stripped) ? null : stripped;
    }

    // A2. A polygon's sublocations are streets by definition, so there is
    // nothing here for A4 to lift out.
    location.is_polygon = location.is_polygon || (polygonCue && location.sublocations.length >= 3);
    if (location.is_polygon) {
      if (location.location_name !== null || location.sublocations.length > 0) {
        locations.push(location);
      }
      continue;
    }

    // A4.
    const parentIsCity = isBareCity(location.location_name);
    const promoted: Location[] = [];
    const streets: string[] = [];
    for (const sub of location.sublocations) {
      if (isPromotable(sub, parentIsCity, refs)) {
        promoted.push({ location_name: sub, sublocations: [], is_polygon: false });
      } else {
        streets.push(sub);
      }
    }
    location.sublocations = streets;

    // A6. Kept as a marker rather than by clearing `sublocations`: the streets
    // are still the most specific thing the message said, so they stay in the
    // feed and on the pin — only targeting widens. Set after A4 so it applies to
    // real streets, and after the A2 `continue` so a block polygon (the more
    // specific claim) is never overridden by the vaguer one.
    if (areaCue && streets.length > 0) location.region_wide = true;

    // The city before the dash in "гр. Варна - кв. Младост" is context, not a
    // location: keeping it would drop a second pin on the city centre and widen
    // targeting from the district to region-wide Варна.
    const cityWasContext = promoted.length > 0 && parentIsCity && streets.length === 0;
    if (!cityWasContext && (location.location_name !== null || streets.length > 0)) {
      locations.push(location);
    }
    locations.push(...promoted);
  }

  return applyCityWideGuard({ ...output, locations }, message);
}
