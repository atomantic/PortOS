// One replay, because the second GOAWAY in a row is a host tearing every
// connection down rather than one expiring socket — retrying past that only
// delays the failure the caller has to handle anyway.
const MAX_GOAWAY_REPLAYS = 1;
const TRANSIENT_GATEWAY_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524]);
const REPLAY_SAFE_TRANSPORT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * Walk a fetch rejection's `cause` chain — depth-bounded, cycle-guarded, and
 * yielding the bare string a chain can bottom out in. Node/undici exposes every
 * pre-header transport failure as the same `TypeError: fetch failed` with the
 * actionable reason nested under `.cause`, so the description and both replay
 * predicates below all have to look past the outer error.
 */
function* causeChain(error) {
  const seen = new Set();
  let current = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 5; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    yield current;
    current = current.cause;
  }
  if (typeof current === 'string') yield current;
}

/**
 * Flatten a fetch rejection's cause chain for run metadata and classification.
 * Kept inside the vendored toolkit rather than importing PortOS's equivalent
 * helper, preserving this directory's self-contained contract.
 */
export function describeTransportError(error) {
  const parts = [];
  for (const link of causeChain(error)) {
    if (typeof link === 'string') { parts.push(link); continue; }
    if (link.code) parts.push(String(link.code));
    if (link.message) parts.push(String(link.message));
  }
  return parts.join(': ') || String(error);
}

export function isTransientGatewayStatus(status) {
  return TRANSIENT_GATEWAY_STATUSES.has(Number(status));
}

/**
 * Is this an HTTP/2 `GOAWAY` — the remote retiring a pooled connection?
 *
 * This is the ONE transport failure that is replay-safe against a billable,
 * remote provider, and the distinction is what `isReplaySafeTransportError`
 * cannot make. A reset or a socket timeout may land *after* the upstream
 * accepted the request, so replaying one can bill a second generation; that
 * whole family therefore stays behind the local-and-keyless gate. A GOAWAY
 * carries the opposite guarantee — HTTP/2 §6.8 defines it as the peer
 * declaring it will not process streams above `lastStreamID`, so a request
 * that dies this way was never handled and one replay produces exactly one
 * generation.
 *
 * Without it a gateway that recycles idle connections on its own schedule
 * (NVIDIA NIM does) fails a run in ~0ms with a bare `UND_ERR_SOCKET`, which
 * classifies as UNKNOWN and escalates to a tier-4 investigation task — for a
 * request that merely picked an expiring socket out of the pool.
 *
 * Matched on the message rather than the code: undici raises it as a
 * `SocketError` (`UND_ERR_SOCKET`) today, and the GOAWAY text is the durable
 * part of that contract.
 */
export function isUnprocessedGoawayError(error) {
  for (const link of causeChain(error)) {
    if (/GOAWAY/i.test(typeof link === 'string' ? link : String(link.message || ''))) return true;
  }
  return false;
}

export function isReplaySafeTransportError(error) {
  for (const link of causeChain(error)) {
    if (typeof link !== 'string' && REPLAY_SAFE_TRANSPORT_CODES.has(link.code)) return true;
  }
  return false;
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '::' || host === '0.0.0.0') return true;
  const octets = host.split('.');
  return octets.length === 4
    && Number(octets[0]) === 127
    && octets.slice(1).every((octet) => /^\d+$/.test(octet) && Number(octet) <= 255);
}

/**
 * Completion POSTs are not generally safe to replay: a proxy can return a
 * transient error after the provider accepted the request, which would repeat
 * a billable generation. PortOS's local, keyless inference daemons are the one
 * bounded case where duplicate work cannot create an external charge. Keep
 * this opt-in predicate beside the retry policy so every caller applies the
 * same safety boundary.
 */
export function isReplaySafeLocalRequest({ endpoint, apiKey } = {}) {
  if (apiKey || typeof endpoint !== 'string' || !URL.canParse(endpoint)) return false;
  return isLoopbackHost(new URL(endpoint).hostname);
}

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError');
}

function abortableDelay(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Retry a streaming request only while it is still safe to replace the whole
 * response: before the caller has accepted an OK response and begun reading
 * its body. Final responses/errors are returned unchanged so existing provider
 * classification and fallback behavior remain authoritative.
 *
 * Two replay policies live here, and the narrower one is not optional:
 *
 * - `allowReplay` (caller-proven local + keyless) covers transient gateway
 *   STATUSES and the whole reset/timeout transport family, any of which the
 *   upstream may already have processed.
 * - An HTTP/2 `GOAWAY` is replayed **once regardless of `allowReplay`**,
 *   because the frame itself proves the request was never processed. Gating it
 *   behind `allowReplay` meant a remote gateway recycling an idle pooled
 *   connection killed the run outright; see `isUnprocessedGoawayError`. Bounded
 *   to `MAX_GOAWAY_REPLAYS`.
 */
export async function fetchWithPreHeaderRetry(fetchAttempt, {
  signal,
  allowReplay = false,
  maxAttempts = 3,
  maxElapsedMs = 2000,
  baseDelayMs = 100,
  now = Date.now,
  delay = abortableDelay,
} = {}) {
  const startedAt = now();
  let goawayReplays = 0;

  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetchAttempt();
      const retryable = isTransientGatewayStatus(response?.status);
      // An OK/non-retryable response is now the caller's stream to consume.
      // Return it even if the signal raced with header delivery: the caller's
      // reader owns partial-output handling from this boundary onward.
      if (!allowReplay || !retryable) return response;
      if (signal?.aborted) throw abortError(signal);
      const delayMs = baseDelayMs * (2 ** (attempt - 1));
      const hasBudget = attempt < maxAttempts && now() - startedAt + delayMs <= maxElapsedMs;
      if (!hasBudget) return response;

      await Promise.resolve(response.body?.cancel?.()).catch(() => {});
      await delay(delayMs, signal);
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      const delayMs = baseDelayMs * (2 ** (attempt - 1));
      const hasBudget = attempt < maxAttempts && now() - startedAt + delayMs <= maxElapsedMs;
      const broadReplay = allowReplay && isReplaySafeTransportError(error);
      // Checked only when the broad policy declined, so a local provider's
      // GOAWAY keeps spending the broad budget rather than this narrower one.
      const goawayReplay = !broadReplay
        && goawayReplays < MAX_GOAWAY_REPLAYS
        && isUnprocessedGoawayError(error);
      if ((!broadReplay && !goawayReplay) || !hasBudget) throw error;
      if (goawayReplay) goawayReplays += 1;
      await delay(delayMs, signal);
    }
  }
}
