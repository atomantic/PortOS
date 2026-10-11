/**
 * Music Video style-break end frames (#11173).
 *
 * A scene may carry an optional end frame (`scene.endImageId`, the selected
 * `endImage` take): a stylized still the clip moves into from its photographic
 * start frame, such as a pencil-sketch or magazine-cutout version. Only fal
 * models whose catalog entry takes an end image can honour it. Every other lane
 * ignores it, and this module says why, so the board and the production
 * dispatcher make the same call.
 */
import { FAL_DEFAULT_IMAGE_VIDEO_MODEL, getFalVideoModel } from './falVideoModels.js';
import { isPerformanceScene } from './musicVideoShotTiming.js';

const endImageOf = (scene) => (typeof scene?.endImageId === 'string' && scene.endImageId.trim() ? scene.endImageId : null);

/**
 * Whether a clip for `scene` on `backend` (with `falModelId` for fal, and the
 * request's video `mode`, image-to-video by default) sends the scene's end
 * frame. Returns `{ endImageId, used, reason }`: `reason` names why a selected
 * end frame is ignored, and is null when it is used or absent.
 */
export function sceneEndFramePlan(scene, { backend = null, falModelId = null, mode = 'image' } = {}) {
  const endImageId = endImageOf(scene);
  if (!endImageId) return { endImageId: null, used: false, reason: null };
  const ignored = (reason) => ({ endImageId, used: false, reason });
  if (isPerformanceScene(scene)) return ignored('A performance shot follows the song and takes no end frame');
  if (mode !== 'image') return ignored('A song-driven clip takes no end frame');
  if (backend !== 'fal') return ignored('Only fal.ai models that take an end frame use it; this renderer ignores it');
  const model = getFalVideoModel(falModelId || FAL_DEFAULT_IMAGE_VIDEO_MODEL);
  if (!model?.endImage) return ignored(`${model?.label || 'This fal.ai model'} takes no end frame; choose one that does`);
  return { endImageId, used: true, reason: null };
}

/** The `/api/video-gen` field that carries the end frame, or nothing. */
export const sceneEndFrameRequestFields = (scene, options) => {
  const plan = sceneEndFramePlan(scene, options);
  return plan.used ? { lastImageFile: plan.endImageId } : {};
};
