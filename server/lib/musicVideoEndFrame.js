/**
 * Music Video style-break end frames (#11173).
 *
 * A scene may carry an optional end frame (`scene.endImageId`, the selected
 * `endImage` take): a stylized still the clip moves into from its photographic
 * start frame, such as a pencil-sketch or magazine-cutout version. fal models
 * whose catalog entry takes an end image honour it, and so does a local model
 * whose runtime anchors the last frame of a first+last-frame render (LTX-2.x,
 * #11258). Every other lane ignores it, and this module says why, so the board
 * and the production dispatcher make the same call.
 */
import { FAL_DEFAULT_IMAGE_VIDEO_MODEL, getFalVideoModel } from './falVideoModels.js';
import { RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL, getRunwayVideoModel } from './runwayVideoModels.js';
import { isPerformanceScene } from './musicVideoShotTiming.js';
import { isLastFrameAnchoredRuntime } from './runners.js';
import { VIDEO_RUNTIME_MODES } from './videoModeProfiles.js';

// A local clip ends on the end frame through a first+last-frame render, so the
// runtime must both run that mode and anchor its last frame (MiniMax H3 ref2va
// anchors it but renders song-driven clips only).
const localRuntimeEndsOnFrame = (runtime) => isLastFrameAnchoredRuntime(runtime)
  && Boolean(VIDEO_RUNTIME_MODES[runtime]?.includes('fflf'));

const endImageOf = (scene) => (typeof scene?.endImageId === 'string' && scene.endImageId.trim() ? scene.endImageId : null);

/**
 * Whether a clip for `scene` on `backend` (with `falModelId` for fal, `runwayModelId` for Runway, the local
 * model's `localRuntime` for local, and the request's video `mode`,
 * image-to-video by default) sends the scene's end frame. Returns
 * `{ endImageId, used, reason }`: `reason` names why a selected end frame is
 * ignored, and is null when it is used or absent.
 */
export function sceneEndFramePlan(scene, { backend = null, falModelId = null, runwayModelId = null, mode = 'image', localRuntime = null } = {}) {
  const endImageId = endImageOf(scene);
  if (!endImageId) return { endImageId: null, used: false, reason: null };
  const ignored = (reason) => ({ endImageId, used: false, reason });
  if (isPerformanceScene(scene)) return ignored('A performance shot follows the song and takes no end frame');
  if (mode !== 'image') return ignored('A song-driven clip takes no end frame');
  if (backend === 'local') {
    return localRuntimeEndsOnFrame(localRuntime)
      ? { endImageId, used: true, reason: null }
      : ignored('This local model animates from the start frame only; local LTX-2.x and MiniMax H3 end on the end frame');
  }
  if (backend === 'runway') {
    const model = getRunwayVideoModel(runwayModelId || RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL);
    return model?.endImage
      ? { endImageId, used: true, reason: null }
      : ignored(`${model?.label || 'This Runway model'} takes no end frame; choose one that does`);
  }
  if (backend !== 'fal') return ignored('Only fal.ai and Runway models that take an end frame and local LTX use it; this renderer ignores it');
  const model = getFalVideoModel(falModelId || FAL_DEFAULT_IMAGE_VIDEO_MODEL);
  if (!model?.endImage) return ignored(`${model?.label || 'This fal.ai model'} takes no end frame; choose one that does`);
  return { endImageId, used: true, reason: null };
}

/**
 * The `/api/video-gen` fields that carry the end frame, or nothing. A local
 * render anchors it only in first+last-frame mode, so that lane also names it.
 */
export const sceneEndFrameRequestFields = (scene, options) => {
  const plan = sceneEndFramePlan(scene, options);
  if (!plan.used) return {};
  return options?.backend === 'local' ? { lastImageFile: plan.endImageId, mode: 'fflf' } : { lastImageFile: plan.endImageId };
};
