// pg_trgm-equivalent trigram similarity (PLAN.MD §1.3), promoted from the
// Phase 0 spike (spikes/polygon-jsts/fuzzy.mjs). Mirrors pg_trgm semantics:
// lowercase, split into alphanumeric words, pad each word with two leading
// spaces and one trailing space, extract 3-grams, Jaccard over the sets.

/** pg_trgm's default `%` operator threshold — used for region/street matching. */
export const SIMILARITY_THRESHOLD = 0.3;
/** `similarity_threshold` used by polygon street resolution (Phase 3). */
export const POLYGON_RESOLVE_THRESHOLD = 0.4;

export function trigrams(text: string): Set<string> {
  const words = String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const grams = new Set<string>();
  for (const word of words) {
    const padded = `  ${word} `;
    for (let i = 0; i <= padded.length - 3; i++) grams.add(padded.slice(i, i + 3));
  }
  return grams;
}

function jaccard(ta: Set<string>, tb: Set<string>): number {
  if (ta.size === 0 && tb.size === 0) return 0;
  // Iterate the smaller set — the lookups are what cost.
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let shared = 0;
  for (const g of small) if (large.has(g)) shared++;
  return shared / (ta.size + tb.size - shared);
}

export function similarity(a: string, b: string): number {
  return jaccard(trigrams(a), trigrams(b));
}

/**
 * Trigram sets for a candidate list, memoized against the array identity.
 *
 * The street list is ~3,000 rows held in a module-scope cache that only turns
 * over every 6 hours (db/queries.ts), while alert targeting calls bestMatch
 * several times per alert. Without this, each call re-tokenized every candidate
 * name — the dominant cost in the matcher, against a 10 ms CPU budget. The
 * WeakMap keys on the cached array, so a ref-cache refresh drops the memo with
 * the rows it describes.
 */
const candidateGrams = new WeakMap<object, Map<string, Set<string>>>();

function gramsFor(candidates: readonly unknown[], name: string): Set<string> {
  let memo = candidateGrams.get(candidates as object);
  if (!memo) {
    memo = new Map();
    candidateGrams.set(candidates as object, memo);
  }
  let grams = memo.get(name);
  if (!grams) {
    grams = trigrams(name);
    memo.set(name, grams);
  }
  return grams;
}

/**
 * Highest-scoring candidate at or above the threshold, else null — the
 * TypeScript stand-in for `WHERE name % ? ORDER BY similarity(...) DESC LIMIT 1`.
 */
export function bestMatch<T>(
  name: string,
  candidates: readonly T[],
  getName: (candidate: T) => string,
  threshold: number = SIMILARITY_THRESHOLD,
): T | null {
  // Hoisted out of the loop: the query was previously re-tokenized once per
  // candidate, i.e. thousands of times per call.
  const queryGrams = trigrams(name);
  if (queryGrams.size === 0) return null;

  let best: T | null = null;
  let bestScore = threshold;
  for (const candidate of candidates) {
    const score = jaccard(queryGrams, gramsFor(candidates, getName(candidate)));
    if (score >= bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}
