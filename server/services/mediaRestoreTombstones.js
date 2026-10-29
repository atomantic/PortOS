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
 * video row is stamped `restoredAt` past the delete, so a peer still holding
 * the tombstone admits it (videoRowLiveStamp) and drops its copy of the tombstone.
 */
import { stat } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { safeUnder } from '../lib/ffmpeg.js';
import { isSafeFilename } from '../lib/pathSafety.js';
import { parseTsMs } from '../lib/lwwTimestamp.js';
import { supersedingTimestamp } from '../lib/tombstones.js';
import { listMediaTombstones, clearMediaTombstone } from './mediaTombstones.js';
import { mutateVideoHistory, HISTORY_UNCHANGED } from './videoGen/history.js';
import { readImageSidecar, sidecarEditQueue } from './imageGen/sidecarStore.js';
import { announceLocalVideoRows, emitMediaHistoryChanged } from './peerSyncEventBus.js';

async function localInstanceId() {
  const identity = await import('./instanceIdentity.js');
  const id = await identity.getInstanceId().catch(() => null);
  return typeof id === 'string' && id && id !== identity.UNKNOWN_INSTANCE_ID ? id : null;
}

// True when `path` exists and changed status after the delete was recorded.
async function reappearedAfter(path, deletedAt) {
  if (!path) return false;
  const info = await stat(path).catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  const deletedMs = parseTsMs(deletedAt);
  return Boolean(info?.isFile() && deletedMs !== null && info.ctimeMs > deletedMs);
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
      // the same reason the video check runs inside the history writer.
      const restored = await sidecarEditQueue(key, async () => {
        const tombstone = (await listMediaTombstones('image')).find((t) => t.key === key);
        if (!tombstone || !(await reappearedAfter(join(PATHS.images, key), tombstone.deletedAt))) return false;
        const { metadata } = await readImageSidecar(key);
        if (metadata?.originInstanceId !== local) {
          keptLog('image', key, metadata?.originInstanceId);
          return false;
        }
        return clearMediaTombstone('image', key, { deletedAt: tombstone.deletedAt });
      });
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
 * Clear the tombstone of every locally owned video row and gallery image that
 * came back after its delete, and announce the restored rows to peers.
 * Serialized: the backup restore and the boot reconcile may overlap.
 * Resolves `{ videos, images }`, the restored keys.
 */
export function clearRestoredMediaTombstones() {
  const run = tail.then(async () => {
    const local = await localInstanceId();
    if (!local) return { videos: [], images: [] };
    const videos = await restoredVideos(local);
    const images = await restoredImages(local);
    return { videos, images };
  });
  tail = run.then(() => {}, () => {});
  return run;
}
