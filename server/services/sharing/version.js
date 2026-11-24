/**
 * `SHARING_SCHEMA_VERSION` is the wire format version of share artifacts; bump it when a
 * change would stop older instances parsing newer ones.
 *   1 — bucket.json, manifest with `assetRefs { kind, ref }`, records in
 *       `records/{series,issues,universes,media}/<id>.json`, blobs at `assets/{images,videos}/<filename>`.
 *   2 — content-addressed blobs: assetRefs gain `hash` (sha256) at `assets/blobs/<hash>` (+ `.metadata.json`);
 *       the importer prefers the hash and falls back to the v1 path.
 * Readers accept `version <= local`, refusing newer with INCOMPATIBLE_VERSION; the sender always
 * writes the local version. `producedByVersion` (app version) is informational only.
 */

import { readFile } from 'fs/promises';

export const SHARING_SCHEMA_VERSION = 2;

const PACKAGE_JSON_URL = new URL('../../../package.json', import.meta.url);
let cachedAppVersion = null;
let cachedAt = 0;

/**
 * App version from package.json, cached 60s; "unknown" on read failure.
 * Reads package.json directly instead of importing `updateChecker.js`, keeping
 * sharing leaves off both eager `PATHS.data` evaluation and the GitHub/PR/CoS graph.
 */
export async function getProducedByVersion() {
  const now = Date.now();
  if (cachedAppVersion && now - cachedAt < 60_000) return cachedAppVersion;
  let v = null;
  try {
    const raw = await readFile(PACKAGE_JSON_URL, 'utf8');
    v = JSON.parse(raw)?.version ?? null;
  } catch {
    v = null;
  }
  cachedAppVersion = (typeof v === 'string' && v) ? v : 'unknown';
  cachedAt = now;
  return cachedAppVersion;
}

/** Returns true when we can read artifacts produced at `remoteVersion`. */
export function isManifestCompatible(remoteVersion) {
  if (!Number.isFinite(remoteVersion)) return false;
  return remoteVersion <= SHARING_SCHEMA_VERSION;
}
