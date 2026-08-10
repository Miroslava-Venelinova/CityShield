// Kind-aware place-name matching.
//
// `bestMatch` compares whole names, which makes a written kind prefix pure
// noise the trigrams have to average away: bare "Аспарухово" scored 1.000 on
// the *village* Аспарухово (55 km out) and only 0.786 on "кв. Аспарухово", the
// district in the city — so alerts about the district pinned a village and, via
// region_id, notified nobody. The same shape produced "ж.к. Чайка" → the resort
// "Чайка" and "ж.к. Младост" → the Девня one.
//
// So: parse the kind off the name, compare only the cores, and use the kind as
// a *filter* (a к.к. is never a кв.). Where two candidates still tie on the core
// — the district and the village really are both "Аспарухово" — prefer the one
// inside Varna: every source we crawl is Varna-scoped, and a like-named district
// carries orders of magnitude more users than a village 55 km away.
//
// `bestMatch` itself is unchanged and still serves the polygon resolver and the
// reverse-geocode path; this module is a layer on top for the two call sites
// that resolve a *place* name (targeting and the map pin).

import regionSeed from "../../seeds/regions.json";
import streetSeed from "../../seeds/streets.json";
import type { NamedRow } from "../db/queries";
import { type GramKey, gramKeys, gramSimilarity, similarity } from "./fuzzy";
import { distanceKm } from "./geo";

/** Canonical kind token, keyed by the form the prompt asks the model for. */
export type PlaceKind =
  | "ул." | "бул." | "ал." | "пл."
  | "ж.к." | "кв." | "к.к." | "м-т" | "с.о." | "с." | "гр.";

/**
 * What a kind says the place *is*. Two names only match when their classes
 * agree or one of them is unstated — "к.к. Чайка" and "кв. Чайка" are two
 * different places that happen to share a core.
 */
export type PlaceClass = "street" | "district" | "resort" | "village" | "city";

const KIND_CLASS: Record<PlaceKind, PlaceClass> = {
  "ул.": "street", "бул.": "street", "ал.": "street", "пл.": "street",
  // Every kind that names a place INSIDE a settlement shares one class, because
  // the sources use them interchangeably for the same place. кв. (квартал) and
  // ж.к. (жилищен комплекс) always did — "ж.к. Чайка" and "кв. Чайка" are one
  // district — and the 08.08.2026 review found м-т (местност) and с.о. doing the
  // same: epro writes "м-ст Изгрев" for the row the seed carries as "кв. Изгрев",
  // and "м-т Ален мак" / "м-т Добрева чешма" for two с.о. villa zones. Held
  // apart, those three were rejected by kindsCompatible and targeted nobody at
  // all; "м-ст Изгрев" then matched the *village* Изгрев, 25 km out, because a
  // bare seeded name is compatible with everything.
  "ж.к.": "district", "кв.": "district", "м-т": "district", "с.о.": "district",
  // к.к. deliberately stays out of that merge. It is the one sub-settlement kind
  // the sources do NOT use interchangeably, and the separation is measured:
  // alert 584f1445 pinned "ж.к. Чайка" on к.к. Чайка, a resort 6 km from the
  // district of that name, and the kind is the only thing that tells them apart.
  // Merging it back would hand every "ж.к. Чайка" to the resort again, since
  // "к.к. Чайка" is the closer *literal* spelling of the two and literal
  // spelling is this module's last tie-break.
  "к.к.": "resort",
  "с.": "village",
  "гр.": "city",
};

export function placeClass(kind: PlaceKind | null): PlaceClass | null {
  return kind === null ? null : KIND_CLASS[kind];
}

// Every spelling the model has actually produced, not just the canonical one
// the prompt asks for: "ЖК", "ж.к", "ж.к \"Младост\"", "м.", "м-ст", "ул.7".
//
// Each abbreviation requires its dot (or a following space, or a dash) so a
// real name that merely starts with the same letters is left alone — "Младост"
// must not parse as м. + "ладост", "Булаир" not as бул. + "аир", "Пловдив" not
// as пл. + "овдив". Spelled-out kinds carry `(?![\p{L}])` for the same reason
// ("Градинарово" is not град + "инарово"); `\b` would not do — JavaScript
// defines it over ASCII \w, so it never fires between two Cyrillic letters.
//
// Order matters where one pattern could swallow another's prefix, which is why
// "с.о." is tried before "с." — and why it insists on BOTH its dots, or
// "с. Осеново" would come back as с.о. + "сеново".
const KIND_PATTERNS: Array<{ re: RegExp; kind: PlaceKind }> = [
  { re: /^(?:улица(?![\p{L}])|ул\s*\.|ул(?=\s))\s*/iu, kind: "ул." },
  { re: /^(?:булевард(?![\p{L}])|бул\s*\.|бул(?=\s))\s*/iu, kind: "бул." },
  { re: /^(?:алея(?![\p{L}])|ал\s*\.)\s*/iu, kind: "ал." },
  { re: /^(?:площад(?![\p{L}])|пл\s*\.)\s*/iu, kind: "пл." },
  { re: /^(?:жилищен\s+комплекс(?![\p{L}])|ж\s*\.?\s*к\s*\.?)\s*/iu, kind: "ж.к." },
  { re: /^(?:квартал(?![\p{L}])|кв\s*\.|кв(?=\s))\s*/iu, kind: "кв." },
  { re: /^(?:курортен\s+комплекс(?![\p{L}])|к\s*\.\s*к(?:\s*-\s*с)?\s*\.?|кк(?=\s))\s*/iu, kind: "к.к." },
  { re: /^(?:местност(?![\p{L}])|м\s*-\s*с?т|м\s*\.)\s*/iu, kind: "м-т" },
  { re: /^(?:с\s*\.\s*о\s*\.|со(?=\s))\s*/iu, kind: "с.о." },
  { re: /^(?:село(?![\p{L}])|с\s*\.)\s*/iu, kind: "с." },
  { re: /^(?:град(?![\p{L}])|гр\s*\.)\s*/iu, kind: "гр." },
];

export interface ParsedName {
  /** The kind the written prefix declares, or null when the name carries none. */
  kind: PlaceKind | null;
  /** The name with its kind prefix, quotes and doubled whitespace removed. */
  core: string;
}

// Sources quote district names ('кв."Аспарухово"', 'ж.к "Младост"'). A space
// rather than nothing, so a quote used as a separator does not fuse two words.
const QUOTES = /["'„“”«»‘’]+/gu;

/** Strip decorative quotes and collapse whitespace. */
export function cleanName(raw: string): string {
  return raw.replace(QUOTES, " ").replace(/\s+/gu, " ").trim();
}

/**
 * Split a written place name into its kind and its core.
 *
 * A name with no recognised prefix comes back `{ kind: null, core: <name> }`,
 * which stays compatible with every kind — most seeded street rows and a good
 * half of the region rows carry no prefix at all.
 */
export function parseName(raw: string): ParsedName {
  const cleaned = cleanName(raw);
  for (const { re, kind } of KIND_PATTERNS) {
    const m = re.exec(cleaned);
    if (m) return { kind, core: cleaned.slice(m[0].length).trim() };
  }
  return { kind: null, core: cleaned };
}

/** True when two kinds could name the same place (an unstated kind fits anything). */
export function kindsCompatible(a: PlaceClass | null, b: PlaceClass | null): boolean {
  return a === null || b === null || a === b;
}

// ── Matching ─────────────────────────────────────────────────────────────────

/**
 * Score a core has to clear to count as a match — higher than `bestMatch`'s 0.3
 * because stripping the kind prefix removes trigrams that were only ever
 * diluting the score, so everything lands higher. Over the 102 distinct
 * location_name values the pipeline has produced, every wanted match scores
 * ≥ 0.417 and every false positive ≤ 0.357, so 0.40 separates them cleanly —
 * 0.3 on cores starts admitting junk like "Св.св.Константин и Елена" →
 * "Константиново" (0.385), which is exactly what this replaces.
 */
export const CORE_MATCH_THRESHOLD = 0.4;

/**
 * Two candidates within this much of the top score are treated as a tie, and
 * the tie is broken in favour of the one inside the city. Wide enough to cover
 * "Младост" scoring 1.000 on the Девня ж.к. and 0.800 on "ж.к. Младост 1".
 */
const NEAR_TIE_BAND = 0.2;

/** How far from the Варна centroid still counts as "in the city". */
const IN_CITY_RADIUS_KM = 9;

/** Used only if the regions table has no row for Варна (it does — seeds/regions.json). */
const VARNA_CENTER = { lat: 43.2073873, lng: 27.9166653 };

interface Prepared {
  row: NamedRow;
  cls: PlaceClass | null;
  grams: Set<GramKey>;
}

/**
 * Parsed kind + core trigrams per candidate, memoized against the array
 * identity — the same trick, and the same reason, as fuzzy.ts's candidateGrams:
 * the regions/streets arrays come from a 6-hour module-scope cache while the
 * matchers run several times per alert, so without this every call re-parses
 * and re-tokenizes all 245 regions (or 1,300 streets) against a 10 ms budget.
 * Keying on the cached array drops the memo when the ref cache turns over.
 *
 * This is the one genuinely expensive thing on the alert path, and it is paid in
 * full on the FIRST match an isolate does — which for a 15-minute cron tick is
 * every tick. It overran the 10 ms budget on 30.07.2026 and stopped ingestion
 * dead, so what it does per row is kept to the minimum: the packed-gram
 * representation (fuzzy.ts) rather than string grams, and nothing that only one
 * of the two callers needs. In particular `inCity` is NOT computed here —
 * `matchStreet` passes `preferInCity: false` and never reads it, so eagerly
 * running 1,333 haversines for it was pure cost.
 */
const preparedRows = new WeakMap<object, Prepared[]>();

/**
 * Kind and core grams for every *seeded* name, built once at module evaluation.
 *
 * Both are derived from the name alone — nothing here needs a row id, a
 * coordinate, or which table the name came from — and the names are static data
 * that ships in this bundle anyway. So the work does not belong in a request at
 * all: module evaluation is charged against the Worker's separate startup budget
 * (400 ms) rather than the 10 ms an invocation gets, and doing it here also
 * leaves the regex and tokenizer paths JIT-warm for the first real match. That
 * first match was costing ~9.7 ms of a 10 ms budget purely because it was the
 * first; per-row cost was never the problem.
 *
 * D1 stays the source of truth for the rows themselves — `prepare` still maps
 * over what the ref cache read, and any name the seeds do not carry (the two
 * region_aliases rows from migration 0013, or a re-seed that has not been
 * deployed yet) is simply computed on demand. Drift costs speed, never accuracy.
 */
const seeded = new Map<string, { cls: PlaceClass | null; grams: Set<GramKey> }>();
for (const { name } of [...regionSeed, ...streetSeed]) {
  if (seeded.has(name)) continue;
  const { kind, core } = parseName(name);
  seeded.set(name, { cls: placeClass(kind), grams: gramKeys(core) });
}

function prepare(rows: readonly NamedRow[]): Prepared[] {
  const memo = preparedRows.get(rows as object);
  if (memo) return memo;

  const prepared = rows.map((row) => {
    const pre = seeded.get(row.name);
    if (pre) return { row, cls: pre.cls, grams: pre.grams };
    const { kind, core } = parseName(row.name);
    return { row, cls: placeClass(kind), grams: gramKeys(core) };
  });
  preparedRows.set(rows as object, prepared);
  return prepared;
}

/**
 * The city centre the in-city preference measures from, taken from the same seed
 * data as everything else rather than hardcoded. Memoized per array alongside
 * `prepare`, and only ever asked for on the `preferInCity` path.
 */
const centers = new WeakMap<object, { lat: number; lng: number }>();

/**
 * The Варна centroid, from the seeded `regions` rows.
 *
 * Exported for the city-wide fan-out (core/alert-service.ts), which measures its
 * radius from the same point the in-city tie-break does. Same memo, so asking
 * for it there costs nothing beyond the first call per cached array.
 */
export function cityCenter(rows: readonly NamedRow[]): { lat: number; lng: number } {
  return centerOf(rows);
}

function centerOf(rows: readonly NamedRow[]): { lat: number; lng: number } {
  const memo = centers.get(rows as object);
  if (memo) return memo;

  let center = VARNA_CENTER;
  for (const row of rows) {
    if (row.lat === null || row.lng === null) continue;
    if (parseName(row.name).core.toLowerCase() === "варна") {
      center = { lat: row.lat, lng: row.lng };
      break;
    }
  }
  centers.set(rows as object, center);
  return center;
}

/**
 * Whether a candidate sits inside the city, for breaking a near-tie.
 *
 * Computed on demand rather than per row up front: only the handful of
 * candidates inside the near-tie band are ever asked, so this runs a few times
 * per match instead of once per seeded row. A row seeded without coordinates
 * cannot be placed, so it never wins a near-tie on location — but it still
 * competes on score.
 */
function isInCity(row: NamedRow, center: { lat: number; lng: number }): boolean {
  return row.lat !== null && row.lng !== null
    && distanceKm(row.lat, row.lng, center.lat, center.lng) <= IN_CITY_RADIUS_KM;
}

function matchCore(
  raw: string,
  rows: readonly NamedRow[],
  accepts: (cls: PlaceClass | null) => boolean,
  threshold: number,
  preferInCity: boolean,
  inScope: ((row: NamedRow) => boolean) | null = null,
): NamedRow | null {
  const { kind, core } = parseName(raw);
  const queryClass = placeClass(kind);
  // A bare kind abbreviation ("м-т", "местност") has no core to match on — it
  // names no place, so it matches nothing rather than whatever it scores over.
  if (!core || !accepts(queryClass)) return null;

  const queryGrams = gramKeys(core);
  if (queryGrams.size === 0) return null;

  let top = 0;
  const scored: Array<{ p: Prepared; score: number }> = [];
  for (const p of prepare(rows)) {
    // Settlement scope, applied inside this loop rather than by filtering the
    // array at the call site: `prepare` memoizes on array *identity*, so a
    // freshly filtered array per call would throw the memo away and re-parse
    // every row — the exact cost the memo exists to avoid, on a 10 ms budget.
    // A predicate rather than an id compare because the two tables answer it
    // with different columns — a street's scope is its `region_id`, a region's
    // its `settlement_id` — and either way it runs before the row is scored,
    // which is what makes it cheap.
    if (inScope !== null && !inScope(p.row)) continue;
    if (!kindsCompatible(queryClass, p.cls)) continue;
    const score = gramSimilarity(queryGrams, p.grams);
    if (score < threshold) continue;
    if (score > top) top = score;
    scored.push({ p, score });
  }
  if (scored.length === 0) return null;

  // In-city preference, applied only among candidates close enough to the top
  // score to be genuine alternatives — a distant place that simply scores much
  // better is still the better answer.
  const center = centerOf(rows);
  let pool = scored.filter((s) => s.score >= top - NEAR_TIE_BAND);
  if (preferInCity) {
    const inCity = pool.filter((s) => isInCity(s.p.row, center));
    if (inCity.length > 0) pool = inCity;
  }

  let winner = pool[0]!;
  for (const s of pool) if (s.score > winner.score) winner = s;

  // Cores can tie exactly — the seed carries both "Боровец" and "Бул. Боровец",
  // both "Свети Никола" and "м-т Свети Никола". Fall back to the whole written
  // names, so a query that spelled the kind out lands on the row that spelled it
  // out too rather than on whichever came first. Comparing the full names is
  // what `bestMatch` did all along, so this is only ever the last word.
  const tied = pool.filter((s) => s.score === winner.score);
  if (tied.length > 1) {
    let literalBest = -1;
    for (const s of tied) {
      // Strictly greater, so a still-unbroken tie keeps seed order — that is
      // what makes "Младост" resolve to "ж.к. Младост 1" rather than "2"
      // deterministically instead of by iteration order.
      const literal = similarity(raw, s.p.row.name);
      if (literal > literalBest) {
        literalBest = literal;
        winner = s;
      }
    }

    // Two rows can now be spelled IDENTICALLY: migration 0017 dropped the global
    // UNIQUE on region_name, so Варна's "Цветен квартал" and Белослав's are both
    // just that. The literal comparison above scores identical names identically
    // by construction, so it cannot separate them and "strictly greater" would
    // leave the answer to whichever the seed listed first.
    //
    // The in-city band settles most such pairs on its own — Белослав's district
    // is 16.5 km out, so it never reaches this line. What it cannot settle is a
    // pair on the SAME side of the 9 km threshold: two `с.о.` villa zones out
    // among the villages, 12 km and 39 km from the centre, are both simply "not
    // in the city" and both stay in the pool. Measured: without the line below,
    // those two swap answers when the array order changes.
    //
    // Distance is the same judgement preferInCity already makes, at a finer
    // grain. It is a tie-break, not an answer — the caller that KNOWS which
    // settlement was meant should pass a scope, and this is only for the one
    // that does not.
    if (preferInCity) {
      const stillTied = tied.filter(
        (s) => similarity(raw, s.p.row.name) === literalBest
          && s.p.row.lat !== null && s.p.row.lng !== null);
      for (const s of stillTied) {
        if (distanceKm(s.p.row.lat!, s.p.row.lng!, center.lat, center.lng)
          < distanceKm(winner.p.row.lat ?? Infinity, winner.p.row.lng ?? Infinity,
            center.lat, center.lng)) {
          winner = s;
        }
      }
    }
  }
  return winner.p.row;
}

const isRegionClass = (cls: PlaceClass | null) => cls !== "street";
const isStreetClass = (cls: PlaceClass | null) => cls === null || cls === "street";

/**
 * The regions row a written place name refers to, or null.
 *
 * A name carrying a street kind ("ул. Пловдив") is never a region, and a name
 * whose kind disagrees with the row's ("к.к. Чайка" vs "кв. Чайка") is never
 * that row.
 *
 * `inSettlement` is the settlement the name was written inside, and is what
 * tells Варна's "Цветен квартал" from Белослав's — two rows that carry the same
 * name since migration 0017 dropped the global UNIQUE, and which nothing in the
 * name itself can separate. A settlement id matches that settlement's own row
 * and any district linked to it; `null` asks for settlement-class rows only,
 * which is how a settlement slot is resolved without a district of the same name
 * winning it.
 *
 * Preference, not restriction: it retries unscoped when the scope matches
 * nothing. 181 of the 261 seeded regions still carry no parent link — every row
 * predating the province sweep — and a hard filter would make those unreachable
 * whenever a settlement happened to be named, turning a correct answer into no
 * answer. Scoping can therefore only ever move a match onto a better row, never
 * take one away.
 */
export function matchRegion(
  raw: string, rows: readonly NamedRow[], threshold = CORE_MATCH_THRESHOLD,
  inSettlement?: number | null,
): NamedRow | null {
  if (inSettlement !== undefined) {
    const scoped = matchCore(raw, rows, isRegionClass, threshold, true,
      inSettlement === null
        ? (r) => r.settlement_id === null || r.settlement_id === undefined
        : (r) => r.settlement_id === inSettlement || r.id === inSettlement);
    if (scoped !== null) return scoped;
  }
  return matchCore(raw, rows, isRegionClass, threshold, true);
}

/**
 * The streets row a written street name refers to, or null.
 *
 * `scopeRegionId` is the settlement the lookup is happening in, and rows in any
 * other settlement are not candidates. It is what makes a street name usable at
 * all now that the table holds several settlements: 52% of the street names
 * around Тополи, Аврен and Долни чифлик also exist in Варна, so an unscoped
 * "ул. Тича" is a coin toss between places 25 km apart.
 *
 * Omitting it searches every settlement, which is right for a caller asking
 * whether a name is a street *anywhere* (ingestion/normalize.ts) and wrong for
 * one resolving a particular location — those must pass a scope, and must treat
 * an unresolvable settlement as "no scope exists" rather than falling back to
 * this, which would silently restore the ambiguity on exactly the inputs that
 * trigger it.
 *
 * No in-city preference: within one settlement there is no city/village
 * ambiguity left to break — the scope is what broke it.
 */
export function matchStreet(
  raw: string, rows: readonly NamedRow[],
  scopeRegionId: number | null = null, threshold = CORE_MATCH_THRESHOLD,
): NamedRow | null {
  return matchCore(raw, rows, isStreetClass, threshold, false,
    scopeRegionId === null ? null : (r) => r.region_id === scopeRegionId);
}
