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
