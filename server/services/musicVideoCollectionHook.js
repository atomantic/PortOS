/**
 * Music Video collection hook: every image and clip rendered for a music video
 * lands in that video's media collection (`mvc-<projectId>`), not only the
 * ones a shot keeps as a take. A shot's render files through its take
 * (projects.js appendSceneTakes); this hook also covers renders with no shot:
 * Cast & Sets images, cover art, and Image Gen / Video Gen requests that name
 * the video with `musicVideoProjectId` (the forms send it when opened from a
 * music video's clip, and agents pass it for tests, sheets and alternates).
 * Filing is idempotent, so a shot render filed by both paths lands once.
 *
 * Best-effort bookkeeping: a failure is logged, never thrown. Mounted once at
 * server boot; it only listens.
 */

import { basename } from 'path';
import { mediaJobEvents } from './mediaJobQueue/index.js';
import { withBackupAssetPublication } from '../lib/backupSnapshotBoundary.js';
import { createKeyCachedQueue } from '../lib/createKeyCachedQueue.js';
import { storyboardFirstFrameFile } from '../lib/storyboardGuidance.js';

/** The project and asset a completed job files, or null when it names no music video. */
function musicVideoCollectionTarget(job) {
  if (job?.kind !== 'image' && job?.kind !== 'video') return null;
  const params = job.params || {};
  const projectId = params.musicVideoProjectId || params.musicVideo?.projectId;
  if (typeof projectId !== 'string' || !projectId) return null;
  const ref = job.kind === 'image' ? job.result?.filename : (job.result?.generationId || job.id);
  if (typeof ref !== 'string' || !ref) return null;
  const sceneId = params.musicVideo?.sceneId || null;
  // A clip from a storyboard panel files the first frame it built too (videoGen/grok.js).
  const firstFrame = job.kind === 'video' ? storyboardFirstFrameFile(job.result) : null;
  const sourceImageId = firstFrame || (job.kind === 'video' && typeof params.sourceImagePath === 'string' ? basename(params.sourceImagePath) : null);
  return {
    projectId,
    assets: [
      ...(firstFrame ? [{ kind: 'image', ref: firstFrame, sceneId, take: null }] : []),
      { kind: job.kind, ref, sceneId, take: sourceImageId ? { sourceImageId } : null },
    ],
  };
}

/** File assets into a project's collection by id; a project that is gone files nothing. */
export async function fileIntoMusicVideoCollection(projectId, assets) {
  const [{ getProject }, { fileMusicVideoMedia }] = await Promise.all([
    import('./musicVideo/projects.js'), import('./musicVideo/mediaPool.js'),
  ]);
  const project = await getProject(projectId).catch(() => null);
  if (!project) return false;
  await fileMusicVideoMedia(project, assets);
  return true;
}

const serialize = createKeyCachedQueue();
const inFlight = new Set();
let completedHandler = null;

export function initMusicVideoCollectionHook() {
  if (completedHandler) return;
  completedHandler = (job) => {
    const target = musicVideoCollectionTarget(job);
    if (!target) return;
    const handled = withBackupAssetPublication(() => serialize(target.projectId,
      () => fileIntoMusicVideoCollection(target.projectId, target.assets)))
      .catch((err) => console.error(`❌ music-video collection hook failed for ${target.projectId}: ${err?.message || err}`));
    inFlight.add(handled);
    handled.finally(() => inFlight.delete(handled));
  };
  mediaJobEvents.on('completed', completedHandler);
  console.log('🗂️ Music Video collection hook initialized');
}

export const __testing = {
  reset() {
    if (completedHandler) mediaJobEvents.off('completed', completedHandler);
    completedHandler = null;
    serialize.clear();
  },
  async drain() {
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  },
};
