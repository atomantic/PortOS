import { higgsfieldShotRequestFields } from '../../lib/higgsfieldVideoModels.js';
import { googleShotRequestFields } from '../../lib/googleVideoModels.js';
// Shot-card frame and clip submission (#15583). The board, autopilot and API
// callers share one resolver, so a request that names only the project, shot
// and slot still sends the references the card would.

import { ServerError, failValidation } from '../../lib/errorHandler.js';
import { musicVideoClipConditioningReferences } from '../../lib/musicVideo/musicVideoConditioning.js';
import { shotWantsClipSound } from '../../lib/musicVideo/musicVideoClipSound.js';
import { sceneEndFrameRequestFields } from '../../lib/musicVideo/musicVideoEndFrame.js';
import { authoredShotPrompt } from '../../lib/musicVideo/musicVideoShotPrompt.js';
import { shotActionContractProblem } from '../../lib/musicVideo/musicVideoActionContract.js';
import {
  falSceneTake, falTakeRequestFields, grokCoverage, isPerformanceScene, ltxReferenceFrames, performanceBlockedReason,
  runwaySceneTake, runwayTakeRequestFields, sceneRenderShot, shotRequestSpanSec,
} from '../../lib/musicVideo/musicVideoShotTiming.js';
import { loraFamilyOf, VIDEO_LORA_FAMILIES } from '../../lib/runners.js';
import { buildSceneFrameGenerateBody } from './sceneFrameReferences.js';
import { renderTierVideoSettings, sceneRenderTierPlan } from '../../lib/musicVideo/musicVideoRenderTier.js';

const LTX_REFERENCES_MODE = 'ltxReferences';
const LTX_IC_MODE = 'ic-ingredients-25';
const LTX_MAX_REFERENCES = 8;

const grokSceneRequestDuration = (scene, settings, target = null, scenes = null) => {
  const span = shotRequestSpanSec(scene, scenes);
  return target?.grokDuration || (span != null ? grokCoverage(span).requestSec : settings?.grokDuration);
};

function sceneOrThrow(project, sceneId) {
  const scene = project?.scenes?.find((entry) => entry.sceneId === sceneId);
  if (!scene) throw new ServerError('Shot not found', { status: 404, code: 'NOT_FOUND' });
  return scene;
}

export async function renderSceneFrames(project, { sceneId, ...input } = {}) {
  const scene = sceneOrThrow(project, sceneId);
  const built = await buildSceneFrameGenerateBody(project, scene, input);
  const { castInputs, ...body } = built;
  const { generateSchema } = await import('../../lib/imageGenValidation.js');
  const { executeImageGenerate } = await import('../imageGen/submitJob.js');
  const { validateRequest } = await import('../../lib/validateRequest.js');
  const data = validateRequest(generateSchema, body);
  const rendered = await executeImageGenerate(data);
  return { sceneId, ok: true, ...rendered.body, castInputs: rendered.params?.musicVideo?.castInputs || castInputs };
}

const preparedClipBody = (input) => Boolean(input?.mode || input?.backend || input?.sourceImageFile || input?.modelId || input?.falModelId || input?.grokDuration);

function clipTag(project, scene, input, extra = {}) {
  const card = input.card || input;
  return {
    ...(project.castAndSets?.catalogCheckin?.basis ? { catalogBasis: project.castAndSets.catalogCheckin.basis } : {}),
    projectId: project.id,
    sceneId: scene.sceneId,
    compose: true,
    expectedShot: sceneRenderShot(scene),
    ...(input.revisionId ? { revisionId: input.revisionId } : {}),
    ...(card.prompt ? { promptAsTyped: true } : {}),
    ...(typeof card.songAudio === 'boolean' && !isPerformanceScene(scene) ? { songAudio: card.songAudio } : {}),
    ...(card.wholeLine && isPerformanceScene(scene) ? { wholeLine: true } : {}),
    ...(card.startFrameLayout ? { startFrameLayout: true } : {}),
    ...(card.frameRoute ? { frameRoute: card.frameRoute } : {}),
    ...(input.tier ? { tier: input.tier } : {}),
    ...extra,
  };
}

async function audioReactiveLora() {
  const { listLoras } = await import('../loras.js');
  const loras = await listLoras();
  return loras.find((lora) => /audio-reactive/i.test(`${lora.filename || ''} ${lora.name || ''}`) && loraFamilyOf(lora) === VIDEO_LORA_FAMILIES.LTX_VIDEO) || null;
}

/** A clip body for an API caller that sends the card's options rather than a video-gen payload. */
async function buildShortClipBody(project, scene, input) {
  if (!scene.referenceImageId) throw new ServerError('Generate a reference frame first', { status: 422, code: 'MUSIC_VIDEO_FRAME_REQUIRED' });
  const problem = shotActionContractProblem(scene.direction?.actionContract, scene);
  if (problem) throw new ServerError(problem, { status: 422, code: 'MUSIC_VIDEO_SHOT_INTENT_INVALID' });
  const card = input.card || input;
  const prompt = card.prompt || authoredShotPrompt(scene);
  if (!prompt) throw new ServerError('Add a shot prompt first', { status: 422, code: 'MUSIC_VIDEO_CLIP_UNPROMPTED' });
  const backend = input.target?.backend ?? project.videoSettings?.backend;
  const settings = renderTierVideoSettings(backend, {
    scene, scenes: project.scenes, videoSettings: project.videoSettings, override: input.target, tier: input.tier,
  });
  const { getVideoModels } = await import('../../lib/mediaModels.js');
  const models = getVideoModels();
  const model = models.find((entry) => entry.id === (settings.modelId || input.target?.modelId));
  const audioReactive = settings.backend === 'local' && settings.generationMode === 'audioReactive';
  if (audioReactive) {
    const lora = await audioReactiveLora();
    if (!lora || model?.runtime !== 'ltx2') {
      throw new ServerError('Audio-reactive generation requires an installed LTX-2.3 audio-reactive LoRA and an LTX-2.3 local model', { status: 409, code: 'MUSIC_VIDEO_CLIP_UNAVAILABLE' });
    }
    settings.detectedLora = lora;
  }
  const performance = isPerformanceScene(scene);
  const performanceBlocked = performance ? performanceBlockedReason(audioReactive ? 'local' : settings.backend) : null;
  if (performanceBlocked) throw new ServerError(performanceBlocked, { status: 409, code: 'MUSIC_VIDEO_CLIP_UNAVAILABLE' });
  const hostedPerformance = performance && settings.backend === 'fal';
  const localCutaway = settings.backend === 'local' && !performance && !audioReactive;
  const projectLtx = settings.generationMode === LTX_REFERENCES_MODE && localCutaway && model?.runtime === 'ltx25' && !scene.setReference?.greyboxShotId;
  const useLtx = localCutaway && (typeof card.ltxReferences === 'boolean' ? card.ltxReferences : projectLtx);
  let ltxFiles = null;
  let ltxFrames = null;
  if (useLtx) {
    const { loadSceneCastMedia } = await import('./castGuideMedia.js');
    const castMedia = await loadSceneCastMedia(scene, { project });
    ltxFiles = Array.isArray(card.expectedClipReferenceFiles) && card.ltxReferences === true
      ? card.expectedClipReferenceFiles
      : musicVideoClipConditioningReferences(project, scene, castMedia, { limit: LTX_MAX_REFERENCES }).map((ref) => ref.imageId);
    if (!ltxFiles.length) throw new ServerError('Choose at least one clip reference for LTX 2.5 References', { status: 422, code: 'MUSIC_VIDEO_CLIP_REFERENCE_MISSING' });
    const need = shotRequestSpanSec(scene, project.scenes);
    const coverScene = need != null ? { ...scene, startSec: 0, endSec: need } : scene;
    const coveringFrames = ltxReferenceFrames(coverScene);
    ltxFrames = ltxReferenceFrames(coverScene, input.target?.numFrames);
    if (coveringFrames == null || ltxFrames == null || ltxFrames < coveringFrames) {
      throw new ServerError('This shot is too long for one LTX reference clip. Split it or choose a shorter clip length.', { status: 422, code: 'MUSIC_VIDEO_CLIP_TOO_LONG' });
    }
  }
  const songAudio = useLtx || hostedPerformance ? false : typeof card.songAudio === 'boolean' ? card.songAudio : settings.generationMode === 'suppliedAudio';
  const mode = useLtx ? LTX_IC_MODE : audioReactive || songAudio ? 'a2v' : 'image';
  const falFields = settings.backend === 'fal' ? falTakeRequestFields(falSceneTake({ scene, scenes: project.scenes, videoSettings: settings, songDurationSec: project?.audioAnalysis?.durationSec ?? null })) : null;
  const higgsfieldFields = settings.backend === 'higgsfield' ? higgsfieldShotRequestFields(settings, shotRequestSpanSec(scene, project.scenes)) : null;
  const googleFields = settings.backend === 'google' ? googleShotRequestFields(settings, shotRequestSpanSec(scene, project.scenes)) : null;
  const runwayFields = settings.backend === 'runway' ? runwayTakeRequestFields(runwaySceneTake({ scene, scenes: project.scenes, videoSettings: settings })) : null;
  const providerFields = settings.backend === 'grok' ? { grokDuration: grokSceneRequestDuration(scene, settings, input.target, project.scenes) }
    : falFields || runwayFields || higgsfieldFields || googleFields ? falFields || runwayFields || higgsfieldFields || googleFields
      : settings.backend === 'gemini' ? {}
        : settings.backend === 'local' ? {
          modelId: settings.modelId || undefined,
          ...(useLtx ? { numFrames: ltxFrames, icReferenceImageFiles: ltxFiles }
            : input.target?.numFrames ? { numFrames: input.target.numFrames } : {}),
          disableAudio: !shotWantsClipSound(scene),
        } : { grokDuration: settings.grokDuration, disableAudio: !shotWantsClipSound(scene) };
  return {
    prompt,
    ...(settings.backend ? { backend: settings.backend } : {}),
    ...providerFields,
    mode,
    sourceImageFile: scene.referenceImageId,
    ...(useLtx || card.endFrame === false || songAudio ? {} : sceneEndFrameRequestFields(scene, {
      backend: settings.backend, falModelId: falFields?.falModelId, runwayModelId: runwayFields?.runwayModelId, googleModelId: googleFields?.googleModelId,
      higgsfieldModelId: settings.higgsfieldModelId, mode,
      localRuntime: model?.runtime ?? null,
    })),
    ...(audioReactive ? { audioStartSec: scene.startSec || 0, loraFilenames: [settings.detectedLora.filename], loraScales: [settings.audioReactiveScale] } : {}),
    musicVideo: clipTag(project, scene, input, {
      ...(audioReactive ? { audioReactive: true } : {}),
      ...(hostedPerformance ? { songAudio: false } : {}),
      ...(ltxFiles ? { expectedClipReferenceFiles: ltxFiles } : {}),
      ...(Array.isArray(card.expectedClipReferenceLabels) ? { expectedClipReferenceLabels: card.expectedClipReferenceLabels } : {}),
    }),
  };
}

/** Fill LTX ingredient files the caller left out, from the shot's current picks. */
async function ensureSceneClipReferences(body, project, scene) {
  if (body.mode !== LTX_IC_MODE || (Array.isArray(body.icReferenceImageFiles) && body.icReferenceImageFiles.length)) return body;
  const { loadSceneCastMedia } = await import('./castGuideMedia.js');
  const castMedia = await loadSceneCastMedia(scene, { project });
  const files = musicVideoClipConditioningReferences(project, scene, castMedia, { limit: LTX_MAX_REFERENCES }).map((ref) => ref.imageId);
  if (!files.length) {
    throw new ServerError('A reference picked for this shot is unavailable. Try again, or use Back to auto on its References row.', { status: 409, code: 'MUSIC_VIDEO_CLIP_REFERENCE_MISSING' });
  }
  const tag = body.musicVideo || {};
  return {
    ...body,
    icReferenceImageFiles: files,
    musicVideo: { ...tag, expectedClipReferenceFiles: tag.expectedClipReferenceFiles || files },
  };
}

/**
 * A prepared body at `tier`: the tier's resolution fills the field the
 * backend reads unless the body names one. The board resolves the tier itself
 * so its price matches; this covers an API caller that sends only the tier.
 */
function preparedTierFields(project, scene, { tier, ...body }) {
  if (!tier || !body.backend) return body;
  const plan = sceneRenderTierPlan(body.backend, {
    scene, scenes: project.scenes,
    videoSettings: {
      ...(project.videoSettings || {}),
      ...Object.fromEntries(['falModelId', 'runwayModelId', 'higgsfieldModelId', 'googleModelId'].filter((key) => body[key]).map((key) => [key, body[key]])),
    },
  });
  return plan && body[plan.requestField] == null ? { ...body, [plan.requestField]: plan[tier] } : body;
}

async function buildSceneClipSubmission(project, scene, input = {}) {
  const body = preparedClipBody(input) ? {
    ...preparedTierFields(project, scene, input),
    musicVideo: {
      ...(typeof input.musicVideo === 'string' ? JSON.parse(input.musicVideo) : (input.musicVideo || {})),
      projectId: project.id,
      sceneId: scene.sceneId,
      ...(input.tier ? { tier: input.tier } : {}),
    },
  } : await buildShortClipBody(project, scene, input);
  return ensureSceneClipReferences(body, project, scene);
}

export async function renderSceneClips(project, { sceneId, ...input } = {}) {
  const scene = sceneOrThrow(project, sceneId);
  const body = await buildSceneClipSubmission(project, scene, input);
  const { generateBodySchema } = await import('../../lib/videoGenValidation.js');
  const { submitVideoGenJob } = await import('../videoGen/submitJob.js');
  const parsed = generateBodySchema.safeParse(body);
  if (!parsed.success) failValidation(parsed);
  const queued = await submitVideoGenJob(parsed.data, {});
  return { sceneId, ok: true, ...queued };
}
