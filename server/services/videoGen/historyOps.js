/** User-facing video-history mutations. */

import { PATHS, unlinkGuarded } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { safeUnder } from '../../lib/ffmpeg.js';
import { loadHistory, mutateVideoHistory } from './history.js';

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

export async function deleteHistoryItem(id) {
  const history = await loadHistory();
  const item = history.find((h) => h.id === id);
  if (!item) throw new ServerError('Not found', { status: 404, code: 'NOT_FOUND' });
  // Same path-traversal guard as extractLastFrame — unlink only if the
  // filename resolves to inside the expected dir.
  const videoFile = safeUnder(PATHS.videos, item.filename);
  if (videoFile) await unlinkGuarded(videoFile).catch(() => {});
  if (item.thumbnail) {
    const thumbFile = safeUnder(PATHS.videoThumbnails, item.thumbnail);
    if (thumbFile) await unlinkGuarded(thumbFile).catch(() => {});
  }
  // Delete evaluation frame thumbnails written by sampleEvaluationFrames:
  // `${jobId}-f1.jpg` … `${jobId}-f9.jpg` (max count in sampleEvaluationFrames is 5,
  // but 9 is a safe upper bound to catch any future increase).
  for (let i = 1; i <= 9; i++) {
    const frameFile = safeUnder(PATHS.videoThumbnails, `${id}-f${i}.jpg`);
    if (frameFile) await unlinkGuarded(frameFile).catch(() => {});
  }
  // Serialized removal through the shared tail (re-filters the freshest list),
  // so a concurrent download/render append isn't dropped by this save.
  await mutateVideoHistory((h) => h.filter((x) => x.id !== id));
  // Drop the derived index row with the entry (#2738) — keyed by job id, the
  // ref the index wrote it under. Non-fatal + dynamically imported; see the
  // matching hook in imageGen/local.js#deleteImage for the rationale.
  await import('../mediaAssetIndex/index.js')
    .then((m) => m.unindexVideo(id))
    .catch((err) => console.error(`❌ Media index video delete hook: ${err.message}`));
  console.log(`🗑️ Deleted video: ${item.filename}`);
  return { ok: true };
}
