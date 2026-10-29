/**
 * Retire the delete record of a video or gallery image the user brought back.
 *
 * A delete records a media tombstone and trashes the files. Two paths restore
 * them with no PortOS delete-undo: a backup folder restore (backup.js
 * reconcileLiveFileRestore) and the OS Trash's Put Back (noticed at the next
 * boot reconcile; there is no filesystem watcher). Left alone, the tombstone
 * keeps a locally owned item invisible to peers and keeps advertising its delete.
 *
 * An item counts as restored when it is present again (a video: its history row
 * and its file; an image: its file) and its file's status-change time (ctime,
 * which a restore's write or a Put Back's move sets) is later than the delete.
 * The ctime check also keeps an in-flight delete, whose tombstone is recorded
 * just before its files move, from being mistaken for a restore.
 *
 * Only an item this machine owns (`originInstanceId`) is un-deleted here; a
 * peer-owned one keeps its tombstone and follows its owner's delete. A restored
 * video row or image sidecar is stamped `restoredAt` past the delete, so a peer
 * still holding the tombstone admits it (videoRowLiveStamp, imageLiveStamp) and
 * drops its copy of the tombstone.
 *
 * The image stamp is a sidecar write, which takes the backup asset-publication
 * lease, so a backup restore (which holds the snapshot cut while it reconciles)
 * defers images to a second pass after it releases its owners.
 *
 * The same pass first settles a delete a crash left in flight (its tombstone
 * recorded but never committed or withdrawn, mediaTombstones.js): the file
 * still present means the trash never happened, so the tombstone is withdrawn;
 * the file gone means it did, so the tombstone commits and starts travelling.
 */
import { stat } from 'fs/promises';
import { join } from 'path';
import { PATHS, atomicWrite } from '../lib/fileUtils.js';
import { withBackupAssetPublication } from '../lib/backupSnapshotBoundary.js';
import { safeUnder } from '../lib/ffmpeg.js';
import { isSafeFilename } from '../lib/pathSafety.js';
import { parseTsMs } from '../lib/lwwTimestamp.js';
import { supersedingTimestamp } from '../lib/tombstones.js';
import {
  listMediaTombstones,
  listInFlightMediaTombstones,
  commitMediaTombstone,
  clearMediaTombstone,
} from './mediaTombstones.js';
import { mutateVideoHistory, HISTORY_UNCHANGED } from './videoGen/history.js';
import { readImageSidecar, sidecarEditQueue } from './imageGen/sidecarStore.js';
import { announceLocalVideoRows, emitMediaHistoryChanged } from './peerSyncEventBus.js';

async function localInstanceId() {
  const identity = await import('./instanceIdentity.js');
  const id = await identity.getInstanceId().catch(() => null);
  return typeof id === 'string' && id && id !== identity.UNKNOWN_INSTANCE_ID ? id : null;
}

// The file's stat, or null when it is absent (or the path was refused).
async function fileStat(path) {
  if (!path) return null;
  const info = await stat(path).catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  return info?.isFile() ? info : null;
}

// True when `path` exists and changed status after the delete was recorded.
async function reappearedAfter(path, deletedAt) {
  const info = await fileStat(path);
  const deletedMs = parseTsMs(deletedAt);
  return Boolean(info && deletedMs !== null && info.ctimeMs > deletedMs);
}

async function settleInFlight(kind, tombstone, filePresent) {
  if (filePresent) {
    await clearMediaTombstone(kind, tombstone.key, { deletedAt: tombstone.deletedAt });
    console.log(`♻️ Interrupted ${kind} delete of ${tombstone.key} never trashed its file: delete record withdrawn`);
  } else {
    await commitMediaTombstone(kind, tombstone);
    console.log(`🗑️ Interrupted ${kind} delete of ${tombstone.key} had trashed its file: delete record committed`);
  }
}

// Each check runs under the lock its delete holds from recording the tombstone
// to settling it (the history writer, the per-image sidecar queue), so a marker
// seen there belongs to an interrupted delete, never to one still running.
async function resolveInFlightVideos() {
  if ((await listInFlightMediaTombstones('video')).length === 0) return;
  await mutateVideoHistory(async (history) => {
    for (const tombstone of await listInFlightMediaTombstones('video')) {
      const row = history.find((r) => r?.id === tombstone.key);
      await settleInFlight('video', tombstone, Boolean(row && await fileStat(safeUnder(PATHS.videos, row.filename))));
    }
    return HISTORY_UNCHANGED;
  });
}

async function resolveInFlightImages() {
  for (const { key } of await listInFlightMediaTombstones('image')) {
    await sidecarEditQueue(key, async () => {
      const tombstone = (await listInFlightMediaTombstones('image')).find((t) => t.key === key);
      if (!tombstone) return;
      const present = isSafeFilename(key, ['.png']) && Boolean(await fileStat(join(PATHS.images, key)));
      await settleInFlight('image', tombstone, present);
    });
  }
}

const keptLog = (kind, key, origin) => console.log(
  `⏭️ Restored ${kind} ${key} keeps its delete record: owned by ${origin || 'an unknown machine'}, so it follows the owner's delete`,
);

// Classified inside the history writer: deleteHistoryItem records its
// tombstone and trashes the files in one writer turn, so no delete is ever
// caught between the two here (ctime alone cannot tell that state apart).
async function restoredVideos(local) {
  if ((await listMediaTombstones('video')).length === 0) return [];
  const restored = [];
  const stamped = [];
  await mutateVideoHistory(async (history) => {
    const tombstones = new Map((await listMediaTombstones('video')).map((t) => [t.key, t]));
    for (const row of history) {
      const tombstone = tombstones.get(row?.id);
      if (!tombstone || !(await reappearedAfter(safeUnder(PATHS.videos, row.filename), tombstone.deletedAt))) continue;
      if (row.originInstanceId !== local) {
        keptLog('video', row.id, row.originInstanceId);
        continue;
      }
      row.restoredAt = supersedingTimestamp(tombstone.deletedAt);
      restored.push(tombstone);
      stamped.push(row);
    }
    return stamped.length > 0 ? history : HISTORY_UNCHANGED;
  });
  // Announced as each clears: a later failure must not strand a row whose
  // tombstone is already gone, since no later pass would find it again.
  const cleared = [];
  try {
    for (const row of stamped) {
      const tombstone = restored.find((t) => t.key === row.id);
      if (await clearMediaTombstone('video', row.id, { deletedAt: tombstone.deletedAt })) cleared.push({ ...row });
    }
  } finally {
    if (cleared.length > 0) announceLocalVideoRows(cleared, local);
    for (const row of cleared) console.log(`♻️ Restored video ${row.id}: delete record cleared`);
  }
  return cleared.map((r) => r.id);
}

async function restoredImages(local) {
  const cleared = [];
  try {
    for (const { key } of await listMediaTombstones('image')) {
      if (!isSafeFilename(key, ['.png'])) continue;
      // Inside the per-image queue deleteImage records and trashes under, for
      // the same reason the video check runs inside the history writer. The
      // stamp lands before the tombstone clears: a crash in between leaves the
      // tombstone for the next pass rather than a restored image peers refuse.
      const restored = await withBackupAssetPublication(() => sidecarEditQueue(key, async () => {
        const tombstone = (await listMediaTombstones('image')).find((t) => t.key === key);
        if (!tombstone || !(await reappearedAfter(join(PATHS.images, key), tombstone.deletedAt))) return false;
        const { path, metadata } = await readImageSidecar(key);
        if (metadata?.originInstanceId !== local) {
          keptLog('image', key, metadata?.originInstanceId);
          return false;
        }
        await atomicWrite(path, { ...metadata, restoredAt: supersedingTimestamp(tombstone.deletedAt) });
        return clearMediaTombstone('image', key, { deletedAt: tombstone.deletedAt });
      }));
      if (restored) cleared.push(key);
    }
  } finally {
    if (cleared.length > 0) emitMediaHistoryChanged({ kind: 'image', op: 'upsert', ids: cleared });
    for (const key of cleared) console.log(`♻️ Restored image ${key}: delete record cleared`);
  }
  return cleared;
}

let tail = Promise.resolve();

/**
 * Settle every delete a crash left in flight, then clear the tombstone of
 * every locally owned video row and gallery image that came back after its
 * delete, and announce the restored rows to peers.
 * Serialized: the backup restore and the boot reconcile may overlap.
 * `images: false` skips the restored-image pass, for a caller holding the
 * backup snapshot cut (the image stamp would wait on that cut).
 * Resolves `{ videos, images }`, the restored keys.
 */
export function clearRestoredMediaTombstones({ images: includeImages = true } = {}) {
  const run = tail.then(async () => {
    await resolveInFlightVideos();
    await resolveInFlightImages();
    const local = await localInstanceId();
    if (!local) return { videos: [], images: [] };
    const videos = await restoredVideos(local);
    const images = includeImages ? await restoredImages(local) : [];
    return { videos, images };
  });
  tail = run.then(() => {}, () => {});
  return run;
}
