/**
 * Client error reporter — POSTs window.onerror + unhandledrejection events to
 * `/api/client-errors` for aggregation in the Review Hub.
 *
 * In-memory dedup (60s window per message+stack hash) plus a 1/sec throttle
 * to keep render storms from flooding the server; both mirror the server-side
 * aggregator's behavior so identical guards exist on both ends. The reporter
 * is fire-and-forget: it never throws, and any failure during fetch is
 * swallowed so the unhandledrejection handler can't recurse into itself.
 */

import { evictOldest } from './boundedMap.js';
import { isExtensionError } from './extensionErrors.js';

const ENDPOINT = '/api/client-errors';
const MIN_SEND_INTERVAL_MS = 1000;
const DEDUP_WINDOW_MS = 60 * 1000;
const MAX_RECENT = 64;

const recentHashes = new Map(); // hash -> firstSentAt
let lastSentAt = 0;

function hashString(input) {
  // Lightweight FNV-1a 32-bit, hex. Not cryptographic — only enough to
  // collapse repeated render storms before they cross the network.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function hashError(message, stack, source) {
  const stackKey = (stack || '').split('\n').slice(0, 3).join('\n');
  return hashString(`${message}\n${stackKey}\n${source || ''}`);
}

function pruneRecent(now) {
  for (const [hash, sentAt] of recentHashes) {
    if (now - sentAt > DEDUP_WINDOW_MS) recentHashes.delete(hash);
  }
  // After the TTL sweep, enforce the hard size cap by evicting oldest-first.
  evictOldest(recentHashes, MAX_RECENT);
}

// Guarded stringify so a circular rejection reason or a value that throws
// from its toString() can't itself throw out of the global error handler —
// `reportClientError`'s "never throws" contract is critical because we wire
// it from `unhandledrejection`.
function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    try { return Object.prototype.toString.call(value); } catch { return '[unstringifiable]'; }
  }
}

function safeToString(value) {
  try { return String(value); } catch { return '[unstringifiable]'; }
}

// Read a property from an unknown reason without trusting it not to throw —
// a Proxy or hostile getter can throw on `.message` / `.stack` access.
function safeGet(obj, key) {
  try { return obj[key]; } catch { return undefined; }
}

function coerceStack(stack) {
  if (stack == null) return undefined;
  return typeof stack === 'string' ? stack : safeToString(stack);
}

function extractFromReason(reason) {
  if (reason instanceof Error) {
    return {
      message: safeGet(reason, 'message') || safeToString(reason),
      stack: coerceStack(safeGet(reason, 'stack')),
    };
  }
  if (reason && typeof reason === 'object') {
    const m = safeGet(reason, 'message');
    return {
      message: safeToString(m ?? safeStringify(reason)),
      stack: coerceStack(safeGet(reason, 'stack')),
    };
  }
  return { message: safeToString(reason ?? 'Unknown'), stack: undefined };
}

/**
 * Build the report payload from a raw browser event description. Exported for
 * tests; production wires call `reportClientError` directly.
 */
export function buildPayload(input) {
  const base = {
    type: input.type === 'unhandledrejection' ? 'unhandledrejection' : 'error',
    url: typeof window !== 'undefined' ? window.location.href : undefined,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
  };

  if (input.type === 'unhandledrejection') {
    const { message, stack } = extractFromReason(input.reason);
    return { ...base, message, stack };
  }

  if (input.error instanceof Error) {
    return {
      ...base,
      message: safeGet(input.error, 'message') || input.message || 'Unknown error',
      stack: coerceStack(safeGet(input.error, 'stack')),
      source: input.filename,
      line: input.lineno,
      column: input.colno,
    };
  }

  return {
    ...base,
    message: input.message || 'Unknown error',
    source: input.filename,
    line: input.lineno,
    column: input.colno,
  };
}

// Build the request body so that any non-serializable value on `stack` /
// `message` (BigInt, Symbol, throwing toJSON) can't slip past the try block
// and reject inside the fetch call. Falls back to a degraded payload that
// keeps the type + truncated message rather than dropping the report.
function safeBody(payload) {
  try {
    return JSON.stringify(payload);
  } catch {
    return JSON.stringify({
      type: payload.type,
      message: safeToString(payload.message),
      stack: '[unserializable]',
    });
  }
}

/**
 * Report a client-side error. Resolves to:
 *   - `{ sent: true }` — sent to the server.
 *   - `{ sent: false, reason: 'duplicate' | 'extension' | 'rate-limited' | 'no-fetch' | 'transport-error' | 'caught' | 'empty' }`
 *
 * Never throws — any synchronous exception while building the payload or any
 * fetch failure resolves to `{ sent: false, reason }`. This is critical because
 * the reporter is wired from `unhandledrejection`, where any uncaught throw
 * would itself become an unhandled rejection (infinite recursion).
 */
export async function reportClientError(input) {
  if (typeof fetch !== 'function') return { sent: false, reason: 'no-fetch' };

  let payload;
  let hash;
  const now = Date.now();
  try {
    payload = buildPayload(input);
    if (!payload.message) return { sent: false, reason: 'empty' };

    // Before the throttle below, so an extension error can't consume the 1/sec
    // slot and drop a real PortOS error arriving behind it. See
    // lib/extensionErrors.js for why we filter these at all.
    if (isExtensionError(payload)) return { sent: false, reason: 'extension' };

    if (now - lastSentAt < MIN_SEND_INTERVAL_MS) {
      return { sent: false, reason: 'rate-limited' };
    }
    hash = hashError(payload.message, payload.stack, payload.source);
    // Prune BEFORE the dedup check — otherwise an expired entry stays in
    // the map until some unrelated accepted send triggers pruneRecent,
    // silently suppressing recurrences past the 60s window for the rest
    // of the tab's lifetime.
    pruneRecent(now);
    if (recentHashes.has(hash)) {
      return { sent: false, reason: 'duplicate' };
    }

    recentHashes.set(hash, now);
    lastSentAt = now;
  } catch {
    return { sent: false, reason: 'caught' };
  }

  // Raw `fetch` (not the shared `request()` helper) because we need
  // `keepalive: true` so the POST survives a tab unload triggered by the
  // crash itself, and we must never throw — an exception inside the
  // `unhandledrejection` handler would itself become an unhandled rejection.
  // Outer try/catch covers a *synchronous* throw from fetch itself (stubbed
  // test globals, CSP-blocked requests that throw before returning a
  // promise); without it the `.then().catch()` chain is never attached and
  // the rejection escapes.
  let ok = false;
  try {
    ok = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: safeBody(payload),
      keepalive: true,
    }).then(r => r.ok).catch(() => false);
  } catch {
    ok = false;
  }

  return ok ? { sent: true } : { sent: false, reason: 'transport-error' };
}

/**
 * Reset all in-memory state. Test-only.
 */
export function _resetForTests() {
  recentHashes.clear();
  lastSentAt = 0;
}
