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
//   A10 a name the source text does not contain is not a location. Every guard
//       above reasons about what the model produced; none of them asked whether
//       the message says it. A heating alert whose only place was "ж.к Трошево"
//       came back with six locations including a village 23 km away, and nothing
//       deterministic could tell. Omission has no deterministic fix; invention
//       does, and this is it.
//   A11 the same place listed twice is one place. Duplicates cost a pin, a
//       repeated enrichment (up to a Nominatim round trip each, on the ingest
//       deadline) and a repeated targeting query — "кв. Цветен" arrived three
//       times, byte-identical, in one parse.
//   A12 "карето … и карето …" is TWO blocks. Both the prompt and A2 assumed one
//       polygon per message, so seven streets forming two disjoint blocks were
//       marked as one and could never close a ring.
//   A13 "гр. X – улиците: A, B, C" says in words that A, B and C are streets.
//       A4's promotion rule lifted them into locations of their own anyway and
//       pinned them on like-named villages, because it never looked at the
//       marker that had already settled the question.
//   A14 streets can name where the REMEDY is: "разположена водоноска на
//       кръстовището между ул. Юпитер и ул. Сатурн" is a water truck parked at a
//       junction, not an outage on those two streets.
//
// A10 and A12–A14 all read the *position* of a name inside the source text
// rather than merely its presence, which is what keeps them off the shapes they
// are not about — see sourceSpans.

import { cleanName, matchRegion, matchStreet, parseName, placeClass } from "../core/place-names";
import { gramKeys, gramSimilarity } from "../core/fuzzy";
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

// ── Source-text positions (A10, A12, A13, A14) ───────────────────────────────

const WORD_SPLIT = /[^\p{L}\p{N}]+/u;

/** A name's core, lowercased and split into words. */
function coreWords(raw: string): string[] {
  return parseName(raw).core.toLowerCase().split(WORD_SPLIT).filter(Boolean);
}

/**
 * Everything the positional guards need about one message, computed once.
 *
 * Four rules ask where a name sits in the source text, and each of them would
 * otherwise lowercase and re-tokenize the whole message per location per name.
 * The messages are short but the CPU budget is 10 ms, and this is on the ingest
 * path with the AI parse and the polygon build.
 */
interface SourceText {
  /** The whole message, lowercased — what `indexOf` is run against. */
  lower: string;
  /** Its distinct words, with trigrams, for A10's lenient containment test. */
  words: Array<{ word: string; grams: Set<number> }>;
}

function readSource(message: string): SourceText {
  const lower = message.toLowerCase();
  const seen = new Set<string>();
  const words: SourceText["words"] = [];
  for (const word of lower.split(WORD_SPLIT)) {
    if (!word || seen.has(word)) continue;
    seen.add(word);
    words.push({ word, grams: gramKeys(word) });
  }
  return { lower, words };
}

/**
 * How close a source word has to be to a name's word to count as the same one.
 *
 * The comparison has to be lenient because the model canonicalises what it
 * reads: "бул. Вл. Варненчик" comes back as "бул. Владислав Варненчик", and a
 * literal test would call the expansion an invention and delete a correct
 * location. 0.6 on trigrams absorbs an inflected ending or an expanded
 * abbreviation while still separating two different names.
 */
const SOURCE_WORD_SIMILARITY = 0.6;

/**
 * Whether the source text mentions this name at all.
 *
 * ONE word of the core is enough, deliberately — this is the weakest form of the
 * containment test, and the weakest form is what a guard that DELETES data
 * should ship as. A false positive here is a silenced alert, which is the one
 * direction the guard doctrine says to be paranoid about, and the acceptance
 * corpus (§2.6's `40b78a66`) needs no more than this: none of the six invented
 * locations shares a single word with the message they were attached to.
 *
 * Tightening it to "most of the words" would also catch a model that invents a
 * plausible neighbour of a real name — but it would delete "бул. Владислав
 * Варненчик" from a message that wrote "бул. Вл. Варненчик", and that trade is
 * the wrong way round.
 */
function mentions(name: string, src: SourceText): boolean {
  const words = coreWords(name);
  if (words.length === 0) return true; // nothing to test — leave it to A1
  for (const word of words) {
    if (src.lower.includes(word)) return true;
    const grams = gramKeys(word);
    for (const w of src.words) {
      if (gramSimilarity(grams, w.grams) >= SOURCE_WORD_SIMILARITY) return true;
    }
  }
  return false;
}

/**
 * Where a name first appears in the source text, or -1.
 *
 * Literal, unlike `mentions`: the positional rules only ever act when they find
 * a name, so a miss costs nothing but a rule that does not fire, while a loose
 * match would move a street into the wrong half of a two-block message.
 */
function firstIndex(name: string, src: SourceText, from = 0): number {
  let best = -1;
  for (const word of coreWords(name)) {
    const at = src.lower.indexOf(word, from);
    if (at >= 0 && (best < 0 || at < best)) best = at;
  }
  return best;
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

// ── A12 · a second block in the same message ─────────────────────────────────

/**
 * The word that opens a block, wherever it appears. `POLYGON_CUE` answers "does
 * this message describe a block at all"; this one answers "how many", so it is
 * global and matches only the noun — "затворен" and "между" describe the same
 * block a second time and would double-count it.
 */
const BLOCK_CUE = /кар[еe]\w*/giu;

/** Every offset in the message where a block is opened. */
function blockCueOffsets(message: string): number[] {
  const offsets: number[] = [];
  for (const m of message.matchAll(BLOCK_CUE)) offsets.push(m.index);
  return offsets;
}

// ── A13 · an explicit "улиците:" list ────────────────────────────────────────

/**
 * epro's own statement that what follows is a list of streets: "гр. Суворово –
 * улиците: Хан Аспарух, Георги Бенковски, Искър(Петлешев)".
 *
 * The colon is required. Without it "улиците" is just a noun and A1 already
 * treats a bare one as placeless; with it, the source has answered the exact
 * question A4's promotion rule was about to guess at.
 */
const STREET_LIST_MARKER = /улиц(?:ите|и|а)\s*:|ул\s*\.\s*:/giu;

// ── A14 · streets that locate the remedy ─────────────────────────────────────

/**
 * Phrases after which a street name is where the FIX is, not where the outage
 * is. `675df786`: "разположена водоноска на кръстовището между ул. Юпитер и
 * ул. Сатурн" — a water truck is parked at that junction, and both streets were
 * stored as affected.
 *
 * Two phrases, not the three the fix plan listed. "разположена … на" is dropped
 * because it is ordinary Bulgarian that any sentence about a location can carry,
 * and a phrase list this small over-fits on one message as it is. "водоноска" is
 * a water truck and names nothing else; "кръстовището между" is a junction,
 * which is a point rather than an affected area.
 *
 * Note the near miss this has to be kept clear of: POLYGON_CUE contains "между",
 * so had that sentence named a third street, A2 would have marked it a polygon.
 * A14 therefore runs BEFORE A2 and suppresses it for the streets it removes.
 */
const REMEDY_CUE = /водоноска|кръстовището\s+между/giu;

/**
 * Streets that appear only AFTER a remedy cue, and never before one.
 *
 * Positional rather than per message, and that is the whole safety of it: a
 * message reading "без вода: ул. А, ул. Б. Водоноска на ул. В" loses only ул. В.
 * Dropping every street whenever the cue appears anywhere would lose the outage
 * with the remedy.
 */
function remedyOnlyStreets(streets: string[], src: SourceText): Set<string> {
  const cues = [...src.lower.matchAll(REMEDY_CUE)].map((m) => m.index);
  if (cues.length === 0) return new Set();
  const firstCue = cues[0]!;
  const dropped = new Set<string>();
  for (const street of streets) {
    const at = firstIndex(street, src);
    // Named before any cue (or not found at all) — it is the outage's own.
    if (at < 0 || at < firstCue) continue;
    dropped.add(street);
  }
  return dropped;
}

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
function isPromotable(
  sub: string, parentIsCity: boolean, refs: ReferenceRows, declaredStreets: Set<string>,
): boolean {
  const { kind, core } = parseName(sub);
  if (!core) return false;

  // A13. The source said, in words, that this entry is a street. A4's rule was
  // written for "гр. Варна - кв. Младост, ул. X", where nothing states which is
  // which and the ordering is all there is to go on; where there IS a statement,
  // promoting over it overrides the message. `5b048900` lifted three Суворово
  // streets into locations of their own and pinned Георги Бенковски on с.
  // Бенковски 30 km away; `0d59345b` made Васил Левски the AREA of a Вълчи дол
  // alert, which then resolved to Varna's street of that name (§2.4).
  if (declaredStreets.has(sub)) return false;

  const cls = placeClass(kind);
  if (cls === "street") return false;
  if (cls !== null) return true;

  if (ZONE_SUFFIX.test(core)) return matchStreet(sub, refs.streets) === null;
  return parentIsCity && matchRegion(sub, refs.regions) !== null;
}

/**
 * The street-list entries an explicit "улиците:" marker covers.
 *
 * Positional, because the marker is: "гр. Варна - кв. Виница, улиците: ул. A" is
 * one clause about one district, and a message can carry a marked list beside an
 * unmarked mention. The span runs from the marker to the end of its sentence,
 * and an entry is covered when it is named inside one.
 */
function declaredStreetEntries(streets: string[], src: SourceText): Set<string> {
  const spans: Array<[number, number]> = [];
  for (const m of src.lower.matchAll(STREET_LIST_MARKER)) {
    const start = m.index + m[0].length;
    // To the end of the sentence — a full stop followed by a space or the end,
    // a semicolon, or a line break. Commas do not end it: the list is commas.
    const end = src.lower.slice(start).search(/[;\n]|\.\s|\.$/u);
    spans.push([start, end < 0 ? src.lower.length : start + end]);
  }
  if (spans.length === 0) return new Set();

  const declared = new Set<string>();
  for (const street of streets) {
    for (const [start, end] of spans) {
      const at = firstIndex(street, src, start);
      if (at >= 0 && at < end) { declared.add(street); break; }
    }
  }
  return declared;
}

// ── A12 · two blocks in one message ──────────────────────────────────────────

/**
 * Split one polygon entry's street list into the blocks the message describes.
 *
 * `d29913c5` reads "карето, заключено между бул. Левски, ул. Девня, ул. Райко
 * Даскалов, ул. Звзда и ул. Доктор Иван Селемински **и карето**, заключено между
 * ул. Девня, ул. Тодор Влайков и ул. Панайот Хитов" — two blocks sharing
 * ул. Девня. The model emitted a single location with all seven streets and
 * marked it `is_polygon`; seven streets forming two disjoint blocks cannot
 * produce one ring, so it could never have built whatever else was fixed.
 *
 * Each street goes to the block whose cue it follows, by position in the source.
 * A street named in both halves belongs to both — that is the shared side, and
 * dropping it from either would open that block at a corner.
 *
 * Returns a single list unchanged unless there really are two blocks WITH streets
 * between the cues, which is what keeps it off a message that merely says the
 * word twice.
 */
function splitBlocks(streets: string[], message: string, src: SourceText): string[][] {
  const cues = blockCueOffsets(message);
  if (cues.length < 2) return [streets];

  // Where each street is first named. A street the message does not spell (the
  // model canonicalised it) has no position and cannot be assigned, so the split
  // is abandoned rather than guessed at.
  const at = streets.map((s) => firstIndex(s, src));
  if (at.some((i) => i < 0)) return [streets];

  // Only cues with at least one street between them open a new block; "карето"
  // repeated inside one description is still one block.
  const starts = [cues[0]!];
  for (const cue of cues.slice(1)) {
    if (at.some((i) => i > starts[starts.length - 1]! && i < cue)) starts.push(cue);
  }
  if (starts.length < 2) return [streets];

  const blocks: string[][] = starts.map(() => []);
  for (let s = 0; s < streets.length; s++) {
    // The last cue this street follows. A street named BEFORE the first cue
    // ("Без вода на ул. X. Карето между …") belongs to the first block rather
    // than to none — falling out of the loop would drop it silently, which is
    // the one thing a split must never do.
    let owner = 0;
    for (let b = starts.length - 1; b >= 0; b--) {
      if (at[s]! >= starts[b]!) { owner = b; break; }
    }
    blocks[owner]!.push(streets[s]!);
    // A shared side is named again inside the later block; find it there too.
    for (let b = 1; b < starts.length; b++) {
      const again = firstIndex(streets[s]!, src, starts[b]!);
      const end = b + 1 < starts.length ? starts[b + 1]! : src.lower.length;
      if (again >= 0 && again < end && !blocks[b]!.includes(streets[s]!)) {
        blocks[b]!.push(streets[s]!);
      }
    }
  }
  // A block needs three sides. Anything short of that is not a second block, so
  // fold everything back into one rather than shipping a stub that cannot close.
  return blocks.every((b) => b.length >= 3) ? blocks : [streets];
}

// ── A11 · duplicate locations ────────────────────────────────────────────────

/**
 * Merge locations naming the same place, unioning their street lists.
 *
 * `52e21c59` produced "кв. Цветен" three times, byte-identical. `afb764bf`
 * produced "с. Припек" and "гр. Игнатиево" twice each, the second Игнатиево
 * carrying a 16-street list with its own typos. `c12154c9` produced four
 * separate "гр. Варна" entries with one street each. Nothing downstream breaks,
 * but every duplicate costs a pin on the map, a repeated enrichment — up to a
 * Nominatim round trip each, on the ingest deadline — and a repeated targeting
 * query.
 *
 * Keyed on the two name slots plus `is_polygon`, and conservatively: entries
 * that differ in `region_wide` or in `is_polygon` are NOT merged, because
 * unioning them would widen the narrower one's audience to the vaguer one's
 * claim. Two polygons in one settlement stay apart for the same reason — after
 * A12 they are two different blocks.
 */
function mergeDuplicates(locations: Location[]): Location[] {
  const merged: Location[] = [];
  const byKey = new Map<string, Location>();
  for (const location of locations) {
    if (location.is_polygon) { merged.push(location); continue; }
    const key = `${cleanName(location.settlement ?? "").toLowerCase()} `
      + `${cleanName(location.area ?? "").toLowerCase()} `
      + `${location.region_wide === true}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, location);
      merged.push(location);
      continue;
    }
    for (const street of location.streets) {
      if (!existing.streets.includes(street)) existing.streets.push(street);
    }
  }
  return merged;
}

// ── Heating is Варна by construction ─────────────────────────────────────────

/**
 * Веолия operates one district-heating network in this province and it is the
 * city's — there is no district heating in the villages, so a `heating` message
 * naming a district and no settlement is naming a district OF Варна.
 *
 * The cheapest correctness win in the 08.08.2026 review: `40b78a66`'s only real
 * place was "ж.к Трошево" with no settlement, which leaves `settlementScope`
 * guessing and every street lookup unscoped. Stated as a fact about the source
 * rather than inferred from the text, so it cannot misfire on wording.
 */
const HEATING_CATEGORY = "heating";
const HEATING_SETTLEMENT = "гр. Варна";

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
  output: ProcessedData, message: string, refs: ReferenceRows, category: string,
): ProcessedData {
  const polygonCue = hasPolygonCue(message);
  // Both cues are read once per message, so a message that hedges marks every
  // location it produced — the same coarseness A2 and A3 already accept. The
  // sources publish one outage per message, so a hedge in it is about all of it.
  const areaCue = hasAreaCue(message);
  const src = readSource(message);
  const locations: Location[] = [];

  for (const original of output.locations) {
    const location: Location = { ...original, streets: [...original.streets] };

    // A5 then A1 over the street list.
    location.streets = location.streets
      .map(stripAddressDetail)
      .filter((s) => !isPlaceless(s));

    // A14, before A2: the remedy cue contains "между", which is also a polygon
    // cue, so a junction with a third street named nearby would otherwise be
    // promoted to a block built out of the water truck's parking spot.
    const remedy = remedyOnlyStreets(location.streets, src);
    if (remedy.size > 0) {
      location.streets = location.streets.filter((s) => !remedy.has(s));
      console.warn(`[normalize] A14 dropped ${[...remedy].join(", ")} — named as the `
        + `location of a water truck / junction, not of the outage.`);
    }

    // Same over each name slot, independently. A placeless name above a real
    // street list is still a usable location — the streets are the location —
    // so only that slot goes, never the entry.
    for (const slot of ["settlement", "area"] as const) {
      const raw = location[slot];
      if (raw === null) continue;
      const stripped = stripAddressDetail(raw);
      location[slot] = isPlaceless(stripped) ? null : stripped;
    }

    // A10, after A5 (which strips the house numbers the message DOES contain)
    // and A1 (which has already removed the names that are not places at all),
    // and before A4 — a promoted district must be checked as the street it
    // arrived as, not lifted first and tested afterwards.
    location.streets = location.streets.filter((s) => {
      if (mentions(s, src)) return true;
      console.warn(`[normalize] A10 dropped street "${s}" — the source text does not name it.`);
      return false;
    });
    for (const slot of ["settlement", "area"] as const) {
      const raw = location[slot];
      if (raw === null || mentions(raw, src)) continue;
      console.warn(`[normalize] A10 dropped ${slot} "${raw}" — the source text does not name it.`);
      location[slot] = null;
    }

    // A9, before anything reads the two slots together.
    location.settlement = coherentSettlement(location, refs);

    // Веолия runs exactly one district-heating network and it is the city's, so
    // a heating message is about Варна by construction. A category constant, not
    // a heuristic — and it lands after A10, so it restores the settlement on a
    // message whose only stated place was a district ("ж.к Трошево") rather than
    // preserving one the model invented.
    if (category === HEATING_CATEGORY && location.settlement === null
      && (location.area !== null || location.streets.length > 0)) {
      location.settlement = HEATING_SETTLEMENT;
    }

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
      if (location.streets.length === 0) continue;
      // A12. One entry per block the message describes — normally one.
      for (const block of splitBlocks(location.streets, message, src)) {
        locations.push({ ...location, streets: block });
      }
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
    // A13: the entries the source itself declared to be streets.
    const declaredStreets = declaredStreetEntries(location.streets, src);
    const promoted: string[] = [];
    const streets: string[] = [];
    let firstPromotedAt = -1;
    let firstStreetAt = -1;
    location.streets.forEach((sub, i) => {
      if (isPromotable(sub, parentIsCity, refs, declaredStreets)) {
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

  // A11 last: every rule above can create a duplicate that was not in the parse
  // — A4 splits one entry into siblings that repeat the settlement, A10 can null
  // an `area` and leave two entries identical, A12 splits one polygon into two.
  return applyCityWideGuard({ ...output, locations: mergeDuplicates(locations) }, message);
}
