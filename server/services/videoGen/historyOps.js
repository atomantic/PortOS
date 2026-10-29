/** User-facing video-history mutations. */

import { trashFiles } from '../../lib/trashFiles.js';
import { PATHS, atomicWrite } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { safeUnder } from '../../lib/ffmpeg.js';
import { mutateVideoHistory, HISTORY_UNCHANGED } from './history.js';
import { extendMasterPath } from './extendMaster.js';
import { beginMediaTombstone, commitLocalDeleteTombstone, clearMediaTombstone } from '../mediaTombstones.js';

export async function updateHistoryItemPrompt(id, prompt) {
  let result;
  await mutateVideoHistory((history) => {
    const item = history.find((h) => h.id === id);
    if (!item) throw new ServerError('Not found', { status: 404, code: 'NOT_FOUND' });
    const trimmedPrompt = typeof prompt === 'string' ? prompt.trim() : '';
    if (trimmedPrompt) item.prompt = trimmedPrompt;
    else delete item.prompt;
    // The trigger-weave provenance (#4665) describes the prompt this render was
    // MADE with, so it can't survive an edit to that prompt — leaving it would
    // have the row claim a `renderPrompt` derived from text that is no longer
    // there, and name tokens as "added" to a prompt they were never added to.
    delete item.renderPrompt;
    delete item.addedTriggerWords;
    result = { id, prompt: trimmedPrompt };
    return history;
  });
  return result;
}

export async function setHistoryItemHidden(id, hidden) {
  let result;
  // Serialized find-and-set through the shared tail; a 404 throw inside the
  // mutator rejects before any save, preserving the not-found semantics.
  await mutateVideoHistory((history) => {
    const item = history.find((h) => h.id === id);
    if (!item) throw new ServerError('Not found', { status: 404, code: 'NOT_FOUND' });
    item.hidden = !!hidden;
    result = { ok: true, hidden: item.hidden };
    return history;
  });
  return result;
}

// `fromRemoteTombstone`: the delete originated from a peer's tombstone, which the
// caller already merged — so don't re-record it (that would restamp deletedAt
// and ping-pong) or re-announce it.
// `onlyIf(row)` re-checks the row inside the history writer: a remote tombstone
// must not retire a replacement written after the caller's own read.
export async function deleteHistoryItem(id, { forgetInMusicVideos = true, fromRemoteTombstone = false, onlyIf = null } = {}) {
  // One lease covers the history read, file removals, history rewrite, and
  // derived row removal; per-file admission would leave gaps between stores.
  return withBackupAssetPublication(async () => {
    let item;
    let tombstone = null;
    let skipped = false;
    // Hold the history writer across its recovery snapshot and the file move,
    // so overlapping prompt edits/deletes cannot retire a different revision.
    await mutateVideoHistory(async history => {
      item = history.find((entry) => entry.id === id);
      if (!item) throw new ServerError('Not found', { status: 404, code: 'NOT_FOUND' });
      if (onlyIf && !onlyIf(item)) {
        skipped = true;
        return HISTORY_UNCHANGED;
      }
      const videoFile = safeUnder(PATHS.videos, item.filename);
      if (!videoFile) throw new ServerError('Invalid video filename', { status: 400, code: 'INVALID_VIDEO_PATH' });
      // The shared history file stays in place; recycle a per-video copy of
      // this record alongside its bytes so prompts/settings remain recoverable.
      const metadataFile = `${videoFile}.metadata.json`;
      await atomicWrite(metadataFile, item);
      const files = [videoFile, metadataFile, extendMasterPath(videoFile)];
      if (item.thumbnail) files.push(safeUnder(PATHS.videoThumbnails, item.thumbnail));
      // Evaluation frames are derived; include all supported frame slots.
      for (let i = 1; i <= 9; i++) files.push(safeUnder(PATHS.videoThumbnails, `${id}-f${i}.jpg`));
      // Record BEFORE trashing: a crash between the two must never leave a
      // deleted row without its tombstone. It stays in flight (unexported)
      // until the trash commits, and is withdrawn if the trash fails (#14088).
      if (!fromRemoteTombstone) tombstone = await beginMediaTombstone('video', id);
      try {
        await trashFiles(files);
      } catch (err) {
        if (tombstone) await clearMediaTombstone('video', id, { deletedAt: tombstone.deletedAt });
        throw err;
      }
      if (tombstone) await commitLocalDeleteTombstone('video', tombstone);
      return history.filter(entry => entry.id !== id);
    });
    if (skipped) return { ok: false, skipped: true };
    // Drop the derived index row with the entry (#2738) — keyed by job id, the
    // ref the index wrote it under. Non-fatal + dynamically imported; see the
    // matching hook in imageGen/local.js#deleteImage for the rationale.
    await import('../mediaAssetIndex/index.js')
      .then((m) => m.unindexVideo(id))
      .catch((err) => console.error(`❌ Media index video delete hook: ${err.message}`));
    // Music videos forget it too (their unused takes, marks and collection rows);
    // a batch delete from a video's asset manager forgets its whole batch at once.
    // Non-fatal like the index hook: the delete is committed and must still be announced.
    if (forgetInMusicVideos) {
      await import('../musicVideo/mediaPool.js')
        .then((m) => m.forgetDeletedMusicVideoAssets([`video:${id}`]))
        .catch((err) => console.error(`❌ Music video forget after video delete failed: ${err.message}`));
    }
    console.log(`🗑️ Trashed video: ${item.filename}`);
    // Announce only the owner's own delete: a remote-tombstone delete was
    // already announced by the peer that recorded it.
    void import('../peerSyncEventBus.js')
      .then(async (m) => {
        m.emitMediaHistoryChanged({ kind: 'video', op: 'delete', ids: [id] });
        if (!fromRemoteTombstone) await m.announceLocalVideoDelete(item, tombstone);
      })
      .catch((err) => console.error(`❌ Video delete announce failed: ${err.message}`));
    return { ok: true };
  });
}
