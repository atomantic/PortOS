/**
 * Last-writer-wins (LWW) timestamp comparison for cross-instance sync merges.
 *
 * Every per-record merge path (`mergeMediaCollectionsFromSync`,
 * `mergeAuthorsFromSync`, …) decides which side wins by comparing `updatedAt` /
 * `addedAt` strings. The sanitizers accept ANY `Date.parse`-able string (not
 * strictly ISO-8601), so the compare MUST parse to epoch ms — a lexicographic
 * string compare would mis-order two parseable-but-different-format timestamps.
 * These helpers are the single source of that rule so the polarity can't drift
 * between record kinds.
 */

/** Parse a timestamp string to epoch ms, or null when unparseable. */
export function parseTsMs(s) {
  const n = typeof s === 'string' ? Date.parse(s) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * "Newer wins": true iff `candidate` is STRICTLY newer than `incumbent`.
 * Unparseable `candidate` never overrides; an unparseable `incumbent` loses to a
 * valid candidate; a tie (or both unparseable) breaks to the incumbent (local).
 * Used to decide whether a remote record overwrites the local copy.
 */
export function compareNewerWins(candidate, incumbent) {
  const cMs = parseTsMs(candidate);
  const iMs = parseTsMs(incumbent);
  if (cMs === null) return false;   // candidate unparseable → never overrides
  if (iMs === null) return true;    // incumbent unparseable, candidate valid → take valid
  return cMs > iMs;
}

/**
 * "Earliest wins" tiebreak for two records of the same key: returns -1 if `a` is
 * earlier (a wins), 1 if `b` is earlier, 0 on tie. Unparseable side LOSES — a
 * corrupted timestamp can't claim to be earliest; both unparseable → tie (0) so
 * the caller's default wins. Used to keep the earliest `addedAt` on a sync
 * replay (e.g. merging collection items by key).
 */
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
