/**
 * Overnight local clip batches (#15498): the director picks shots and local
 * reference-conditioned models, and each shot × model is queued as the same
 * request its Shot card's Render sends, held by the media queue's run window
 * (`params.schedule`) until the start time. Finished clips attach as takes
 * through the normal scene-video hook, which never replaces a selected clip.
 * A batch is just its jobs, tagged `musicVideo.batchId`; there is no separate record.
 */
import { basename } from 'path';
import { authoredShotPrompt } from '../../lib/musicVideoShotPrompt.js';
import { ltxReferenceFrames, sceneRenderShot } from '../../lib/musicVideoShotTiming.js';
import { preMusicClipSound } from '../../lib/musicVideoColdOpen.js';
import { resolveGalleryImage } from '../../lib/pathSafety.js';

/** Which overnight lane a local model renders on, or null when it takes no clip references. */
export function overnightModelKind(model) {
  if (model?.runtime === 'ltx25') return 'ltxReferences';
  if (model?.fastvideoFamily === 'fasth3omni') return 'omni';
  return null;
}

/**
 * The Render request bodies for each shot × model, before route validation,
 * plus the pairs that cannot render and why. `clipReferences(tag, limit, opts)`
 * resolves a shot's clip references as the submission guards will.
 */
export async function overnightRenderBodies({ project, sceneIds, models, schedule, batchId, clipReferences }) {
  const bodies = [];
  const skipped = [];
  const skip = (sceneId, modelId, reason) => skipped.push({ sceneId, modelId, reason });
  for (const sceneId of sceneIds) {
    const scene = project.scenes?.find((entry) => entry.sceneId === sceneId);
    if (!scene) { skip(sceneId, null, 'The shot no longer exists.'); continue; }
    if (!scene.referenceImageId) { skip(sceneId, null, 'The shot has no start frame.'); continue; }
    if (sceneRenderShot(scene) !== 'cutaway') { skip(sceneId, null, 'Performance shots render on their song lanes.'); continue; }
    const prompt = authoredShotPrompt(scene);
    if (!prompt) { skip(sceneId, null, 'The shot has no clip prompt.'); continue; }
    const tag = {
      projectId: project.id, sceneId, compose: true, promptAsTyped: true, expectedShot: 'cutaway', songAudio: false, batchId,
      ...(project.castAndSets?.catalogCheckin?.basis ? { catalogBasis: project.castAndSets.catalogCheckin.basis } : {}),
    };
    for (const model of models) {
      const common = { prompt, backend: 'local', modelId: model.id, sourceImageFile: scene.referenceImageId,
        disableAudio: !preMusicClipSound(scene), schedule };
      if (overnightModelKind(model) === 'ltxReferences') {
        const numFrames = ltxReferenceFrames(scene);
        if (!numFrames) { skip(sceneId, model.id, 'The shot is too long for one LTX reference clip.'); continue; }
        const refs = await clipReferences(tag, 8, { project, excludePath: resolveGalleryImage(scene.referenceImageId) });
        if (!refs.length) { skip(sceneId, model.id, 'The shot has no clip references.'); continue; }
        bodies.push({ sceneId, modelId: model.id, body: { ...common, mode: 'ic-ingredients-25', numFrames,
          icReferenceImageFiles: refs.map((ref) => basename(ref.path)), musicVideo: tag } });
      } else {
        bodies.push({ sceneId, modelId: model.id, body: { ...common, mode: 'image', musicVideo: tag } });
      }
    }
  }
  return { bodies, skipped };
}

/** One batch's jobs for its summary, newest batch first. */
export function overnightBatches(jobs, projectId) {
  const batches = new Map();
  for (const job of jobs) {
    const tag = job.params?.musicVideo;
    if (!tag?.batchId || tag.projectId !== projectId) continue;
    const batch = batches.get(tag.batchId) || { batchId: tag.batchId, queuedAt: job.queuedAt, schedule: job.params.schedule || null, jobs: [] };
    if (job.queuedAt && (!batch.queuedAt || job.queuedAt < batch.queuedAt)) batch.queuedAt = job.queuedAt;
    batch.jobs.push({
      jobId: job.id, sceneId: tag.sceneId, modelId: job.params.modelId || null, status: job.status,
      ...(job.statusMsg ? { statusMsg: job.statusMsg } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(job.status === 'completed' ? { videoHistoryId: job.result?.generationId || job.id } : {}),
    });
    batches.set(tag.batchId, batch);
  }
  return [...batches.values()].sort((a, b) => String(b.queuedAt).localeCompare(String(a.queuedAt)));
}
