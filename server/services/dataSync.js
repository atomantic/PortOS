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
  RECORD_KIND_SCHEMA_CATEGORIES,
  buildPortosMeta,
  compareSchemaVersions,
  scopeVersionDiff,
  formatVersionGap,
} from '../lib/schemaVersions.js';
import { mergeUniversesFromSync, listUniverses } from './universeBuilder.js';
import { getUniverseMutationEpoch } from './universeBuilder/store.js';
import { getPipelineMutationEpoch } from './pipeline/syncEpoch.js';
import { mergeSeriesFromSync, listSeries } from './pipeline/series.js';
import { mergeIssuesFromSync, listIssues } from './pipeline/issues.js';
import { mergeMediaCollectionsFromSync, listCollections, itemKey } from './mediaCollections.js';
import { listSyncableSessionsForWire, mergeStorySessionsFromSync } from './storyBuilder.js';
import { getStoryBuilderMutationEpoch } from './storyBuilderStore/store.js';
import { sanitizeStateForWire } from '../lib/syncWire.js';
import {
  getDigitalTwinSnapshot,
  applyDigitalTwinRemote,
  DIGITAL_TWIN_CHECKSUM_PATHS,
} from './digital-twin-sync.js';

// --- Category Definitions ---

const GOALS_FILE = join(PATHS.digitalTwin, 'goals.json');
const CHARACTER_FILE = join(PATHS.data, 'character.json');
// Digital Twin snapshot + merge lives in ./digital-twin-sync.js (it now covers
// the FULL identity dataset — taste, documents, autobiography — not just the
// four core JSON files). dataSync delegates to it the same way it delegates
// universe/pipeline merges to their owning services.
const MEATSPACE_DIR = PATHS.meatspace;
// Pipeline series + issues used to live under data/pipeline-series/<id> and
// data/pipeline-issues/<id>; #1015 moved the RECORDS into PostgreSQL
// (`pipeline_series` / `pipeline_issues`). Same federation-invisibility problem
// as universes (#1014): a PG-backed pipeline edit no longer touches these
// directories, so the dir fingerprint alone would go stale and peers would stop
// receiving pipeline edits. The pipeline store exports a monotonic mutation
// epoch (bumped on every series/issue record write/delete) folded into this
// path's fingerprint via PIPELINE_EPOCH_KEY below. The series dir is still
// stat'd because its `manuscript-review.json` siblings remain file-primary —
// a review-only edit must still invalidate the pipeline checksum.
const PIPELINE_SERIES_DIR = join(PATHS.data, 'pipeline-series');
const PIPELINE_ISSUES_DIR = join(PATHS.data, 'pipeline-issues');
// Sentinel fingerprint-map key (not a real path — readFingerprintMap special-
// cases it) carrying the pipeline mutation epoch into the pipeline +
// mediaCollections checksum caches.
const PIPELINE_EPOCH_KEY = '__pipelineEpoch';
// Universes used to live in a single `universe-builder.json`; migration 034
// split them into `data/universes/<id>/index.json`, and #1014 moved them again
// into PostgreSQL (`universes` + `universe_runs`). Sync reads them through the
// service (listUniverses, below). For the fingerprint-based checksum cache, a
// PG-backed edit no longer touches this directory, so the dir fingerprint alone
// would go stale and peers would silently stop receiving universe edits. The
// universe store exports a monotonic mutation epoch (bumped on every record
// write/delete) that we fold into this path's fingerprint via
// UNIVERSE_EPOCH_KEY below — so the checksum cache invalidates on a DB edit just
// as it did on a file edit, keeping the storage swap invisible to federation.
// Under the file backend the dir still changes too (harmless double-signal).
const UNIVERSE_BUILDER_DIR = join(PATHS.data, 'universes');
// Sentinel fingerprint-map key (not a real path — readFingerprintMap special-
// cases it) carrying the universe mutation epoch into the universe +
// mediaCollections checksum caches.
const UNIVERSE_EPOCH_KEY = '__universeEpoch';
// Migration 059 split the monolithic media-collections.json into per-record
// `data/media-collections/<id>/index.json`. The fingerprint walker descends
// into the dir so per-record edits invalidate the snapshot checksum cache.
const MEDIA_COLLECTIONS_DIR = join(PATHS.data, 'media-collections');
// Outbound peer subscriptions drive the per-peer snapshot exclude-set (see
// getSnapshot's `forPeerId` scoping). A subscribe/unsubscribe changes which
// records ride the scoped snapshot, so it must invalidate the per-peer
// checksum cache for the universe / pipeline / mediaCollections categories
// even when no record file itself moved (e.g. ephemeralize-then-delete tears
// down a sub WITHOUT touching the other records). Added to those categories'
// CHECKSUM_PATHS below.
const PEER_SUBSCRIPTIONS_FILE = join(PATHS.data, 'sharing', 'peer_subscriptions.json');
const VIDEO_HISTORY_FILE = join(PATHS.data, 'video-history.json');
// Story Builder sessions used to live in per-record `data/story-builder/<id>/
// index.json`; #1016 moved the RECORDS into PostgreSQL (`story_builder_sessions`).
// Only `sync: true` sessions ride this category (#730). Same federation-
// invisibility problem as universes (#1014): a PG-backed session edit no longer
// touches this directory, so the dir fingerprint alone would go stale and peers
// would stop receiving session edits. The store exports a monotonic mutation
// epoch (bumped on every session record write/delete) folded into this path's
// fingerprint via STORY_BUILDER_EPOCH_KEY below. Under the file backend the dir
// still changes too (harmless double-signal).
const STORY_BUILDER_DIR = join(PATHS.data, 'story-builder');
// Sentinel fingerprint-map key (not a real path — readFingerprintMap special-
// cases it) carrying the Story Builder mutation epoch into the storyBuilder
// checksum cache.
const STORY_BUILDER_EPOCH_KEY = '__storyBuilderEpoch';

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
    // No local character — accept remote entirely, but strip a legacy persisted `level`
    // (an older peer still sends it): level is age-derived on read now (#2673), so a stored
    // value would be stale and would re-propagate in our own snapshot.
    const { level: _staleLevel, ...accepted } = remoteData;
    await atomicWrite(CHARACTER_FILE, accepted);
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
    // `level` is age-derived on read (#2673), not persisted — never merge a stale peer level.
    events: mergedEvents,
    syncedJiraTickets: mergedTickets,
    syncedTaskIds: mergedTasks,
    updatedAt: remoteTs > localTs ? remoteTs : localTs
  };
  // Drop any legacy persisted `level` (carried through `...local`) — it's derived on read now.
  delete merged.level;

  if (eventsChanged || remoteTs > localTs) {
    await atomicWrite(CHARACTER_FILE, merged);
    console.log(`🔄 Character sync: merged ${mergedEvents.length} events`);
    return { applied: true, count: mergedEvents.length };
  }
  return { applied: false, count: 0 };
}

// --- Category: Digital Twin ---
// getDigitalTwinSnapshot / applyDigitalTwinRemote are imported from
// ./digital-twin-sync.js (see import block at top).

// --- Category: Meatspace ---

async function getMeatspaceSnapshot() {
  const filenames = Object.keys(MEATSPACE_FILES);
  // The files are independent — read them in parallel rather than one-at-a-time
  // (this snapshot runs on every ~60s sync poll).
  const contents = await Promise.all(
    filenames.map((filename) => readJSONFile(join(MEATSPACE_DIR, filename), null)),
  );
  const result = {};
  filenames.forEach((filename, i) => { result[filename] = contents[i]; });
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

// Normalize an `excludeRecordIds` option into a Set. Accepts a Set, an array,
// or null/undefined (→ empty Set = no exclusion = legacy full snapshot).
function toExcludeSet(exclude) {
  if (exclude instanceof Set) return exclude;
  if (Array.isArray(exclude)) return new Set(exclude);
  return new Set();
}

async function getUniverseSnapshot({ exclude } = {}) {
  // listUniverses() loads via the collection store — every per-record JSON
  // under `data/universes/<id>/index.json` plus the sanitizer pass. Same
  // input shape sanitizeStateForWire expects (it reads `state.universes`).
  const universes = await listUniverses({ includeDeleted: true });
  // Drop records the requesting peer already receives per-record via the
  // push pipeline (its INBOUND coverage). The filter runs on the RAW records
  // by `id` BEFORE sanitize so a subscribed-but-deleted record's tombstone is
  // also excluded here (the push pipeline carries that tombstone). Everything
  // un-subscribed — including tombstones for records whose sub was torn down
  // (ephemeralize-then-delete) — still rides the snapshot. This is the single
  // mechanism that fixes BOTH the partial-subscription gap (Item A) and the
  // stranded-tombstone stall (Item B).
  const excludeSet = toExcludeSet(exclude);
  const scoped = excludeSet.size > 0
    ? universes.filter((u) => !excludeSet.has(u?.id))
    : universes;
  const { data } = sanitizeStateForWire('universe', { universes: scoped });
  return { data, checksum: computeChecksum(data) };
}

async function applyUniverseRemote(remoteData, source) {
  if (!remoteData) return { applied: false, count: 0 };
  // Routes through `mergeUniversesFromSync` so the read-modify-write runs
  // INSIDE `queueUniverseWrite` (serialized against every other writer:
  // create / update / promote-variation / handleSave) and each incoming
  // remote record passes through `sanitizeTemplate` for schema-version
  // backfill — older peers landing pre-v4 records get them migrated on the
  // way in instead of polluting disk with un-backfilled state.
  const result = await mergeUniversesFromSync(remoteData.universes || [], { source });
  if (result.applied) {
    console.log(`🔄 Universe sync: merged ${result.count} universe(s)`);
  }
  return result;
}

// --- Category: Pipeline ---

async function getPipelineSnapshot({ exclude } = {}) {
  const [series, issues] = await Promise.all([
    listSeries({ includeDeleted: true }),
    listIssues({ includeDeleted: true }),
  ]);
  // The pipeline category bundles series + their child issues — a `series`
  // subscription covers the whole sub-tree via the per-record push (which
  // ships the series + every child issue). So excluding a covered series id
  // ALSO drops every issue whose `seriesId` matches; otherwise the snapshot
  // would still carry the child issues the push pipeline already delivers,
  // re-introducing the redundant transfer this fix removes. Un-subscribed
  // series (and their issues), plus tombstones for torn-down subs, still ride.
  const excludeSet = toExcludeSet(exclude);
  const scopedSeries = excludeSet.size > 0
    ? series.filter((s) => !excludeSet.has(s?.id))
    : series;
  const scopedIssues = excludeSet.size > 0
    ? issues.filter((i) => !excludeSet.has(i?.seriesId))
    : issues;
  // Wire-projection lives in `server/lib/syncWire.js` — see getUniverseSnapshot.
  const { data } = sanitizeStateForWire('pipeline', {
    series: scopedSeries,
    issues: scopedIssues,
  });
  return { data, checksum: computeChecksum(data) };
}

async function applyPipelineRemote(remoteData, source) {
  if (!remoteData) return { applied: false, count: 0 };
  // Routes through the service merge entry points so each incoming record
  // passes through the same sanitizer and LWW contract as local writes.
  const [seriesResult, issuesResult] = await Promise.all([
    mergeSeriesFromSync(remoteData.series || [], { source }),
    mergeIssuesFromSync(remoteData.issues || [], { source }),
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

async function getMediaCollectionsSnapshot({ exclude } = {}) {
  // listCollections re-reads + sanitizes from disk; we don't cache here since
  // the checksum cache (`CHECKSUM_PATHS` fingerprint check) already short-
  // circuits the I/O when the file hasn't moved.
  // includeDeleted:true so tombstones cross the wire — matches getUniverseSnapshot
  // / getPipelineSnapshot. Without it, a peer that missed the live delete push
  // (offline/unsubscribed at delete time) never learns the collection was deleted
  // and keeps it live; the receiver (mergeMediaCollectionsFromSync) already LWWs
  // the incoming tombstone so this converges deletes without resurrecting them.
  const collections = await listCollections({ includeDeleted: true });
  // Filter out collections whose linked record (universe or series) is marked
  // ephemeral. Mirrors the per-record push pipeline's local-ephemeral guard
  // (see peerSync.js applyIncomingPush) — without this filter, the
  // mediaCollections snapshot category would still leak the collection name +
  // item refs for records the user explicitly opted out of sync. Tombstoned
  // ephemeral parents also drop their collection (sender wouldn't bundle them
  // anyway, but the snapshot path is independent).
  // Independent reads — fetch the universe and series lists concurrently.
  const [allUniversesForEphemeral, allSeriesForEphemeral] = await Promise.all([
    listUniverses({ includeDeleted: true }).catch(() => []),
    listSeries({ includeDeleted: true }).catch(() => []),
  ]);
  const ephemeralUniverseIds = new Set(
    allUniversesForEphemeral.filter((u) => u?.ephemeral === true).map((u) => u.id),
  );
  const ephemeralSeriesIds = new Set(
    allSeriesForEphemeral.filter((s) => s?.ephemeral === true).map((s) => s.id),
  );
  // Exclude collections the requesting peer already receives per-record via
  // the push pipeline (its INBOUND coverage). Keyed on the collection's own
  // id — `mediaCollection` subscriptions target the collection record itself.
  // Un-subscribed collections + tombstones for torn-down subs still ride.
  const excludeSet = toExcludeSet(exclude);
  const filtered = collections.filter((c) => {
    if (excludeSet.has(c?.id)) return false;
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

async function applyMediaCollectionsRemote(remoteData, source) {
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
  const [allUniverses, allSeries] = await Promise.all([
    listUniverses({ includeDeleted: true }).catch(() => []),
    listSeries({ includeDeleted: true }).catch(() => []),
  ]);
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
  const result = await mergeMediaCollectionsFromSync(filtered, { source });
  if (result.applied) {
    console.log(`🔄 MediaCollections sync: merged ${result.count} collection(s)`);
  }
  return result;
}

// --- Category: Video History ---

// `data/video-history.json` is a FLAT array of video-generation rows
// (`{ id, prompt, filename, createdAt, thumbnail, ... }`). MediaCollectionDetail's
// `hydrate()` looks every `{ kind:'video', ref }` collection item up in a
// `videosById` map built from this list — so a synced collection's video items
// are silently filtered out as "missing" on the receiver until the matching row
// arrives. This category rides the same 60s snapshot loop as mediaCollections
// so the rows propagate alongside the collection JSON.
//
// **No exclude-set / `{forPeerId}` filtering applies.** Unlike mediaCollections
// (whose getter drops rows linked to an ephemeral universe/series), video rows
// carry no ephemeral linkage — a video is identified by its bare id, with no
// parent record to opt out of sync. The whole flat list is union-merged.
// (The `.mp4` bytes themselves still flow via the per-record asset-pull worker
// in peerSync.js — this category carries only the JSON metadata row.)

// Read/write the flat history array directly (matching the goals/character
// categories' `readJSONFile`+`atomicWrite` pattern) rather than importing
// videoGen/local.js — that module drags in ffmpeg/spawn machinery we don't
// need on the sync read path, and the on-disk shape is a plain array.
// A video-history row is syncable only if it carries a non-empty string `id`.
// Shared by the snapshot (wire) side and the apply (merge) side so the two can
// never disagree on which rows are keyable — see the convergence note below.
const hasVideoRowId = (r) => typeof r?.id === 'string' && r.id;

async function getVideoHistorySnapshot() {
  const raw = await readJSONFile(VIDEO_HISTORY_FILE, []);
  // Exclude rows without a string `id`: applyVideoHistoryRemote can only merge
  // id-keyed rows, so an id-less row in the wire snapshot/checksum would be
  // un-appliable on the receiver — its recomputed checksum would never match the
  // sender's and the two peers would re-download this category forever. Treat
  // id-less rows as strictly local-only on BOTH sides.
  const rows = (Array.isArray(raw) ? raw : []).filter((r) => r && hasVideoRowId(r));
  // `hidden` is a LOCAL-ONLY visibility flag (e.g. inner chunks of a stitched
  // clip, or a clip the user tucked away). It must NOT influence the wire
  // payload: if the snapshot's content depended on it, two peers that disagree
  // on a row's hidden state would compute different checksums and re-download
  // forever (and a union-merge would never let them converge). So we include
  // the row CONTENT — a shared collection's video still renders on every peer —
  // but strip `hidden` itself so the checksum is hide-state-independent and the
  // flag doesn't propagate (the receiver keeps its own local `hidden` because
  // the immutable-`createdAt` LWW merge keeps the existing row on a tie).
  // Canonicalize ordering for the wire so two peers holding identical sets
  // produce identical checksums regardless of insertion (newest-first) order.
  // Mirrors getMediaCollectionsSnapshot's sort-by-id rationale.
  const data = {
    videos: rows
      .map(({ hidden, ...rest }) => rest) // eslint-disable-line no-unused-vars
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  return { data, checksum: computeChecksum(data) };
}

async function applyVideoHistoryRemote(remoteData) {
  if (!remoteData) return { applied: false, count: 0 };
  const incoming = Array.isArray(remoteData.videos) ? remoteData.videos : [];
  if (incoming.length === 0) return { applied: false, count: 0 };

  const localRaw = await readJSONFile(VIDEO_HISTORY_FILE, []);
  const local = Array.isArray(localRaw) ? localRaw : [];

  // Union by `id`, LWW on `createdAt` when both sides know the same row.
  // Video-history rows are append-mostly and immutable once written, so
  // `createdAt` is a sufficient (and the only) freshness signal — there's no
  // `updatedAt`. A row with no string id can't be keyed and is skipped (a
  // hand-edited or corrupt entry shouldn't clobber a real row at key
  // `undefined`); the snapshot side excludes the same rows so checksums agree.
  const hasId = hasVideoRowId;
  const keyed = local.filter(hasId);
  const before = new Map(keyed.map((r) => [r.id, r]));
  const { merged, changed } = mergeArraysByKey(
    keyed,
    incoming.filter(hasId),
    'id',
    'createdAt',
  );
  if (!changed) return { applied: false, count: 0 };

  // `count` reports rows actually added/updated by this merge (not total
  // post-merge size — that would over-report when callers sum across
  // categories or compare cycle deltas). Matches the pipeline category's
  // `count` contract.
  let changedCount = 0;
  for (const row of merged) {
    const prev = before.get(row.id);
    if (!prev || prev !== row) changedCount++;
  }

  // Preserve any local rows that lacked an id (the merge dropped them from its
  // keyed map) — don't let a sync silently delete un-keyable local history.
  const idless = local.filter((r) => !hasId(r));
  // Newest-first to match how generateVideo unshifts new rows + how the
  // Media History grid expects them.
  const next = [...merged, ...idless].sort((a, b) =>
    String(b?.createdAt ?? '').localeCompare(String(a?.createdAt ?? '')));
  await atomicWrite(VIDEO_HISTORY_FILE, next);
  console.log(`🔄 VideoHistory sync: merged ${changedCount} video row(s)`);
  return { applied: true, count: changedCount };
}

// --- Category: Story Builder sessions ---

// Optional cross-machine resumable Story Builder sessions (#730). Sessions are
// LOCAL-ONLY by default and excluded from sync; only a session with
// `sync: true` participates. `listSyncableSessionsForWire` enforces that
// (returning ONLY sync-enabled sessions, wire-sanitized + sorted by id), so a
// local-only session can NEVER appear in the snapshot or its checksum — two
// peers that disagree only on local-only sessions still compute the same
// checksum and never churn. The merge is union-by-id, LWW on `updatedAt`, and
// refuses to flip a local session's sync mode (see mergeStorySessionsFromSync).
//
// No exclude-set / `{forPeerId}` scoping: sessions have no per-record push
// subscription (they ride the snapshot only), so there's nothing to exclude.

async function getStoryBuilderSnapshot() {
  const sessions = await listSyncableSessionsForWire();
  const data = { sessions };
  return { data, checksum: computeChecksum(data) };
}

async function applyStoryBuilderRemote(remoteData) {
  if (!remoteData) return { applied: false, count: 0 };
  const incoming = Array.isArray(remoteData.sessions) ? remoteData.sessions : [];
  if (incoming.length === 0) return { applied: false, count: 0 };
  return mergeStorySessionsFromSync(incoming);
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
  // The whole digital-twin dir is watched (taste, meta, .md documents,
  // autobiography/) — see DIGITAL_TWIN_CHECKSUM_PATHS in digital-twin-sync.js.
  digitalTwin: DIGITAL_TWIN_CHECKSUM_PATHS,
  meatspace: Object.keys(MEATSPACE_FILES).map((f) => join(MEATSPACE_DIR, f)),
  // PEER_SUBSCRIPTIONS_FILE is in the scoped categories' paths so a
  // subscribe/unsubscribe invalidates the per-peer snapshot checksum cache —
  // the exclude-set is derived from subscriptions, so the scoped snapshot's
  // content (and checksum) can change even when no record file moved.
  // UNIVERSE_EPOCH_KEY folds in the store's mutation epoch so a PG-backed
  // universe edit (which doesn't touch UNIVERSE_BUILDER_DIR) still invalidates
  // the cache — see UNIVERSE_BUILDER_DIR's note. PEER_SUBSCRIPTIONS_FILE so a
  // subscribe/unsubscribe re-checksums the per-peer scoped snapshot.
  universe: [UNIVERSE_BUILDER_DIR, UNIVERSE_EPOCH_KEY, PEER_SUBSCRIPTIONS_FILE],
  // PIPELINE_EPOCH_KEY folds in the pipeline store's mutation epoch so a
  // PG-backed series/issue edit (which doesn't touch these dirs) still
  // invalidates the cache — see PIPELINE_SERIES_DIR's note. The series dir is
  // still stat'd for the file-primary manuscript-review.json siblings.
  pipeline: [PIPELINE_SERIES_DIR, PIPELINE_ISSUES_DIR, PIPELINE_EPOCH_KEY, PEER_SUBSCRIPTIONS_FILE],
  // mediaCollections invalidates on its own record dir AND on the parent
  // record files — `getMediaCollectionsSnapshot` filters collections whose
  // linked universe/series is ephemeral, so a "mark ephemeral" PATCH on a
  // universe must re-checksum the collections snapshot even though no
  // media-collections record file moved. Same goes for un-ephemeral.
  mediaCollections: [MEDIA_COLLECTIONS_DIR, UNIVERSE_BUILDER_DIR, UNIVERSE_EPOCH_KEY, PIPELINE_SERIES_DIR, PIPELINE_EPOCH_KEY, PEER_SUBSCRIPTIONS_FILE],
  // videoHistory is a flat history file with no parent-record dependency —
  // its checksum invalidates only when video-history.json itself moves.
  videoHistory: [VIDEO_HISTORY_FILE],
  // STORY_BUILDER_EPOCH_KEY folds in the store's mutation epoch so a PG-backed
  // session edit (which doesn't touch STORY_BUILDER_DIR) still invalidates the
  // cache — see STORY_BUILDER_DIR's note. The snapshot includes ONLY
  // sync-enabled sessions, but the epoch/dir signal is content-agnostic (any
  // session write re-checksums) — over-invalidation is harmless: the snapshot
  // getter filters back to sync:true and the checksum is unchanged when no
  // synced session moved, so the orchestrator still skips the transfer.
  storyBuilder: [STORY_BUILDER_DIR, STORY_BUILDER_EPOCH_KEY],
};

const CATEGORIES = {
  goals: { getSnapshot: getGoalsSnapshot, applyRemote: applyGoalsRemote },
  character: { getSnapshot: getCharacterSnapshot, applyRemote: applyCharacterRemote },
  digitalTwin: { getSnapshot: getDigitalTwinSnapshot, applyRemote: applyDigitalTwinRemote },
  meatspace: { getSnapshot: getMeatspaceSnapshot, applyRemote: applyMeatspaceRemote },
  universe: { getSnapshot: getUniverseSnapshot, applyRemote: applyUniverseRemote },
  pipeline: { getSnapshot: getPipelineSnapshot, applyRemote: applyPipelineRemote },
  mediaCollections: { getSnapshot: getMediaCollectionsSnapshot, applyRemote: applyMediaCollectionsRemote },
  videoHistory: { getSnapshot: getVideoHistorySnapshot, applyRemote: applyVideoHistoryRemote },
  storyBuilder: { getSnapshot: getStoryBuilderSnapshot, applyRemote: applyStoryBuilderRemote }
};

// Map a snapshot CATEGORY to the `PORTOS_SCHEMA_VERSIONS` keys whose storage
// layout that category's `applyRemote` actually writes — derived from the
// canonical record-kind map so it can't drift. `applyRemote` gates only on
// these keys, so a sender that bumped/added an unrelated category (e.g. a new
// `mediaCollections` version) no longer rejects an unrelated category's
// snapshot.
//
// EVERY category is listed explicitly (not via a `|| []` fallthrough) so the
// guard test below can assert completeness: a future category, or a future
// storage-layout version added to a currently-unversioned one, can't ship
// without a deliberate mapping decision here. The unversioned categories map
// to `[]` (their merges are LWW/deep-union/append-tolerant with no versioned
// on-disk layout today). KNOWN trade-off of per-category scoping: an
// already-shipped OLD receiver no longer blanket-blocks a future sender that
// bumps a category this version doesn't yet know is versioned — that's the
// inverse of the whole-payload over-blocking this change exists to fix.
// Introducing versioning for one of these must add its key to
// PORTOS_SCHEMA_VERSIONS AND here (the coverage test enforces it).
const SNAPSHOT_CATEGORY_SCHEMA_KEYS = {
  universe: RECORD_KIND_SCHEMA_CATEGORIES.universe,
  pipeline: [...RECORD_KIND_SCHEMA_CATEGORIES.series, ...RECORD_KIND_SCHEMA_CATEGORIES.issue],
  mediaCollections: RECORD_KIND_SCHEMA_CATEGORIES.mediaCollection,
  goals: [],
  character: [],
  digitalTwin: [],
  meatspace: [],
  videoHistory: [],
  storyBuilder: RECORD_KIND_SCHEMA_CATEGORIES.storyBuilder,
};

// Exported for the boot-adjacent guard test (see dataSync.pipelineUniverse.test.js):
// every snapshot category must have a deliberate schema-key mapping, and every
// versioned PORTOS_SCHEMA_VERSIONS key must be reachable from some category.
export function getSnapshotCategorySchemaKeys() {
  return SNAPSHOT_CATEGORY_SCHEMA_KEYS;
}

// Per-`(category, forPeerId)` `{ fingerprints, checksum }` cache. The
// orchestrator hits getChecksum every cycle — by far the hottest sync-side I/O —
// so caching keyed on underlying-file `(mtime, size)` lets it stat-and-return
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
    // Sentinel: carry the universe store's mutation epoch (a number) instead of
    // a file stat, so a PG-backed universe edit invalidates the cache even
    // though no file moved. fingerprintsEqual compares these like any value.
    if (p === UNIVERSE_EPOCH_KEY) { out[p] = `epoch:${getUniverseMutationEpoch()}`; return; }
    if (p === PIPELINE_EPOCH_KEY) { out[p] = `epoch:${getPipelineMutationEpoch()}`; return; }
    if (p === STORY_BUILDER_EPOCH_KEY) { out[p] = `epoch:${getStoryBuilderMutationEpoch()}`; return; }
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

// Map a `dataSync` category to the `getOutboundCoverageForPeer` coverage key.
// Only the three per-record-subscribable categories scope by peer; everything
// else (goals/character/digitalTwin/meatspace) has no per-record sub path, so
// it never excludes and never needs the dynamic peerSync import.
const SCOPED_COVERAGE_KEY = {
  universe: 'universe',
  pipeline: 'pipeline',
  mediaCollections: 'mediaCollections',
};

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
  const coverageKey = SCOPED_COVERAGE_KEY[category];
  if (!coverageKey || typeof forPeerId !== 'string' || forPeerId.length === 0) return new Set();
  const { getOutboundCoverageForPeer } = await import('./sharing/peerSync.js');
  const coverage = await getOutboundCoverageForPeer(forPeerId).catch(() => null);
  return coverage?.[coverageKey] instanceof Set ? coverage[coverageKey] : new Set();
}

export async function getChecksum(category, { forPeerId } = {}) {
  const cat = CATEGORIES[category];
  if (!cat) return null;
  const paths = CHECKSUM_PATHS[category];
  if (paths) {
    const fingerprints = await readFingerprintMap(paths);
    // Cache keyed by (category, forPeerId): different requesting peers get
    // different exclude-sets → different scoped snapshots → different
    // checksums. A single per-category cache slot would let peer-B's checksum
    // mask peer-C's. `*` is the unscoped key (no forPeerId).
    const cacheKey = `${category}:${forPeerId || '*'}`;
    const cached = checksumCache.get(cacheKey);
    if (cached && fingerprintsEqual(cached.fingerprints, fingerprints)) {
      return { checksum: cached.checksum };
    }
    // Cache miss only: resolve the per-peer exclude-set (a dynamic peerSync
    // import + subscription read) and build the fresh scoped snapshot. The
    // cache-hit path above never uses `exclude`, so deferring it here saves
    // that I/O on every poll that hits the cache.
    const exclude = await resolveExcludeSet(category, forPeerId);
    const snapshot = await cat.getSnapshot({ exclude });
    setChecksumCache(cacheKey, { fingerprints, checksum: snapshot.checksum });
    return { checksum: snapshot.checksum };
  }
  const exclude = await resolveExcludeSet(category, forPeerId);
  const snapshot = await cat.getSnapshot({ exclude });
  return { checksum: snapshot.checksum };
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
 */
export async function getSnapshot(category, { forPeerId } = {}) {
  const cat = CATEGORIES[category];
  if (!cat) return null;
  const exclude = await resolveExcludeSet(category, forPeerId);
  const snap = await cat.getSnapshot({ exclude });
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
  const versionDiff = scopeVersionDiff(fullDiff, SNAPSHOT_CATEGORY_SCHEMA_KEYS[category] || []);
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
  return cat.applyRemote(remoteData, source);
}
