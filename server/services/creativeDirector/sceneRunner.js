/**
 * Creative Director — server-side scene render orchestrator.
 *
 * Render submission, last-frame extraction, and queue-completion handling
 * are all mechanical operations — no LLM cognition required. We do them
 * directly here instead of paying for a Claude task that would just shell
 * out to the same HTTP endpoints. Once the render lands, we hand off to
 * an `evaluate` agent task whose ONLY job is the cognitive step (read the
 * thumbnail, score it against the style spec + scene intent, accept or
 * request a re-render).
 *
 * Lifecycle for a single scene:
 *   1. updateScene(status='rendering', renderedJobId=null)
 *   2. resolve sourceImageFile (extract last-frame of prior scene if
 *      `useContinuationFromPrior`; else use scene.sourceImageFile if any;
 *      else text-to-video).
 *   3. enqueueJob into mediaJobQueue with owner=`cd:<projectId>:<sceneId>`.
 *   4. listen for mediaJobEvents 'completed'/'failed' for that jobId.
 *   5a. on 'completed': updateScene(renderedJobId, status='evaluating')
 *       and enqueue evaluate agent task.
 *   5b. on 'failed': bump retryCount; if < 3, retry with same prompt; else
 *       updateScene(status='failed') and let completionHook decide what to
 *       do next.
 *
 * Each call sets up its own event listeners and detaches them on settle.
 * Multiple concurrent runners are not expected (the queue serializes
 * renders) but the listener is jobId-scoped so concurrent calls would be
 * isolated anyway.
 */

import { join, basename, resolve as resolvePath, sep as PATH_SEP } from 'path';
import { existsSync } from 'fs';
import { PATHS } from '../../lib/fileUtils.js';
import { presetToRenderParams } from '../../lib/creativeDirectorPresets.js';
import { extractEvaluationFrames, safeUnder } from '../../lib/ffmpeg.js';
import { extractLastFrame } from '../videoGen/local.js';
import { enqueueJob, mediaJobEvents } from '../mediaJobQueue/index.js';
import { getSettings } from '../settings.js';
import { updateScene, getProject } from './local.js';
import { enqueueEvaluateTask } from './agentBridge.js';

const MAX_SCENE_RETRIES = 3;

/**
 * Kick off a render for a single scene. Returns the jobId; the caller does
 * not need to await completion — the listener installed here will spawn
 * the evaluate task or schedule a retry.
 */
export async function runSceneRender(project, scene) {
  console.log(`🎞️  CD scene render starting: ${project.id} / ${scene.sceneId} (order ${scene.order}, attempt ${(scene.retryCount || 0) + 1}/${MAX_SCENE_RETRIES + 1})`);

  await updateScene(project.id, scene.sceneId, {
    status: 'rendering',
    renderedJobId: null,
  });

  const settings = await getSettings();
  const pythonPath = settings.imageGen?.local?.pythonPath || null;
  // Fail fast when local video gen isn't configured. Without this guard the
  // job would be enqueued, fail inside `generateVideo`, retry up to
  // MAX_SCENE_RETRIES, and pollute the persisted queue with N doomed entries
  // — none of which can ever succeed without operator intervention. Mark
  // the scene failed and let advanceAfterSceneSettled flag the project so
  // the user can configure pythonPath and Resume from the UI.
  if (!pythonPath) {
    console.log(`❌ CD scene ${scene.sceneId}: local video gen not configured (settings.imageGen.local.pythonPath missing)`);
    await updateScene(project.id, scene.sceneId, {
      status: 'failed',
      evaluation: {
        accepted: false,
        notes: 'Local video generation is not configured — set settings.imageGen.local.pythonPath in Settings > Image Gen.',
        sampledAt: new Date().toISOString(),
      },
    });
    const { advanceAfterSceneSettled } = await import('./completionHook.js');
    await advanceAfterSceneSettled(project.id);
    return null;
  }

  // Resolve the source image:
  //  - useContinuationFromPrior=true → extract the prior accepted scene's
  //    last frame and use that as the source.
  //  - else if scene.sourceImageFile set → use that file.
  //  - else → text-to-video (no source).
  let sourceImageFile = scene.sourceImageFile || null;
  if (scene.useContinuationFromPrior) {
    const fresh = await getProject(project.id);
    const priorScene = (fresh?.treatment?.scenes || [])
      .filter((s) => s.order < scene.order && s.status === 'accepted')
      .sort((a, b) => b.order - a.order)[0];
    if (priorScene?.renderedJobId) {
      const lf = await extractLastFrame(priorScene.renderedJobId).catch((e) => {
        console.log(`⚠️ CD last-frame for ${priorScene.renderedJobId} failed: ${e.message}`);
        return null;
      });
      if (lf?.filename) {
        sourceImageFile = lf.filename;
      } else {
        console.log(`⚠️ CD scene ${scene.sceneId} requested continuation but last-frame extract failed — falling back to text-to-video`);
      }
    } else {
      console.log(`⚠️ CD scene ${scene.sceneId} requested continuation but no prior accepted scene exists — falling back`);
    }
  }

  // Resolve sourceImageFile to an absolute path if it's a basename in the
  // gallery. Two-layer guard:
  //  1. basename() strips any path segments (so `../../etc/passwd` →
  //     `passwd`); reject `.`/`..` outright.
  //  2. resolve + prefix-check against the images root so a unicode trick
  //     can't escape PATHS.images.
  // Without these, `sourceImageFile: '..'` from a malicious / mistaken
  // payload could resolve to PATHS.images's parent and feed an arbitrary
  // local path into the renderer.
  let sourceImagePath = null;
  if (sourceImageFile) {
    const safe = basename(sourceImageFile);
    if (!safe || safe === '.' || safe === '..') {
      console.log(`⚠️ CD scene ${scene.sceneId} sourceImageFile rejected (dot segment): ${sourceImageFile}`);
    } else {
      const imagesRoot = resolvePath(PATHS.images) + PATH_SEP;
      const localPath = resolvePath(join(PATHS.images, safe));
      if (localPath.startsWith(imagesRoot) && existsSync(localPath)) {
        sourceImagePath = localPath;
      } else {
        console.log(`⚠️ CD scene ${scene.sceneId} sourceImageFile not found on disk: ${sourceImageFile}`);
      }
    }
  }

  const renderParams = presetToRenderParams({
    aspectRatio: project.aspectRatio,
    quality: project.quality,
    durationSeconds: scene.durationSeconds,
  });

  const params = {
    pythonPath,
    prompt: scene.prompt,
    negativePrompt: scene.negativePrompt || '',
    modelId: project.modelId,
    width: renderParams.width,
    height: renderParams.height,
    numFrames: renderParams.numFrames,
    fps: renderParams.fps,
    steps: renderParams.steps,
    guidanceScale: renderParams.guidanceScale,
    tiling: 'auto',
    sourceImagePath,
    mode: sourceImagePath ? 'image' : 'text',
    // Smoke-test / dev knob: skips the mlx_video audio-gen pass to cut
    // wall-clock per scene roughly in half. Project-level so every scene
    // in the project inherits the same setting.
    disableAudio: project.disableAudio === true,
  };

  const owner = `cd:${project.id}:${scene.sceneId}`;
  const { jobId } = enqueueJob({ kind: 'video', params, owner });

  // Wire one-shot listeners scoped to this jobId so we can hand off to the
  // evaluator on success or schedule a retry on failure. mediaJobEvents
  // fires `completed`, `failed`, and `canceled` from the queue's runJob /
  // cancelJob handlers — we MUST listen for all three or a user-initiated
  // cancel via the Render Queue UI would leave the scene stuck in
  // `rendering` forever and leak listeners.
  const onCompleted = async (job) => {
    if (job.id !== jobId) return;
    cleanup();
    await handleRenderCompleted(project.id, scene.sceneId, jobId);
  };
  const onFailed = async (job) => {
    if (job.id !== jobId) return;
    cleanup();
    await handleRenderFailed(project.id, scene.sceneId, job.error || 'render failed');
  };
  const onCanceled = async (job) => {
    if (job.id !== jobId) return;
    cleanup();
    // Treat user-initiated cancel as a terminal stop for this scene — do
    // NOT route through handleRenderFailed (which would retry up to
    // MAX_SCENE_RETRIES); the user explicitly stopped this. Mark the scene
    // failed and let the completionHook flag the project so the user can
    // resume from the UI.
    await handleRenderCanceled(project.id, scene.sceneId);
  };
  function cleanup() {
    mediaJobEvents.off('completed', onCompleted);
    mediaJobEvents.off('failed', onFailed);
    mediaJobEvents.off('canceled', onCanceled);
  }
  mediaJobEvents.on('completed', onCompleted);
  mediaJobEvents.on('failed', onFailed);
  mediaJobEvents.on('canceled', onCanceled);

  return jobId;
}

async function handleRenderCompleted(projectId, sceneId, jobId) {
  console.log(`✅ CD scene render done: ${projectId} / ${sceneId} → ${jobId.slice(0, 8)}`);
  const fresh = await getProject(projectId);
  if (!fresh) return;
  const scene = fresh.treatment?.scenes?.find((s) => s.sceneId === sceneId);
  if (!scene) return;
  // autoAcceptScenes — smoke-test path that bypasses the cognitive evaluator.
  // Mark the scene accepted with a synthetic evaluation, drop the rendered
  // video into the project's collection, and let the orchestrator advance.
  // No Claude task spawned, so a smoke run completes in render time only.
  if (fresh.autoAcceptScenes === true) {
    await updateScene(projectId, sceneId, {
      status: 'accepted',
      renderedJobId: jobId,
      evaluation: {
        accepted: true,
        score: 1,
        notes: 'auto-accepted (autoAcceptScenes)',
        sampledAt: new Date().toISOString(),
      },
    });
    if (fresh.collectionId) {
      const { addItem } = await import('../mediaCollections.js');
      await addItem(fresh.collectionId, { kind: 'video', ref: jobId })
        .catch((e) => console.log(`⚠️ CD auto-accept addItem failed: ${e.message}`));
    }
    const { advanceAfterSceneSettled } = await import('./completionHook.js');
    await advanceAfterSceneSettled(projectId);
    return;
  }
  // Sample 5 evenly-spaced frames so the evaluator can judge intent across
  // the full timeline rather than only the opening pose. i2v scenes whose
  // payoff lands mid- or late-clip (archway appearing, light bloom) were
  // getting rejected when the agent only saw frame 0.
  const videoPath = safeUnder(PATHS.videos, `${jobId}.mp4`);
  const evaluationFrames = videoPath
    ? await extractEvaluationFrames(videoPath, jobId, 5).catch((e) => {
        console.log(`⚠️ CD multi-frame extract failed for ${jobId.slice(0, 8)}: ${e.message}`);
        return [];
      })
    : [];
  if (evaluationFrames.length > 0) {
    console.log(`🎞️ CD sampled ${evaluationFrames.length} evaluator frames for ${sceneId} (${jobId.slice(0, 8)})`);
  }

  await updateScene(projectId, sceneId, {
    status: 'evaluating',
    renderedJobId: jobId,
    evaluationFrames,
  });
  await enqueueEvaluateTask(fresh, {
    ...scene,
    status: 'evaluating',
    renderedJobId: jobId,
    evaluationFrames,
  });
}

async function handleRenderCanceled(projectId, sceneId) {
  console.log(`🛑 CD scene ${sceneId} render canceled by user`);
  await updateScene(projectId, sceneId, {
    status: 'failed',
    evaluation: {
      accepted: false,
      notes: 'Render canceled by user',
      sampledAt: new Date().toISOString(),
    },
  });
  const { advanceAfterSceneSettled } = await import('./completionHook.js');
  await advanceAfterSceneSettled(projectId);
}

async function handleRenderFailed(projectId, sceneId, errorMsg) {
  const fresh = await getProject(projectId);
  if (!fresh) return;
  const scene = fresh.treatment?.scenes?.find((s) => s.sceneId === sceneId);
  if (!scene) return;
  const nextRetry = (scene.retryCount || 0) + 1;
  if (nextRetry <= MAX_SCENE_RETRIES) {
    console.log(`🔁 CD scene ${sceneId} render failed (${errorMsg}) — retry ${nextRetry}/${MAX_SCENE_RETRIES}`);
    await updateScene(projectId, sceneId, { status: 'pending', retryCount: nextRetry });
    const updated = { ...scene, retryCount: nextRetry };
    await runSceneRender(fresh, updated);
    return;
  }
  console.log(`❌ CD scene ${sceneId} render failed terminally: ${errorMsg}`);
  await updateScene(projectId, sceneId, {
    status: 'failed',
    evaluation: {
      accepted: false,
      notes: `Render failed: ${errorMsg}`,
      sampledAt: new Date().toISOString(),
    },
  });
  // The completionHook will be triggered when the evaluate-step is skipped;
  // here we delegate by directly invoking the hook's logic via a synthetic
  // re-evaluation of project state. Simplest: import and call.
  const { advanceAfterSceneSettled } = await import('./completionHook.js');
  await advanceAfterSceneSettled(projectId);
}
