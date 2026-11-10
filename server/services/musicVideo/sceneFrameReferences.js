// The shot card's frame references, resolved on the server (#15583).
// The card, prompt preview and POST /image-gen/generate share this set, so a
// caller that only has the project JSON cannot drop a picked cast sheet.

import { musicVideoFrameGenSize } from '../../lib/musicVideoAspect.js';
import { castInputsFromReferences } from '../../lib/musicVideoCastLook.js';
import {
  MUSIC_VIDEO_MAX_REFERENCE_CHOICES,
  musicVideoConditioningReferences,
  musicVideoFrameReferenceFiles,
  musicVideoMissingFrameLinkedPicks,
} from '../../lib/musicVideoConditioning.js';
import { ServerError } from '../../lib/errorHandler.js';
import { authoredFramePromptText, musicVideoFrameModelInput } from '../../lib/musicVideoShotPrompt.js';
import { shotActionContractProblem } from '../../lib/musicVideoActionContract.js';

export const FRAME_REFERENCE_UNAVAILABLE = 'A reference picked for this shot is unavailable. Try again, or use Back to auto on its References row.';

function refuseMissingFrameReference() {
  throw new ServerError(FRAME_REFERENCE_UNAVAILABLE, { status: 409, code: 'MUSIC_VIDEO_FRAME_REFERENCE_MISSING' });
}

/**
 * The still the card would submit for this shot: authored prompt, reference
 * files (lead frame, then the shot's picks, including a live greybox plate)
 * and the cast inputs those files record.
 */
async function resolveCardFrameRender(project, scene, { slot = 'start', referenceImageId = null, refine = null, fromFrame = false, includeReferences = true } = {}) {
  const end = slot === 'end';
  const lead = referenceImageId || ((fromFrame || end) ? scene?.referenceImageId || null : null);
  const refining = Boolean(typeof refine === 'string' && refine.trim() && lead);
  if (end && !refining && !scene?.endFramePrompt?.trim()) {
    throw new ServerError('Describe the end frame first', { status: 422, code: 'MUSIC_VIDEO_END_FRAME_UNPROMPTED' });
  }
  if (!end && !refining) {
    const problem = shotActionContractProblem(scene?.direction?.actionContract, scene);
    if (problem) throw new ServerError(problem, { status: 422, code: 'MUSIC_VIDEO_SHOT_INTENT_INVALID' });
    if (!musicVideoFrameModelInput(project, scene).prompt) {
      throw new ServerError('Add a frame prompt or shot prompt first', { status: 422, code: 'MUSIC_VIDEO_FRAME_UNPROMPTED' });
    }
  }
  if (refining && !includeReferences) {
    return { prompt: refine, referenceImageFiles: [lead], castInputs: castInputsFromReferences(scene, []),
      greybox: null, fromFrame: false, refine: true, leadImageId: lead };
  }
  const { loadSceneCastMedia } = await import('./castGuideMedia.js');
  const { loadMusicVideoGreybox } = await import('./greyboxReferences.js');
  const castMedia = await loadSceneCastMedia(scene, { project });
  if (musicVideoMissingFrameLinkedPicks(project, scene, castMedia).length) refuseMissingFrameReference();
  const greybox = await loadMusicVideoGreybox(project, scene);
  const conditioning = musicVideoConditioningReferences(project, scene, castMedia, greybox);
  const referenceImageFiles = musicVideoFrameReferenceFiles(lead, conditioning, MUSIC_VIDEO_MAX_REFERENCE_CHOICES, {
    reservePanel: !Array.isArray(scene?.frameReferenceIds),
  });
  return {
    prompt: refining ? refine : (end ? scene.endFramePrompt.trim() : authoredFramePromptText(scene)),
    referenceImageFiles,
    castInputs: castInputsFromReferences(scene, conditioning.filter((ref) => referenceImageFiles.includes(ref.imageId))),
    greybox,
    fromFrame: Boolean(!refining && lead && (fromFrame || end || referenceImageId)),
    refine: refining,
    leadImageId: lead,
  };
}

function explicitImageRequest(imageTarget) {
  if (!imageTarget?.mode) return {};
  const request = { mode: imageTarget.mode };
  if (imageTarget.modelId) request.modelId = imageTarget.modelId;
  if (imageTarget.cloudModel) request.cloudModel = imageTarget.cloudModel;
  return request;
}

/** The image-gen body the shot card used to build in the browser. */
export async function buildSceneFrameGenerateBody(project, scene, input = {}) {
  const slot = input.slot === 'end' ? 'end' : 'start';
  const resolved = await resolveCardFrameRender(project, scene, {
    slot, referenceImageId: input.referenceImageId || null, refine: input.refine || null, fromFrame: input.fromFrame === true, includeReferences: input.includeReferences !== false,
  });
  const selected = slot === 'end' ? scene.endImageId : scene.referenceImageId;
  return {
    ...explicitImageRequest(input.imageTarget),
    prompt: resolved.prompt,
    ...musicVideoFrameGenSize(project),
    ...(resolved.referenceImageFiles.length ? { referenceImageFiles: resolved.referenceImageFiles } : {}),
    musicVideo: {
      ...(project.castAndSets?.catalogCheckin?.basis ? { catalogBasis: project.castAndSets.catalogCheckin.basis } : {}),
      projectId: project.id,
      sceneId: scene.sceneId,
      compose: true,
      castInputs: resolved.castInputs,
      ...(resolved.refine && input.includeReferences === false ? { includeReferences: false } : {}),
      ...(slot === 'end' ? { slot: 'end' } : {}),
      ...(input.revisionId ? { revisionId: input.revisionId } : {}),
      ...(input.select ? { replaceSelection: true, expectedSelection: selected || null } : {}),
      ...(input.thenClip ? { thenClip: input.thenClip } : {}),
      ...(resolved.greybox?.reference ? { greyboxImageId: resolved.greybox.reference.imageId } : {}),
      ...(resolved.greybox?.blocking ? { greyboxBlockingImageId: resolved.greybox.blocking.imageId } : {}),
      ...(resolved.leadImageId ? { leadImageId: resolved.leadImageId } : {}),
      ...(resolved.refine ? { refine: true } : resolved.fromFrame ? { fromFrame: true } : {}),
    },
    castInputs: resolved.castInputs,
  };
}
