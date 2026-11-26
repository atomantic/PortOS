// Shot-card frame and clip submission (#15583). Frames resolve on the server;
// short-form clips use the same request builder as the board. Prepared clip
// bodies still pass through video-gen validation and submission guards.

import { ServerError, failValidation } from '../../lib/errorHandler.js';
import {
  buildSceneClipRequest, fillSceneClipReferenceFiles, sceneClipNeedsCastMedia, sceneClipNeedsReferenceFiles, sceneClipUsesAudioReactive,
} from '../../lib/musicVideo/musicVideoClipRequest.js';
import { renderTierVideoSettings, sceneRenderTierPlan } from '../../lib/musicVideo/musicVideoRenderTier.js';
import { loraFamilyOf, VIDEO_LORA_FAMILIES } from '../../lib/runners.js';
import { buildSceneFrameGenerateBody } from './sceneFrameReferences.js';

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

async function audioReactiveLora() {
  const { listLoras } = await import('../loras.js');
  const loras = await listLoras();
  return loras.find((lora) => /audio-reactive/i.test(`${lora.filename || ''} ${lora.name || ''}`) && loraFamilyOf(lora) === VIDEO_LORA_FAMILIES.LTX_VIDEO) || null;
}

function clipBodyOrThrow({ body, error }) {
  if (error) throw new ServerError(error.message, { status: error.status, code: error.code });
  return body;
}

/** A clip body for an API caller that sends the card's options. */
async function buildShortClipBody(project, scene, input) {
  const { target, tier, revisionId } = input;
  const backend = target?.backend ?? project.videoSettings?.backend;
  const settings = renderTierVideoSettings(backend, {
    scene, scenes: project.scenes, videoSettings: project.videoSettings, override: target, tier,
  });
  const card = input.card || input;
  let model = null;
  if (backend === 'local') {
    const { resolveVideoModelSelection } = await import('../videoGen/modelSelection.js');
    ({ model } = await resolveVideoModelSelection(settings.modelId || undefined));
  }
  const options = { scene, project, card, target, tier, revisionId, settings, model };
  const lora = sceneClipUsesAudioReactive(settings) ? await audioReactiveLora() : null;
  const castMedia = sceneClipNeedsCastMedia(options) ? await sceneCastMedia(project, scene) : null;
  return clipBodyOrThrow(buildSceneClipRequest({ ...options, castMedia, audioReactiveLora: lora }));
}

async function sceneCastMedia(project, scene) {
  const { loadSceneCastMedia } = await import('./castGuideMedia.js');
  return loadSceneCastMedia(scene, { project });
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
  if (!sceneClipNeedsReferenceFiles(body)) return body;
  const castMedia = await sceneCastMedia(project, scene);
  return clipBodyOrThrow(fillSceneClipReferenceFiles(body, { project, scene, castMedia }));
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
