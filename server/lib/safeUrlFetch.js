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
import { ServerError } from './errorHandler.js';
import { fetchWithTimeout } from './fetchWithTimeout.js';
import { isSafeIngestUrl, isBlockedIngestHost } from './catalogValidation.js';

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024; // 12 MB — generous for a single image/feed

/**
 * Boolean SSRF gate: scheme + blocked-host-literal (sync, via isSafeIngestUrl),
 * AND a DNS resolve so a hostname whose A record points at a blocked address
 * (cloud metadata / loopback / link-local) is rejected too. Returns false on any
 * failure — never throws — so redirect revalidation can fail closed.
 */
export async function isPublicHttpUrlSafe(target) {
  if (!isSafeIngestUrl(target)) return false;
  const { hostname } = new URL(target);
  // Host literals were already classified by isSafeIngestUrl; only resolve names.
  const isIpLiteral = /^[\d.]+$/.test(hostname) || hostname.includes(':');
  if (!isIpLiteral) {
    const resolved = await dns.lookup(hostname).catch(() => null);
    if (resolved?.address && isBlockedIngestHost(resolved.address)) return false;
  }
  return true;
}

/**
 * Throwing variant for the FIRST hop (the user-supplied / stored URL) so a bad
 * target surfaces a clean 400 at the route instead of a silent null.
 */
export async function assertPublicHttpUrl(target) {
  if (!await isPublicHttpUrlSafe(target)) {
    throw new ServerError('refusing to fetch a non-http(s) or loopback/link-local URL', {
      status: 400,
      code: 'UNSAFE_URL',
    });
  }
}

// Fetch with the first-hop gate (throws) + manual redirect revalidation (fails
// closed). Returns the Response, or null on a network error / blocked redirect /
// missing Location. The caller decides what to do with a non-ok status.
async function fetchGuarded(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers } = {}) {
  await assertPublicHttpUrl(url);
  const res = await fetchWithTimeout(url, { redirect: 'manual', headers }, timeoutMs).catch(() => null);
  if (res && res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (!location) return null;
    const redirectUrl = new URL(location, url).href;
    if (!await isPublicHttpUrlSafe(redirectUrl)) return null;
    return fetchWithTimeout(redirectUrl, { redirect: 'error', headers }, timeoutMs).catch(() => null);
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
