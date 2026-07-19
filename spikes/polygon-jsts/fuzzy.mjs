// pg_trgm-equivalent trigram similarity (PLAN.MD §1.3) — spike version of the
// future worker/src/core/fuzzy.ts. Mirrors pg_trgm semantics: lowercase,
// split into alphanumeric words, pad each word with two leading spaces and
// one trailing space, extract 3-grams, Jaccard over the trigram sets.

export function trigrams(text) {
  const words = String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const grams = new Set();
  for (const word of words) {
    const padded = `  ${word} `;
    for (let i = 0; i <= padded.length - 3; i++) grams.add(padded.slice(i, i + 3));
  }
  return grams;
}

export function similarity(a, b) {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 && tb.size === 0) return 0;
  let shared = 0;
  for (const g of ta) if (tb.has(g)) shared++;
  return shared / (ta.size + tb.size - shared);
}

export function bestMatch(name, candidates, threshold) {
  let best = null;
  let bestScore = threshold;
  for (const candidate of candidates) {
    const score = similarity(name, candidate);
    if (score >= bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}
