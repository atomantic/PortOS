/**
 * Last-writer-wins timestamp comparison for cross-instance sync merges: `parseTsMs`, `compareNewerWins` (remote
 * overwrites local iff strictly newer.
 *
 * Unparseable loses, tie keeps incumbent), `compareEarlierWins` (earliest-wins tiebreak). Sanitizers accept any
 * `Date.parse`-able string, so compares must parse to epoch ms; a string compare would mis-order formats. Single
 * source of the polarity shared by every `merge*FromSync` path.
 */

export function parseTsMs(s) {
  const n = typeof s === 'string' ? Date.parse(s) : NaN;
  return Number.isFinite(n) ? n : null;
}

// Unparseable candidate never overrides; unparseable incumbent loses to a valid candidate; tie breaks to the incumbent (local).
export function compareNewerWins(candidate, incumbent) {
  const cMs = parseTsMs(candidate);
  const iMs = parseTsMs(incumbent);
  if (cMs === null) return false;   // candidate unparseable → never overrides
  if (iMs === null) return true;    // incumbent unparseable, candidate valid → take valid
  return cMs > iMs;
}

// -1 if `a` is earlier, 1 if `b` is, 0 on tie. An unparseable side loses (a corrupt timestamp can't claim earliest); both unparseable is a tie.
export function compareEarlierWins(a, b) {
  const aMs = parseTsMs(a);
  const bMs = parseTsMs(b);
  if (aMs === null && bMs === null) return 0;
  if (aMs === null) return 1;  // a unparseable → b wins
  if (bMs === null) return -1; // b unparseable → a wins
  if (aMs < bMs) return -1;
  if (aMs > bMs) return 1;
  return 0;
}
