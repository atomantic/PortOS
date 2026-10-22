/**
 * Storyboard federation — the peer-sync face of the storyboards service.
 *
 * A board syncs as ONE whole-record LWW unit on `updatedAt` (record kind and
 * category `storyboard`/`storyboards`); a delete travels as the tombstone pair
 * and the shared GC sweep hard-removes it once every peer has had the grace
 * window. Panel art takes ride the push asset manifest as gallery images
 * (`buildStoryboardAssetManifest`); a `sketch:` take syncs as its reference
 * only — the stroke/PNG sidecars in data/media-sketches are machine-local.
 *
 * Imports the store directly (never ./index.js) so index.js can re-export this
 * module without a cycle.
 */

import { compareNewerWins } from '../../lib/lwwTimestamp.js';
import {
  contentHashForRecord,
  deleteSyncBaseHash,
  flushBaseHashes,
  maybeJournalBeforeOverwrite,
  setSyncBaseHash,
  withBaseHashFlushBatch,
} from '../../lib/conflictJournal.js';
import { sanitizeStoryboard } from '../../lib/storyboardRecord.js';
import { isValidStoryboardId } from '../../lib/storyboardVocabulary.js';
import { emitRecordUpdated } from '../sharing/recordEvents.js';
import {
  deleteRaw, listIds, listLiveIds, listRaw, listTombstoneIdsBefore, queueStoryboardWrite, readRaw, writeRaw,
} from './store.js';

export const STORYBOARD_KIND = 'storyboard';

// The authored fields a conflict-journal restore overlays (mirrored in
// RESTORABLE_FIELDS.storyboard); identity and timestamps stay structural.
const RESTORABLE_FIELDS = ['name', 'logline', 'aspectRatio', 'artStyle', 'universeId', 'moodBoardId', 'recipe', 'beats'];

/** One board's sanitized record with its tombstone surfaced, or null when unknown. */
export async function getStoryboardForSync(id) {
  if (!isValidStoryboardId(id)) return null;
  return sanitizeStoryboard(await readRaw(id));
}

/** Every LIVE board as `{ id, updatedAt }` — the full-sync coverage compare set. */
export async function listStoryboardsForSync() {
  return (await listRaw())
    .map(sanitizeStoryboard)
    .filter((board) => board && !board.deleted)
    .map(({ id, updatedAt }) => ({ id, updatedAt }));
}

/** Board ids — live only by default, or all (incl. tombstones) for the sweep. */
export async function listStoryboardIdsForSync({ includeDeleted = false } = {}) {
  return includeDeleted ? listIds() : listLiveIds();
}

/**
 * Merge boards received from a peer: sanitize, then whole-record LWW on
 * `updatedAt`, serialized per id against the REST writers. Journals the local
 * version a remote win is about to overwrite and re-stamps the conflict-journal
 * base hash for the record it wrote.
 */
export async function mergeStoryboardsFromSync(remoteRecords, { source = { via: 'sync', peerId: null } } = {}) {
  if (!Array.isArray(remoteRecords)) return { applied: false, count: 0 };
  const byId = new Map();
  for (const raw of remoteRecords) {
    const remote = sanitizeStoryboard(raw);
    if (remote && !byId.has(remote.id)) byId.set(remote.id, remote);
  }
  let changed = 0;
  for (const remote of byId.values()) {
    const applied = await queueStoryboardWrite(remote.id, async () => {
      const local = sanitizeStoryboard(await readRaw(remote.id));
      if (local && !compareNewerWins(remote.updatedAt, local.updatedAt)) return false;
      // Re-receiving a tombstone already held would restart its GC grace period.
      if (local?.deleted === true && remote.deleted === true) return false;
      if (local) {
        await maybeJournalBeforeOverwrite({ kind: STORYBOARD_KIND, id: remote.id, local, remote, source });
      }
      await writeRaw(remote.id, remote);
      await setSyncBaseHash(STORYBOARD_KIND, remote.id, contentHashForRecord(STORYBOARD_KIND, remote));
      return true;
    });
    if (applied) changed += 1;
  }
  await flushBaseHashes();
  if (changed > 0) console.log(`🎬 Storyboard sync: merged ${changed} board(s)`);
  return { applied: changed > 0, count: changed };
}

/** Hard-prune tombstones deleted before the absolute epoch-ms `cutoffEpochMs`. */
export async function pruneTombstonedStoryboards(cutoffEpochMs) {
  if (!Number.isFinite(cutoffEpochMs)) return { pruned: 0 };
  const candidateIds = await listTombstoneIdsBefore(cutoffEpochMs);
  let pruned = 0;
  await withBaseHashFlushBatch(async () => {
    for (const id of candidateIds) {
      // Re-check inside the per-id queue: a merge that rewrote the tombstone
      // with a fresher deletedAt restarted its grace period.
      const removed = await queueStoryboardWrite(id, async () => {
        const current = sanitizeStoryboard(await readRaw(id));
        const deletedAtMs = Date.parse(current?.deletedAt || '');
        if (!current?.deleted || !Number.isFinite(deletedAtMs) || deletedAtMs >= cutoffEpochMs) return false;
        await deleteRaw(id);
        await deleteSyncBaseHash(STORYBOARD_KIND, id);
        return true;
      });
      if (removed) pruned += 1;
    }
  });
  if (pruned > 0) console.log(`🎬 Storyboard tombstone GC: pruned ${pruned} board(s)`);
  return { pruned };
}

/**
 * Restore a board from a conflict-journal snapshot: overlay the authored
 * fields, un-tombstone, and bump `updatedAt` so the restore wins the next LWW
 * and re-pushes. Null when the board was already hard-pruned.
 */
export async function restoreStoryboard(id, patch = {}) {
  if (!isValidStoryboardId(id)) return null;
  const restored = await queueStoryboardWrite(id, async () => {
    const current = sanitizeStoryboard(await readRaw(id));
    if (!current) return null;
    const overlay = Object.fromEntries(RESTORABLE_FIELDS.filter((key) => key in patch).map((key) => [key, patch[key]]));
    const next = sanitizeStoryboard({
      ...current, ...overlay, deleted: false, deletedAt: null, updatedAt: new Date().toISOString(),
    });
    await writeRaw(id, next);
    return next;
  });
  if (restored) emitRecordUpdated(STORYBOARD_KIND, id);
  return restored;
}
