/**
 * Fetch wrapper with AbortController timeout, and an opt-in retry for
 * connection-level failures.
 *
 * The retry exists because undici reports a retired pooled connection (notably
 * an HTTP/2 GOAWAY) as a request-level rejection, so a perfectly good request
 * dies as a bare `TypeError: fetch failed`. The same request succeeds on a fresh
 * socket, which makes one replay the correct response — but only for the caller
 * that says so.
 *
 * It is OFF by default and per-call for two reasons. A blanket retry doubles
 * traffic against a genuinely-down host, and replaying a non-idempotent POST
 * (an OAuth token exchange burning a single-use refresh code, a peer sync push)
 * can do real damage. `shouldRetry` stays caller-supplied for a subtler reason:
 * only GOAWAY is *definitively* safe to replay — HTTP/2 §6.8 guarantees streams
 * above `lastStreamID` were never processed — whereas an ECONNRESET after the
 * request was fully sent may mean the server processed it and only the response
 * was lost. The caller knows which of those its endpoint can tolerate.
 *
 * @param {string} url
 * @param {RequestInit} [options]
 * @param {number} [timeoutMs=15000] - Timeout in milliseconds
 * @param {object} [retry] - Opt-in retry policy; omit for the historical no-retry behavior
 * @param {number} [retry.retries=0] - Extra attempts after the first
 * @param {number} [retry.retryDelayMs=250] - Pause between attempts, so the replay
 *   opens a new connection rather than racing the pool's teardown of the old one
 * @param {(err: unknown) => boolean} [retry.shouldRetry] - Required for a retry to
 *   fire; decides whether THIS failure is safely replayable
 * @returns {Promise<Response>}
 */
export function fetchWithTimeout(url, options = {}, timeoutMs = 15000, retry = {}) {
  const { retries = 0, retryDelayMs = 250, shouldRetry } = retry;
  // Each attempt re-enters fetchOnce, so a replay builds a FRESH
  // AbortController and gets a full timeout budget rather than inheriting the
  // exhausted one.
  return fetchOnce(url, options, timeoutMs).catch((err) => {
    if (retries < 1 || typeof shouldRetry !== 'function' || !shouldRetry(err)) throw err;
    return new Promise((resolve) => setTimeout(resolve, retryDelayMs))
      .then(() => fetchWithTimeout(url, options, timeoutMs, { ...retry, retries: retries - 1 }));
  });
}

/**
 * One attempt: fetch with an AbortController timeout, honoring a caller signal.
 * @returns {Promise<Response>}
 */
async function fetchOnce(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
  const timeoutId = hasTimeout ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let signal = controller.signal;
  let abortHandler;
  if (options.signal) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
      signal = AbortSignal.any([controller.signal, options.signal]);
    } else {
      // Fallback: propagate caller abort to our controller
      abortHandler = () => controller.abort();
      options.signal.addEventListener('abort', abortHandler, { once: true });
      if (options.signal.aborted) {
        controller.abort();
      }
    }
  }

  try {
    const response = await fetch(url, { ...options, signal });
    return response;
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
    if (options.signal && abortHandler) {
      options.signal.removeEventListener('abort', abortHandler);
    }
  }
}
