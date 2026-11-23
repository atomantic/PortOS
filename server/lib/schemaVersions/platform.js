/**
 * Federation-infrastructure wire versions: memory, media-library, CoS and Eidoverse manifests, app quality, Meatspace snapshots and peer capabilities.
 *
 * One domain slice of `PORTOS_SCHEMA_VERSIONS` (`server/lib/schemaVersions.js` composes every slice in the shipped key order).
 * Bump a value here, never in the composer, so a routine bump runs scoped CI instead of the full matrix; a NEW category also needs its composer entry.
 */

export const PLATFORM_SCHEMA_VERSIONS = Object.freeze({
  // Numeric-only peer wire payload for app quality (GET /api/apps/quality-federation).
  // `repository` stays `{ schemaVersion, repository, measurements }`. `repositories`
  // is `{ schemaVersion, repositories }` at this same version. The .quality.json file format is versioned separately.
  appQuality: 1,
  // Memory pull capability; each receiver keeps its own monotonic history.
  memoryHistory: 1,
  // Media-library manifest envelope (receiver-pull; ahead senders are skipped, not rejected).
  mediaLibrary: 1,
  // Eidoverse foundation offering envelope and withdrawal tombstones (receiver-pull); v3 = `tombstones`.
  eidoverseFoundations: 3,
  // Meatspace daily-log snapshot; v2 = identity-keyed blood, epigenetic and eye rows with `rowTombstones`.
  meatspace: 2,
  // Paired-peer credential handshake (`X-PortOS-Peer-Auth`), advertised in health details.
  peerAuth: 1,
  // Image `createdAt` on push asset manifests (capability, advertised in health details).
  peerAssetStamps: 1,
  // CoS history archive manifest envelope (receiver-pull; ahead senders are skipped).
  cosHistory: 1,
  // CoS task queues and claim metadata (receiver-pull, claim-aware merge); v13 = one spawn counter and no spawn-budget proof metadata; a v12 peer would hold every such task (#16807).
  cosTasks: 13,
});
