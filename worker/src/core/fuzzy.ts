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

export function similarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 && tb.size === 0) return 0;
  let shared = 0;
  for (const g of ta) if (tb.has(g)) shared++;
  return shared / (ta.size + tb.size - shared);
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
  let best: T | null = null;
  let bestScore = threshold;
  for (const candidate of candidates) {
    const score = similarity(name, getName(candidate));
    if (score >= bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}
