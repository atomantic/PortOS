/**
 * Array utilities — pure, side-effect-free helpers shared across services.
 */

/** Return array inputs unchanged, or a fresh empty array for anything else. */
export const asArray = (value) => (Array.isArray(value) ? value : []);

/** Fisher-Yates shuffle returning a new array; unlike the biased `sort(() => Math.random() - 0.5)`. */
export function shuffle(arr, random = Math.random) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Collapse items that share a key, keeping ONE survivor per key in first-seen
 * order. Returns a new array.
 *
 * A multi-row `INSERT … ON CONFLICT (key) DO UPDATE` must never name the same key
 * twice: Postgres refuses the whole statement ("cannot affect row a second time").
 * Batching helpers must dedupe first (`DO NOTHING` upserts are exempt).
 *
 * `pick(held, candidate)` returns the survivor on a repeat; default is last-seen-wins.
 * Pass a comparator when the conflict rule is not "latest write" (e.g. newest timestamp).
 */
export function dedupeByKey(items, keyOf, pick = (held, candidate) => candidate) {
  const byKey = new Map();
  for (const item of items) {
    const key = keyOf(item);
    byKey.set(key, byKey.has(key) ? pick(byKey.get(key), item) : item);
  }
  return [...byKey.values()];
}
