/**
 * Client Error Aggregator
 *
 * Receives error reports from the browser (window.onerror / unhandledrejection
 * via POST /api/client-errors), redacts obvious secrets, de-duplicates by
 * message+stack hash, throttles to a slow trickle, and surfaces unique
 * groups in the Review Hub.
 *
 * Single-user / single-process — in-memory rate-limit and dedup state is fine.
 */

import { createHash } from 'crypto';
import * as reviewService from './review.js';
import { redactOutput } from '../lib/commandSecurity.js';
import { stripQueryString } from '../lib/errorHandler.js';
import { isExtensionError } from '../lib/extensionErrors.js';

const MAX_MESSAGE_CHARS = 500;
const MAX_STACK_CHARS = 4000;
const MAX_URL_CHARS = 500;
const MAX_USER_AGENT_CHARS = 300;

// Throttle: backstop against a buggy or error-looping client that bypasses
// its own throttle. At steady state the client is the primary limiter; this
// guarantees a misbehaving build can't drive the Review Hub at line rate.
// Not a DoS shield — this is a single-user app behind Tailscale.
const MIN_ACCEPT_INTERVAL_MS = 1000;
// Dedup window matches `reviewService.createItem`'s own alert-dedup window
// (24h, keyed off `metadata.referenceId`) so an entry that evicts here
// doesn't desync from the downstream "you already have this alert" check.
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_HASH_ENTRIES = 256;

// Tokens that should never appear in stored fields. Pattern-based so we do
// not bind to any one provider's secret shape — anything with an obvious
// auth-ish silhouette (key=value, key: value, `bearer <token>`, or a known
// provider prefix) is stripped. JSON `"KEY":"value"` shapes are caught by
// the shared `redactOutput` helper below.
const SECRET_LIKE_PATTERNS = [
  /(api[_-]?key|access[_-]?token|secret|password|authorization)\s*[=:]\s*['"]?[\w.\-/+=]{8,}/gi,
  /\bbearer\s+[\w.\-/+=]{12,}/gi,
  /\bsk-[A-Za-z0-9\-_]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

const REDACTED = '[REDACTED]';

const recentHashes = new Map(); // hash -> firstSeenAt
let lastAcceptedAt = 0;

function redactSecrets(str) {
  if (typeof str !== 'string' || !str) return str;
  let out = redactOutput(str);
  for (const re of SECRET_LIKE_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

function truncate(str, max) {
  if (typeof str !== 'string') return undefined;
  const trimmed = str.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function sanitize(payload) {
  const message = redactSecrets(truncate(payload.message, MAX_MESSAGE_CHARS)) || 'Unknown client error';
  const stack = redactSecrets(truncate(payload.stack, MAX_STACK_CHARS));
  const url = truncate(stripQueryString(payload.url), MAX_URL_CHARS);
  const userAgent = truncate(payload.userAgent, MAX_USER_AGENT_CHARS);
  // `source` is a script URL (e.g. /assets/index-abc.js?v=…) — strip queries
  // so cache-busted requests dedup together and tokens don't leak.
  const source = truncate(stripQueryString(payload.source), MAX_URL_CHARS);
  return {
    type: payload.type,
    message,
    stack,
    url,
    userAgent,
    source,
    line: Number.isInteger(payload.line) ? payload.line : undefined,
    column: Number.isInteger(payload.column) ? payload.column : undefined,
  };
}

function hashError({ message, stack, source }) {
  // Stack frames carry line/column noise that diverges across builds; key
  // on the first 3 lines so a true regression dedups across HMR cycles.
  const stackKey = (stack || '').split('\n').slice(0, 3).join('\n');
  return createHash('sha256').update(`${message}${stackKey}${source || ''}`).digest('hex').slice(0, 16);
}

function buildDescription(payload) {
  const lines = [];
  if (payload.url) lines.push(`URL: ${payload.url}`);
  if (payload.source) {
    const loc = [payload.source];
    if (payload.line != null) loc.push(`:${payload.line}`);
    if (payload.column != null) loc.push(`:${payload.column}`);
    lines.push(`Source: ${loc.join('')}`);
  }
  if (payload.userAgent) lines.push(`UA: ${payload.userAgent}`);
  if (payload.type) lines.push(`Type: ${payload.type}`);
  if (payload.stack) lines.push('', payload.stack);
  return lines.join('\n');
}

function buildTitle(payload) {
  const prefix = payload.type === 'unhandledrejection' ? 'Unhandled rejection' : 'Client error';
  return `${prefix}: ${payload.message.slice(0, 120)}`;
}

function pruneRecent(now) {
  for (const [hash, firstSeenAt] of recentHashes) {
    if (now - firstSeenAt > DEDUP_WINDOW_MS) recentHashes.delete(hash);
  }
  while (recentHashes.size > MAX_HASH_ENTRIES) {
    const oldest = recentHashes.keys().next().value;
    recentHashes.delete(oldest);
  }
}

/**
 * Record a client error report.
 *
 * Resolves to `{ accepted, reason?, itemId? }`. Never throws — a Review Hub
 * write failure is logged and reported as `reason: 'review-hub-write-failed'`
 * so the route stays write-once / no-retry.
 */
export async function recordClientError(rawPayload) {
  const now = Date.now();

  // Before the throttle: an extension error taking the 1/sec slot would drop a
  // real PortOS error arriving behind it. Before sanitize: MAX_STACK_CHARS
  // would truncate away the extension frame that proves provenance.
  // Re-checked here even though current clients filter at the source — a
  // long-lived tab keeps running an old bundle.
  if (isExtensionError(rawPayload)) {
    return { accepted: false, reason: 'extension' };
  }

  // Throttle gate runs before sanitize so a flooded endpoint doesn't burn the
  // regex passes on a payload we're about to drop. The 24h dedup window does
  // the heavy lifting for repeated identical errors; this is the safety net.
  if (now - lastAcceptedAt < MIN_ACCEPT_INTERVAL_MS) {
    return { accepted: false, reason: 'rate-limited' };
  }

  const payload = sanitize(rawPayload);
  const hash = hashError(payload);

  // Prune BEFORE the dedup check — otherwise an expired entry keeps
  // suppressing the same error until some unrelated accepted write happens
  // to trigger pruneRecent. A recurring error past the 24h window would
  // never surface a fresh Review Hub alert.
  pruneRecent(now);
  if (recentHashes.has(hash)) {
    return { accepted: false, reason: 'duplicate' };
  }

  // Advance the throttle clock BEFORE the write so a sustained createItem
  // failure (disk full, file lock, etc.) is rate-limited too — otherwise a
  // looping client could attempt one write per call regardless of throughput.
  lastAcceptedAt = now;

  const item = await reviewService.createItem({
    type: 'alert',
    title: buildTitle(payload),
    description: buildDescription(payload),
    metadata: {
      referenceId: `client-error:${hash}`,
      category: 'client-error',
      kind: payload.type,
      source: payload.source,
      line: payload.line,
      column: payload.column,
      url: payload.url,
    },
  }).catch(err => {
    console.error(`❌ Failed to record client error to Review Hub: ${err.message}`);
    return null;
  });

  if (!item) return { accepted: false, reason: 'review-hub-write-failed' };

  recentHashes.set(hash, now);
  return { accepted: true, itemId: item.id };
}

/**
 * Reset all in-memory state. Test-only — never called from production paths.
 */
export function _resetForTests() {
  recentHashes.clear();
  lastAcceptedAt = 0;
}
