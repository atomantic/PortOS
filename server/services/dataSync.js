/**
 * Data Sync Service
 *
 * Snapshot-based sync for JSON file data between PortOS peer instances.
 * Supports per-category sync with entity-level merge and LWW conflict resolution.
 * No data is ever lost — unique records from both sides are kept (union semantics).
 */

import { meatspaceEvents } from './meatspaceEvents.js';
import { dashboardEvents } from './dashboardEvents.js';
import { stat, readdir } from 'fs/promises';
import { join } from 'path';
import { isDeepStrictEqual } from 'util';
import { atomicWrite, readJSONFile, PATHS } from '../lib/fileUtils.js';
import { canonicalStringify, isEmptyScalar, isPlainObject } from '../lib/objects.js';
import { snapshotChecksum } from '../lib/snapshotChecksum.js';
import { parseTsMs } from '../lib/lwwTimestamp.js';
import { isTombstoned, mergeTombstones, pruneTombstones } from '../lib/tombstones.js';
import { GOAL_TOMBSTONES_KEY, reconcileGoalTombstones } from './identity/goalTombstones.js';
import { ROW_TOMBSTONES_KEY, mergeRowCopies, rowLiveStamp } from '../lib/meatspaceRowIdentity.js';
import {
  DAILY_LOG_TOMBSTONES_KEY,
  dailyLogEventLiveStamp,
  queueDailyLogWrite,
} from './meatspaceDailyLog.js';
import { queueConfigWrite, queueHealthWrite } from './meatspaceWriteQueues.js';
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
import { mergeIssuesFromSync, listAllIssues } from './pipeline/issues.js';
import { getPeers } from './instances.js';
import { mutateVideoHistory, HISTORY_UNCHANGED, videoRowLiveStamp } from './videoGen/history.js';
import { listHostedEntries, reconcileHostedMedia } from './peerHostedMedia.js';
import { sanitizeAssetFilename } from './sharing/buckets.js';
import { authorizeRemoteMediaTombstone } from './mediaTombstoneAuthorization.js';
import { rowOwnerCandidates } from '../lib/mediaRowOwners.js';
import { listMediaTombstones, listExportableMediaTombstones, mergeMediaTombstones, clearMediaTombstone } from './mediaTombstones.js';
import { emitMediaHistoryChanged } from './peerSyncEventBus.js';
import { referenceCollectionAssetManifest } from './sharing/peerSyncAssets.js';
import { mergeMediaCollectionsFromSync, listCollections, itemKey } from './mediaCollections.js';
import { listSyncableSessionsForWire, mergeStorySessionsFromSync } from './storyBuilder.js';
import { getStoryBuilderMutationEpoch } from './storyBuilderStore/store.js';
import { sanitizeStateForWire } from '../lib/syncWire.js';
import * as characterService from './character.js';
import {
  getDigitalTwinSnapshot,
  applyDigitalTwinRemote,
  DIGITAL_TWIN_CHECKSUM_PATHS,
} from './digital-twin-sync.js';
import {
  getUsageSnapshot,
  getUsageManifest,
  applyUsageRemote,
  USAGE_CHECKSUM_PATHS,
} from './peerUsage.js';

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

// Blood/epigenetic/eye records merge by row identity (`mergeRowUnionFile`), not
// by `date`: two labs on one day, a retest, or left/right exams entered
// separately share a date (#10910). Identity is the row's id, plus for a row of
// unknown provenance (no `createdAt`) a content-derived `legacy-` key every
// machine computes alike (`lib/meatspaceRowIdentity.js`, #12432). Copies of one row resolve by per-row
// `updatedAt` LWW, and a delete travels as a `rowTombstones` entry, so edits and
// deletes reach peers at `PORTOS_SCHEMA_VERSIONS.meatspace` 2. `legacyIds` marks
// the file whose rows are addressed by id (id-less rows get their content key).
const MEATSPACE_FILES = {
  'daily-log.json': { type: 'daily-log' }, // mergeDailyLogFile
  'blood-tests.json': { type: 'row-union', arrayKey: 'tests' },
  'epigenetic-tests.json': { type: 'row-union', arrayKey: 'tests' },
  'eyes.json': { type: 'row-union', arrayKey: 'exams', legacyIds: true },
  'config.json': { type: 'object-lww' }
};

// --- Checksum Helper ---

// Insertion-order sensitive by design: every getter here canonicalizes its own
// ordering before hashing (see the sorted-record notes below).
const computeChecksum = snapshotChecksum;

// --- Merge Helpers ---

const roundToHundredth = (value) => Math.round(value * 100) / 100;

// Keep a non-empty local scalar when a peer has a conflicting value, but fill
// gaps from the peer. This preserves local edits while still combining fields
// added independently on two machines.
const mergeNonEmptyObject = (local, remote) => {
  const remoteObject = isPlainObject(remote) ? remote : {};
  const merged = { ...remoteObject };
  for (const [key, value] of Object.entries(isPlainObject(local) ? local : {})) {
    if (isEmptyScalar(value) && !isEmptyScalar(remoteObject[key])) continue;
    merged[key] = value;
  }
  return merged;
};

const logEventId = (record) => (
  isPlainObject(record) && typeof record.id === 'string' && record.id ? record.id : null
);

const logEventStampMs = (record) => parseTsMs(record.updatedAt) ?? parseTsMs(record.createdAt) ?? -Infinity;

// Pick one of two copies of the same logged event. The order is total, so the
// winner is the same whichever copy is local and whichever peer syncs first.
// Newer `updatedAt` wins. On equal stamps the larger `count` wins: a peer from
// before #8143 adds a same-product log to an existing row in place without
// restamping it, and that increment is a real drink/item. Then canonical text.
const preferLogEventCopy = (a, b) => {
  const stampDiff = logEventStampMs(a) - logEventStampMs(b);
  if (stampDiff !== 0 && !Number.isNaN(stampDiff)) return stampDiff > 0 ? a : b;
  const countDiff = (Number(a.count) || 1) - (Number(b.count) || 1);
  if (countDiff !== 0) return countDiff > 0 ? a : b;
  return canonicalStringify(a) >= canonicalStringify(b) ? a : b;
};

// Merge one day's alcohol drinks or nicotine items (#8143). A row with an `id` is
// one logged event: copies of it collapse to the preferred copy, and two
// identical rows with different ids stay two events. A row without an `id` was
// logged before events had identity, so it keeps the old content-keyed dedupe —
// its identical twin on a peer is the same row synced earlier, not a new event —
// and is dropped once an edit has turned it into an identified event (`replaces`).
const mergeDailyLogEvents = (local, remote) => {
  const records = [...(Array.isArray(local) ? local : []), ...(Array.isArray(remote) ? remote : [])];
  const merged = [];
  const indexById = new Map();
  const seenLegacy = new Set(
    records.filter((r) => logEventId(r) && isPlainObject(r.replaces)).map((r) => canonicalStringify(r.replaces)),
  );
  for (const record of records) {
    const id = logEventId(record);
    if (id) {
      const index = indexById.get(id);
      if (index === undefined) {
        indexById.set(id, merged.length);
        merged.push(record);
      } else {
        merged[index] = preferLogEventCopy(merged[index], record);
      }
      continue;
    }
    const key = canonicalStringify(record);
    if (seenLegacy.has(key)) continue;
    seenLegacy.add(key);
    merged.push(record);
  }
  return merged;
};

const mergeDailyLogCategory = (local, remote, listKey, totalKey, totalForItem) => {
  const localCategory = isPlainObject(local) ? local : {};
  const remoteCategory = isPlainObject(remote) ? remote : {};
  const merged = mergeNonEmptyObject(localCategory, remoteCategory);
  const hasList = Array.isArray(localCategory[listKey]) || Array.isArray(remoteCategory[listKey]);
  if (!hasList) return merged;

  const records = mergeDailyLogEvents(localCategory[listKey], remoteCategory[listKey]);
  merged[listKey] = records;
  if (records.length > 0) {
    merged[totalKey] = roundToHundredth(records.reduce((total, record) => total + totalForItem(record), 0));
  } else if (isEmptyScalar(merged[totalKey])) {
    merged[totalKey] = 0;
  }
  return merged;
};

const standardDrinksFor = (drink) => {
  const oz = drink?.oz || 0;
  const abv = drink?.abv || 0;
  const count = drink?.count || 1;
  return ((oz * count * (abv / 100)) / 0.6);
};

const nicotineMilligramsFor = (item) => (item?.mgPerUnit ?? 0) * (item?.count ?? 1);

// Daily-log entries are one date-keyed record shared by several independent
// tenants. A date collision therefore needs a tenant merge instead of the
// generic date-keyed "keep local" behavior used by the other meatspace files.
function mergeMeatspaceDailyLogEntry(local, remote) {
  const localEntry = isPlainObject(local) ? local : {};
  const remoteEntry = isPlainObject(remote) ? remote : {};
  const merged = mergeNonEmptyObject(localEntry, remoteEntry);

  if (isPlainObject(localEntry.alcohol) || isPlainObject(remoteEntry.alcohol)) {
    merged.alcohol = mergeDailyLogCategory(
      localEntry.alcohol,
      remoteEntry.alcohol,
      'drinks',
      'standardDrinks',
      standardDrinksFor,
    );
  }
  if (isPlainObject(localEntry.nicotine) || isPlainObject(remoteEntry.nicotine)) {
    merged.nicotine = mergeDailyLogCategory(
      localEntry.nicotine,
      remoteEntry.nicotine,
      'items',
      'totalMg',
      nicotineMilligramsFor,
    );
  }
  // A cleared weigh-in is `bodyDeletedAt` on the date, not an empty `body`:
  // mergeNonEmptyObject would refill the gap from the peer. The marker wins
  // against a body with no updatedAt (the copy an older peer still holds) and
  // against any body clock it is strictly newer than. A later re-log stamps
  // updatedAt past the marker and drops it. This stays on meatspace schema 2 —
  // a version bump would make older peers refuse the whole snapshot.
  const localDeletedAt = typeof localEntry.bodyDeletedAt === 'string' && parseTsMs(localEntry.bodyDeletedAt) !== null
    ? localEntry.bodyDeletedAt : null;
  const remoteDeletedAt = typeof remoteEntry.bodyDeletedAt === 'string' && parseTsMs(remoteEntry.bodyDeletedAt) !== null
    ? remoteEntry.bodyDeletedAt : null;
  if (!localDeletedAt && !remoteDeletedAt) {
    if (isPlainObject(localEntry.body) || isPlainObject(remoteEntry.body)) {
      merged.body = mergeNonEmptyObject(localEntry.body, remoteEntry.body);
    }
    return merged;
  }
  const deletedAt = !localDeletedAt ? remoteDeletedAt
    : !remoteDeletedAt ? localDeletedAt
      : (parseTsMs(remoteDeletedAt) > parseTsMs(localDeletedAt) ? remoteDeletedAt : localDeletedAt);
  const localBody = meaningfulBody(localEntry.body);
  const remoteBody = meaningfulBody(remoteEntry.body);
  let body = null;
  if (localBody && remoteBody) {
    const localMs = parseTsMs(localBody.updatedAt);
    const remoteMs = parseTsMs(remoteBody.updatedAt);
    if (localMs === null && remoteMs === null) body = mergeNonEmptyObject(localBody, remoteBody);
    else if (remoteMs !== null && (localMs === null || remoteMs > localMs)) body = mergeNonEmptyObject(remoteBody, localBody);
    else body = mergeNonEmptyObject(localBody, remoteBody);
  } else {
    body = localBody || remoteBody;
  }
  const updatedMs = parseTsMs(body?.updatedAt);
  const deletedMs = parseTsMs(deletedAt);
  if (!body || updatedMs === null || deletedMs > updatedMs) {
    delete merged.body;
    merged.bodyDeletedAt = deletedAt;
    return merged;
  }
  if (updatedMs > deletedMs) {
    merged.body = body;
    delete merged.bodyDeletedAt;
    return merged;
  }
  merged.body = body;
  merged.bodyDeletedAt = deletedAt;
  return merged;
}

// An empty object is a gap, not a recorded weigh-in. Only a body that still
// carries a value can outlive `bodyDeletedAt`.
function meaningfulBody(body) {
  if (!isPlainObject(body)) return null;
  return Object.values(body).some(value => !isEmptyScalar(value)) ? body : null;
}

const DAILY_LOG_EVENT_LISTS = [
  { category: 'alcohol', listKey: 'drinks', totalKey: 'standardDrinks', totalFor: standardDrinksFor },
  { category: 'nicotine', listKey: 'items', totalKey: 'totalMg', totalFor: nicotineMilligramsFor },
];

// Whole-log pass over identified alcohol/nicotine events (#8154), run after the
// per-date merge on entries already sorted by date:
//  - A date move keeps the event's `id` and restamps it, so copies of one id on
//    several dates collapse to the single copy `preferLogEventCopy` picks, on
//    whichever date that copy lives. That order is total, so the result does not
//    depend on which peer is local — no per-date tombstone is needed for a move.
//  - A tombstoned id is dropped unless its live stamp (newer of createdAt /
//    updatedAt) is strictly newer than the deletion, i.e. edited after it.
// Rows without an `id` are left alone: they have no identity to match.
// Returns the surviving tombstones (pruned of ones an edit superseded).
const reconcileDailyLogEvents = (entries, tombstones) => {
  const liveStamps = [];
  for (const { category, listKey, totalKey, totalFor } of DAILY_LOG_EVENT_LISTS) {
    const winners = new Map();
    for (const entry of entries) {
      for (const record of entry?.[category]?.[listKey] ?? []) {
        const id = logEventId(record);
        if (!id) continue;
        const current = winners.get(id);
        winners.set(id, current ? preferLogEventCopy(current, record) : record);
      }
    }
    for (const entry of entries) {
      const list = entry?.[category]?.[listKey];
      if (!Array.isArray(list)) continue;
      const kept = list.filter((record) => {
        const id = logEventId(record);
        if (!id) return true;
        if (winners.get(id) !== record) return false;
        return !isTombstoned(tombstones, id, dailyLogEventLiveStamp(record), 'id');
      });
      for (const record of kept) {
        const id = logEventId(record);
        if (id) liveStamps.push({ id, stamp: dailyLogEventLiveStamp(record) });
      }
      if (kept.length === list.length) continue;
      if (kept.length === 0) {
        delete entry[category];
      } else {
        entry[category] = {
          ...entry[category],
          [listKey]: kept,
          [totalKey]: roundToHundredth(kept.reduce((total, record) => total + totalFor(record), 0)),
        };
      }
    }
  }
  return pruneTombstones(tombstones, liveStamps, { keyField: 'id', timestampField: 'stamp' });
};

// Merge a peer's whole `daily-log.json` into the local one. Pure: returns the
// file to persist. Tombstones union in both directions (#8154) before the
// reconcile pass, so a deletion made on either side removes the event on both.
function mergeDailyLogFile(local, remote) {
  const localFile = isPlainObject(local) ? local : {};
  const remoteFile = isPlainObject(remote) ? remote : {};
  const { merged } = mergeArraysByKey(
    Array.isArray(localFile.entries) ? localFile.entries : [],
    Array.isArray(remoteFile.entries) ? remoteFile.entries : [],
    'date',
    null,
    mergeMeatspaceDailyLogEntry,
  );
  // Shallow copies: the reconcile pass replaces or deletes a category on an
  // entry, and must not do that to the caller's local objects.
  const entries = merged.map((entry) => (isPlainObject(entry) ? { ...entry } : entry));
  entries.sort((a, b) => (a?.date || '').localeCompare(b?.date || ''));
  const { merged: unionTombstones } = mergeTombstones(
    localFile[DAILY_LOG_TOMBSTONES_KEY],
    remoteFile[DAILY_LOG_TOMBSTONES_KEY],
    { keyField: 'id' },
  );
  const tombstones = reconcileDailyLogEvents(entries, unionTombstones);
  const mergedFile = {
    ...remoteFile,
    ...localFile,
    entries,
    lastEntryDate: entries[entries.length - 1]?.date || null,
  };
  if (tombstones.length > 0) mergedFile[DAILY_LOG_TOMBSTONES_KEY] = tombstones;
  else delete mergedFile[DAILY_LOG_TOMBSTONES_KEY];
  return mergedFile;
}

/**
 * Merge two arrays of records by a key field. LWW by timestampField when both
 * sides have the same record. Records unique to either side are kept (union).
 * A mergeRecord callback can combine same-key records for domains whose record
 * is itself a container for independent sub-records.
 */
function mergeArraysByKey(localArr, remoteArr, idField, timestampField, mergeRecord) {
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
    } else if (mergeRecord) {
      const mergedItem = mergeRecord(localItem, remoteItem);
      if (canonicalStringify(mergedItem) !== canonicalStringify(localItem)) {
        localMap.set(key, mergedItem);
        changed = true;
      }
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
 * Merge a peer's row-union file (blood / epigenetic / eye records) into the
 * local one. Pure: returns the file to persist.
 *
 * Copies of one row (`mergeRowCopies`: same id, or same content key for a row
 * without `createdAt`) resolve to the newer `updatedAt`, so an edit wins on
 * every machine. Tombstones union both ways and drop a row when any of its keys
 * is tombstoned, unless it was edited after the delete; a row that outlives its
 * tombstone prunes it.
 */
function mergeRowUnionFile(localFile, remoteFile, { arrayKey, legacyIds = false }) {
  const local = isPlainObject(localFile) ? localFile : {};
  const remote = isPlainObject(remoteFile) ? remoteFile : {};
  const entries = mergeRowCopies(local[arrayKey], remote[arrayKey], {
    stampIds: legacyIds,
    keepLocalDuplicates: !legacyIds,
  });
  const { merged: unionTombstones } = mergeTombstones(
    local[ROW_TOMBSTONES_KEY],
    remote[ROW_TOMBSTONES_KEY],
    { keyField: 'id' },
  );
  const kept = [];
  const liveStamps = [];
  for (const { row, keys } of entries) {
    if (keys) {
      const stamp = rowLiveStamp(row);
      if ([...keys].some((key) => isTombstoned(unionTombstones, key, stamp, 'id'))) continue;
      for (const key of keys) liveStamps.push({ id: key, stamp });
    }
    kept.push(row);
  }
  const tombstones = pruneTombstones(unionTombstones, liveStamps, { keyField: 'id', timestampField: 'stamp' });
  // Stable by date; same-date rows keep local-then-remote order.
  kept.sort((a, b) => (a?.date || '').localeCompare(b?.date || ''));

  const mergedFile = { ...remote, ...local, [arrayKey]: kept };
  if (tombstones.length > 0) mergedFile[ROW_TOMBSTONES_KEY] = tombstones;
  else delete mergedFile[ROW_TOMBSTONES_KEY];
  return mergedFile;
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

// --- Category: Goals ---

async function getGoalsSnapshot() {
  const data = await readJSONFile(GOALS_FILE, { goals: [] }, { strict: true });
  return { data, checksum: computeChecksum(data) };
}

const GOALS_METADATA_FIELDS = ['birthDate', 'lifeExpectancy', 'timeHorizons'];

/**
 * Freshness of a goals document for the metadata LWW. The document's own
 * `updatedAt` is the clock — `setBirthDate` and every goal write stamp it — so a
 * birth-date edit that never touches a child goal still orders correctly. The
 * newest goal `updatedAt` stands in only for a legacy document with no usable
 * document clock. `null` = no usable clock at all (never wins).
 */
function goalsDocumentClockMs(doc) {
  const docMs = parseTsMs(doc?.updatedAt);
  if (docMs !== null) return docMs;
  let newest = null;
  for (const goal of Array.isArray(doc?.goals) ? doc.goals : []) {
    const ms = parseTsMs(goal?.updatedAt);
    if (ms !== null && (newest === null || ms > newest)) newest = ms;
  }
  return newest;
}

// Goals merge by union, so a delete is only representable as a tombstone (#9816):
// `deleteGoal` leaves `{ id, deletedAt }` in the goals document, the list unions in
// both directions (a legacy peer that omits it leaves ours untouched), and any
// goal copy the union covers is dropped here, children reparented. See
// identity/goalTombstones.js for the restoration rule and resurrection horizon.
async function applyGoalsRemote(remoteData) {
  const { editGoals } = await import('./identity/store.js');
  return editGoals(local => {
    const localGoals = local.goals || [];
    const { merged: tombstones } = mergeTombstones(
      local[GOAL_TOMBSTONES_KEY],
      remoteData[GOAL_TOMBSTONES_KEY],
      { keyField: 'id' },
    );
    // A tombstoned remote copy is filtered BEFORE the union so it neither counts
    // as a change nor as proof the remote document is fresher.
    const remoteGoals = reconcileGoalTombstones(remoteData.goals || [], tombstones).goals;
    // Merge goals array by ID with LWW on updatedAt
    const { merged: unionGoals } = mergeArraysByKey(localGoals, remoteGoals, 'id', 'updatedAt');
    const { goals: mergedGoals, tombstones: liveTombstones } = reconcileGoalTombstones(unionGoals, tombstones);
    const goalsChanged = canonicalStringify(mergedGoals) !== canonicalStringify(localGoals);
    const tombstonesChanged = canonicalStringify(liveTombstones) !== canonicalStringify(local[GOAL_TOMBSTONES_KEY] ?? []);

    // Top-level metadata (birthDate, lifeExpectancy, timeHorizons) is LWW on the document
    // clock, independent of the goal-array merge: a metadata-only edit changes no goal.
    // A tie keeps local, so a replay of the same snapshot is a no-op. The legacy child-clock
    // fallback reads the tombstone-filtered remote goals, so a deleted copy is no proof of
    // a fresher document.
    const remoteClock = goalsDocumentClockMs({ ...remoteData, goals: remoteGoals });
    const localClock = goalsDocumentClockMs(local);
    const remoteWins = remoteClock !== null && (localClock === null || remoteClock > localClock);

    const winning = {};
    if (remoteWins) {
      for (const field of GOALS_METADATA_FIELDS) winning[field] = remoteData[field] ?? local[field];
      // Carry the winning clock itself — restamping on receipt would out-date the peer's
      // next edit, and leaving ours would let the same snapshot win again.
      if (parseTsMs(remoteData.updatedAt) !== null) winning.updatedAt = remoteData.updatedAt;
    }
    const metaChanged = Object.entries(winning).some(([field, value]) => !isDeepStrictEqual(value, local[field]));

    if (goalsChanged || tombstonesChanged || metaChanged) {
      Object.assign(local, winning, { goals: mergedGoals });
      // A legacy document stays free of the field until something is tombstoned.
      if (liveTombstones.length > 0) local[GOAL_TOMBSTONES_KEY] = liveTombstones;
      else delete local[GOAL_TOMBSTONES_KEY];
      console.log(`🔄 Goals sync: merged ${mergedGoals.length} goals`);
      return { applied: true, count: mergedGoals.length };
    }
    return { applied: false, count: 0 };
  });
}

// --- Category: Character ---

async function getCharacterSnapshot() {
  // Use the wire projection (persisted record + a backward-compatible `level`) so pre-#2673
  // peers still get a usable integer level even though `level` is no longer persisted (#2673).
  const data = await characterService.getWireCharacter();
  if (!data) return { data: null, checksum: 'empty' };
  return { data, checksum: computeChecksum(data) };
}

// Merge + persist live in the Character service so they share its mutation queue with local
// edits (#9817); reading local state here and writing it back would race them.
async function applyCharacterRemote(remoteData) {
  return characterService.applyRemoteSnapshot(remoteData);
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
    // Snapshot-only projection; the merge path reads its local inputs strictly.
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

    if (config.type === 'daily-log') {
      // Through the same write queue as the local drink/nicotine/body writers,
      // so a sync cannot overwrite a delete (and its tombstone) made between
      // this read and write.
      const written = await queueDailyLogWrite(async () => {
        const local = await readJSONFile(filePath, null, { strict: true });
        const merged = mergeDailyLogFile(local, remoteFile);
        if (canonicalStringify(merged) === canonicalStringify(local)) return false;
        await atomicWrite(filePath, merged);
        return true;
      });
      if (written) totalApplied++;
      continue;
    }

    // Both branches below read-modify-write a file whose local writers run on
    // a shared queue, so the sync apply must take the same one.
    if (config.type === 'object-lww') {
      const written = await queueConfigWrite(async () => {
        const local = await readJSONFile(filePath, null, { strict: true });
        const { merged, changed } = mergeObjectLWW(local, remoteFile, 'updatedAt');
        if (!changed) return false;
        await atomicWrite(filePath, merged);
        return true;
      });
      if (written) {
        if (filename === 'config.json') meatspaceEvents.emit('death-clock:changed', {});
        totalApplied++;
      }
    } else {
      const written = await queueHealthWrite(async () => {
        const local = await readJSONFile(filePath, null, { strict: true });
        const merged = mergeRowUnionFile(local, remoteFile, config);
        // A peer with nothing to add must not create the file here.
        if (local === null && merged[config.arrayKey].length === 0 && !merged[ROW_TOMBSTONES_KEY]) return false;
        if (canonicalStringify(merged) === canonicalStringify(local)) return false;
        await atomicWrite(filePath, merged);
        return true;
      });
      if (written) totalApplied++;
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

async function applyUniverseRemote(remoteData, source, meta = {}) {
  if (!remoteData) return { applied: false, count: 0 };
  // Routes through `mergeUniversesFromSync` so the read-modify-write runs
  // INSIDE `queueUniverseWrite` (serialized against every other writer:
  // create / update / promote-variation / handleSave) and each incoming
  // remote record passes through `sanitizeTemplate` for schema-version
  // backfill — older peers landing pre-v4 records get them migrated on the
  // way in instead of polluting disk with un-backfilled state.
  // `senderSchemaVersions` gates the moodBoardId omitted-vs-cleared
  // disambiguation (#4188) — see mergeUniversesFromSync.
  const result = await mergeUniversesFromSync(remoteData.universes || [], {
    source,
    senderSchemaVersions: meta.senderSchemaVersions || null,
  });
  if (result.applied) {
    console.log(`🔄 Universe sync: merged ${result.count} universe(s)`);
  }
  return result;
}

// --- Category: Pipeline ---

async function getPipelineSnapshot({ exclude } = {}) {
  const [series, issues] = await Promise.all([
    listSeries({ includeDeleted: true }),
    listAllIssues({ includeDeleted: true }),
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

async function applyPipelineRemote(remoteData, source, { senderSchemaVersions = null } = {}) {
  if (!remoteData) return { applied: false, count: 0 };
  // Routes through the service merge entry points so each incoming record
  // passes through the same sanitizer and LWW contract as local writes.
  const [seriesResult, issuesResult] = await Promise.all([
    mergeSeriesFromSync(remoteData.series || [], { source }),
    mergeIssuesFromSync(remoteData.issues || [], { source, senderSchemaVersions }),
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
  // Project through the SHARED wire sanitizer before canonicalizing, so this
  // snapshot and the per-record push agree on which fields cross the wire
  // instead of each deciding for itself (see `sanitizeRecordForWire` — it
  // normalizes the soft-delete pair to tail position, which service-sanitized
  // records already satisfy, and drops the local-only `source` provenance stamp
  // added in #3311 so an upgraded peer's checksum stays byte-stable against a
  // not-yet-upgraded one).
  const { data: wire } = sanitizeStateForWire('mediaCollections', { collections: filtered });
  const canonical = wire.collections
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
  // Unioned references do not prove the sender has bytes. Ownership is
  // reconciled separately from its local-file inventory, even on checksum ties.
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
  // STRICT (#4115): an unreadable history would publish a valid CHECKSUM over an
  // empty set — peers conclude this machine holds no videos and the category
  // thrashes forever. Absent is a real empty; unreadable must not go on the wire.
  const raw = await readJSONFile(VIDEO_HISTORY_FILE, [], { strict: true });
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
  // `suppliedByInstanceId` is likewise MACHINE-LOCAL (who handed THIS machine the
  // row); stripped so identical row sets hash identically. `originInstanceId` syncs.
  // `pendingDelete` (a delete queued for the row's owner) is this machine's own work.
  // Canonicalize ordering for the wire so two peers holding identical sets
  // produce identical checksums regardless of insertion (newest-first) order.
  // Mirrors getMediaCollectionsSnapshot's sort-by-id rationale.
  const data = {
    videos: rows
      .map(({ hidden, suppliedByInstanceId, pendingDelete, ...rest }) => rest)
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  // Deliberate deletes ride the snapshot so a peer still holding the row can't
  // resurrect it. Sorted by key for a deterministic checksum. The key is OMITTED
  // when empty so a peer with no deletes keeps the exact pre-tombstone checksum
  // (an older peer that ignores `tombstones` would otherwise never converge).
  // A delete still trashing its files is left out until it commits (#14088).
  const tombstones = [...(await listExportableMediaTombstones('video'))].sort((a, b) => a.key.localeCompare(b.key));
  if (tombstones.length > 0) data.tombstones = tombstones;
  return { data, checksum: computeChecksum(data) };
}

// This separate inventory describes only bytes on this machine, never the
// unioned history or files streamed from another peer. It is refreshed even
// when history is unchanged and is absent on older peers.
export async function getHostedMediaInventory(category = 'videoHistory', kind = 'video') {
  const { data } = category === 'mediaCollections' ? await getMediaCollectionsSnapshot() : await getVideoHistorySnapshot();
  const references = category === 'mediaCollections'
    ? data.collections.filter((c) => !c.deleted).flatMap((c) => referenceCollectionAssetManifest(c).filter((asset) => asset.kind === kind).map((asset) => asset.filename))
    : data.videos.map((row) => row.filename);
  const names = await readdir(kind === 'image' ? PATHS.images : PATHS.videos, { withFileTypes: true }).catch((err) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  const local = new Set(names.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const checked = [...new Set(references.filter((name) =>
    typeof name === 'string' && sanitizeAssetFilename(name) === name))];
  const filenames = checked.filter((name) => local.has(name));
  // File times let paired peers settle who made an unattributed copy
  // (mediaOriginReconcile.js); an older peer ignores the extra field.
  const dir = kind === 'image' ? PATHS.images : PATHS.videos;
  const mtimes = {};
  for (const name of filenames) {
    const info = await stat(join(dir, name)).catch(() => null);
    if (info) mtimes[name] = info.mtimeMs;
  }
  return { version: 1, filenames, checked, mtimes, portosMeta: await buildPortosMeta() };
}

// Unlike the collection inventory, this lists every gallery image on disk, so a name
// absent from it is genuinely not held (`complete`). Older peers 404 it.
export async function getImageLibraryInventory() {
  const entries = await readdir(PATHS.images, { withFileTypes: true }).catch((err) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  const filenames = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.png') && sanitizeAssetFilename(e.name) === e.name).map((e) => e.name).sort();
  const mtimes = {};
  for (const name of filenames) {
    const info = await stat(join(PATHS.images, name)).catch(() => null);
    if (info) mtimes[name] = info.mtimeMs;
  }
  return { version: 1, filenames, checked: filenames, complete: true, mtimes, portosMeta: await buildPortosMeta() };
}

async function applyVideoHistoryRemote(remoteData, source) {
  if (!remoteData) return { applied: false, count: 0 };
  const incomingRows = Array.isArray(remoteData.videos) ? remoteData.videos : [];
  const incomingTombstones = Array.isArray(remoteData.tombstones) ? remoteData.tombstones : [];
  if (incomingRows.length === 0 && incomingTombstones.length === 0) return { applied: false, count: 0 };

  // Tombstones merge first so the row merge below sees the full delete set;
  // only the ones the sender is authorized for ever reach the store.
  const removedCount = await applyRemoteVideoTombstones(await authorizedSnapshotTombstones(incomingTombstones, source));
  const { count } = await mergeVideoRows(incomingRows, source);
  const changedCount = count + removedCount;
  if (changedCount === 0) return { applied: false, count: 0 };
  console.log(`🔄 VideoHistory sync: merged ${changedCount} video row(s)`);
  return { applied: true, count: changedCount };
}

/**
 * The one video-row merge, shared by the snapshot path and realtime
 * `peer:sync:event` upserts. `source.peerId` is the SENDER's instance id.
 * Drops tombstoned rows, then union-merges by id (LWW on `createdAt`) inside the history write queue.
 * Returns `{ count, ids }` for rows actually added or updated.
 */
export async function mergeVideoRows(incomingRows, source) {
  // Only the row's owner may un-delete it: a `restoredAt` from any other
  // sender is dropped, so it can neither pass a delete here nor shield the
  // row from its owner's later delete.
  const fromOwner = (r) => typeof source?.peerId === 'string' && r?.originInstanceId === source.peerId;
  const admitted = (Array.isArray(incomingRows) ? incomingRows : [])
    .map((r) => (r && typeof r === 'object' && 'restoredAt' in r && !fromOwner(r) ? (({ restoredAt, ...rest }) => rest)(r) : r));

  // The whole read/merge/write runs inside the shared history mutation queue so
  // a local completion (videoDownload) or another peer's snapshot can't be
  // overwritten by this merge's stale base. The queue's read is STRICT (#4115):
  // an unreadable file rejects instead of becoming an empty merge base that
  // would delete every local-only row on write-back.
  // Tombstones are read INSIDE the writer: a local delete records its tombstone
  // while holding it, so reading before we queue would miss a delete that commits
  // while we wait and re-add the row it just removed (#14123).
  const changedIds = [];
  let tombstones = [];
  const hostedIndex = await listHostedEntries();
  await mutateVideoHistory(async (local) => {
    tombstones = await listMediaTombstones('video');
    // A row survives a tombstone only when it was (re)created or restored after the delete.
    const incoming = admitted.filter((r) => !(hasVideoRowId(r) && isTombstoned(tombstones, r.id, videoRowLiveStamp(r), 'key')));
    if (incoming.length === 0) return HISTORY_UNCHANGED;
    // Union by `id`, LWW on `createdAt` when both sides know the same row.
    // Video-history rows are append-mostly and immutable once written, so
    // `createdAt` is a sufficient (and the only) freshness signal — there's no
    // `updatedAt`. A row with no string id can't be keyed and is skipped (a
    // hand-edited or corrupt entry shouldn't clobber a real row at key
    // `undefined`); the snapshot side excludes the same rows so checksums agree.
    const hasId = hasVideoRowId;
    // An origin-less copy takes the origin a sender names, but only a sender
    // that already holds delete authority over it (an owner candidate): no peer
    // gains a power it lacked, and the two snapshots' checksums converge.
    const adoptedIds = new Set();
    const keyed = local.filter(hasId).map((row) => {
      if (row.originInstanceId || typeof source?.peerId !== 'string' || !rowOwnerCandidates(row, hostedIndex).includes(source.peerId)) return row;
      const named = incoming.find((r) => hasId(r) && r.id === row.id && typeof r.originInstanceId === 'string' && r.originInstanceId);
      if (!named) return row;
      adoptedIds.add(row.id);
      return { ...row, originInstanceId: named.originInstanceId };
    });
    const before = new Map(keyed.map((r) => [r.id, r]));
    const { merged: lwwMerged, changed: rowsChanged } = mergeArraysByKey(
      keyed,
      // suppliedByInstanceId and pendingDelete are local-only: never trust a sender's value.
      incoming.filter(hasId).map(({ suppliedByInstanceId, pendingDelete, ...rest }) => rest),
      'id',
      'createdAt',
    );
    // The Make-primary designation is the one field of a row that moves after
    // creation: the newest valid `primaryAt` of the local and incoming rows wins,
    // whichever side won the row itself (a re-created row must not drop it).
    const incomingById = new Map(incoming.filter(hasId).map((r) => [r.id, r]));
    const designated = (r) => typeof r?.primaryInstanceId === 'string' && r.primaryInstanceId && parseTsMs(r.primaryAt) !== null;
    let primaryChanged = false;
    const rawMerged = lwwMerged.map((row) => {
      const best = [before.get(row.id), incomingById.get(row.id)].filter(designated)
        .reduce((a, b) => (!a || parseTsMs(b.primaryAt) > parseTsMs(a.primaryAt) ? b : a), null);
      if (!best || (row.primaryInstanceId === best.primaryInstanceId && row.primaryAt === best.primaryAt)) return row;
      primaryChanged = true;
      return { ...row, primaryInstanceId: best.primaryInstanceId, primaryAt: best.primaryAt };
    });
    if (!rowsChanged && !primaryChanged && adoptedIds.size === 0) return HISTORY_UNCHANGED;
    // Ownership of a row held here never comes from a sender: its origin and
    // supplier stay the local values, even when absent (an origin-less row stays
    // origin-less, or any peer could claim it and then delete it). Only a row
    // newly added here takes the incoming origin, with this sender as supplier.
    const merged = rawMerged.map((row) => {
      const prev = before.get(row.id);
      if (prev === row) return row;
      const { originInstanceId: incomingOrigin, ...content } = row;
      const originInstanceId = prev ? prev.originInstanceId : incomingOrigin;
      const suppliedByInstanceId = prev ? prev.suppliedByInstanceId : source?.peerId;
      return {
        ...content,
        ...(originInstanceId ? { originInstanceId } : {}),
        ...(suppliedByInstanceId ? { suppliedByInstanceId } : {}),
      };
    });

    // `count` reports rows actually added/updated by this merge (not total
    // post-merge size — that would over-report when callers sum across
    // categories or compare cycle deltas). Matches the pipeline category's
    // `count` contract.
    for (const row of merged) {
      const prev = before.get(row.id);
      if (!prev || prev !== row || adoptedIds.has(row.id)) changedIds.push(row.id);
    }

    // Preserve any local rows that lacked an id (the merge dropped them from its
    // keyed map) — don't let a sync silently delete un-keyable local history.
    const idless = local.filter((r) => !hasId(r));
    // Newest-first to match how generateVideo unshifts new rows + how the
    // Media History grid expects them.
    return [...merged, ...idless].sort((a, b) =>
      String(b?.createdAt ?? '').localeCompare(String(a?.createdAt ?? '')));
  }, { stampOrigin: false });
  // A row admitted past a tombstone held here (re-created or restored by its
  // owner) supersedes it: drop it, or this machine keeps advertising a delete
  // its peers no longer hold and the snapshots never converge.
  const superseded = new Map(tombstones.map((t) => [t.key, t.deletedAt]));
  for (const id of changedIds) {
    if (superseded.has(id)) await clearMediaTombstone('video', id, { deletedAt: superseded.get(id) });
  }
  emitMediaHistoryChanged({ kind: 'video', op: 'upsert', ids: changedIds });
  return { count: changedIds.length, ids: changedIds };
}

// Snapshot tombstones pass the shared admission rule (mediaTombstoneAuthorization.js)
// against the sender's registry record; an unknown sender's are all refused.
async function authorizedSnapshotTombstones(tombstones, source) {
  if (tombstones.length === 0) return [];
  const peer = source?.peerId
    ? (await getPeers().catch(() => [])).find((p) => p.instanceId === source.peerId) ?? null
    : null;
  const local = await readJSONFile(VIDEO_HISTORY_FILE, [], { strict: true });
  const rowsById = new Map((Array.isArray(local) ? local : []).filter(hasVideoRowId).map((r) => [r.id, r]));
  const hostedIndex = await listHostedEntries();
  const accepted = tombstones.filter((tombstone) => authorizeRemoteMediaTombstone({
    peer, tombstone, localRow: rowsById.get(tombstone?.key) ?? null, hostedIndex, via: 'snapshot',
  }).allowed);
  const ignored = tombstones.length - accepted.length;
  if (ignored > 0) console.log(`⏭️ VideoHistory snapshot from ${source?.peerId ?? 'unknown sender'}: ignored ${ignored} tombstone(s)`);
  return accepted;
}

/**
 * Merge an ALREADY AUTHORIZED video tombstone list (authorizeRemoteMediaTombstone)
 * and trash every local row (and its files) it supersedes. Returns the number
 * of local rows removed. `fromRemoteTombstone` keeps deleteHistoryItem from
 * re-recording the tombstone or re-announcing the delete.
 */
export async function applyRemoteVideoTombstones(remoteTombstones, { forgetInMusicVideos = true } = {}) {
  if (!Array.isArray(remoteTombstones) || remoteTombstones.length === 0) return 0;
  await mergeMediaTombstones('video', remoteTombstones);
  const tombstones = await listMediaTombstones('video');
  const local = await readJSONFile(VIDEO_HISTORY_FILE, [], { strict: true });
  // Only the rows these authorized tombstones name: a row another tombstone
  // in the store covers has not been admitted for this sender.
  const keys = new Set(remoteTombstones.map((t) => t?.key).filter((key) => typeof key === 'string'));
  const doomed = (Array.isArray(local) ? local : [])
    .filter((r) => hasVideoRowId(r) && keys.has(r.id) && isTombstoned(tombstones, r.id, videoRowLiveStamp(r), 'key'));
  if (doomed.length === 0) return 0;
  // Lazy import: historyOps pulls in trash/ffmpeg machinery the sync read path avoids.
  const { deleteHistoryItem } = await import('./videoGen/historyOps.js');
  let removed = 0;
  const failures = [];
  for (const row of doomed) {
    try {
      // Re-checked under the history writer: a replacement row written since the
      // read above carries a newer createdAt and must survive this tombstone.
      const result = await deleteHistoryItem(row.id, {
        fromRemoteTombstone: true,
        forgetInMusicVideos,
        onlyIf: (current) => isTombstoned(tombstones, current.id, videoRowLiveStamp(current), 'key'),
      });
      if (result?.skipped) {
        console.log(`⏭️ VideoHistory tombstone: ${row.id} was re-created since the delete`);
        continue;
      }
      removed++;
    } catch (err) {
      // Row already gone is an expected race with a concurrent local delete.
      if (err?.code === 'NOT_FOUND') {
        console.log(`⏭️ VideoHistory tombstone: ${row.id} already removed`);
        continue;
      }
      console.error(`❌ VideoHistory tombstone removal failed for ${row.id}: ${err.message}`);
      failures.push(row.id);
    }
  }
  // Fail the apply so the caller retries (a snapshot keeps its checksum uncached)
  // instead of leaving a tombstoned row and its files in place.
  if (failures.length > 0) {
    throw new Error(`VideoHistory tombstone removal failed for ${failures.length} row(s): ${failures.join(', ')}`);
  }
  return removed;
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
  // usage invalidates on our OWN usage.json (every recorded AI run rewrites it)
  // and on the peer-digest store (a peer's newer digest changes what we forward
  // on). Both are atomicWrite'd — see peerUsage.js.
  usage: USAGE_CHECKSUM_PATHS,
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
  storyBuilder: { getSnapshot: getStoryBuilderSnapshot, applyRemote: applyStoryBuilderRemote },
  // `getManifest` is optional and only `usage` has one: it is the only category
  // that is BOTH always dirty (every recorded AI run rewrites usage.json) and a
  // map of independently-advancing per-instance slots, so it is the only one
  // where "one slot moved" was costing a whole-payload transfer (#5759).
  usage: { getSnapshot: getUsageSnapshot, getManifest: getUsageManifest, applyRemote: applyUsageRemote }
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
  meatspace: ['meatspace'],
  videoHistory: ['videoHistory'],
  storyBuilder: RECORD_KIND_SCHEMA_CATEGORIES.storyBuilder,
  // Per-instance digests replaced whole under an LWW stamp, with every field
  // read defensively — no versioned on-disk layout to gate on.
  usage: [],
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
    const { checksum } = await checksumSource(cat, exclude);
    setChecksumCache(cacheKey, { fingerprints, checksum });
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
  const versionDiff = scopeVersionDiff(fullDiff, SNAPSHOT_CATEGORY_SCHEMA_KEYS[category] || []);
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
  if ((category === 'videoHistory' || category === 'mediaCollections') && options.inventory === true) {
    const peer = (await getPeers()).find((p) => p.instanceId === source.peerId && p.enabled !== false);
    if (peer && remoteData?.version === 1 && Array.isArray(remoteData.filenames) && Array.isArray(remoteData.checked)) {
      const kind = options.inventoryKind === 'image' ? 'image' : 'video';
      // Every report of held bytes feeds the holders list (services/mediaHolders.js).
      if (kind === 'video' || category === 'mediaCollections') {
        const { recordPeerInventory } = await import('./mediaHolders.js');
        await recordPeerInventory(peer.instanceId, kind, remoteData.filenames, remoteData.checked);
      }
      if (options.inventoryScope === 'library') {
        // File times only: a whole-library listing must not drive host-mode reconciliation.
        if (kind === 'image' && category === 'mediaCollections' && isPlainObject(remoteData.mtimes)) {
          const { recordPeerHoldings, reconcileMediaOrigins } = await import('./mediaOriginReconcile.js');
          await recordPeerHoldings(peer.instanceId, 'image', 'imageLibrary', { mtimes: remoteData.mtimes, checked: remoteData.checked, complete: remoteData.complete === true });
          await reconcileMediaOrigins('image');
        }
      } else if (kind === 'video' || category === 'mediaCollections') {
        if (peer.mediaSyncMode === 'host') await reconcileHostedMedia(peer.instanceId, kind, remoteData.filenames, remoteData.checked);
        if (isPlainObject(remoteData.mtimes)) {
          const { recordPeerHoldings, reconcileMediaOrigins } = await import('./mediaOriginReconcile.js');
          await recordPeerHoldings(peer.instanceId, kind, category, { mtimes: remoteData.mtimes, checked: remoteData.checked });
          await reconcileMediaOrigins(kind);
        }
      }
    }
    return { applied: false, count: 0 };
  }
  // Third arg: sender envelope details for appliers that disambiguate
  // omitted-vs-cleared fields by sender version (universe moodBoardId, #4188).
  // Appliers that don't need it ignore the extra argument.
  return cat.applyRemote(remoteData, source, { senderSchemaVersions });
}
