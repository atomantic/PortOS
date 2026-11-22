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
  RESTORABLE_FIELDS,
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

export async function listStoryboardsForIntegrity() {
  return (await listRaw()).map(sanitizeStoryboard).filter(Boolean);
}

/** Board ids — live only by default, or all (incl. tombstones) for the sweep. */
export async function listStoryboardIdsForSync({ includeDeleted = false } = {}) {
  return includeDeleted ? listIds() : listLiveIds();
}

// Per key a sender may omit, the storyboards wire version from which an
// omission means "cleared". `ALWAYS` keys are ones the current sanitizer always
// writes (a current peer clears with null), so absence only ever means the
// sender's sanitizer predates the field; `beforeSong` and `linkMedia` are also
// omitted when cleared, so only a sender below the version that added them
// omits them for lack of them.
const ALWAYS = Number.POSITIVE_INFINITY;
const BOARD_KEPT_WHEN_OMITTED = { plot: ALWAYS, plotLlm: ALWAYS, tempTrack: ALWAYS, source: ALWAYS };
const BEAT_KEPT_WHEN_OMITTED = { pin: ALWAYS, beforeSong: 12 };
const PANEL_KEPT_WHEN_OMITTED = {
  facing: ALWAYS, composition: ALWAYS, move: ALWAYS, lens: ALWAYS, focus: ALWAYS, eyeline: ALWAYS,
  setShot: ALWAYS, sourceSceneId: ALWAYS, sourceShotId: ALWAYS, sourceRev: ALWAYS, linkMedia: 15,
};

const isPlainRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const entriesById = (items) => new Map((Array.isArray(items) ? items : [])
  .filter((item) => isPlainRecord(item) && typeof item.id === 'string')
  .map((item) => [item.id, item]));

/**
 * The remote board that won LWW, with the local values of fields its sender
 * could not represent put back (`raw` is the board as received, before the
 * sanitizer filled every omitted key with an empty). Beats and panels match by
 * id; one the remote dropped stays dropped. Re-sanitizing re-applies the
 * cross-field rules, so a restored pick, set camera or pin survives only while
 * the remote still links its record, place or marker.
 */
function keepFieldsSenderOmitted(remote, raw, local, senderVersion) {
  let restored = false;
  const restore = (target, rawEntry, localEntry, keptWhenOmitted) => {
    for (const [key, clearsFrom] of Object.entries(keptWhenOmitted)) {
      if (senderVersion < clearsFrom && !Object.hasOwn(rawEntry, key) && Object.hasOwn(localEntry, key)) {
        target[key] = localEntry[key];
        restored = true;
      }
    }
  };
  const next = { ...remote };
  restore(next, raw, local, BOARD_KEPT_WHEN_OMITTED);
  const rawBeats = entriesById(raw.beats);
  const localBeats = entriesById(local.beats);
  const rawPanels = entriesById([...rawBeats.values()].flatMap((beat) => (Array.isArray(beat.panels) ? beat.panels : [])));
  const localPanels = entriesById(local.beats.flatMap((beat) => beat.panels));
  next.beats = remote.beats.map((beat) => {
    const out = { ...beat };
    const rawBeat = rawBeats.get(beat.id);
    const localBeat = localBeats.get(beat.id);
    if (rawBeat && localBeat) restore(out, rawBeat, localBeat, BEAT_KEPT_WHEN_OMITTED);
    out.panels = beat.panels.map((panel) => {
      const rawPanel = rawPanels.get(panel.id);
      const localPanel = localPanels.get(panel.id);
      if (!rawPanel || !localPanel) return panel;
      const kept = { ...panel };
      restore(kept, rawPanel, localPanel, PANEL_KEPT_WHEN_OMITTED);
      return kept;
    });
    return out;
  });
  return restored ? sanitizeStoryboard(next) : remote;
}

/**
 * Merge boards received from a peer: sanitize, then whole-record LWW on
 * `updatedAt`, serialized per id against the REST writers. A live remote win
 * over a live local board keeps the fields an older sender's sanitizer could
 * not emit (`keepFieldsSenderOmitted`). Journals the local version a remote
 * win is about to overwrite and re-stamps the conflict-journal base hash for
 * the record it wrote.
 */
export async function mergeStoryboardsFromSync(remoteRecords, { source = { via: 'sync', peerId: null }, senderSchemaVersions = null } = {}) {
  if (!Array.isArray(remoteRecords)) return { applied: false, count: 0 };
  const senderVersion = Number(senderSchemaVersions?.storyboards) || 0;
  const byId = new Map();
  for (const raw of remoteRecords) {
    const remote = sanitizeStoryboard(raw);
    if (remote && !byId.has(remote.id)) byId.set(remote.id, { remote, raw });
  }
  let changed = 0;
  for (const { remote: sanitized, raw } of byId.values()) {
    const applied = await queueStoryboardWrite(sanitized.id, async () => {
      const local = sanitizeStoryboard(await readRaw(sanitized.id));
      if (local && !compareNewerWins(sanitized.updatedAt, local.updatedAt)) return false;
      // Re-receiving a tombstone already held would restart its GC grace period.
      if (local?.deleted === true && sanitized.deleted === true) return false;
      const remote = local && !local.deleted && !sanitized.deleted
        ? keepFieldsSenderOmitted(sanitized, raw, local, senderVersion)
        : sanitized;
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
    const overlay = Object.fromEntries(RESTORABLE_FIELDS[STORYBOARD_KIND].filter((key) => key in patch).map((key) => [key, patch[key]]));
    const next = sanitizeStoryboard({
      ...current, ...overlay, deleted: false, deletedAt: null, updatedAt: new Date().toISOString(),
    });
    await writeRaw(id, next);
    return next;
  });
  if (restored) emitRecordUpdated(STORYBOARD_KIND, id);
  return restored;
}
