/**
 * Array utilities — pure, side-effect-free helpers shared across services.
 */

/**
 * Fisher-Yates shuffle. Returns a new array in randomized order; never
 * mutates the input. Use this everywhere an array needs a uniform random
 * order — never the naive/biased `arr.sort(() => Math.random() - 0.5)`
 * (that comparator violates the sort contract and skews toward certain
 * permutations depending on the engine's sort algorithm).
 */
export function shuffle(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Collapse items that share a key, keeping ONE survivor per key in first-seen
 * order. Returns a new array; never mutates the input.
 *
 * The reason this is shared rather than inlined: **a multi-row
 * `INSERT … ON CONFLICT (key) DO UPDATE` must never name the same conflict key
 * twice.** Postgres refuses the whole statement with "ON CONFLICT DO UPDATE
 * command cannot affect row a second time" — it will not pick a winner for you,
 * because applying two updates to one row in one command has no defined order.
 * So any batching helper that joins N rows into one VALUES list has to collapse
 * duplicates first, and the rows it batches usually come from somewhere that
 * makes no uniqueness promise (a disk scan, a peer's payload). `DO NOTHING`
 * upserts are exempt — Postgres tolerates in-VALUES duplicates there.
 *
 * `pick(held, candidate)` chooses the survivor when a key repeats and must
 * return one of its two arguments. It defaults to last-seen-wins, which is what
 * a sequential one-row-at-a-time upsert loop would have left behind. Pass a
 * comparator instead when the table's conflict rule is not "latest write" — a
 * last-writer-wins store, for example, has to keep the newest timestamp so a
 * payload's internal ordering can't change the outcome.
 */
export function dedupeByKey(items, keyOf, pick = (held, candidate) => candidate) {
  const byKey = new Map();
  for (const item of items) {
    const key = keyOf(item);
    byKey.set(key, byKey.has(key) ? pick(byKey.get(key), item) : item);
  }
  return [...byKey.values()];
}
