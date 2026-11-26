/**
 * certMeta: best-effort reader for the `data/certs/meta.json` marker that `npm run setup:cert` writes. Returns null on missing-or-partial so callers treat "no meta" as "no cert" without re-implementing the guard.
 *
 * Sibling of `lib/certPaths.js` and `lib/tailscale-https.js`. Zero-dep and side-effect-free, safe to import from `scripts/`, `server/`, `server/lib/` and managed-app code, which is why it inlines `JSON.parse` + try/catch rather than reusing `server/lib/fileUtils.js#safeJSONParse` (that would pull the server-lib chain into `scripts/` and managed apps).
 *
 * Usage:
 *   import { certPaths } from './lib/certPaths.js';
 *   import { readCertMeta } from './lib/certMeta.js';
 *   const { meta: META_PATH } = certPaths(PATHS.data);
 *   const meta = readCertMeta(META_PATH);  // null when absent or mid-write
 * @param {string} metaPath absolute path to `meta.json`.
 * @returns {object | null}
 */
import { readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';

function parseCertMeta(text) {
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

export async function readCertMetaAsync(metaPath) {
  try {
    return parseCertMeta(await readFile(metaPath, 'utf-8'));
  } catch {
    return null;
  }
}

export function readCertMeta(metaPath) {
  try {
    const stat = statSync(metaPath, { throwIfNoEntry: false });
    if (!stat) return null;
    return parseCertMeta(readFileSync(metaPath, 'utf-8'));
  } catch {
    // EACCES on stat / read, EIO, malformed JSON, primitive JSON — every
    // failure mode collapses to "no meta", matching the legacy inline
    // try/catch print-access-url.js used to carry.
    return null;
  }
}

/**
 * Return the browser-trusted MagicDNS hostname recorded by setup-cert, or null
 * for self-signed/legacy/malformed metadata. Keeping validation here means CLI
 * banners and browser auto-open cannot disagree about whether a stored value is
 * safe to interpolate into a URL.
 */
export function getTailscaleCertHostname(meta) {
  if (meta?.mode !== 'tailscale' || typeof meta?.hostname !== 'string') return null;
  const hostname = meta.hostname.trim().replace(/\.$/, '').toLowerCase();
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/.test(hostname)) {
    return null;
  }
  return hostname;
}

/** Exact trusted PortOS origin from certificate metadata. */
export function getTailscaleHttpsUrl(meta, port = 5555) {
  const hostname = getTailscaleCertHostname(meta);
  const numericPort = Number(port);
  if (!hostname || !Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    return null;
  }
  return `https://${hostname}:${numericPort}`;
}

/**
 * ISO `notAfter` of the PEM cert, or null when unparseable. Node's own X.509 parser avoids requiring an `openssl` binary (absent on Windows). Shared by every meta.json writer so they record identical `expiresAt` values.
 */
export function certExpiresAtFromPem(cert) {
  try {
    const expiresAt = new Date(new X509Certificate(cert).validTo);
    return Number.isNaN(expiresAt.getTime()) ? null : expiresAt.toISOString();
  } catch {
    return null;
  }
}

export function readCertExpiresAt(certPath) {
  try {
    return certExpiresAtFromPem(readFileSync(certPath));
  } catch {
    return null;
  }
}
