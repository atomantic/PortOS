/**
 * Data Sync Service
 *
 * Snapshot-based sync for JSON file data between PortOS peer instances.
 * Supports per-category sync with entity-level merge and LWW conflict resolution.
 * No data is ever lost — unique records from both sides are kept (union semantics).
 */

import crypto from 'crypto';
import { stat, readdir } from 'fs/promises';
import { join } from 'path';
import { atomicWrite, readJSONFile, PATHS } from '../lib/fileUtils.js';
import { isPlainObject } from '../lib/objects.js';
import {
  PORTOS_SCHEMA_VERSIONS,
  buildPortosMeta,
  compareSchemaVersions,
  formatVersionGap,
} from '../lib/schemaVersions.js';
import { mergeUniversesFromSync, listUniverses } from './universeBuilder.js';
import { mergeSeriesFromSync, listSeries } from './pipeline/series.js';
import { mergeIssuesFromSync, listIssues } from './pipeline/issues.js';
import { mergeMediaCollectionsFromSync, listCollections, itemKey } from './mediaCollections.js';
import { sanitizeStateForWire } from '../lib/syncWire.js';

// --- Category Definitions ---

const GOALS_FILE = join(PATHS.digitalTwin, 'goals.json');
const CHARACTER_FILE = join(PATHS.data, 'character.json');
const IDENTITY_FILE = join(PATHS.digitalTwin, 'identity.json');
const CHRONOTYPE_FILE = join(PATHS.digitalTwin, 'chronotype.json');
const LONGEVITY_FILE = join(PATHS.digitalTwin, 'longevity.json');
const FEEDBACK_FILE = join(PATHS.digitalTwin, 'feedback.json');
const MEATSPACE_DIR = PATHS.meatspace;
const PIPELINE_SERIES_DIR = join(PATHS.data, 'pipeline-series');
const PIPELINE_ISSUES_DIR = join(PATHS.data, 'pipeline-issues');
// Universes used to live in a single `universe-builder.json`; migration 034
// splits them into `data/universes/<id>/index.json` with a type-level
// `data/universes/index.json`. Sync uses the directory for both reading
// (listUniverses, below) and for fingerprint-based checksum caching — the
// fingerprint walker descends into the dir so per-record edits invalidate.
const UNIVERSE_BUILDER_DIR = join(PATHS.data, 'universes');
const MEDIA_COLLECTIONS_FILE = join(PATHS.data, 'media-collections.json');

const MEATSPACE_FILES = {
  'daily-log.json': { arrayKey: 'entries', idField: 'date' },
  'blood-tests.json': { arrayKey: 'tests', idField: 'date' },
  'epigenetic-tests.json': { arrayKey: 'tests', idField: 'date' },
  'eyes.json': { arrayKey: 'exams', idField: 'date' },
  'config.json': { type: 'object-lww' }
};

// --- Checksum Helper ---

function computeChecksum(data) {
  return crypto.createHash('md5').update(JSON.stringify(data)).digest('hex');
}

// --- Merge Helpers ---

/**
 * Merge two arrays of records by a key field. LWW by timestampField when both
 * sides have the same record. Records unique to either side are kept (union).
 */
function mergeArraysByKey(localArr, remoteArr, idField, timestampField) {
  const localMap = new Map();
  for (const item of localArr) {
    localMap.set(item[idField], item);
  }

  let changed = false;
  for (const remoteItem of remoteArr) {
    const key = remoteItem[idField];
    const localItem = localMap.get(key);

    if (!localItem) {
      // New record from remote — add it
      localMap.set(key, remoteItem);
      changed = true;
    } else if (timestampField) {
      // Both have it — LWW
      const localTs = localItem[timestampField] || '';
      const remoteTs = remoteItem[timestampField] || '';
      if (remoteTs > localTs) {
        localMap.set(key, remoteItem);
        changed = true;
      }
    }
  }

  return { merged: Array.from(localMap.values()), changed };
}

/**
 * LWW merge for single objects. Remote wins if its updatedAt is newer.
 */
function mergeObjectLWW(local, remote, timestampField = 'updatedAt') {
  if (!local) return { merged: remote, changed: true };
  if (!remote) return { merged: local, changed: false };
  const localTs = local[timestampField] || '';
  const remoteTs = remote[timestampField] || '';
  if (remoteTs > localTs) {
    return { merged: remote, changed: true };
  }
  return { merged: local, changed: false };
}

/**
 * Deep merge for derived files (longevity, chronotype) where timestamps
 * are unreliable (regenerated on derivation). Merges nested marker objects
 * as unions, keeps non-default scalar values, and uses LWW as final tiebreaker.
 */
function mergeDeepUnion(local, remote, timestampField = 'derivedAt') {
  if (!local) return { merged: remote, changed: true };
  if (!remote) return { merged: local, changed: false };

  const merged = { ...local };
  let changed = false;

  for (const [key, remoteVal] of Object.entries(remote)) {
    const localVal = local[key];

    // Skip timestamp fields — set after merge
    if (key === timestampField) continue;

    // Nested objects (markers): union keys, local wins per-key conflicts
    if (isPlainObject(remoteVal) && isPlainObject(localVal)) {
      const mergedObj = { ...localVal };
      for (const [k, v] of Object.entries(remoteVal)) {
        if (!(k in mergedObj)) {
          mergedObj[k] = v;
          changed = true;
        }
      }
      merged[key] = mergedObj;
      continue;
    }

    // Missing locally — take remote
    if (localVal === undefined || localVal === null) {
      merged[key] = remoteVal;
      changed = true;
      continue;
    }

    // Remote has non-default value, local has default — take remote
    if (localVal === 0 && remoteVal !== 0) {
      merged[key] = remoteVal;
      changed = true;
    }
  }

  // Use the newer timestamp
  const localTs = local[timestampField] || '';
  const remoteTs = remote[timestampField] || '';
  merged[timestampField] = remoteTs > localTs ? remoteTs : localTs;

  return { merged, changed };
}

// --- Category: Goals ---

async function getGoalsSnapshot() {
  const data = await readJSONFile(GOALS_FILE, { goals: [] });
  return { data, checksum: computeChecksum(data) };
}

async function applyGoalsRemote(remoteData) {
  const local = await readJSONFile(GOALS_FILE, { goals: [] });

  // Merge goals array by ID with LWW on updatedAt
  const { merged: mergedGoals, changed: goalsChanged } = mergeArraysByKey(
    local.goals || [],
    remoteData.goals || [],
    'id',
    'updatedAt'
  );

  // Merge top-level metadata (birthDate, lifeExpectancy, timeHorizons) via LWW
  // Use the most recent goal's updatedAt as proxy for file freshness
  const localMaxTs = (local.goals || []).reduce((max, g) => Math.max(max, new Date(g.updatedAt || 0).getTime()), 0);
  const remoteMaxTs = (remoteData.goals || []).reduce((max, g) => Math.max(max, new Date(g.updatedAt || 0).getTime()), 0);
  const metaSource = remoteMaxTs > localMaxTs ? remoteData : local;

  const merged = {
    ...local,
    birthDate: metaSource.birthDate ?? local.birthDate,
    lifeExpectancy: metaSource.lifeExpectancy ?? local.lifeExpectancy,
    timeHorizons: metaSource.timeHorizons ?? local.timeHorizons,
    goals: mergedGoals
  };

  if (goalsChanged || remoteMaxTs > localMaxTs) {
    await atomicWrite(GOALS_FILE, merged);
    console.log(`🔄 Goals sync: merged ${mergedGoals.length} goals`);
    return { applied: true, count: mergedGoals.length };
  }
  return { applied: false, count: 0 };
}

// --- Category: Character ---

async function getCharacterSnapshot() {
  const data = await readJSONFile(CHARACTER_FILE, null);
  if (!data) return { data: null, checksum: 'empty' };
  return { data, checksum: computeChecksum(data) };
}

async function applyCharacterRemote(remoteData) {
  if (!remoteData) return { applied: false, count: 0 };

  const local = await readJSONFile(CHARACTER_FILE, null);
  if (!local) {
    // No local character — accept remote entirely
    await atomicWrite(CHARACTER_FILE, remoteData);
    console.log(`🔄 Character sync: accepted remote character`);
    return { applied: true, count: 1 };
  }

  // Merge events by ID (union — never lose events)
  const { merged: mergedEvents, changed: eventsChanged } = mergeArraysByKey(
    local.events || [],
    remoteData.events || [],
    'id',
    'timestamp'
  );

  // Sort events chronologically
  mergedEvents.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

  // Merge synced ticket/task arrays (union by value)
  const mergedTickets = [...new Set([...(local.syncedJiraTickets || []), ...(remoteData.syncedJiraTickets || [])])];
  const mergedTasks = [...new Set([...(local.syncedTaskIds || []), ...(remoteData.syncedTaskIds || [])])];

  // Scalar fields: take from whichever is more recent
  const localTs = local.updatedAt || '';
  const remoteTs = remoteData.updatedAt || '';
  const scalarSource = remoteTs > localTs ? remoteData : local;

  const merged = {
    ...local,
    name: scalarSource.name ?? local.name,
    class: scalarSource.class ?? local.class,
    avatarPath: scalarSource.avatarPath ?? local.avatarPath,
    xp: Math.max(local.xp || 0, remoteData.xp || 0),
    hp: scalarSource.hp,
    maxHp: scalarSource.maxHp,
    level: Math.max(local.level || 1, remoteData.level || 1),
    events: mergedEvents,
    syncedJiraTickets: mergedTickets,
    syncedTaskIds: mergedTasks,
    updatedAt: remoteTs > localTs ? remoteTs : localTs
  };

  if (eventsChanged || remoteTs > localTs) {
    await atomicWrite(CHARACTER_FILE, merged);
    console.log(`🔄 Character sync: merged ${mergedEvents.length} events`);
    return { applied: true, count: mergedEvents.length };
  }
  return { applied: false, count: 0 };
}

// --- Category: Digital Twin ---

const DIGITAL_TWIN_FILES = {
  identity: { path: IDENTITY_FILE, timestampField: 'updatedAt', merge: 'lww' },
  chronotype: { path: CHRONOTYPE_FILE, timestampField: 'derivedAt', merge: 'deepUnion' },
  longevity: { path: LONGEVITY_FILE, timestampField: 'derivedAt', merge: 'deepUnion' },
  feedback: { path: FEEDBACK_FILE, timestampField: 'updatedAt', merge: 'lww' }
};

async function getDigitalTwinSnapshot() {
  const result = {};
  for (const [key, { path }] of Object.entries(DIGITAL_TWIN_FILES)) {
    result[key] = await readJSONFile(path, null);
  }
  return { data: result, checksum: computeChecksum(result) };
}

async function applyDigitalTwinRemote(remoteData) {
  if (!remoteData) return { applied: false, count: 0 };

  let totalApplied = 0;
  for (const [key, { path, timestampField, merge }] of Object.entries(DIGITAL_TWIN_FILES)) {
    const remoteFile = remoteData[key];
    if (!remoteFile) continue;

    const local = await readJSONFile(path, null);
    const mergeFn = merge === 'deepUnion' ? mergeDeepUnion : mergeObjectLWW;
    const { merged, changed } = mergeFn(local, remoteFile, timestampField);
    if (changed) {
      await atomicWrite(path, merged);
      totalApplied++;
    }
  }

  if (totalApplied > 0) {
    console.log(`🔄 Digital twin sync: updated ${totalApplied} files`);
  }
  return { applied: totalApplied > 0, count: totalApplied };
}

// --- Category: Meatspace ---

async function getMeatspaceSnapshot() {
  const result = {};
  for (const [filename] of Object.entries(MEATSPACE_FILES)) {
    const filePath = join(MEATSPACE_DIR, filename);
    result[filename] = await readJSONFile(filePath, null);
  }
  return { data: result, checksum: computeChecksum(result) };
}

async function applyMeatspaceRemote(remoteData) {
  if (!remoteData) return { applied: false, count: 0 };

  let totalApplied = 0;
  for (const [filename, config] of Object.entries(MEATSPACE_FILES)) {
    const remoteFile = remoteData[filename];
    if (!remoteFile) continue;

    const filePath = join(MEATSPACE_DIR, filename);
    const local = await readJSONFile(filePath, null);

    if (config.type === 'object-lww') {
      const { merged, changed } = mergeObjectLWW(local, remoteFile, 'updatedAt');
      if (changed) {
        await atomicWrite(filePath, merged);
        totalApplied++;
      }
    } else {
      // Array merge
      const localArr = local?.[config.arrayKey] || [];
      const remoteArr = remoteFile[config.arrayKey] || [];
      const { merged, changed } = mergeArraysByKey(localArr, remoteArr, config.idField, null);

      if (changed) {
        // Sort by idField (usually date)
        merged.sort((a, b) => (a[config.idField] || '').localeCompare(b[config.idField] || ''));
        const mergedFile = { ...(local || {}), [config.arrayKey]: merged };
        await atomicWrite(filePath, mergedFile);
        totalApplied++;
      }
    }
  }

  if (totalApplied > 0) {
    console.log(`🔄 Meatspace sync: updated ${totalApplied} files`);
  }
  return { applied: totalApplied > 0, count: totalApplied };
}

// Pipeline + universe sync covers the creative pipeline state (series, issues,
// universes) over Tailscale between same-network peers. Same-content image and
// video blobs continue to flow through the share-bucket system (cloud-synced
// folders) — those are too large for the snapshot-every-cycle pattern this
// service uses. Sync here is record-level only: serialized state for the
// records, no media blobs.

// --- Category: Universe ---

async function getUniverseSnapshot() {
  // listUniverses() loads via the collection store — every per-record JSON
  // under `data/universes/<id>/index.json` plus the sanitizer pass. Same
  // input shape sanitizeStateForWire expects (it reads `state.universes`).
  const universes = await listUniverses({ includeDeleted: true });
  const { data } = sanitizeStateForWire('universe', { universes });
  return { data, checksum: computeChecksum(data) };
}

async function applyUniverseRemote(remoteData) {
  if (!remoteData) return { applied: false, count: 0 };
  // Routes through `mergeUniversesFromSync` so the read-modify-write runs
  // INSIDE `queueUniverseWrite` (serialized against every other writer:
  // create / update / promote-variation / handleSave) and each incoming
  // remote record passes through `sanitizeTemplate` for schema-version
  // backfill — older peers landing pre-v4 records get them migrated on the
  // way in instead of polluting disk with un-backfilled state.
  const result = await mergeUniversesFromSync(remoteData.universes || []);
  if (result.applied) {
    console.log(`🔄 Universe sync: merged ${result.count} universe(s)`);
  }
  return result;
}

// --- Category: Pipeline ---

async function getPipelineSnapshot() {
  const [series, issues] = await Promise.all([
    listSeries({ includeDeleted: true }),
    listIssues({ includeDeleted: true }),
  ]);
  // Wire-projection lives in `server/lib/syncWire.js` — see getUniverseSnapshot.
  const { data } = sanitizeStateForWire('pipeline', {
    series,
    issues,
  });
  return { data, checksum: computeChecksum(data) };
}

async function applyPipelineRemote(remoteData) {
  if (!remoteData) return { applied: false, count: 0 };
  // Routes through the service merge entry points so each incoming record
  // passes through the same sanitizer and LWW contract as local writes.
  const [seriesResult, issuesResult] = await Promise.all([
    mergeSeriesFromSync(remoteData.series || []),
    mergeIssuesFromSync(remoteData.issues || []),
  ]);

  const seriesChanged = seriesResult.count;
  const issuesChanged = issuesResult.count;
  if (seriesChanged === 0 && issuesChanged === 0) return { applied: false, count: 0 };

  // `count` is the total number of records actually changed/added by this
  // merge (NOT total post-merge records — that would over-report when callers
  // sum across categories or compare cycle-over-cycle deltas). `seriesChanged`
  // / `issuesChanged` are surfaced separately so per-side telemetry stays
  // distinguishable.
  console.log(`🔄 Pipeline sync: merged ${seriesChanged} series + ${issuesChanged} issue(s)`);
  return {
    applied: true,
    count: seriesChanged + issuesChanged,
    seriesChanged,
    issuesChanged,
  };
}

// --- Category: Media Collections ---

// Per-universe / per-series buckets of image + video refs. The collection
// records carry the linkage (universeId / seriesId) and an items[] array of
// `{ kind, ref, addedAt }` rows. We sync the JSON itself here (union of items
// + LWW on scalars) so collection edits propagate even when the linked
// universe / series record itself didn't move. The per-record push pipeline
// (peerSync.js) ALSO bundles a record's linked collection in its push payload
// so image bytes flow via the existing asset-pull worker — the snapshot path
// covers the JSON, the push path covers the image bytes.

async function getMediaCollectionsSnapshot() {
  // listCollections re-reads + sanitizes from disk; we don't cache here since
  // the checksum cache (`CHECKSUM_PATHS` fingerprint check) already short-
  // circuits the I/O when the file hasn't moved.
  const collections = await listCollections();
  // Filter out collections whose linked record (universe or series) is marked
  // ephemeral. Mirrors the per-record push pipeline's local-ephemeral guard
  // (see peerSync.js applyIncomingPush) — without this filter, the
  // mediaCollections snapshot category would still leak the collection name +
  // item refs for records the user explicitly opted out of sync. Tombstoned
  // ephemeral parents also drop their collection (sender wouldn't bundle them
  // anyway, but the snapshot path is independent).
  const ephemeralUniverseIds = new Set(
    (await listUniverses({ includeDeleted: true }).catch(() => []))
      .filter((u) => u?.ephemeral === true)
      .map((u) => u.id),
  );
  const ephemeralSeriesIds = new Set(
    (await listSeries({ includeDeleted: true }).catch(() => []))
      .filter((s) => s?.ephemeral === true)
      .map((s) => s.id),
  );
  const filtered = collections.filter((c) => {
    if (c.universeId && ephemeralUniverseIds.has(c.universeId)) return false;
    if (c.seriesId && ephemeralSeriesIds.has(c.seriesId)) return false;
    return true;
  });
  // Canonicalize ordering for the wire so two peers holding identical sets
  // produce identical checksums regardless of write history. Without this
  // sort, on-disk order is insertion-order — peer A and peer B can land the
  // same items in different orders and end up with permanently different
  // checksums, which the UI's cursor-vs-remote comparison reads as "behind"
  // forever. Sort collections by id (stable, unique) and each collection's
  // items by `<kind>:<ref>` (the same key used for set membership in
  // `mergeCollectionItems`).
  const canonical = filtered
    .map((c) => ({
      ...c,
      items: [...(c.items || [])].sort((a, b) => itemKey(a).localeCompare(itemKey(b))),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const data = { collections: canonical };
  return { data, checksum: computeChecksum(data) };
}

async function applyMediaCollectionsRemote(remoteData) {
  if (!remoteData) return { applied: false, count: 0 };
  // Symmetric receiver-side guard. The sender filters collections linked
  // to local-ephemeral parents in getMediaCollectionsSnapshot, but a
  // peer running an older PortOS (or any non-conformant client) could
  // still ship them. Without this filter, an incoming snapshot could
  // mutate item refs or scalars on a collection whose universe/series
  // the user explicitly marked private.
  const incoming = Array.isArray(remoteData.collections) ? remoteData.collections : [];
  // Build two filter sets per kind: ephemeral parents (privacy) AND
  // tombstoned parents (cleanup integrity). The delete cascade unlinks
  // its collection by clearing the parent id — a peer that still has
  // the parent live could otherwise ship a newer collection snapshot
  // with the old parent id and re-link the collection to our tombstone,
  // undoing the cleanup.
  const allUniverses = await listUniverses({ includeDeleted: true }).catch(() => []);
  const allSeries = await listSeries({ includeDeleted: true }).catch(() => []);
  const refusedUniverseIds = new Set(
    allUniverses.filter((u) => u?.ephemeral === true || u?.deleted === true).map((u) => u.id),
  );
  const refusedSeriesIds = new Set(
    allSeries.filter((s) => s?.ephemeral === true || s?.deleted === true).map((s) => s.id),
  );
  const filtered = incoming.filter((c) => {
    if (c?.universeId && refusedUniverseIds.has(c.universeId)) return false;
    if (c?.seriesId && refusedSeriesIds.has(c.seriesId)) return false;
    return true;
  });
  // Routes through `mergeMediaCollectionsFromSync` so the read-modify-write
  // runs INSIDE `serializeFileWrite` (same tail as addItem / removeItem /
  // bulkUpdateCollectionItems) — a sync-driven write can't interleave with a
  // concurrent local mutation on the same JSON file.
  const result = await mergeMediaCollectionsFromSync(filtered);
  if (result.applied) {
    console.log(`🔄 MediaCollections sync: merged ${result.count} collection(s)`);
  }
  return result;
}

// --- Public API ---

// Files each category reads, used to keep the in-process checksum cache
// honest: `getChecksum` skips the full snapshot when none of these files'
// fingerprints changed since the last computed checksum. The fingerprint is
// `${mtimeMs}:${size}:${ino}` — every PortOS sync-side write goes through
// `atomicWrite` (temp + rename), which produces a new inode on every replace
// regardless of mtime resolution or content size, so a same-tick same-size
// rewrite still invalidates the cache. (An in-place writer that bypasses
// atomicWrite and lands within one ms tick with identical byte length is the
// only residual blind spot — PortOS doesn't ship one today.)
const CHECKSUM_PATHS = {
  goals: [GOALS_FILE],
  character: [CHARACTER_FILE],
  digitalTwin: Object.values(DIGITAL_TWIN_FILES).map((f) => f.path),
  meatspace: Object.keys(MEATSPACE_FILES).map((f) => join(MEATSPACE_DIR, f)),
  universe: [UNIVERSE_BUILDER_DIR],
  pipeline: [PIPELINE_SERIES_DIR, PIPELINE_ISSUES_DIR],
  // mediaCollections invalidates on its own file AND on the parent record
  // files — `getMediaCollectionsSnapshot` filters collections whose linked
  // universe/series is ephemeral, so a "mark ephemeral" PATCH on a universe
  // must re-checksum the collections snapshot even though
  // media-collections.json itself didn't move. Same goes for un-ephemeral.
  mediaCollections: [MEDIA_COLLECTIONS_FILE, UNIVERSE_BUILDER_DIR, PIPELINE_SERIES_DIR],
};

const CATEGORIES = {
  goals: { getSnapshot: getGoalsSnapshot, applyRemote: applyGoalsRemote },
  character: { getSnapshot: getCharacterSnapshot, applyRemote: applyCharacterRemote },
  digitalTwin: { getSnapshot: getDigitalTwinSnapshot, applyRemote: applyDigitalTwinRemote },
  meatspace: { getSnapshot: getMeatspaceSnapshot, applyRemote: applyMeatspaceRemote },
  universe: { getSnapshot: getUniverseSnapshot, applyRemote: applyUniverseRemote },
  pipeline: { getSnapshot: getPipelineSnapshot, applyRemote: applyPipelineRemote },
  mediaCollections: { getSnapshot: getMediaCollectionsSnapshot, applyRemote: applyMediaCollectionsRemote }
};

// Per-category `{ fingerprints, checksum }` cache. The orchestrator hits
// getChecksum every cycle — by far the hottest sync-side I/O — so caching
// keyed on underlying-file `(mtime, size)` lets it stat-and-return when
// nothing has changed, instead of re-materializing the full payload.
const checksumCache = new Map();

// Combine mtime/size/inode of one regular file into a single fingerprint
// string. Inode is included so an atomic-write replace (which mints a new
// inode) is always detected even when mtime rounds equal.
const fingerprintEntry = (s) => s ? `${s.mtimeMs}:${s.size}:${s.ino}` : null;

// Walk a directory two levels deep — the layout produced by collectionStore
// (`{dir}/index.json` + `{dir}/<id>/index.json`) — and concatenate per-file
// fingerprints into one deterministic string. Sorted by name so the result
// is stable across readdir orderings. Used by the universe + mediaCollections
// checksum paths so per-record edits invalidate the cache without enumerating
// every record at module-load.
async function fingerprintDirTwoLevels(dirPath) {
  const top = await readdir(dirPath).catch(() => null);
  if (!top) return null;
  const sortedTop = [...top].sort();
  const segments = [];
  for (const name of sortedTop) {
    const childPath = join(dirPath, name);
    const cs = await stat(childPath).catch(() => null);
    if (!cs) continue;
    if (cs.isFile()) {
      segments.push(`${name}:${fingerprintEntry(cs)}`);
      continue;
    }
    if (!cs.isDirectory()) continue;
    const inner = await readdir(childPath).catch(() => []);
    for (const innerName of [...inner].sort()) {
      const innerPath = join(childPath, innerName);
      const is = await stat(innerPath).catch(() => null);
      if (is?.isFile()) segments.push(`${name}/${innerName}:${fingerprintEntry(is)}`);
    }
  }
  return segments.join('|') || 'empty';
}

async function readFingerprintMap(paths) {
  const out = {};
  await Promise.all(paths.map(async (p) => {
    const s = await stat(p).catch(() => null);
    if (!s) { out[p] = null; return; }
    if (s.isDirectory()) {
      out[p] = await fingerprintDirTwoLevels(p);
      return;
    }
    out[p] = fingerprintEntry(s);
  }));
  return out;
}

function fingerprintsEqual(a, b) {
  for (const p in a) if (a[p] !== b[p]) return false;
  for (const p in b) if (a[p] !== b[p]) return false;
  return true;
}

export function getSupportedCategories() {
  return Object.keys(CATEGORIES);
}

export async function getChecksum(category) {
  const cat = CATEGORIES[category];
  if (!cat) return null;
  const paths = CHECKSUM_PATHS[category];
  if (paths) {
    const fingerprints = await readFingerprintMap(paths);
    const cached = checksumCache.get(category);
    if (cached && fingerprintsEqual(cached.fingerprints, fingerprints)) {
      return { checksum: cached.checksum };
    }
    const snapshot = await cat.getSnapshot();
    checksumCache.set(category, { fingerprints, checksum: snapshot.checksum });
    return { checksum: snapshot.checksum };
  }
  const snapshot = await cat.getSnapshot();
  return { checksum: snapshot.checksum };
}

export async function getSnapshot(category) {
  const cat = CATEGORIES[category];
  if (!cat) return null;
  const snap = await cat.getSnapshot();
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
  const portosMeta = isPlainObject(options.portosMeta) ? options.portosMeta : null;
  const senderSchemaVersions = isPlainObject(portosMeta?.schemaVersions) ? portosMeta.schemaVersions : {};
  const senderPortosVersion = typeof portosMeta?.portosVersion === 'string' ? portosMeta.portosVersion : null;
  const versionDiff = compareSchemaVersions(senderSchemaVersions, PORTOS_SCHEMA_VERSIONS);
  if (versionDiff.ahead.length > 0) {
    console.warn(
      `⚠️ dataSync: rejecting "${category}" snapshot — ${formatVersionGap(versionDiff)} ` +
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
  return cat.applyRemote(remoteData);
}
