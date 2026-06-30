/**
 * Safe public-URL fetch — SSRF-guarded text/binary fetch for "go grab this
 * remote thing the user pointed us at" flows (RSS feeds, remote images, …).
 *
 * Centralizes the guard so new callers reuse ONE implementation instead of
 * copying the host-parsing logic a fourth time (it already lives, subtly
 * differently, in feeds.js `fetchFeedXml` and catalogIngestSources.js
 * `assertIngestUrlSafe`). The hard part — classifying a host literal as
 * loopback/link-local/cloud-metadata across IPv4 / IPv6 / IPv4-mapped forms —
 * is reused from `catalogValidation.isBlockedIngestHost`; this module adds the
 * DNS-resolve check and the redirect-revalidating fetch wrappers on top.
 *
 * Posture (matches the catalog ingest gate): block non-http(s) schemes,
 * loopback, link-local, and the cloud-metadata endpoint; ALLOW other
 * private/LAN hosts (a single-user tool legitimately reaches Tailscale peers /
 * home wikis). A redirect to a blocked target fails CLOSED (returns null) — the
 * landed hop is revalidated exactly like the first.
 */

import dns from 'dns/promises';
import { Agent } from 'undici';
import { ServerError } from './errorHandler.js';
import { fetchWithTimeout } from './fetchWithTimeout.js';
import { isSafeIngestUrl, isBlockedIngestHost } from './catalogValidation.js';

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024; // 12 MB — generous for a single image/feed

/**
 * Core SSRF resolve: scheme + blocked-host-literal (sync, via isSafeIngestUrl),
 * AND a single DNS resolve so a hostname whose A record points at a blocked
 * address (cloud metadata / loopback / link-local) is rejected too. Returns the
 * vetted IP so the caller can PIN it at connect time — closing the DNS-rebinding
 * TOCTOU where a re-resolution at connect could land on a private address the
 * validation lookup never saw. Never throws.
 *
 * `address` is null only for an IP-literal target (the connect goes straight to
 * the literal — there's no name to re-resolve, so no TOCTOU and nothing to pin).
 * A hostname that can't be resolved fails CLOSED ({ safe: false }) rather than
 * falling through to an unpinned fetch: an unpinned connect would re-resolve at
 * connect time, exactly the rebinding window this guard exists to close (an
 * attacker can fail the validation lookup, then answer a private IP at connect).
 *
 * @returns {Promise<{ safe: boolean, address?: string|null, family?: number }>}
 */
async function resolvePublicHttpUrl(target) {
  if (!isSafeIngestUrl(target)) return { safe: false };
  const { hostname } = new URL(target);
  // Host literals were already classified by isSafeIngestUrl and need no pinning
  // (net connects straight to the literal — there's no name to rebind).
  const isIpLiteral = /^[\d.]+$/.test(hostname) || hostname.includes(':');
  if (isIpLiteral) return { safe: true, address: null };
  const resolved = await dns.lookup(hostname).catch(() => null);
  if (!resolved?.address) return { safe: false }; // can't vet → can't safely pin → fail closed
  if (isBlockedIngestHost(resolved.address)) return { safe: false };
  return { safe: true, address: resolved.address, family: resolved.family };
}

/**
 * Boolean SSRF gate. Returns false on any failure — never throws — so redirect
 * revalidation can fail closed.
 */
export async function isPublicHttpUrlSafe(target) {
  return (await resolvePublicHttpUrl(target)).safe;
}

/**
 * net.lookup-compatible function that ALWAYS yields the SSRF-vetted IP, ignoring
 * the hostname undici would otherwise re-resolve. This is what closes the
 * rebinding TOCTOU: undici connects to exactly the address the guard approved,
 * while Host header + TLS SNI stay the original hostname (undici derives
 * `servername` from the host), so cert validation is unaffected. undici asks
 * with `all: true`, so honor both the array and single-address callback shapes.
 */
export function buildPinnedLookup(address, family) {
  const fam = family || (address.includes(':') ? 6 : 4);
  return (_hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const entry = { address, family: fam };
    cb(null, options?.all ? [entry] : entry.address, entry.family);
  };
}

// One-shot dispatcher that pins every connection to the vetted IP. Created
// per-request and left for GC after the body is consumed (single-user,
// low-volume tool — a pooled keep-alive agent would only hold a stale socket).
function pinnedDispatcher(address, family) {
  return new Agent({ connect: { lookup: buildPinnedLookup(address, family) } });
}

// Fetch the URL with its connection pinned to the SSRF-vetted address (when we
// have one), falling back to the runtime's own resolution otherwise.
function pinnedFetch(url, resolved, options, timeoutMs) {
  const fetchOptions = resolved.address
    ? { ...options, dispatcher: pinnedDispatcher(resolved.address, resolved.family) }
    : options;
  return fetchWithTimeout(url, fetchOptions, timeoutMs).catch(() => null);
}

function throwUnsafeUrl() {
  throw new ServerError('refusing to fetch a non-http(s) or loopback/link-local URL', {
    status: 400,
    code: 'UNSAFE_URL',
  });
}

/**
 * Throwing variant for the FIRST hop (the user-supplied / stored URL) so a bad
 * target surfaces a clean 400 at the route instead of a silent null.
 */
export async function assertPublicHttpUrl(target) {
  if (!await isPublicHttpUrlSafe(target)) throwUnsafeUrl();
}

// Fetch with the first-hop gate (throws) + manual redirect revalidation (fails
// closed). Every hop is resolved AND pinned, so the connect can't re-resolve to
// a blocked address after the check passes. Returns the Response, or null on a
// network error / blocked redirect / missing Location. The caller decides what
// to do with a non-ok status.
async function fetchGuarded(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers } = {}) {
  const first = await resolvePublicHttpUrl(url);
  if (!first.safe) throwUnsafeUrl();
  const res = await pinnedFetch(url, first, { redirect: 'manual', headers }, timeoutMs);
  if (res && res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (!location) return null;
    const redirectUrl = new URL(location, url).href;
    const hop = await resolvePublicHttpUrl(redirectUrl);
    if (!hop.safe) return null;
    return pinnedFetch(redirectUrl, hop, { redirect: 'error', headers }, timeoutMs);
  }
  return res;
}

/**
 * Fetch a URL's body as text. Returns the string on a 2xx, or null on any
 * failure (network error, non-ok status, blocked redirect).
 */
export async function fetchPublicText(url, { timeoutMs, headers } = {}) {
  const res = await fetchGuarded(url, { timeoutMs, headers });
  if (!res?.ok) return null;
  return res.text();
}

/**
 * Fetch a URL's body as a Buffer. Returns `{ buffer, contentType }` on a 2xx
 * within the size cap, or null on any failure. The cap is enforced first via
 * Content-Length (cheap early-out) and then bounds PEAK MEMORY by streaming the
 * body and aborting the moment accumulated bytes exceed it — so a server that
 * omits or lies about Content-Length can't stream gigabytes into memory before a
 * post-read check fires. Falls back to a buffered read only when the response
 * exposes no stream (e.g. a test double).
 */
export async function fetchPublicBinary(url, { timeoutMs, headers, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const res = await fetchGuarded(url, { timeoutMs, headers });
  if (!res?.ok) return null;
  const contentType = res.headers.get('content-type') || '';
  const declared = Number(res.headers.get('content-length'));
  if (maxBytes && Number.isFinite(declared) && declared > maxBytes) return null;

  if (!res.body || typeof res.body.getReader !== 'function') {
    // No readable stream (some runtimes / test doubles) — fall back to a
    // buffered read, still capped post-read.
    const buffer = Buffer.from(await res.arrayBuffer());
    if (maxBytes && buffer.byteLength > maxBytes) return null;
    return { buffer, contentType };
  }

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (maxBytes && total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released by cancel() */ }
  }
  return { buffer: Buffer.concat(chunks), contentType };
}
