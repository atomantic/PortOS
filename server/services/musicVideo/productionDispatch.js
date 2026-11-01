import { currentPlateEvidence } from '../../lib/musicVideoPlateEvidence.js';
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
 *
 * A STANDALONE auto-review run's revised sections (#10014) ride the same
 * lanes with a tag that names no production run: only the production-step
 * reservation is skipped, the revision guard still charges the spend limit.
 */

import { withMusicVideoStyle } from './styleReferences.js';
import { ServerError } from '../../lib/errorHandler.js';
import { resolveGalleryImage, resolveImageInputPath } from '../../lib/pathSafety.js';
import { RENDER_TARGET } from '../../lib/renderTargets.js';
import { falSceneTake, falTakeRequestFields, grokCoverage, runwaySceneTake, runwayTakeRequestFields } from '../../lib/musicVideoShotTiming.js';
import { authoredShotPrompt, musicVideoFrameModelInput } from '../../lib/musicVideoShotPrompt.js';
import { sceneEndFrameRequestFields } from '../../lib/musicVideoEndFrame.js';
import { preMusicClipSound } from '../../lib/musicVideoColdOpen.js';
import { conditioningReferences, falRouteVideoSettings, runwayRouteVideoSettings } from './productionPool.js';
import { loadSceneCastMedia } from './castGuideMedia.js';
import { castInputsFromReferences } from '../../lib/musicVideoCastLook.js';
import { musicVideoFrameGenSize } from '../../lib/musicVideoAspect.js';

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
  const repairing = project.productionRuns?.find((run) => run.id === tag.productionRunId)?.steps?.find((step) => step.key === tag.productionStepKey)?.plateRepairBasis;
  const unmet = repairing ? (scene.takes || []).flatMap((take) => currentPlateEvidence(scene, take)?.checks.filter((check) => check.status === 'fail').map((check) => `${check.requirement}: ${check.note}`) || []) : [];
  // The autonomous run's stills review names what the last still got wrong (autonomousService.js).
  const fixes = typeof scene.stillFixes?.text === 'string' ? scene.stillFixes.text : '';
  const { loadMusicVideoGreybox } = await import('./greyboxReferences.js');
  const greybox = await loadMusicVideoGreybox(project, scene);
  // A Casting guide may live in any image-input root (catalog.js validates it with resolveImageInputPath).
  const chosen = conditioningReferences(project, scene, await loadSceneCastMedia(scene), greybox);
  const sent = [];
  const referenceImagePaths = [];
  for (const ref of chosen) {
    const path = ref.greybox ? greybox.path : ref.castGuide ? resolveImageInputPath(ref.imageId) : resolveGalleryImage(ref.imageId, { mustExist: false });
    if (!path) continue;
    referenceImagePaths.push(path);
    sent.push(ref);
  }
  const { loadLinkedStoryboardPanel } = await import('./linkedPanel.js');
  const panel = await loadLinkedStoryboardPanel(project, scene);
  const panelReference = scene.panelArt ? sent.findIndex((ref) => ref.imageId === scene.panelArt) + 1 : 0;
  const { prompt, promptAdditions } = musicVideoFrameModelInput(project, scene, { repairs: unmet, fixes, greybox, panel, panelReference });
  if (!prompt) throw unprompted(scene, 'frame');
  const [{ resolveRenderTargetConfig }, { resolveImageCleaners }, { enqueueJob }] = await Promise.all([
    import('../imageGen/cloudProviderConfig.js'),
    import('../../lib/imageCleanDefaults.js'),
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
    ...(promptAdditions.length ? { promptAdditions } : {}),
    // The project's aspect, never the backend's per-prompt choice (a portrait
    // close-up pillarboxes in a 16:9 render).
    ...musicVideoFrameGenSize(project),
    cleanC2PA,
    denoise,
    ...(referenceImagePaths.length ? { referenceImagePaths, referenceImageStrengths: referenceImagePaths.map(() => 1) } : {}),
    // Stamp the references this enqueue sends. The hook must not re-read Casting when the job finishes.
    musicVideo: { ...tag, castInputs: castInputsFromReferences(scene, sent) },
  };
  const baseParams = resolved.cloud
    ? { ...resolved.cloud.jobParams, ...common }
    : { pythonPath: settings.imageGen?.local?.pythonPath || null, modelId: route.model, ...common };
  const params = await withMusicVideoStyle(project, baseParams, route.mode, route.model, settings);
  await guardRevision(tag, 'image');
  if (tag.productionRunId) {
    const { assertProductionSubmission } = await import('./productionService.js');
    await assertProductionSubmission(tag.projectId, tag.productionRunId, tag.productionStepKey, { sceneId: tag.sceneId, kind: 'image' });
  }
  const owner = tag.productionRunId ? `music-video-production:${tag.productionRunId}` : `music-video-auto-review:${tag.revisionId}`;
  const { jobId } = await enqueueJob({ kind: 'image', params, owner });
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
  // The director's text; the submit service composes the rest as labeled additions (#11317).
  const prompt = authoredShotPrompt(scene);
  if (!prompt) throw unprompted(scene, 'shot');
  const spanSec = typeof scene.startSec === 'number' && typeof scene.endSec === 'number' && scene.endSec > scene.startSec
    ? scene.endSec - scene.startSec : null;
  // The autonomous run's pilot repair names what the last clip got wrong (autonomousService.js).
  const fixes = typeof scene.clipFixes?.text === 'string' ? scene.clipFixes.text : '';
  const byBackend = {
    // A supplied-audio route animates the frame from its shot's own song window.
    local: route.audio === 'supplied' ? { modelId: route.model, mode: 'a2v', _suppliedAudio: true } : { modelId: route.model, disableAudio: !preMusicClipSound(scene) },
    grok: { grokDuration: spanSec != null ? grokCoverage(spanSec).requestSec : (project.videoSettings?.grokDuration || 10), disableAudio: !preMusicClipSound(scene) },
    fal: falClipParams(project, scene, route),
    reactor: { disableAudio: true },
    runway: runwayTakeRequestFields(runwaySceneTake({ scene, videoSettings: runwayRouteVideoSettings(project, route) })),
  };
  // A local model ends on the end frame only when its runtime anchors the last
  // frame (#11258), so the plan needs the model this route actually renders on.
  const localRuntime = route.mode === 'local' && scene.endImageId
    ? (await (await import('../videoGen/modelSelection.js')).resolveVideoModelSelection(route.model || undefined)).model?.runtime ?? null
    : null;
  const { submitVideoGenJob } = await import('../videoGen/submitJob.js');
  // The submit service runs the revision guard itself as its last step before
  // the queue write (submitJob.js), like every board-submitted clip.
  const { jobId } = await submitVideoGenJob({
    prompt,
    backend: route.mode,
    mode: 'image',
    sourceImageFile: scene.referenceImageId,
    ...(byBackend[route.mode] || {}),
    // A style-break end frame (#11173), when this fal or local model takes one.
    ...sceneEndFrameRequestFields(scene, {
      backend: route.mode, falModelId: byBackend.fal?.falModelId, runwayModelId: byBackend.runway?.runwayModelId, mode: byBackend[route.mode]?.mode || 'image', localRuntime,
    }),
    musicVideo: { ...tag, compose: true },
    ...(fixes ? { _clipFixes: fixes } : {}),
  }, {});
  return { jobId };
}

/**
 * Clip from storyboard's second half: animate the still the shot's storyboard
 * render just made on `backend` (the project's lane when absent). The tag names
 * that still so the review guard can admit the clip on the art approval; a
 * client cannot send that key (the video route's tag schema strips it).
 */
export function dispatchStoryboardStillClip({ project, scene, backend = null, model = null }) {
  return dispatchClip({
    project, scene,
    route: { kind: 'video', mode: backend || project.videoSettings?.backend || undefined, model },
    tag: { projectId: project.id, sceneId: scene.sceneId, storyboardStill: scene.referenceImageId },
  });
}

/**
 * Dispatch one production step. `tag` is the full `musicVideo` job tag
 * (`projectId`, `sceneId`, `productionRunId`, `productionStepKey`, optional
 * `revisionId`; a standalone auto-review section carries only `projectId`,
 * `sceneId` and `revisionId`). Returns `{ jobId }`; throws when the submission is refused.
 */
export async function dispatchProductionStep({ stepKind, project, scene, route, tag, settings }) {
  return stepKind === 'frame'
    ? dispatchFrame({ project, scene, route, tag, settings })
    : dispatchClip({ project, scene, route, tag, settings });
}
