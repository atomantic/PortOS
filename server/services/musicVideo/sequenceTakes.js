/**
 * Music Video sequence takes (#16128): render a director-picked run of 2-6
 * consecutive shots as ONE hosted reference-to-video take. `dryRun` returns the
 * exact prompt, references, length and price without sending anything; the
 * submit queues the same request. On completion musicVideoSequenceTakeHook.js
 * finds the cuts and files the whole clip on each shot with its own in-point.
 *
 * The preview and the submit build the request with the same code, so what the
 * board shows is what is sent.
 */

import { basename } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { buildFalVideoRequest, coerceFalVideoSeconds, getFalVideoModel } from '../../lib/falVideoModels.js';
import {
  composeSequenceTakePrompt, defaultSequenceTakeModelId, sequenceTakeModelProblem, sequenceTakeRun, unionSequenceTakeReferences,
} from '../../lib/musicVideoSequenceTake.js';
import { SEQUENCE_PROMPT_EXPANSION } from '../../lib/musicVideoSequenceCoverage.js';

const refuse = (status, code, message, context) => { throw new ServerError(message, { status, code, ...(context ? { context } : {}) }); };

/** Each shot's frame, then its clip references, as resolved files. Refuses a shot with no frame. */
async function gatherReferences(project, members, model) {
  const [{ resolveGalleryImage }, { musicVideoClipReferences }, { MUSIC_VIDEO_MAX_REFERENCE_CHOICES }] = await Promise.all([
    import('../../lib/pathSafety.js'), import('./clipCastReferences.js'), import('../../lib/musicVideoConditioning.js'),
  ]);
  const frames = members.map((scene) => {
    const path = scene.referenceImageId ? resolveGalleryImage(scene.referenceImageId) : null;
    if (!path) refuse(409, 'PRODUCTION_FRAME_MISSING', `"${scene.label || scene.sceneId}" has no start frame yet. Render or pick one first.`, { sceneId: scene.sceneId });
    return { key: path, sceneId: scene.sceneId, label: scene.label || '', imageId: scene.referenceImageId };
  });
  const extras = [];
  for (const [i, scene] of members.entries()) {
    const refs = await musicVideoClipReferences({ projectId: project.id, sceneId: scene.sceneId }, MUSIC_VIDEO_MAX_REFERENCE_CHOICES, { project, excludePath: frames[i].key });
    extras.push(refs.map((ref) => ({ key: ref.path, label: ref.label, role: ref.role || 'character', imageId: basename(ref.path), ...(ref.comparison ? { comparison: ref.comparison } : {}) })));
  }
  return unionSequenceTakeReferences({ frames, extras, max: model.referenceImages.max });
}

/**
 * Plan (and with `dryRun: false`, queue) one sequence take.
 * Body: `{ sceneIds, modelId?, resolution?, prompt?, dryRun? }`. A `prompt` is
 * sent exactly as written, with no additions.
 */
export async function sequenceTake(projectId, { sceneIds, modelId: requestedModelId, resolution: requestedResolution, prompt: override, dryRun = false } = {}) {
  const [{ requireProject }, { musicVideoBriefAllowsVideo }] = await Promise.all([
    import('./requireProject.js'), import('../../lib/musicVideoMediumPlan.js'),
  ]);
  const project = await requireProject(projectId);
  if (!musicVideoBriefAllowsVideo(project)) {
    refuse(409, 'MUSIC_VIDEO_NO_VIDEO_TOOL', 'No video tool is selected in this project\'s brief, so generated footage is not dispatched.');
  }
  const modelId = requestedModelId || defaultSequenceTakeModelId(project);
  const modelProblem = sequenceTakeModelProblem(modelId);
  if (modelProblem) refuse(400, 'SEQUENCE_TAKE_MODEL', modelProblem);
  const model = getFalVideoModel(modelId);
  const run = sequenceTakeRun(project, sceneIds);
  if (!run.ok) refuse(run.code === 'SEQUENCE_TAKE_SCENE_MISSING' ? 404 : 400, run.code, run.reason);
  if (run.durationSec > model.duration.max + 1e-6) {
    refuse(400, 'SEQUENCE_TAKE_TOO_LONG', `These shots run ${run.durationSec}s; ${model.label} renders at most ${model.duration.max}s in one take. Pick fewer shots.`);
  }
  const { members } = run;
  const { references, omitted, overCap } = await gatherReferences(project, members, model);
  if (overCap) refuse(400, 'SEQUENCE_TAKE_TOO_MANY_FRAMES', `${model.label} takes at most ${model.referenceImages.max} reference images, fewer than these shots' frames.`);
  const seconds = coerceFalVideoSeconds(model, run.durationSec);
  const composed = composeSequenceTakePrompt({ project, members, modelId, references, seconds });
  const typed = typeof override === 'string' && override.trim() ? override : null;
  const prompt = typed ?? composed.prompt;
  const promptAdditions = typed ? [] : composed.promptAdditions;
  const resolution = requestedResolution || project?.videoSettings?.falResolution || undefined;
  const build = (referenceImageUrls) => {
    try {
      return buildFalVideoRequest({ modelId, prompt, seconds: run.durationSec, resolution, referenceImageUrls, promptExpansion: SEQUENCE_PROMPT_EXPANSION });
    } catch (err) {
      if (err?.code !== 'FAL_MODEL_INPUT') throw err;
      return refuse(400, 'VALIDATION_ERROR', err.message);
    }
  };
  // Placeholders: the preview shows the body's shape, never local file paths.
  const preview = build(references.map((_, i) => `pending:reference-${i + 1}`));
  const plan = {
    modelId,
    modelLabel: model.label,
    sceneIds: members.map((scene) => scene.sceneId),
    runSec: run.durationSec,
    seconds: preview.seconds,
    resolution: preview.resolution,
    estimatedCostUsd: preview.estimatedCostUsd,
    prompt,
    composedPrompt: composed.prompt,
    promptAdditions,
    promptOverride: Boolean(typed),
    references: references.map(({ kind, sceneId, label, role, imageId }) => ({ kind, ...(sceneId ? { sceneId } : {}), label, ...(role ? { role } : {}), imageId })),
    omittedReferences: omitted,
    maxReferences: model.referenceImages.max,
    windows: composed.windows,
    body: preview.body,
  };
  if (dryRun) return { dryRun: true, ...plan };

  const [{ assertShotActionContract }, { captureTakeDependencies }, { musicVideoAspect }, { enqueueJob }] = await Promise.all([
    import('../../lib/musicVideoActionContract.js'), import('../../lib/musicVideoDependencies.js'),
    import('../../lib/musicVideoAspect.js'), import('../mediaJobQueue/index.js'),
  ]);
  members.forEach((scene) => assertShotActionContract(scene));
  const built = build(references.map((ref) => ref.key));
  const aspect = musicVideoAspect(project);
  const dependencies = Object.fromEntries(members.map((scene) => [scene.sceneId, captureTakeDependencies(scene, basename(scene.referenceImageId))]));
  const params = {
    mode: 'fal',
    videoMode: 'text',
    modelId,
    prompt,
    negativePrompt: '',
    duration: built.seconds,
    ...(built.resolution ? { resolution: built.resolution } : {}),
    ...(aspect ? { aspectRatio: aspect, frameAspect: aspect } : {}),
    referenceImagePaths: references.map((ref) => ref.key),
    ...(promptAdditions.length ? { promptAdditions } : {}),
    // No sceneId: the per-scene hooks ignore this job; the sequence-take hook files it on every shot.
    musicVideo: { projectId, sequenceTake: { sceneIds: plan.sceneIds, windows: composed.windows } },
    musicVideoSequenceDependencies: dependencies,
    ...(Number.isFinite(built.estimatedCostUsd) ? { musicVideoCostUsd: built.estimatedCostUsd, musicVideoCostModelId: modelId } : {}),
  };
  const { jobId } = await enqueueJob({ kind: 'video', owner: `music-video-sequence-take:${projectId}`, params });
  console.log(`🎞️ music-video sequence take ${projectId.slice(0, 8)} [${plan.sceneIds.join(', ')}] → one ${built.seconds}s fal request ${jobId.slice(0, 8)}`);
  return { dryRun: false, jobId, ...plan };
}
