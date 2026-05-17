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

import { join } from 'path';
import { PATHS, resolveGalleryImage } from '../../lib/fileUtils.js';
import { verifyVideoPlayable } from '../../lib/ffmpeg.js';
import { presetToRenderParams } from '../../lib/creativeDirectorPresets.js';
import { extractLastFrame, sampleEvaluationFrames } from '../videoGen/local.js';
import { enqueueJob, mediaJobEvents } from '../mediaJobQueue/index.js';
import { getSettings } from '../settings.js';
import { updateScene, updateProject, getProject } from './local.js';
import { enqueueEvaluateTask } from './agentBridge.js';

const MAX_SCENE_RETRIES = 3;

// Default image strength when an i2v continuation scene has no explicit
// per-scene `imageStrength`. Anchors the next clip to the prior last-frame
// hard enough to preserve scene geometry (subject, camera, palette) while
// still allowing motion. Lower values let the model drift; higher values
// can cause near-still frames. 0.85 lands near the sweet spot in practice.
export const DEFAULT_CONTINUATION_IMAGE_STRENGTH = 0.85;

export function resolveImageStrength({ explicit, isContinuation }) {
  if (explicit != null) return explicit;
  if (isContinuation) return DEFAULT_CONTINUATION_IMAGE_STRENGTH;
  return null;
}

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
  //
  // `continuationFellBack` records that the scene asked for i2v continuation
  // but we couldn't honor it (prior scene's last frame missing/unextractable
  // or no accepted prior scene at all) and silently degraded to text-to-
  // video. The autoAccept path uses this to fail the scene instead of
  // accepting a render that proves nothing about the i2v chaining mechanics
  // — otherwise the smoke test would report green even when continuation is
  // broken.
  let sourceImageFile = scene.sourceImageFile || null;
  let continuationFellBack = false;
  // Track whether `sourceImageFile` was assigned via the continuation
  // branch (vs. being a user-supplied scene.sourceImageFile). If it
  // was, and the path-resolution step below later drops it as missing
  // or invalid, we need to flag continuationFellBack — otherwise the
  // smoke-test autoAccept path silently reports a green render even
  // though the actual i2v chaining never engaged.
  let continuationSourceFromExtract = false;
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
        continuationSourceFromExtract = true;
      } else {
        console.log(`⚠️ CD scene ${scene.sceneId} requested continuation but last-frame extract failed — falling back to text-to-video`);
        continuationFellBack = true;
      }
    } else {
      console.log(`⚠️ CD scene ${scene.sceneId} requested continuation but no prior accepted scene exists — falling back`);
      continuationFellBack = true;
    }
  }

  const sourceImagePath = sourceImageFile ? resolveGalleryImage(sourceImageFile) : null;
  if (sourceImageFile && !sourceImagePath) {
    console.log(`⚠️ CD scene ${scene.sceneId} sourceImageFile rejected or missing on disk: ${sourceImageFile}`);
  }
  // If the continuation branch above produced a sourceImageFile but the
  // path-resolution step just dropped it (file missing, dot-segment, or
  // outside PATHS.images), the render will silently fall through to
  // text-to-video. Surface that as a continuation fallback so the
  // smoke-test autoAccept guard still catches it — otherwise the test
  // could report a green render that proves nothing about i2v chaining.
  if (continuationSourceFromExtract && !sourceImagePath) {
    console.log(`⚠️ CD scene ${scene.sceneId} continuation last-frame resolved to no file — flagging as fallback`);
    continuationFellBack = true;
  }

  const renderParams = presetToRenderParams({
    aspectRatio: project.aspectRatio,
    quality: project.quality,
    durationSeconds: scene.durationSeconds,
  });

  // Resolve effective image strength. Continuation renders that don't pin a
  // strength tend to drift hard from the seed (a "blue ball" continuation
  // generates a totally new scene that loosely starts from the seed) — so
  // anchor i2v continuation scenes at 0.85 by default. Explicit per-scene
  // values from the treatment / evaluator override the default; null
  // outside continuation lets the renderer apply its own default.
  const effectiveImageStrength = resolveImageStrength({
    explicit: scene.imageStrength,
    isContinuation: continuationSourceFromExtract && !!sourceImagePath,
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
    imageStrength: effectiveImageStrength,
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
    await handleRenderCompleted(project.id, scene.sceneId, jobId, { continuationFellBack });
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

async function handleRenderCompleted(projectId, sceneId, jobId, opts = {}) {
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
    // If the scene asked for i2v continuation but the runner silently fell
    // back to text-to-video (prior render's last frame was missing or
    // unextractable), we MUST fail here. Otherwise the smoke test would
    // report green even when continuation chaining is broken — exactly the
    // regression this fixture is supposed to catch.
    //
    // Bypass handleRenderFailed: that function retries up to
    // MAX_SCENE_RETRIES, and a broken last-frame extraction will fail the
    // same way every retry — burning three more full renders before
    // surfacing the regression. Mark terminal directly and let the
    // completion hook decide what to do next.
    if (opts.continuationFellBack && scene.useContinuationFromPrior) {
      const reason = `scene ${sceneId} requested continuation but fell back to text-to-video`;
      console.log(`❌ CD auto-accept: ${reason} — failing the entire smoke project so the regression is visible immediately (one accepted scene + later failures would still stitch + complete and hide this).`);
      // Failing only the scene isn't enough: advanceAfterSceneSettled keeps
      // going as long as at least one scene was accepted, which would then
      // stitch the surviving clips into a `complete` project and report the
      // smoke run as green even though i2v chaining is provably broken.
      // Fail the whole project so the smoke fixture goes red.
      await updateScene(projectId, sceneId, {
        status: 'failed',
        evaluation: {
          accepted: false,
          notes: `Render failed: ${reason}`,
          sampledAt: new Date().toISOString(),
        },
      });
      await updateProject(projectId, {
        status: 'failed',
        failureReason: `i2v continuation regression detected: ${reason}`,
      }).catch((e) => console.log(`⚠️ CD updateProject(failed) for ${projectId} failed: ${e.message}`));
      return;
    }
    const videoPath = join(PATHS.videos, `${jobId}.mp4`);
    const playable = await verifyVideoPlayable(videoPath);
    if (!playable.ok) {
      const reason = playable.reason || 'video file unplayable';
      console.log(`❌ CD auto-accept: video unplayable for ${jobId.slice(0, 8)}: ${reason} — failing smoke project directly (retrying would waste renders; a broken render must not produce a green smoke result).`);
      await updateScene(projectId, sceneId, {
        status: 'failed',
        evaluation: {
          accepted: false,
          notes: `Render failed: ${reason}`,
          sampledAt: new Date().toISOString(),
        },
      });
      await updateProject(projectId, {
        status: 'failed',
        failureReason: `unplayable render detected: ${reason}`,
      }).catch((e) => console.log(`⚠️ CD updateProject(failed) for ${projectId} failed: ${e.message}`));
      return;
    }
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
  // Helper: persist the completed render and skip the evaluator. The
  // pause/fail-aware path keeps the scene in `evaluating` with the
  // renderedJobId set so resume can pick up evaluation directly without
  // re-rendering. completionHook#advanceAfterSceneSettled detects
  // orphaned `evaluating` scenes (renderedJobId set, no live evaluate
  // run in runs[]) and re-fires the evaluator — closing the loop without
  // wasting the rendered clip.
  const skipEvaluatorForPause = async (statusLabel, frames) => {
    await updateScene(projectId, sceneId, {
      status: 'evaluating',
      renderedJobId: jobId,
      evaluationFrames: frames,
    });
    console.log(`⏸️  CD project ${projectId} is ${statusLabel} — render landed during pause; persisting renderedJobId on scene ${sceneId} and deferring evaluator to resume.`);
  };
  // Pre-frame-sample status check: a user pause that landed while the
  // render was in flight should short-circuit BEFORE we burn ffprobe +
  // ffmpeg cycles writing throwaway thumbnails. Frames will be sampled
  // on resume by advanceAfterSceneSettled instead.
  const preFrames = await getProject(projectId);
  if (preFrames?.status === 'paused' || preFrames?.status === 'failed') {
    await skipEvaluatorForPause(preFrames.status, []);
    return;
  }
  const evaluationFrames = await sampleEvaluationFrames(jobId).catch((err) => {
    console.error(`❌ CD sampleEvaluationFrames failed for ${jobId.slice(0, 8)}: ${err.message}`);
    return [];
  });
  // Re-check immediately before the agent-task enqueue. Single-user
  // single-instance app per CLAUDE.md, but pause IS a real user action
  // and the API roundtrip can land between this read and the enqueue
  // below. The cost of one extra read is trivial vs. spending an agent
  // run on work the user explicitly canceled.
  const postFrames = await getProject(projectId);
  if (postFrames?.status === 'paused' || postFrames?.status === 'failed') {
    await skipEvaluatorForPause(postFrames.status, evaluationFrames);
    return;
  }
  await updateScene(projectId, sceneId, {
    status: 'evaluating',
    renderedJobId: jobId,
    evaluationFrames,
  });
  // Final pause guard: close the async gap between the postFrames check above
  // and the enqueue below. The scene is already persisted in 'evaluating' with
  // renderedJobId set, so advanceAfterSceneSettled's resume path will pick it
  // up correctly on the next Resume click — no further action needed here.
  const postUpdate = await getProject(projectId);
  if (postUpdate?.status === 'paused' || postUpdate?.status === 'failed') {
    console.log(`⏸️  CD project ${projectId} is ${postUpdate.status} — paused during updateScene; renderedJobId persisted on scene ${sceneId}, deferring evaluator to resume.`);
    return;
  }
  await enqueueEvaluateTask(fresh, { ...scene, renderedJobId: jobId, status: 'evaluating', evaluationFrames });
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
