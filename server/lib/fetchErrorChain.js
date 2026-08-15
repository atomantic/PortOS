/**
 * Flatten a fetch rejection's whole `cause` chain into one searchable string.
 *
 * Node/undici reports every network-level failure as the same opaque
 * `TypeError: fetch failed`, with the real reason (ECONNRESET, ETIMEDOUT, an
 * HTTP/2 GOAWAY, ...) tucked into `err.cause` — and sometimes nested deeper
 * still. A classifier that reads only `err.message` therefore sees "fetch
 * failed" for everything and misclassifies retryable failures as fatal, which
 * is the precise bug this exists to prevent. Collects each level's `.code` as
 * well as its `.message`, so code-only signals (`UND_ERR_SOCKET`) match too.
 *
 * Callers layer their OWN predicate on top of this string rather than sharing
 * one: what counts as retryable is caller-specific. The Ollama pull loop treats
 * a timeout as transient (it is streaming a multi-GB download over a flaky
 * link); the Hugging Face probes deliberately do NOT (a slow Hub would then get
 * double the traffic). Keep that policy at the call site; keep the extraction
 * here.
 *
 * @param {unknown} err
 * @returns {string} `code: message: code: message…` across the chain, or
 *   `String(err)` when nothing was extractable.
 */
export function describeFetchError(err) {
  const parts = [];
  let node = err;
  const seen = new Set();
  // Bound the walk in case of a self-referential cause chain.
  for (let depth = 0; node && typeof node === 'object' && depth < 5; depth++) {
    if (seen.has(node)) break;
    seen.add(node);
    if (node.code) parts.push(String(node.code));
    if (node.message) parts.push(String(node.message));
    node = node.cause;
  }
  // A chain can bottom out in a bare string cause — keep it.
  if (typeof node === 'string') parts.push(node);
  return parts.join(': ') || String(err);
}

/**
 * Is this a connection-level failure with no HTTP response — an HTTP/2 GOAWAY
 * (the remote retiring an idle pooled connection, which undici surfaces as a
 * request error) or the usual reset/hang-up family?
 *
 * These are artifacts of connection REUSE rather than of the request, so the
 * same request generally succeeds immediately on a fresh socket, which is what
 * makes them worth one replay via `fetchWithTimeout`'s `shouldRetry`.
 *
 * Deliberately narrow, and the exclusions are the load-bearing part. It matches
 * NO timeout — not our own `AbortError`, not a bare `timeout`, and not the
 * TCP-level `ETIMEDOUT`. Broader classifiers like `ollamaManager`'s
 * `isTransientPullError` do include timeouts, correctly: that one is retrying a
 * multi-GB streamed download over a flaky link, where another go is worth it.
 * Here the caller is a per-item probe loop, so retrying a timeout would hand a
 * merely-slow host double the traffic — the opposite of the politeness this
 * whole path exists to provide. Callers needing the wider net should keep their
 * own predicate over `describeFetchError`.
 *
 * `ECONNREFUSED` is kept despite not being a reuse artifact: nothing is
 * listening, so the replay fails in milliseconds and costs the host nothing,
 * and it genuinely recovers a request that raced a server restart.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isReplayableConnectionError(err) {
  return /GOAWAY|ECONNRESET|EPIPE|ECONNREFUSED|socket hang up|other side closed|UND_ERR_SOCKET/i
    .test(describeFetchError(err));
}
