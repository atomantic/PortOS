/**
 * Music Video production run (#9066) — server-side scene generation.
 *
 * The board's two scene lanes (`generateFrame` / `generateSceneVideo` in
 * client/src/hooks/useMusicVideoSceneMedia.js) rebuilt without a browser: the
 * same composed prompts (handoff.js), the same conditioning references, the
 * same `musicVideo` job tag the completion hooks file takes from, so a
 * production take is indistinguishable from a hand-generated one. The tag
 * additionally names the production run and step (`productionRunId`,
 * `productionStepKey`) so completion and failure events correlate to exactly
 * one step.
 *
 * Every dispatch names its route explicitly — the backend (and model) the
 * run's pool allowed — and is refused rather than resolved to anything else:
 * the image mode is checked against what the render-target resolver actually
 * picked, and the video body always carries an explicit `backend`, so the
 * install's pin ladder can never substitute a different provider.
 *
 * A step carrying a `revisionId` (the review's revision of a failed section)
 * passes the revision's enqueue-time guard first, exactly as the routes do.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { resolveGalleryImage } from '../../lib/pathSafety.js';
import { RENDER_TARGET } from '../../lib/renderTargets.js';
import { approximateMotionCues, falSceneTake, falTakeRequestFields, grokCoverage } from '../../lib/musicVideoShotTiming.js';
import { sceneFramePrompt, sceneShotPrompt } from './handoff.js';
import { conditioningReferences, falRouteVideoSettings } from './productionPool.js';

const unprompted = (scene, what) => new ServerError(
  `"${scene.label || scene.sceneId}" has no ${what} prompt to generate from`,
  { status: 422, code: 'PRODUCTION_SCENE_UNPROMPTED', context: { sceneId: scene.sceneId } },
);

async function guardRevision(tag, kind) {
  if (!tag.revisionId) return;
  const { assertRevisionOpen } = await import('./revisionService.js');
  await assertRevisionOpen(tag.projectId, tag.revisionId, { sceneId: tag.sceneId, kind });
}

/** Enqueue a scene's reference frame on exactly `route`. Returns `{ jobId }`. */
async function dispatchFrame({ project, scene, route, tag, settings }) {
  const prompt = sceneFramePrompt(project, scene);
  if (!prompt) throw unprompted(scene, 'frame');
  const referenceImagePaths = conditioningReferences(project)
    .map((ref) => resolveGalleryImage(ref.imageId, { mustExist: false })).filter(Boolean);
  const [{ resolveRenderTargetConfig }, { resolveImageCleaners }, { enqueueJob }] = await Promise.all([
    import('../imageGen/cloudProviderConfig.js'),
    import('../imageGen/index.js'),
    import('../mediaJobQueue/index.js'),
  ]);
  const resolved = resolveRenderTargetConfig(settings, RENDER_TARGET.MUSIC_VIDEO, { mode: route.mode, model: route.model });
  if (resolved.mode !== route.mode) {
    throw new ServerError(`The ${route.mode} image backend is not available; the run will not substitute ${resolved.mode}`, { status: 409, code: 'PRODUCTION_ROUTE_INELIGIBLE' });
  }
  if (resolved.cloud && !resolved.cloud.enabled) throw resolved.cloud.disabledError;
  const { cleanC2PA, denoise } = resolveImageCleaners(undefined, settings, route.mode);
  const common = {
    prompt,
    cleanC2PA,
    denoise,
    ...(referenceImagePaths.length ? { referenceImagePaths, referenceImageStrengths: referenceImagePaths.map(() => 1) } : {}),
    musicVideo: tag,
  };
  const params = resolved.cloud
    ? { ...resolved.cloud.jobParams, ...common }
    : { pythonPath: settings.imageGen?.local?.pythonPath || null, modelId: route.model, ...common };
  await guardRevision(tag, 'image');
  const { jobId } = await enqueueJob({ kind: 'image', params, owner: `music-video-production:${tag.productionRunId}` });
  return { jobId };
}

/**
 * The fal request fields for a scene clip — built from the same `falSceneTake`
 * that productionPool.stepPriceUsd charged the step, so the run pays for exactly
 * what it submits.
 */
const falClipParams = (project, scene, route) => falTakeRequestFields(falSceneTake({
  scene,
  videoSettings: falRouteVideoSettings(project, route),
  songDurationSec: project.audioAnalysis?.durationSec ?? null,
}));

/** Enqueue a scene's i2v clip on exactly `route` through the video submit service. Returns `{ jobId }`. */
async function dispatchClip({ project, scene, route, tag }) {
  if (!scene.referenceImageId) {
    throw new ServerError(`"${scene.label || scene.sceneId}" has no reference frame yet`, { status: 409, code: 'PRODUCTION_FRAME_MISSING' });
  }
  const base = sceneShotPrompt(project, scene);
  if (!base) throw unprompted(scene, 'shot');
  const spanSec = typeof scene.startSec === 'number' && typeof scene.endSec === 'number' && scene.endSec > scene.startSec
    ? scene.endSec - scene.startSec : null;
  const isGrok = route.mode === 'grok';
  const prompt = [base, isGrok ? approximateMotionCues(project.phrases, scene.startSec, scene.endSec) : ''].filter(Boolean).join('. ');
  const byBackend = {
    local: { modelId: route.model, disableAudio: true },
    grok: { grokDuration: spanSec != null ? grokCoverage(spanSec).requestSec : (project.videoSettings?.grokDuration || 10), disableAudio: true },
    fal: falClipParams(project, scene, route),
    reactor: { disableAudio: true },
  };
  const { submitVideoGenJob } = await import('../videoGen/submitJob.js');
  // The submit service runs the revision guard itself as its last step before
  // the queue write (submitJob.js), like every board-submitted clip.
  const { jobId } = await submitVideoGenJob({
    prompt,
    backend: route.mode,
    mode: 'image',
    sourceImageFile: scene.referenceImageId,
    ...(byBackend[route.mode] || {}),
    musicVideo: tag,
  }, {});
  return { jobId };
}

/**
 * Dispatch one production step. `tag` is the full `musicVideo` job tag
 * (`projectId`, `sceneId`, `productionRunId`, `productionStepKey`, optional
 * `revisionId`). Returns `{ jobId }`; throws when the submission is refused.
 */
export async function dispatchProductionStep({ stepKind, project, scene, route, tag, settings }) {
  return stepKind === 'frame'
    ? dispatchFrame({ project, scene, route, tag, settings })
    : dispatchClip({ project, scene, route, tag, settings });
}
