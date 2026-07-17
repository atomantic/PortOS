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
 *
 * Strict posture (`blockPrivate: true`): additionally reject ALL private/LAN
 * addresses (RFC1918, CGNAT-adjacent, IPv6 ULA fc00::/7, …) — both host literals
 * and DNS-resolved addresses. RSS feeds use this so an arbitrary user-added feed
 * URL can't be pointed at the home network, preserving feeds.js's historical
 * block-all-private posture while gaining the connect-time IP pin.
 */

import dns from 'dns/promises';
import { Agent } from 'undici';
import { ServerError } from './errorHandler.js';
import { fetchWithTimeout } from './fetchWithTimeout.js';
import { isSafeIngestUrl, isBlockedIngestHost } from './catalogValidation.js';

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024; // 12 MB — generous for a single image/feed

/**
 * Classify an IP literal as private/loopback/link-local (IPv4 or IPv6) for the
 * strict `blockPrivate` posture. `isBlockedIngestHost` only covers
 * loopback/link-local/metadata (the default posture ALLOWS LAN); this widens the
 * net to the full RFC1918 / CGNAT-adjacent / IPv6-ULA ranges so a feed URL can't
 * reach the home network. An unparseable / empty value fails closed (private).
 */
function isPrivateAddress(ip) {
  if (!ip) return true;
  const lower = ip.toLowerCase();
  if (lower.includes(':')) {
    if (lower === '::1' || lower === '::') return true;
    // Embedded IPv4 — IPv4-mapped (::ffff:…) OR the deprecated IPv4-compatible
    // (::…) form, either dotted (::ffff:1.2.3.4) or the two-hextet form URL
    // parsing normalizes to (::ffff:c0a8:101 AND the ffff-less ::c0a8:101 that
    // `new URL('http://[::192.168.1.1]')` yields). Decode and re-check as IPv4 so
    // a private v4 embedded in an IPv6 literal can't slip past. Mirrors the
    // embedded-v4 handling in catalogValidation.isBlockedIngestHost.
    const embedded = /^::(?:ffff:)?(.+)$/i.exec(lower);
    if (embedded) {
      const tail = embedded[1];
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return isPrivateAddress(tail);
      const parts = tail.split(':');
      if (parts.length === 2 && parts.every((p) => /^[0-9a-f]{1,4}$/.test(p))) {
        const hi = parseInt(parts[0], 16);
        const lo = parseInt(parts[1], 16);
        return isPrivateAddress(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
      }
    }
    const firstGroup = lower.split(':')[0];
    if (firstGroup) {
      const firstWord = parseInt(firstGroup, 16);
      if (Number.isFinite(firstWord)) {
        if ((firstWord & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
        if ((firstWord & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
      }
    }
    return false;
  }
  const parts = lower.split('.').map(Number);
  if (parts.length === 4 && parts.every((p) => !isNaN(p) && p >= 0 && p <= 255)) {
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true; // CGNAT 100.64/10 (Tailscale et al.)
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
  }
  return false;
}

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
async function resolvePublicHttpUrl(target, { blockPrivate = false } = {}) {
  if (!isSafeIngestUrl(target)) return { safe: false };
  const { hostname } = new URL(target);
  // Host literals were already classified by isSafeIngestUrl and need no pinning
  // (net connects straight to the literal — there's no name to rebind).
  const isIpLiteral = /^[\d.]+$/.test(hostname) || hostname.includes(':');
  if (isIpLiteral) {
    // Strict posture must still reject a private LITERAL (e.g. http://192.168.1.5)
    // that isSafeIngestUrl deliberately allows in the default LAN-friendly gate.
    const literal = hostname.replace(/^\[|\]$/g, '');
    if (blockPrivate && isPrivateAddress(literal)) return { safe: false };
    return { safe: true, address: null };
  }
  const resolved = await dns.lookup(hostname).catch(() => null);
  if (!resolved?.address) return { safe: false }; // can't vet → can't safely pin → fail closed
  if (isBlockedIngestHost(resolved.address)) return { safe: false };
  if (blockPrivate && isPrivateAddress(resolved.address)) return { safe: false };
  return { safe: true, address: resolved.address, family: resolved.family };
}

/**
 * Boolean SSRF gate. Returns false on any failure — never throws — so redirect
 * revalidation can fail closed. `blockPrivate` opts into the strict posture.
 */
export async function isPublicHttpUrlSafe(target, { blockPrivate = false } = {}) {
  return (await resolvePublicHttpUrl(target, { blockPrivate })).safe;
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
export async function assertPublicHttpUrl(target, { blockPrivate = false } = {}) {
  if (!await isPublicHttpUrlSafe(target, { blockPrivate })) throwUnsafeUrl();
}

// Fetch with the first-hop gate + manual redirect revalidation (fails closed).
// Every hop is resolved AND pinned, so the connect can't re-resolve to a blocked
// address after the check passes. Returns the Response, or null on a network
// error / blocked redirect / missing Location. The caller decides what to do
// with a non-ok status. First-hop unsafe THROWS a clean 400 by default (routes
// want that); `throwOnUnsafe: false` makes it fail closed to null instead — for
// callers (RSS feeds) whose own contract is a friendly "couldn't fetch" result
// rather than a bubbled error.
async function fetchGuarded(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers, blockPrivate = false, throwOnUnsafe = true } = {}) {
  const first = await resolvePublicHttpUrl(url, { blockPrivate });
  if (!first.safe) {
    if (throwOnUnsafe) throwUnsafeUrl();
    return null;
  }
  const res = await pinnedFetch(url, first, { redirect: 'manual', headers }, timeoutMs);
  if (res && res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (!location) return null;
    // A malformed Location must fail closed to null (not throw) so the
    // throwOnUnsafe:false contract holds for the redirect hop too — same
    // guarded-parse pattern as isSafeIngestUrl.
    let redirectUrl;
    try { redirectUrl = new URL(location, url).href; } catch { return null; }
    const hop = await resolvePublicHttpUrl(redirectUrl, { blockPrivate });
    if (!hop.safe) return null;
    return pinnedFetch(redirectUrl, hop, { redirect: 'error', headers }, timeoutMs);
  }
  return res;
}

/**
 * Read a response body into a Buffer bounded by `maxBytes`, or null when the
 * body exceeds the cap. The cap is enforced first via Content-Length (cheap
 * early-out) and then bounds PEAK MEMORY by streaming the body and aborting the
 * moment accumulated bytes exceed it — so a server that omits or lies about
 * Content-Length can't stream gigabytes into memory before a post-read check
 * fires. Falls back to a buffered read only when the response exposes no
 * stream (e.g. a test double). Shared by fetchPublicBinary and the opt-in
 * fetchPublicText cap.
 */
async function readBodyCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (maxBytes && Number.isFinite(declared) && declared > maxBytes) return null;

  if (!res.body || typeof res.body.getReader !== 'function') {
    // No readable stream (some runtimes / test doubles) — fall back to a
    // buffered read, still capped post-read.
    const buffer = Buffer.from(await res.arrayBuffer());
    if (maxBytes && buffer.byteLength > maxBytes) return null;
    return buffer;
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
  return Buffer.concat(chunks);
}

/**
 * Fetch a URL's body as text. Returns the string on a 2xx, or null on any
 * failure (network error, non-ok status, blocked redirect). `blockPrivate` opts
 * into the strict block-all-private posture and `throwOnUnsafe: false` returns
 * null (instead of throwing a 400) when the first hop is unsafe — both used by
 * RSS feed fetches. `maxBytes` (opt-in — no default, so existing callers keep
 * the plain `res.text()` behavior) streams the body through the shared cap and
 * returns null when it's exceeded, bounding peak memory exactly like
 * fetchPublicBinary.
 */
export async function fetchPublicText(url, { timeoutMs, headers, maxBytes, blockPrivate = false, throwOnUnsafe = true } = {}) {
  const res = await fetchGuarded(url, { timeoutMs, headers, blockPrivate, throwOnUnsafe });
  if (!res?.ok) return null;
  if (!maxBytes) return res.text();
  const buffer = await readBodyCapped(res, maxBytes);
  return buffer === null ? null : buffer.toString('utf-8');
}

/**
 * Fetch a URL's body as a Buffer. Returns `{ buffer, contentType }` on a 2xx
 * within the size cap, or null on any failure (see readBodyCapped for the
 * streaming peak-memory bound).
 */
export async function fetchPublicBinary(url, { timeoutMs, headers, maxBytes = DEFAULT_MAX_BYTES, blockPrivate = false, throwOnUnsafe = true } = {}) {
  const res = await fetchGuarded(url, { timeoutMs, headers, blockPrivate, throwOnUnsafe });
  if (!res?.ok) return null;
  const contentType = res.headers.get('content-type') || '';
  const buffer = await readBodyCapped(res, maxBytes);
  return buffer === null ? null : { buffer, contentType };
}
