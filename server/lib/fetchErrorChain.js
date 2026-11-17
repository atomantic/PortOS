/**
 * `describeFetchError(err)` flattens a fetch rejection's nested `cause` chain into one searchable
 * `code: message` string.
 */

/**
 * Flatten a fetch rejection's whole `cause` chain into one searchable string.
 *
 * undici hides the real reason in (nested) `err.cause` behind `fetch failed`; each level's
 * `.code` is collected too. Callers keep their OWN retry predicate on top.
 *
 * @param {unknown} err
 * @returns {string} `code: message: code: message…` across the chain, or
 *   `String(err)` when nothing was extractable.
 */
export function describeFetchError(err) {
  const parts = [];
  let node = err;
  const seen = new Set();
  // Bound the walk against a self-referential cause chain.
  for (let depth = 0; node && typeof node === 'object' && depth < 5; depth++) {
    if (seen.has(node)) break;
    seen.add(node);
    if (node.code) parts.push(String(node.code));
    if (node.message) parts.push(String(node.message));
    node = node.cause;
  }
  // A chain can bottom out in a bare string cause.
  if (typeof node === 'string') parts.push(node);
  return parts.join(': ') || String(err);
}

/**
 * Connection-level failure with no HTTP response (GOAWAY / reset family): artifacts of
 * connection REUSE, worth one replay via `fetchWithTimeout`'s `shouldRetry`. NO timeouts
 * on purpose (a per-item probe loop would double traffic to a slow host); `ECONNREFUSED`
 * is kept since the replay fails fast and recovers a restart race.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isReplayableConnectionError(err) {
  return /GOAWAY|ECONNRESET|EPIPE|ECONNREFUSED|socket hang up|other side closed|UND_ERR_SOCKET/i
    .test(describeFetchError(err));
}
