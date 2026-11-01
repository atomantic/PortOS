import { effectiveJobPrompt } from '../lib/federatedMediaWire.js';
/**
 * Music Video scene reference-frame attach hook (issue #1760, Phase 1b).
 *
 * Subscribes to mediaJobEvents and, for each completed image job that carries
 * `params.musicVideo`, appends the rendered filename to that project scene's
 * immutable takes (#8965) — server-side, independent of any mounted client. The
 * take becomes the scene's `referenceImageId` only while that slot is still
 * unselected. It replaces a selected frame only when the job tag sets
 * `replaceSelection` (a one-tap re-render). This is
 * the durable counterpart to the director board's optimistic generate-then-
 * attach: a long-running local/Codex render that completes after the user
 * navigated away, refreshed, or moved their cursor still lands on the scene
 * (otherwise the image reaches the gallery but the scene link is lost).
 *
 * Only the async local/Codex lanes ride the media-job queue this hook listens
 * to. The synchronous external SD-API lane returns its filename inline and the
 * client PATCHes `referenceImageId` directly — the same split the writers-room
 * (#1363) and catalog (#1359) hooks document.
 *
 * `updateScene` routes through the project store dispatcher, so the attach also
 * emits a `musicVideoProject` record-updated event — the new `referenceImageId`
 * propagates to subscribed sync peers exactly like a hand edit. On success the
 * hook emits `musicVideoEvents` 'scene-image', which socket.js bridges to the
 * client so the board updates reactively.
 *
 * The shared completion-hook scaffold (tag-decode, per-project serialization,
 * best-effort error handling, idempotent init/reset) lives in `createMediaJobImageHook` (#1791) — this file is just the
 * music-video-specific config. Mounted once at server boot from server/index.js
 * (after the media job queue is running).
 */

import { createMediaJobImageHook } from './mediaJobImageHook.js';
import { appendSceneTakes } from './musicVideo/projects.js';
import { musicVideoEvents } from './musicVideo/events.js';
import { recordSceneLastFailure } from './musicVideo/sceneFailure.js';

const hook = createMediaJobImageHook({
  label: 'music-video scene-image',
  initLog: '🎞️ Music Video scene-image hook initialized',
  tagKey: 'musicVideo',
  // Require both ids; the tag is otherwise ambiguous about which scene to file.
  identify: (tag) => (tag?.projectId && tag.sceneId
    ? { projectId: tag.projectId, sceneId: tag.sceneId }
    : null),
  // Serialize per PROJECT: two scene renders for the same project completing
  // close together would otherwise both load→modify→save the one project record
  // (file backend) and the later write would clobber the earlier scene's
  // `referenceImageId`. Different projects still attach concurrently.
  serializeKey: ({ projectId }) => projectId,
  // No newest-render-wins guard (#8965): renders that complete out of order
  // are all kept as takes, and none of them can displace a selection, so an
  // older render is a candidate rather than something to drop.
  describe: ({ projectId, sceneId }) => `${projectId}/${sceneId}`,
  // A deleted project/scene 404s here, so a late completion can't resurrect it.
  // A render tagged `slot: 'end'` (#11173) is a candidate for the scene's
  // style-break end frame, never its start frame.
  attach: ({ projectId, sceneId, filename, job }) => {
    const tag = job.params?.musicVideo || {};
    return appendSceneTakes(projectId, sceneId, [{
      kind: tag.slot === 'end' ? 'endImage' : 'image',
      assetId: filename,
      source: 'generated',
      provider: 'portos',
      jobId: typeof job.id === 'string' ? job.id : null,
      prompt: effectiveJobPrompt(job),
      // Copied from the submit, not recomputed: a long render can finish after Casting changes.
      ...(tag.castInputs ? { castInputs: tag.castInputs } : {}),
      ...(tag.replaceSelection === true ? { replaceSelection: true } : {}),
    }]);
  },
  onAttached: ({ projectId, sceneId, filename, job }, { scene, appended }) => {
    musicVideoEvents.emit('scene-image', {
      projectId,
      sceneId,
      referenceImageId: scene.referenceImageId ?? null,
      endImageId: scene.endImageId ?? null,
      takes: scene.takes,
      // A landed frame retires this lane's recorded failure (takes.js).
      lastFailure: scene.lastFailure ?? null,
      takeId: appended[0]?.takeId ?? null,
    });
    console.log(`🎞️ music-video scene image take ${projectId.slice(0, 8)}/${sceneId} ← ${filename}`);
    const thenClip = job?.params?.musicVideo?.thenClip;
    // Detached: the clip submission writes the project, which this hook's per-project queue must not wait on.
    if (thenClip && scene.referenceImageId === filename) void animateStoryboardStill({ ...thenClip, projectId, sceneId, still: filename });
  },
  // A render that FAILED (a cancel is not a failure) is recorded on the scene
  // so the board can say which scene failed and why, including after a reload.
  // An end-frame render's failure is only toasted: the scene's failure chip
  // retries the start frame, which is not what failed.
  onTerminal: (ctx, status, job) => (job?.params?.musicVideo?.slot === 'end' ? undefined : recordSceneLastFailure(ctx, status, job, 'image')),
});

/**
 * Clip from storyboard: the still this render made is now the shot's selection,
 * so animate it. A refusal (no prompt, a lane that is off) is recorded on the
 * shot's video lane, where its Retry is.
 */
async function animateStoryboardStill({ projectId, sceneId, still, backend = null, model = null }) {
  try {
    const { requireProject } = await import('./musicVideo/requireProject.js');
    const { dispatchStoryboardStillClip } = await import('./musicVideo/productionDispatch.js');
    const project = await requireProject(projectId);
    const scene = project.scenes?.find((s) => s.sceneId === sceneId);
    // Only the still this render made: a selection that changed meanwhile is the director's call.
    if (!scene?.referenceImageId || scene.referenceImageId !== still) return;
    const { jobId } = await dispatchStoryboardStillClip({ project, scene, backend, model });
    console.log(`🎬 music-video storyboard clip queued ${projectId.slice(0, 8)}/${sceneId} → ${jobId}`);
  } catch (err) {
    console.log(`🚫 music-video storyboard clip refused ${projectId.slice(0, 8)}/${sceneId}: ${err.message}`);
    await recordSceneLastFailure({ projectId, sceneId }, 'failed', { error: err.message }, 'video').catch((e) => {
      console.error(`❌ music-video storyboard clip failure not recorded ${projectId.slice(0, 8)}/${sceneId}: ${e.message}`);
    });
  }
}

export function initMusicVideoSceneImageHook() {
  hook.init();
}

// Test-only reset so suites that re-init can do so cleanly.
export const __testing = hook.__testing;
