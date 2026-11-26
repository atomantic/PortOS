// Build a Music Video shot's clip request from the resolved render settings and conditioning assets.

import { higgsfieldShotRequestFields } from '../higgsfieldVideoModels.js';
import { googleShotRequestFields } from '../googleVideoModels.js';
import { shotActionContractProblem } from './musicVideoActionContract.js';
import { musicVideoClipConditioningReferences } from './musicVideoConditioning.js';
import { shotWantsClipSound } from './musicVideoClipSound.js';
import { sceneEndFrameRequestFields } from './musicVideoEndFrame.js';
import { isMusicVideoSetOmitted } from './musicVideoGreybox.js';
import { authoredShotPrompt } from './musicVideoShotPrompt.js';
import {
  falSceneTake, falTakeRequestFields, grokSceneRequestDuration, isPerformanceScene, ltxReferenceFrames, performanceBlockedReason,
  runwaySceneTake, runwayTakeRequestFields, sceneRenderShot, shotRequestSpanSec,
} from './musicVideoShotTiming.js';

export const LTX_REFERENCES_GENERATION_MODE = 'ltxReferences';
export const LTX_REFERENCES_IC_MODE = 'ic-ingredients-25';
export const LTX_REFERENCES_MAX_REFERENCES = 8;
export const isLtx25Model = (model) => model?.runtime === 'ltx25';

export const sceneClipUsesAudioReactive = (settings) => settings.backend === 'local' && settings.generationMode === 'audioReactive';

const refusal = (message, code, status = 422) => ({ error: { message, code, status } });
const pickedLtxFiles = (card) => card.ltxReferences === true && Array.isArray(card.expectedClipReferenceFiles) ? card.expectedClipReferenceFiles : null;

function usesLtxReferences({ scene, card = {}, settings, model }) {
  if (settings.backend !== 'local' || isPerformanceScene(scene) || sceneClipUsesAudioReactive(settings)) return false;
  if (typeof card.ltxReferences === 'boolean') return card.ltxReferences;
  return settings.generationMode === LTX_REFERENCES_GENERATION_MODE && isLtx25Model(model)
    && (!scene.setReference?.greyboxShotId || isMusicVideoSetOmitted(scene));
}

export function sceneClipNeedsCastMedia(input) {
  return usesLtxReferences(input) && pickedLtxFiles(input.card || {}) == null;
}

const referenceFiles = (project, scene, castMedia) =>
  musicVideoClipConditioningReferences(project, scene, castMedia, { limit: LTX_REFERENCES_MAX_REFERENCES }).map((ref) => ref.imageId);

export function sceneClipNeedsReferenceFiles(body) {
  return body.mode === LTX_REFERENCES_IC_MODE && !(Array.isArray(body.icReferenceImageFiles) && body.icReferenceImageFiles.length);
}

/** Resolve ingredients for a prepared request that names LTX References without listing files. */
export function fillSceneClipReferenceFiles(body, { project, scene, castMedia }) {
  const files = referenceFiles(project, scene, castMedia);
  if (!files.length) {
    return refusal('A reference picked for this shot is unavailable. Try again, or use Back to auto on its References row.', 'MUSIC_VIDEO_CLIP_REFERENCE_MISSING', 409);
  }
  return { body: {
    ...body,
    icReferenceImageFiles: files,
    musicVideo: { ...body.musicVideo, expectedClipReferenceFiles: body.musicVideo?.expectedClipReferenceFiles || files },
  } };
}

function backendFields({ scene, project, settings, target, ltx }) {
  const scenes = project.scenes;
  switch (settings.backend) {
    case 'grok': return { grokDuration: grokSceneRequestDuration(scene, settings, target, scenes) };
    case 'fal': return falTakeRequestFields(falSceneTake({
      scene, scenes, videoSettings: settings, songDurationSec: project.audioAnalysis?.durationSec ?? null,
    }));
    case 'runway': return runwayTakeRequestFields(runwaySceneTake({ scene, scenes, videoSettings: settings }));
    case 'higgsfield': return higgsfieldShotRequestFields(settings, shotRequestSpanSec(scene, scenes));
    case 'google': return googleShotRequestFields(settings, shotRequestSpanSec(scene, scenes));
    case 'gemini': return {};
    case 'local': return {
      modelId: settings.modelId || undefined,
      ...(ltx ? { numFrames: ltx.frames, icReferenceImageFiles: ltx.files }
        : target?.numFrames ? { numFrames: target.numFrames } : {}),
      disableAudio: !shotWantsClipSound(scene),
    };
    default: return { grokDuration: settings.grokDuration, disableAudio: !shotWantsClipSound(scene) };
  }
}

/** Return a video-gen body or a refusal with its UI text and API status. */
export function buildSceneClipRequest({ scene, project, card = {}, target, tier, revisionId, settings, model, castMedia, audioReactiveLora }) {
  if (!scene.referenceImageId) return refusal('Generate a reference frame first', 'MUSIC_VIDEO_FRAME_REQUIRED');
  const problem = shotActionContractProblem(scene.direction?.actionContract, scene);
  if (problem) return refusal(problem, 'MUSIC_VIDEO_SHOT_INTENT_INVALID');
  const prompt = card.prompt || authoredShotPrompt(scene);
  if (!prompt) return refusal('Add a shot prompt first', 'MUSIC_VIDEO_CLIP_UNPROMPTED');

  const audioReactive = sceneClipUsesAudioReactive(settings);
  if (audioReactive && (!audioReactiveLora?.filename || model?.runtime !== 'ltx2')) {
    return refusal('Audio-reactive generation requires an installed LTX-2.3 audio-reactive LoRA and an LTX-2.3 local model', 'MUSIC_VIDEO_CLIP_UNAVAILABLE', 409);
  }
  const performance = isPerformanceScene(scene);
  const performanceBlocked = performance ? performanceBlockedReason(settings.backend) : null;
  if (performanceBlocked) return refusal(performanceBlocked, 'MUSIC_VIDEO_CLIP_UNAVAILABLE', 409);

  let ltx = null;
  if (usesLtxReferences({ scene, card, settings, model })) {
    const files = pickedLtxFiles(card) ?? referenceFiles(project, scene, castMedia);
    if (!files.length) return refusal('Choose at least one clip reference for LTX 2.5 References', 'MUSIC_VIDEO_CLIP_REFERENCE_MISSING');
    const need = shotRequestSpanSec(scene, project.scenes);
    const coverScene = need != null ? { ...scene, startSec: 0, endSec: need } : scene;
    const coveringFrames = ltxReferenceFrames(coverScene);
    const frames = ltxReferenceFrames(coverScene, target?.numFrames);
    if (coveringFrames == null || frames == null || frames < coveringFrames) {
      return refusal('This shot is too long for one LTX reference clip. Split it or choose a shorter clip length.', 'MUSIC_VIDEO_CLIP_TOO_LONG');
    }
    ltx = { files, frames };
  }

  const hostedPerformance = performance && settings.backend === 'fal';
  const songAudio = ltx || hostedPerformance ? false
    : typeof card.songAudio === 'boolean' ? card.songAudio : settings.generationMode === 'suppliedAudio';
  const mode = ltx ? LTX_REFERENCES_IC_MODE : audioReactive || songAudio ? 'a2v' : 'image';
  const fields = backendFields({ scene, project, settings, target, ltx });
  const endFrame = ltx || card.endFrame === false || songAudio ? {} : sceneEndFrameRequestFields(scene, {
    backend: settings.backend, falModelId: fields.falModelId, runwayModelId: fields.runwayModelId, googleModelId: fields.googleModelId,
    higgsfieldModelId: settings.higgsfieldModelId, mode, localRuntime: model?.runtime ?? null,
  });
  const expectedFiles = ltx?.files ?? card.expectedClipReferenceFiles;
  return { body: {
    prompt,
    ...(settings.backend ? { backend: settings.backend } : {}),
    ...fields,
    mode,
    sourceImageFile: scene.referenceImageId,
    ...endFrame,
    ...(audioReactive ? {
      audioStartSec: scene.startSec || 0,
      loraFilenames: [audioReactiveLora.filename],
      loraScales: [settings.audioReactiveScale ?? 1.2],
    } : {}),
    musicVideo: {
      ...(project.castAndSets?.catalogCheckin?.basis ? { catalogBasis: project.castAndSets.catalogCheckin.basis } : {}),
      projectId: project.id,
      sceneId: scene.sceneId,
      compose: true,
      expectedShot: sceneRenderShot(scene),
      ...(revisionId ? { revisionId } : {}),
      ...(card.prompt ? { promptAsTyped: true } : {}),
      ...(hostedPerformance ? { songAudio: false } : {}),
      ...(typeof card.songAudio === 'boolean' && !performance ? { songAudio: card.songAudio } : {}),
      ...(card.wholeLine && performance ? { wholeLine: true } : {}),
      ...(card.startFrameLayout ? { startFrameLayout: true } : {}),
      ...(card.frameRoute ? { frameRoute: card.frameRoute } : {}),
      ...(tier ? { tier } : {}),
      ...(audioReactive ? { audioReactive: true } : {}),
      ...(Array.isArray(expectedFiles) ? { expectedClipReferenceFiles: expectedFiles } : {}),
      ...(Array.isArray(card.expectedClipReferenceLabels) ? { expectedClipReferenceLabels: card.expectedClipReferenceLabels } : {}),
    },
  } };
}
