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
import { loadHistory, mutateVideoHistory, HISTORY_UNCHANGED } from './videoGen/history.js';
import { readImageSidecar } from './imageGen/sidecarStore.js';
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

async function restoredVideos(local) {
  const tombstones = await listMediaTombstones('video');
  if (tombstones.length === 0) return [];
  const rows = new Map((await loadHistory()).filter((r) => typeof r?.id === 'string').map((r) => [r.id, r]));
  const restored = [];
  for (const tombstone of tombstones) {
    const row = rows.get(tombstone.key);
    if (!row || !(await reappearedAfter(safeUnder(PATHS.videos, row.filename), tombstone.deletedAt))) continue;
    if (row.originInstanceId !== local) keptLog('video', row.id, row.originInstanceId);
    else restored.push(tombstone);
  }
  if (restored.length === 0) return [];

  const restoredAt = new Map(restored.map((t) => [t.key, supersedingTimestamp(t.deletedAt)]));
  const stamped = [];
  await mutateVideoHistory((history) => {
    for (const row of history) {
      if (!restoredAt.has(row?.id)) continue;
      row.restoredAt = restoredAt.get(row.id);
      stamped.push(row);
    }
    return stamped.length > 0 ? history : HISTORY_UNCHANGED;
  });
  const cleared = [];
  for (const row of stamped) {
    const tombstone = restored.find((t) => t.key === row.id);
    if (await clearMediaTombstone('video', row.id, { deletedAt: tombstone.deletedAt })) cleared.push({ ...row });
  }
  return cleared;
}

async function restoredImages(local) {
  const cleared = [];
  for (const tombstone of await listMediaTombstones('image')) {
    if (!isSafeFilename(tombstone.key, ['.png'])) continue;
    if (!(await reappearedAfter(join(PATHS.images, tombstone.key), tombstone.deletedAt))) continue;
    const { metadata } = await readImageSidecar(tombstone.key);
    if (metadata?.originInstanceId !== local) {
      keptLog('image', tombstone.key, metadata?.originInstanceId);
      continue;
    }
    if (await clearMediaTombstone('image', tombstone.key, { deletedAt: tombstone.deletedAt })) cleared.push(tombstone.key);
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
    if (videos.length > 0) announceLocalVideoRows(videos, local);
    if (images.length > 0) emitMediaHistoryChanged({ kind: 'image', op: 'upsert', ids: images });
    for (const row of videos) console.log(`♻️ Restored video ${row.id}: delete record cleared`);
    for (const key of images) console.log(`♻️ Restored image ${key}: delete record cleared`);
    return { videos: videos.map((r) => r.id), images };
  });
  tail = run.then(() => {}, () => {});
  return run;
}
