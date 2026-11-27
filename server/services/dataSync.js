/** Coordinates federated snapshots, checksum caching, and schema-aware inbound dispatch. */

import { isPlainObject } from '../lib/objects.js';
import {
  PORTOS_SCHEMA_VERSIONS,
  buildPortosMeta,
  compareSchemaVersions,
  scopeVersionDiff,
  formatVersionGap,
} from '../lib/schemaVersions.js';
import { readFingerprintMap, fingerprintsEqual } from './dataSync/checksumFingerprints.js';
import { applyMediaInventory } from './dataSync/mediaInventory.js';
import { CATEGORIES } from './dataSync/categories.js';

export { mergeVideoRows, applyRemoteVideoTombstones } from './dataSync/categories/videoHistory.js';
export { getHostedMediaInventory, getImageLibraryInventory } from './dataSync/mediaInventory.js';

const SNAPSHOT_CATEGORY_SCHEMA_KEYS = Object.fromEntries(
  Object.entries(CATEGORIES).map(([category, { schemaKeys }]) => [category, schemaKeys]),
);

// Exported for the boot-adjacent guard test (see dataSync.pipelineUniverse.test.js):
// every snapshot category must have a deliberate schema-key mapping, and every
// versioned PORTOS_SCHEMA_VERSIONS key must be reachable from some category.
export function getSnapshotCategorySchemaKeys() {
  return SNAPSHOT_CATEGORY_SCHEMA_KEYS;
}

// Per-`(category, forPeerId)` `{ fingerprints, checksum }` cache. The
// orchestrator hits getChecksum every cycle — by far the hottest sync-side I/O —
// so caching keyed on underlying-file fingerprints lets it stat-and-return
// when nothing has changed, instead of re-materializing the full payload.
const checksumCache = new Map();
// `forPeerId` segments the key and ultimately comes from an inbound `?forPeer=`
// query param, so left unbounded the Map could grow once per distinct peer id
// ever seen (peers re-register with fresh instanceIds over time). Bound it with
// simple insertion-order (oldest-first) eviction — a home federation has only a
// handful of peers × ~7 categories, so this cap is never hit in practice; it
// just caps the worst case. Re-inserting an existing key refreshes its order.
const CHECKSUM_CACHE_MAX = 256;
const setChecksumCache = (key, value) => {
  if (checksumCache.has(key)) checksumCache.delete(key);
  checksumCache.set(key, value);
  while (checksumCache.size > CHECKSUM_CACHE_MAX) {
    checksumCache.delete(checksumCache.keys().next().value);
  }
};

export function getSupportedCategories() {
  return Object.keys(CATEGORIES);
}

/**
 * Resolve the per-peer exclude-set for a scoped snapshot. Returns a
 * `Set<recordId>` of records the requesting peer (`forPeerId`) already
 * receives from us via the per-record push pipeline — those are excluded
 * from the snapshot we serve it. Returns an EMPTY set (→ full snapshot,
 * legacy behavior) when:
 *   - the category isn't peer-scoped, or
 *   - `forPeerId` is absent (a non-peer caller, or an OLDER peer that doesn't
 *     send `forPeer` — it gets the full snapshot, applied idempotently), or
 *   - the peerSync lookup fails (best-effort; full snapshot is always safe).
 *
 * Dynamic import keeps `sharing/peerSync.js` (and its transitive merge*FromSync
 * graph) OUT of dataSync's module-load path — same rationale as the
 * orchestrator's dynamic import of the same module.
 */
async function resolveExcludeSet(category, forPeerId) {
  if (!CATEGORIES[category].scopeByPeer || typeof forPeerId !== 'string' || forPeerId.length === 0) return new Set();
  const { getOutboundCoverageForPeer } = await import('./sharing/peerOutboundCoverage.js');
  const coverage = await getOutboundCoverageForPeer(forPeerId).catch(() => null);
  return coverage?.[category] instanceof Set ? coverage[category] : new Set();
}

export async function getChecksum(category, { forPeerId } = {}) {
  const cat = CATEGORIES[category];
  if (!cat) return null;
  if (cat.checksumPaths) {
    const fingerprints = await readFingerprintMap(cat);
    if (cat.checksumRevision) fingerprints.revision = cat.checksumRevision();
    // Cache keyed by (category, forPeerId): different requesting peers get
    // different exclude-sets → different scoped snapshots → different
    // checksums. A single per-category cache slot would let peer-B's checksum
    // mask peer-C's. `*` is the unscoped key (no forPeerId).
    const cacheKey = `${category}:${forPeerId || '*'}`;
    const cached = checksumCache.get(cacheKey);
    // Usage contains fallible projections and the provider service has a short
    // TTL cache. Revisit unchanged files periodically so a transient read or a
    // stale provider cache cannot pin a partial projection indefinitely.
    const freshEnough = !cat.checksumMaxAgeMs || Date.now() - cached?.computedAt < cat.checksumMaxAgeMs;
    if (cached && freshEnough && fingerprintsEqual(cached.fingerprints, fingerprints)) {
      return { checksum: cached.checksum };
    }
    // Cache miss only: resolve the per-peer exclude-set (a dynamic peerSync
    // import + subscription read) and build the fresh scoped snapshot. The
    // cache-hit path above never uses `exclude`, so deferring it here saves
    // that I/O on every poll that hits the cache.
    const exclude = await resolveExcludeSet(category, forPeerId);
    const { checksum } = await checksumSource(cat, exclude);
    setChecksumCache(cacheKey, { fingerprints, checksum, computedAt: Date.now() });
    return { checksum };
  }
  const exclude = await resolveExcludeSet(category, forPeerId);
  return { checksum: (await checksumSource(cat, exclude)).checksum };
}

// A manifest-serving category hashes its MANIFEST, not its payload, so the
// cheap map is enough to answer a checksum probe — no need to materialize every
// digest just to throw them away.
const checksumSource = (cat, exclude) => (cat.getManifest ? cat.getManifest() : cat.getSnapshot({ exclude }));

/**
 * The category's per-slot version map (`{ data: { instances: { <slotId>:
 * <lwwTimestamp> }, ... }, checksum }`), or `null` for a category that doesn't
 * serve one. Served at `/api/sync/:category/manifest` and read locally by the
 * orchestrator as "what do we already hold?" — see `lib/syncManifest.js`.
 */
export async function getManifest(category) {
  const cat = CATEGORIES[category];
  if (!cat?.getManifest) return null;
  // Same envelope a snapshot carries, so the receiver's schema-version gate
  // still fires on the path where a manifest with no stale slots stands in for
  // a snapshot fetch (a tombstone-only cycle).
  return { ...(await cat.getManifest()), portosMeta: await buildPortosMeta() };
}

/**
 * Produce a category snapshot + checksum + portosMeta envelope.
 *
 * `options.forPeerId` (the requesting peer's instanceId) scopes the snapshot
 * to EXCLUDE records that peer already receives from us per-record via the
 * push pipeline (its inbound coverage). When absent — a non-peer caller, or
 * an OLDER peer that doesn't yet send `forPeer` — the snapshot is the full
 * category (legacy behavior), which the receiver applies idempotently. This
 * additive, ignore-if-unknown query param is what keeps the change
 * forward/backward compatible across independently-upgrading installs.
 *
 * `options.slots` (from `?slots=`) narrows a manifest-serving category to the
 * per-instance slots the caller diffed as stale. Absent — every non-manifest
 * category, and any older peer — serves the whole payload.
 */
export async function getSnapshot(category, { forPeerId, slots } = {}) {
  const cat = CATEGORIES[category];
  if (!cat) return null;
  const exclude = await resolveExcludeSet(category, forPeerId);
  // `slots` narrows a manifest-serving category to the entries the caller says
  // it is missing. Every other category ignores the option and serves the whole
  // payload, exactly as before.
  const snap = await cat.getSnapshot({ exclude, slots });
  // Stamp the sender's PortOS version + schema versions on every outbound
  // snapshot. Receivers compare against their own PORTOS_SCHEMA_VERSIONS in
  // `applyRemote` and reject ahead-mismatches before any data is merged.
  // Legacy receivers ignore the unknown envelope field — no compatibility
  // risk for the upgrade path.
  return { ...snap, portosMeta: await buildPortosMeta() };
}

/**
 * Apply a peer's snapshot to local state.
 *
 * `options.portosMeta` (when provided) is the sender's PortOS version +
 * schemaVersions envelope. The receiver runs the comparator and rejects
 * ahead-mismatches BEFORE calling the category's `applyRemote` so a sender
 * on a newer storage layout can't corrupt local state. Legacy senders that
 * don't include `portosMeta` pass through (comparator treats absent as
 * zero/no-contract; the sanitizer chain handles older inputs in-place).
 *
 * On block, returns `{ applied: false, count: 0, blockedBySchema: { ahead,
 * behind, senderPortosVersion } }` so the orchestrator can persist the gap
 * on the peer record and the Instances UI can surface it.
 */
export async function applyRemote(category, remoteData, options = {}) {
  const cat = CATEGORIES[category];
  if (!cat) return { applied: false, count: 0 };
  // Attribute any conflict the category's merge journals to the snapshot
  // transport + the peer it came from. `options.peerId` is the source peer's
  // instanceId (the snapshot orchestrator passes it; the manual REST apply
  // route has none → null). Category appliers that don't journal ignore the
  // extra arg.
  const source = { via: 'snapshot', peerId: typeof options.peerId === 'string' && options.peerId ? options.peerId : null };
  const portosMeta = isPlainObject(options.portosMeta) ? options.portosMeta : null;
  const senderSchemaVersions = isPlainObject(portosMeta?.schemaVersions) ? portosMeta.schemaVersions : {};
  const senderPortosVersion = typeof portosMeta?.portosVersion === 'string' ? portosMeta.portosVersion : null;
  // Full union diff for diagnostics; gate (and report) only on the schema
  // categories THIS snapshot category actually writes, so an ahead-mismatch on
  // an unrelated category can't reject this category's snapshot.
  const fullDiff = compareSchemaVersions(senderSchemaVersions, PORTOS_SCHEMA_VERSIONS);
  const versionDiff = scopeVersionDiff(fullDiff, cat.schemaKeys);
  if (versionDiff.ahead.length > 0) {
    console.log(
      `⏸️ dataSync: rejecting "${category}" snapshot — ${formatVersionGap(versionDiff)} ` +
      `(sender PortOS ${senderPortosVersion || 'unknown'})`,
    );
    return {
      applied: false,
      count: 0,
      blockedBySchema: {
        ahead: versionDiff.ahead,
        behind: versionDiff.behind,
        senderPortosVersion,
        receiverSchemaVersions: PORTOS_SCHEMA_VERSIONS,
      },
    };
  }
  if (cat.hasMediaInventory && options.inventory === true) {
    return applyMediaInventory(category, remoteData, source, options);
  }
  // Third arg: sender envelope details for appliers that disambiguate
  // omitted-vs-cleared fields by sender version (universe moodBoardId, #4188).
  // Appliers that don't need it ignore the extra argument.
  return cat.applyRemote(remoteData, source, { senderSchemaVersions });
}
