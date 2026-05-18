/**
 * Sharing protocol versioning.
 *
 * `SHARING_SCHEMA_VERSION` is the on-the-wire format version for share-bucket
 * artifacts (bucket.json layout, manifest shape, record-bundle layout). Bump
 * it whenever a format change would prevent older PortOS instances from
 * correctly parsing newer artifacts. Specifically:
 *
 *   1 — initial format. bucket.json with { id, name, schemaVersion, createdAt }.
 *       Manifest with { id, schemaVersion, createdAt, kind, senderInstanceId,
 *       source, sourceBio?, bucketId, bucketName, recordIds[], assetRefs[], note? }.
 *       assetRefs use { kind: 'image'|'video', ref: '<filename>' }.
 *       Record bundles in `records/{series,issues,universes,media}/<id>.json`.
 *       Asset blobs at `assets/{images,videos}/<filename>`.
 *   2 — content-addressed asset blobs. assetRefs now `{ kind, ref, hash }`
 *       (sha256). Blobs live at `assets/blobs/<hash>`; sidecar metadata at
 *       `assets/blobs/<hash>.metadata.json`. The importer prefers the hash
 *       lookup and falls back to `assets/<kind>/<filename>` when `hash` is
 *       absent (so v1 manifests still in-bucket continue to import). Two
 *       manifests that reference identical bytes under different filenames
 *       share one on-disk blob, eliminating duplicate-blob storage.
 *
 * Compatibility rules:
 *   - A peer can read a manifest with `sharingSchemaVersion <= local
 *     SHARING_SCHEMA_VERSION`. Older formats stay supported as we bump.
 *   - A peer cannot read a manifest with `sharingSchemaVersion > local
 *     SHARING_SCHEMA_VERSION` — the importer refuses with INCOMPATIBLE_VERSION
 *     and surfaces a UI hint to upgrade.
 *   - The sender always writes at the local SHARING_SCHEMA_VERSION (never
 *     downgrades to match older peers — that would require maintaining a
 *     parallel writer for every prior version).
 *
 * `producedByVersion` is the PortOS app version (e.g. "1.54.0") read from
 * package.json. It rides on every outgoing manifest and is displayed alongside
 * the source name so the user can see who's running what — informational, not
 * load-bearing for compat decisions.
 */

export const SHARING_SCHEMA_VERSION = 2;

let cachedAppVersion = null;
let cachedAt = 0;

/**
 * Reads PortOS app version from package.json with a short TTL so updates
 * are reflected without a server restart. Falls back to "unknown" on read
 * failure (the manifest still ships, just without informative attribution).
 *
 * `updateChecker` is imported lazily here because its module body evaluates
 * `join(PATHS.data, …)` at load time. Static-importing it from version.js
 * would force every consumer (manifest.js, buckets.js) to drag the same
 * eager-PATHS chain into test files that lazy-mock PATHS in beforeEach.
 */
export async function getProducedByVersion() {
  const now = Date.now();
  if (cachedAppVersion && now - cachedAt < 60_000) return cachedAppVersion;
  const { getCurrentVersion } = await import('../updateChecker.js');
  const v = await getCurrentVersion().catch(() => null);
  cachedAppVersion = (typeof v === 'string' && v) ? v : 'unknown';
  cachedAt = now;
  return cachedAppVersion;
}

/** Returns true when we can read artifacts produced at `remoteVersion`. */
export function isManifestCompatible(remoteVersion) {
  if (!Number.isFinite(remoteVersion)) return false;
  return remoteVersion <= SHARING_SCHEMA_VERSION;
}
