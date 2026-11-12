import { prepareBoardRenderParams } from './renderItem.js';
import { attachBoardPoster } from './db.js';
import { emitRecordUpdated } from '../sharing/recordEvents.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';

export const preparePoster = (render) => prepareBoardRenderParams(render);

// Completion stays server-side: closing the board does not abandon its poster.
export async function completePoster(boardId, style, render, onQueued) {
  const { enqueueJob, getJob, mediaJobEvents } = await import('../mediaJobQueue/index.js');
  const params = await prepareBoardRenderParams(render, {
    prompt: style.prompt,
    negativePrompt: style.negativePrompt || undefined,
    width: 1536,
    height: 1024,
  });
  const { jobId } = await enqueueJob({ kind: 'image', params, owner: `mood-board-poster:${boardId}` });
  if (!jobId) throw new Error('The board image was not queued');
  onQueued(jobId);
  const finished = await new Promise((resolve, reject) => {
    const statuses = ['completed', 'failed', 'canceled'];
    const settle = (job) => {
      if (job?.id !== jobId || !statuses.includes(job.status)) return;
      for (const status of statuses) mediaJobEvents.off(status, settle);
      if (job.status === 'completed' && job.result?.filename) resolve(job);
      else reject(new Error(job.error || 'Board image generation failed or was canceled. Retry Make complete.'));
    };
    for (const status of statuses) mediaJobEvents.on(status, settle);
    // A fast renderer can finish between enqueue and listener registration.
    settle(getJob(jobId));
  });
  await withBackupAssetPublication(async () => {
    await attachBoardPoster(boardId, style, finished.result.filename);
    emitRecordUpdated('moodBoard', boardId);
  });
}
