/** Merges and snapshots the explicitly federated MeatSpace files under their local write queues. */

import { meatspaceEvents } from '../../meatspace/meatspaceEvents.js';
import { join } from 'path';
import { atomicWrite, readJSONFile, PATHS } from '../../../lib/fileUtils.js';
import { canonicalStringify, isEmptyScalar, isPlainObject } from '../../../lib/objects.js';
import { parseTsMs } from '../../../lib/lwwTimestamp.js';
import { isTombstoned, mergeTombstones, pruneTombstones } from '../../../lib/tombstones.js';
import { ROW_TOMBSTONES_KEY, mergeRowCopies, rowLiveStamp } from '../../../lib/meatspaceRowIdentity.js';
import { DAILY_LOG_TOMBSTONES_KEY, dailyLogEventLiveStamp, notifyDailyLogChange, queueDailyLogWrite, snapshotDailyLogResources } from '../../meatspace/meatspaceDailyLog.js';
import { queueConfigWrite, queueHealthWrite } from '../../meatspace/meatspaceWriteQueues.js';
import { mergeArraysByKey } from '../mergeByKey.js';
import { computeChecksum } from '../snapshotHelpers.js';

export const MEATSPACE_DIR = PATHS.meatspace;

// Blood/epigenetic/eye records merge by row identity (`mergeRowUnionFile`), not
// by `date`: two labs on one day, a retest, or left/right exams entered
// separately share a date (#10910). Identity is the row's id, plus for a row of
// unknown provenance (no `createdAt`) a content-derived `legacy-` key every
// machine computes alike (`lib/meatspaceRowIdentity.js`, #12432). Copies of one row resolve by per-row
// `updatedAt` LWW, and a delete travels as a `rowTombstones` entry, so edits and
// deletes reach peers at `PORTOS_SCHEMA_VERSIONS.meatspace` 2. `legacyIds` marks
// the file whose rows are addressed by id (id-less rows get their content key).
export const MEATSPACE_FILES = {
  'daily-log.json': { type: 'daily-log' }, // mergeDailyLogFile
  'blood-tests.json': { type: 'row-union', arrayKey: 'tests' },
  'epigenetic-tests.json': { type: 'row-union', arrayKey: 'tests' },
  'eyes.json': { type: 'row-union', arrayKey: 'exams', legacyIds: true },
  'config.json': { type: 'object-lww' }
};

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

export async function getMeatspaceSnapshot() {
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

export async function applyMeatspaceRemote(remoteData) {
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
        await atomicWrite(filePath, merged, { mode: 0o600, dirMode: 0o700 });
        notifyDailyLogChange(snapshotDailyLogResources(local?.entries), merged.entries);
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
        await atomicWrite(filePath, merged, { mode: 0o600, dirMode: 0o700 });
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
        await atomicWrite(filePath, merged, { mode: 0o600, dirMode: 0o700 });
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
