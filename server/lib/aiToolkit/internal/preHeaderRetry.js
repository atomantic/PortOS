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
 * Flatten a fetch rejection's cause chain for run metadata and classification.
 * Node/undici otherwise exposes every pre-header transport failure as the same
 * `TypeError: fetch failed`, with the actionable code nested under `.cause`.
 * Kept inside the vendored toolkit rather than importing PortOS's equivalent
 * helper, preserving this directory's self-contained contract.
 */
export function describeTransportError(error) {
  const parts = [];
  const seen = new Set();
  let current = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 5; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current.code) parts.push(String(current.code));
    if (current.message) parts.push(String(current.message));
    current = current.cause;
  }
  if (typeof current === 'string') parts.push(current);
  return parts.join(': ') || String(error);
}

export function isTransientGatewayStatus(status) {
  return TRANSIENT_GATEWAY_STATUSES.has(Number(status));
}

export function isReplaySafeTransportError(error) {
  const seen = new Set();
  let current = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 5; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (REPLAY_SAFE_TRANSPORT_CODES.has(current.code)) return true;
    current = current.cause;
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
      if (!allowReplay || !isReplaySafeTransportError(error) || !hasBudget) throw error;
      await delay(delayMs, signal);
    }
  }
}
