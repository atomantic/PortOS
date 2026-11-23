/**
 * Pure clip-request derivation for one music-video shot: validation, LTX 2.5 reference framing, and per-backend fields.
 *
 * `buildSceneClipRequest` returns `{ error }` or `{ body, label }`. The hook toasts `error`, starts the lane, and posts `body`.
 */

import { higgsfieldShotRequestFields } from '../../../server/lib/higgsfieldVideoModels.js';
import { googleShotRequestFields } from '../../../server/lib/googleVideoModels.js';
import { renderTierVideoSettings } from '../../../server/lib/musicVideo/musicVideoRenderTier.js';
import { shotActionContractProblem } from '../../../server/lib/musicVideo/musicVideoActionContract.js';
import { musicVideoClipConditioningReferences, musicVideoSceneCastIds } from '../../../server/lib/musicVideo/musicVideoConditioning.js';
import { shotWantsClipSound } from '../../../server/lib/musicVideo/musicVideoClipSound.js';
import { sceneEndFrameRequestFields } from '../../../server/lib/musicVideo/musicVideoEndFrame.js';
import { authoredShotPrompt } from '../../../server/lib/musicVideo/musicVideoShotPrompt.js';
import { shotRequestSpanSec, ltxReferenceFrames as ltxReferenceFramesFor } from '../../../server/lib/musicVideo/musicVideoShotTiming.js';
import { sourceClipNeedSec } from '../../../server/lib/musicVideo/musicVideoSourceTake.js';
import { LTX_REFERENCES_GENERATION_MODE, LTX_REFERENCES_IC_MODE, LTX_REFERENCES_MAX_REFERENCES, isLtx25Model } from './musicVideoLtxReferences.js';
import {
  falSceneTake, falTakeRequestFields, grokSceneRequestDuration, isPerformanceScene, performanceBlockedReason, runwaySceneTake, runwayTakeRequestFields, sceneRenderShot,
} from './musicVideoShotTiming.js';

const ltxReferenceFrames = (scene, target) => ltxReferenceFramesFor(scene, target?.numFrames);

function videoRenderLabel(settings) {
  if (settings?.renderPool?.mode === 'peers') return 'peer';
  if (settings?.renderPool?.mode === 'both') return null;
  return settings?.backend || 'local';
}

/** Why this shot's cast guides block a project-default LTX reference clip, or null. */
function castGuideError(project, scene, castMedia) {
  const ids = musicVideoSceneCastIds(project, scene);
  const failed = ids.find((id) => castMedia?.[id] === null);
  if (failed) {
    const name = (project?.concept?.subjects || []).find((subject) => subject?.ingredientId === failed)?.name || failed;
    return `Cast guides could not be loaded for ${name}. Retry before rendering.`;
  }
  if (ids.every((id) => castMedia?.[id] !== undefined)) return null;
  return 'Cast guides are still loading. Try again in a moment.';
}

/**
 * LTX 2.5 reference decision for one clip. `{ error }` stops the render;
 * otherwise `{ useLtxReferences, ltxReferenceFiles, referenceFrames }`.
 */
export function resolveLtxClipReferences({ scene, project, card, settings, target, videoSettings, castMedia, performance, audioReactiveSelected }) {
  const localCutaway = settings.backend === 'local' && !performance && !audioReactiveSelected;
  const model = (videoSettings.models || []).find((entry) => entry.id === (settings.modelId || videoSettings.defaultModel));
  const projectLtxReferences = settings.generationMode === LTX_REFERENCES_GENERATION_MODE && localCutaway
    && isLtx25Model(model)
    && !scene.setReference?.greyboxShotId;
  const useLtxReferences = localCutaway && (typeof card?.ltxReferences === 'boolean' ? card.ltxReferences : projectLtxReferences);
  const ltxReferenceFiles = !useLtxReferences ? null : card?.ltxReferences === true ? card.expectedClipReferenceFiles
    : musicVideoClipConditioningReferences(project, scene, castMedia, { limit: LTX_REFERENCES_MAX_REFERENCES }).map((ref) => ref.imageId);
  if (useLtxReferences && card?.ltxReferences !== true) {
    const guideError = castGuideError(project, scene, castMedia);
    if (guideError) return { error: guideError };
    if (!ltxReferenceFiles?.length) return { error: 'Choose at least one clip reference for LTX 2.5 References' };
  }
  const coverSec = sourceClipNeedSec(scene, project?.scenes);
  const ownSpan = typeof scene?.endSec === 'number' && typeof scene?.startSec === 'number' ? scene.endSec - scene.startSec : null;
  const ltxScene = coverSec != null && ownSpan != null && coverSec > ownSpan + 1e-6 ? { startSec: 0, endSec: coverSec } : scene;
  const referenceFrames = useLtxReferences ? ltxReferenceFrames(ltxScene, target) : null;
  if (useLtxReferences && referenceFrames == null) {
    return { error: 'This shot is too long for one LTX reference clip. Split it or choose a shorter clip length.' };
  }
  return { useLtxReferences, ltxReferenceFiles, referenceFrames };
}

const backendClipFields = {
  grok: (ctx) => ({ grokDuration: grokSceneRequestDuration(ctx.scene, ctx.settings, ctx.target, ctx.project?.scenes) }),
  fal: (ctx) => falTakeRequestFields(falSceneTake({
    scene: ctx.scene, scenes: ctx.project?.scenes, videoSettings: ctx.settings, songDurationSec: ctx.project?.audioAnalysis?.durationSec ?? null,
  })),
  runway: (ctx) => runwayTakeRequestFields(runwaySceneTake({ scene: ctx.scene, scenes: ctx.project?.scenes, videoSettings: ctx.settings })),
  higgsfield: (ctx) => higgsfieldShotRequestFields(ctx.settings, shotRequestSpanSec(ctx.scene, ctx.project.scenes)),
  google: (ctx) => googleShotRequestFields(ctx.settings, shotRequestSpanSec(ctx.scene, ctx.project.scenes)),
  gemini: () => ({}),
  local: (ctx) => ({
    modelId: ctx.settings.modelId || undefined,
    ...(ctx.useLtxReferences ? { numFrames: ctx.referenceFrames, icReferenceImageFiles: ctx.ltxReferenceFiles }
      : ctx.target?.numFrames ? { numFrames: ctx.target.numFrames } : {}),
    disableAudio: ctx.disableAudio,
  }),
};

/** Request fields for one video backend. An unknown backend keeps the shared Grok duration pin. */
export function buildBackendClipRequestFields(settings, ctx) {
  const build = backendClipFields[settings.backend];
  if (build) return build({ ...ctx, settings });
  return { grokDuration: settings.grokDuration, disableAudio: ctx.disableAudio };
}

function musicVideoMeta({ project, scene, revisionId, audioReactiveSelected, hostedPerformance, card, performance, useLtxReferences, ltxReferenceFiles }) {
  return {
    catalogBasis: project.castAndSets?.catalogCheckin?.basis,
    projectId: project.id, sceneId: scene.sceneId, ...(revisionId ? { revisionId } : {}),
    compose: true, expectedShot: sceneRenderShot(scene), ...(audioReactiveSelected ? { audioReactive: true } : {}),
    ...(hostedPerformance ? { songAudio: false } : {}),
    ...(card ? { promptAsTyped: true, ...(typeof card.songAudio === 'boolean' && !performance ? { songAudio: card.songAudio } : {}) } : {}),
    ...(Array.isArray(card?.expectedClipReferenceFiles) ? { expectedClipReferenceFiles: card.expectedClipReferenceFiles }
      : useLtxReferences ? { expectedClipReferenceFiles: ltxReferenceFiles } : {}),
    ...(Array.isArray(card?.expectedClipReferenceLabels) ? { expectedClipReferenceLabels: card.expectedClipReferenceLabels } : {}),
    ...(card?.wholeLine && performance ? { wholeLine: true } : {}),
    ...(card?.startFrameLayout ? { startFrameLayout: true } : {}),
  };
}

/**
 * The clip POST body for one shot, or `{ error }` when a precondition fails.
 * `label` is the lane placeholder ("Rendering grok…").
 */
export function buildSceneClipRequest({ scene, project, card = null, target = null, tier = null, revisionId, videoSettings, castMedia }) {
  if (!scene.referenceImageId) return { error: 'Generate a reference frame first' };
  const problem = shotActionContractProblem(scene.direction?.actionContract, scene);
  if (problem) return { error: problem };
  const prompt = card ? card.prompt : authoredShotPrompt(scene);
  if (!prompt) return { error: 'Add a shot prompt first' };

  const pinned = target ? { ...videoSettings.settings, ...target } : videoSettings.settings;
  const settings = tier
    ? renderTierVideoSettings(pinned.backend, { scene, scenes: project?.scenes, videoSettings: videoSettings.settings, override: target, tier })
    : pinned;
  const audioReactiveSelected = target
    ? settings.backend === 'local' && settings.generationMode === 'audioReactive'
    : videoSettings.audioReactiveSelected;
  const videoBlockedReason = target && videoSettings.blockedReasonFor
    ? videoSettings.blockedReasonFor(settings)
    : videoSettings.videoBlockedReason;
  if (videoBlockedReason) return { error: videoBlockedReason };

  const performance = isPerformanceScene(scene);
  const performanceBlocked = performance
    ? performanceBlockedReason(audioReactiveSelected ? 'local' : settings.backend)
    : null;
  if (performanceBlocked) return { error: performanceBlocked };
  const hostedPerformance = performance && settings.backend === 'fal';

  const ltx = resolveLtxClipReferences({
    scene, project, card, settings, target, videoSettings, castMedia, performance, audioReactiveSelected,
  });
  if (ltx.error) return { error: ltx.error };

  const songAudio = ltx.useLtxReferences || hostedPerformance ? false
    : typeof card?.songAudio === 'boolean' ? card.songAudio : settings.generationMode === 'suppliedAudio';
  const mode = ltx.useLtxReferences ? LTX_REFERENCES_IC_MODE : audioReactiveSelected || songAudio ? 'a2v' : 'image';
  const disableAudio = !shotWantsClipSound(scene);
  const backendFields = buildBackendClipRequestFields(settings, {
    scene, project, target, disableAudio,
    useLtxReferences: ltx.useLtxReferences,
    referenceFrames: ltx.referenceFrames,
    ltxReferenceFiles: ltx.ltxReferenceFiles,
  });
  const localRuntime = (target?.modelId
    ? (videoSettings.models || []).find((entry) => entry.id === target.modelId)?.runtime
    : videoSettings.activeModel?.runtime) ?? null;
  const endFrame = ltx.useLtxReferences || (card && (card.endFrame === false || songAudio)) ? {} : sceneEndFrameRequestFields(scene, {
    backend: settings.backend,
    falModelId: backendFields.falModelId,
    runwayModelId: backendFields.runwayModelId,
    googleModelId: settings.googleModelId,
    higgsfieldModelId: settings.higgsfieldModelId,
    mode,
    localRuntime,
  });

  return {
    label: videoRenderLabel(settings),
    body: {
      prompt,
      ...(tier ? { tier } : {}),
      ...(settings.backend ? { backend: settings.backend } : {}),
      ...backendFields,
      mode,
      sourceImageFile: scene.referenceImageId,
      ...endFrame,
      ...(audioReactiveSelected ? {
        audioStartSec: scene.startSec || 0,
        loraFilenames: [videoSettings.detectedAudioReactiveLora.filename],
        loraScales: [settings.audioReactiveScale],
      } : {}),
      musicVideo: JSON.stringify(musicVideoMeta({
        project, scene, revisionId, audioReactiveSelected, hostedPerformance, card, performance,
        useLtxReferences: ltx.useLtxReferences, ltxReferenceFiles: ltx.ltxReferenceFiles,
      })),
    },
  };
}
