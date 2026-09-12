/**
 * Fetch wrapper with AbortController timeout, and an opt-in retry for
 * connection-level failures.
 *
 * `timeoutMs` bounds the WHOLE exchange — headers AND body. A server that
 * answers `200 OK` and then stalls mid-body is the failure this helper exists
 * to catch, so the abort timer stays armed past `fetch()` resolving and is
 * cleared only once the body is fully read, cancelled, or the request rejects.
 * Before that was true the argument was a lie at every call site: `fal.js`
 * passed a constant literally named `FAL_DOWNLOAD_TIMEOUT_MS` that bounded only
 * the headers, leaving the multi-MB download itself with no ceiling at all.
 *
 * `timeoutMs <= 0` still means "no deadline" (multi-GB Ollama pulls and the
 * Hugging Face import rely on that — the stream is their lifecycle). A caller
 * that genuinely holds a body open longer than its header budget, and bounds
 * that body some other way, opts out with `{ bodyDeadline: false }` — Beeper's
 * asset proxy is the one such caller, since its mirror applies its own
 * per-chunk idle abort.
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
 * @param {number} [timeoutMs=15000] - Deadline in milliseconds covering headers AND body
 * @param {object} [retry] - PortOS-owned options bag (never forwarded to `fetch`);
 *   omit for the historical no-retry behavior
 * @param {boolean} [retry.bodyDeadline=true] - Keep the deadline armed through body
 *   consumption; set false for a caller that bounds its own stream
 * @param {number} [retry.retries=0] - Extra attempts after the first
 * @param {number} [retry.retryDelayMs=250] - Pause between attempts, so the replay
 *   opens a new connection rather than racing the pool's teardown of the old one
 * @param {(err: unknown) => boolean} [retry.shouldRetry] - Required for a retry to
 *   fire; decides whether THIS failure is safely replayable
 * @returns {Promise<Response>}
 */
export function fetchWithTimeout(url, options = {}, timeoutMs = 15000, retry = {}) {
  const { retries = 0, retryDelayMs = 250, shouldRetry, bodyDeadline = true } = retry;
  // Each attempt re-enters fetchOnce, so a replay builds a FRESH
  // AbortController and gets a full timeout budget rather than inheriting the
  // exhausted one.
  return fetchOnce(url, options, timeoutMs, bodyDeadline).catch((err) => {
    if (retries < 1 || typeof shouldRetry !== 'function' || !shouldRetry(err)) throw err;
    return waitForRetry(retryDelayMs, options.signal)
      .then(() => fetchWithTimeout(url, options, timeoutMs, { ...retry, retries: retries - 1 }));
  });
}

/**
 * Pause before a retry while honoring the same caller cancellation signal as
 * the fetch attempts. This keeps a caller-owned total deadline authoritative
 * even when it expires between attempts.
 */
function waitForRetry(delayMs, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, delayMs));
  if (signal.aborted) return Promise.reject(signal.reason || new DOMException('aborted', 'AbortError'));

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeoutId);
      reject(signal.reason || new DOMException('aborted', 'AbortError'));
    };
    const timeoutId = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * One attempt: fetch with an AbortController timeout, honoring a caller signal.
 * @returns {Promise<Response>}
 */
async function fetchOnce(url, options = {}, timeoutMs = 15000, bodyDeadline = true) {
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

  // Idempotent, because the body wrapper can reach it from several directions
  // (a reader method, the stream closing, a cancel) and the caller-signal
  // listener must be removed exactly once.
  let released = false;
  const releaseDeadline = () => {
    if (released) return;
    released = true;
    if (timeoutId !== null) clearTimeout(timeoutId);
    if (options.signal && abortHandler) {
      options.signal.removeEventListener('abort', abortHandler);
    }
  };

  let response;
  try {
    response = await fetch(url, { ...options, signal });
  } catch (err) {
    releaseDeadline();
    throw err;
  }

  // Nothing left to bound: no timer armed, the caller opted out, or the
  // response has no body to wait on.
  if (timeoutId === null || !bodyDeadline || !response || typeof response !== 'object' || isBodyless(response)) {
    releaseDeadline();
    return response;
  }

  // A body nobody ever reads would otherwise hold the event loop open for the
  // rest of the budget; unref lets the process exit while the abort still fires
  // on time if it is still running.
  if (typeof timeoutId.unref === 'function') timeoutId.unref();
  return withBodyDeadline(response, releaseDeadline);
}

// Response methods that consume the whole body, so the deadline is satisfied
// the moment their promise settles.
const BODY_CONSUMERS = ['json', 'text', 'arrayBuffer', 'blob', 'formData', 'bytes'];

/**
 * Is there anything left for the deadline to cover?
 *
 * A real `Response` with a null body genuinely has nothing left to read —
 * 204/304, a HEAD, and `safeUrlFetch`'s manual-redirect hop — so it is released
 * on the spot rather than leaving a timer armed against a body that will never
 * arrive. A hand-rolled double exposes no `body` either but still resolves
 * `text()`/`json()` later, and that read is precisely what has to stay bounded,
 * so those keep the deadline. A double with neither is inert and passes
 * through untouched, identity intact.
 */
function isBodyless(response) {
  if (response.body != null) return false;
  if (typeof Response !== 'undefined' && response instanceof Response) return true;
  return !BODY_CONSUMERS.some((name) => typeof response[name] === 'function');
}

/**
 * Wrap a `Response` so the abort deadline is released once its body is drained.
 *
 * A Proxy rather than a rebuilt Response: callers pass these straight to
 * `Readable.fromWeb`, `instanceof` checks and their own error mappers, so the
 * object has to stay the real thing. Getters are read with `target` as the
 * receiver because `ok`/`status`/`headers` are branded accessors that throw on
 * a foreign `this`.
 */
function withBodyDeadline(response, release) {
  let wrappedBody;
  return new Proxy(response, {
    get(target, prop) {
      if (prop === 'body') {
        const raw = Reflect.get(target, prop, target);
        // Not a web stream (a test double, or a runtime without one) — there is
        // no close/cancel hook to hang the release on.
        if (!raw || typeof raw.getReader !== 'function') return raw;
        wrappedBody ||= watchStream(raw, release);
        return wrappedBody;
      }

      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;

      if (BODY_CONSUMERS.includes(prop)) {
        return (...args) => {
          const result = Reflect.apply(value, target, args);
          if (!result || typeof result.then !== 'function') {
            release();
            return result;
          }
          return result.then(
            (resolved) => { release(); return resolved; },
            (err) => { release(); throw err; },
          );
        };
      }

      // A clone shares one deadline: whichever copy is drained first satisfies it.
      if (prop === 'clone') {
        return (...args) => withBodyDeadline(Reflect.apply(value, target, args), release);
      }

      return value.bind(target);
    },
  });
}

/**
 * Mirror a body stream, releasing the deadline when it ends, errors, or is
 * cancelled. `highWaterMark: 0` is load-bearing: the default strategy would
 * pull — and therefore LOCK the underlying body — the instant the wrapper is
 * constructed, breaking the common `if (!res.body) … await res.json()` shape
 * where `.body` is only touched as a truthiness check.
 */
function watchStream(stream, release) {
  let reader = null;
  return new ReadableStream({
    async pull(controller) {
      reader ||= stream.getReader();
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        release();
        controller.error(err);
      }
    },
    async cancel(reason) {
      release();
      await Promise.resolve(reader ? reader.cancel(reason) : stream.cancel(reason)).catch(() => {});
    },
  }, { highWaterMark: 0 });
}
