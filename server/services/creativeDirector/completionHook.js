/**
 * Creative Director — task-completion hook.
 *
 * Called from agentLifecycle.handleAgentCompletion when a finished agent
 * task carries `metadata.creativeDirector`. The hook decides what (if
 * anything) happens next based on the project's current state.
 *
 * Flow under the new architecture:
 *   - treatment task done → kick off render for scene 1 (server-side, no
 *     agent task) via sceneRunner.runSceneRender.
 *   - evaluate task done  → look at the scene's verdict:
 *       * `accepted`  → run the next pending scene, OR if all done, run
 *                       the stitch (server-side, no agent task).
 *       * `pending`   → the agent requested a re-render with a new
 *                       prompt; run scene render again.
 *       * `failed`    → continue on to the next scene (one bad render
 *                       shouldn't kill the whole project) OR mark project
 *                       failed if NO scene was ever accepted.
 *
 * `advanceAfterSceneSettled` is also exported for sceneRunner to call
 * directly when a render fails terminally (no evaluate task is spawned in
 * that case).
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { getProject, updateProject, updateScene, updateRun, recordRun } from './local.js';
import { enqueueTreatmentTask } from './agentBridge.js';
import { dispatchSceneEvaluation } from './sceneEvaluator.js';
import { runSceneRender } from './sceneRunner.js';
import { runStitch } from './stitchRunner.js';
import { sampleEvaluationFrames } from '../videoGen/local.js';
import { listJobs, mediaJobEvents } from '../mediaJobQueue/index.js';
import { PATHS } from '../../lib/fileUtils.js';

export async function handleCreativeDirectorCompletion(task, agentId, success) {
  const meta = task?.metadata?.creativeDirector;
  if (!meta?.projectId) return;
  const project = await getProject(meta.projectId).catch(() => null);
  if (!project) {
    console.log(`⚠️ CD completion hook: project ${meta.projectId} not found`);
    return;
  }

  // Update / create the run record so the Runs tab reflects this agent run.
  const completedAt = new Date().toISOString();
  const runId = meta.runId;
  const updatedExisting = runId
    ? await updateRun(project.id, runId, {
        agentId,
        status: success ? 'completed' : 'failed',
        completedAt,
        kind: meta.kind,
        sceneId: meta.sceneId || null,
        taskId: task.id,
      })
    : null;
  if (!updatedExisting) {
    await recordRun(project.id, {
      runId: runId || undefined,
      agentId,
      taskId: task.id,
      kind: meta.kind,
      sceneId: meta.sceneId || null,
      status: success ? 'completed' : 'failed',
      completedAt,
    }).catch((err) => console.log(`⚠️ CD recordRun failed: ${err.message}`));
  }

  if (!success) {
    // Surface a concrete reason on the project so the UI's failure banner
    // has actionable context. Without this, a project flips to 'failed'
    // with whatever stale failureReason it had before (often null), and
    // the user has no idea what happened.
    const reason = `${meta.kind} agent task failed (taskId=${task.id || '?'}, agent=${agentId || '?'})`;
    await updateProject(project.id, { status: 'failed', failureReason: reason })
      .catch((e) => console.log(`⚠️ CD updateProject(failed) for ${project.id} failed: ${e.message}`));
    console.log(`❌ CD project ${project.id} marked failed (task ${meta.kind} failed)`);
    return;
  }

  const fresh = await getProject(project.id);
  if (!fresh) return;
  if (fresh.status === 'paused' || fresh.status === 'failed') return;

  // Always advance — advanceAfterSceneSettled is idempotent and inspects
  // project state to decide what comes next. Calling it for unknown kinds
  // (e.g. legacy 'scene' tasks from before the treatment/evaluate split)
  // makes the system self-healing rather than silently getting stuck.
  return advanceAfterSceneSettled(fresh.id);
}

/**
 * Look at the project's scene state and decide what to do next.
 * Called from:
 *   - completionHook on `treatment` and `evaluate` task completion.
 *   - sceneRunner when a render fails terminally (no evaluate task spawned).
 */
// In-memory dedup. The status field doesn't fully cover this — `planning`
// gets set just before enqueueing the treatment task, and `stitching` just
// before runStitch starts the timeline render. A second concurrent
// invocation between updateProject and enqueue/runStitch would bypass the
// status guard. These per-projectId Sets close the window. Cleared after
// the corresponding async work returns or on failure.
const inflightTreatment = new Set();
const inflightStitch = new Set();
// Resume-after-pause path enqueues an evaluator for an orphaned
// 'evaluating' scene. recordRun isn't persisted until the agentBridge
// writes the run row, so two concurrent advance() calls (e.g. user
// clicks Resume + a stale completionHook fires) could both observe the
// scene as orphaned and double-enqueue. Per-projectId+sceneId set
// closes that window in the same way inflightTreatment/inflightStitch do.
const inflightEvaluator = new Set();
// #1929: scenes we're deferring the first render for while their seeded
// first-pass reference frame is still generating on the media-job queue.
// Keyed `${projectId}:${sceneId}` so a second advance() while a defer
// listener is already armed doesn't register a duplicate listener (which
// would re-fire advanceAfterSceneSettled twice on the same job settle).
const inflightSeedDefer = new Set();
// #1929: cleanup callbacks for every currently-armed seed-frame defer, keyed
// by deferKey — lets __resetInflightState() (tests) tear down real listeners +
// backstop timers, not just the dedup set, so a deferred-but-never-settled test
// can't leak a live listener that later fires a stray advance.
const seedDeferCleanups = new Map();

/**
 * #1929 — find the still-in-flight first-pass reference-frame job seeded for
 * `sceneId` on `projectId`. `enqueueFirstPassSceneFrames` (firstPassGen.js)
 * queues one `image` job per scene tagged `params.creativeDirector` (no
 * `owner`), which `creativeDirectorSceneImageHook` files onto the scene's
 * `sourceImageFile` when it completes. Returns the queued/running job (so the
 * caller can wait on its settle) or null if none is pending.
 *
 * Pure over an injected `jobs` array so it can be unit-tested without the
 * live queue; the module wrapper below passes `listJobs({ kind: 'image' })`.
 */
export function findPendingSeedFrameJob(jobs, projectId, sceneId) {
  if (!Array.isArray(jobs)) return null;
  return jobs.find((j) => {
    if (j?.kind !== 'image') return false;
    if (j.status !== 'queued' && j.status !== 'running') return false;
    const tag = j.params?.creativeDirector;
    return tag?.projectId === projectId && tag?.sceneId === sceneId;
  }) || null;
}

// #1929 — how long to poll for the seed frame's `sourceImageFile` to land
// after its media job completes. The scene-image hook (creativeDirectorScene
// ImageHook) files it on the SAME 'completed' event our defer listener sees,
// but both handlers run async so the write may still be in flight when we
// re-advance. A short bounded poll lets scene-0 pick up the seeded frame
// without wedging the pipeline if the attach failed (frame simply won't be
// there and the scene renders text-to-video, per the fire-and-forget contract).
// Poll fast at first (the scene-image hook usually files sourceImageFile
// within a tick or two of the same 'completed' event), then back off — so a
// successful attach is picked up almost immediately, while a genuinely failed
// attach still gives up promptly instead of blocking scene-0 for the full
// window. Values are the delay BEFORE each successive re-read.
const SEED_FRAME_ATTACH_POLL_SCHEDULE_MS = [25, 50, 100, 250, 250, 500, 500];
const SEED_FRAME_ATTACH_MAX_WAIT_MS = SEED_FRAME_ATTACH_POLL_SCHEDULE_MS.reduce((a, b) => a + b, 0);

// Backstop for a seed job that never emits a terminal event (worker crash,
// queue stall, a pm2 restart that drops the in-memory job). Without it the
// defer listeners + inflightSeedDefer entry would leak forever and wedge the
// scene in 'pending'. Generous — a real image render can take a while — but
// finite so the pipeline always makes progress.
const SEED_DEFER_BACKSTOP_MS = 5 * 60 * 1000;

async function waitForSeedFrameThenAdvance(projectId, sceneId) {
  // Poll until the scene-image hook has filed sourceImageFile, the project
  // leaves a runnable state (paused/failed/deleted), the scene stops being
  // pending, or we exhaust the schedule.
  for (let i = 0; ; i += 1) {
    const fresh = await getProject(projectId).catch(() => null);
    if (!fresh || fresh.status === 'paused' || fresh.status === 'failed') return;
    const scene = fresh.treatment?.scenes?.find((s) => s.sceneId === sceneId);
    // Scene gone, no longer pending (something else advanced it), or the
    // reference frame has landed → stop waiting and let advance() take over.
    if (!scene || scene.status !== 'pending' || scene.sourceImageFile) break;
    if (i >= SEED_FRAME_ATTACH_POLL_SCHEDULE_MS.length) {
      console.log(`⏳ CD scene ${sceneId} on ${projectId}: seed frame did not attach within ${SEED_FRAME_ATTACH_MAX_WAIT_MS}ms — rendering without it (text-to-video).`);
      break;
    }
    await new Promise((r) => setTimeout(r, SEED_FRAME_ATTACH_POLL_SCHEDULE_MS[i]));
  }
  // Force past the seed-defer gate for THIS scene: the job we were waiting on
  // is terminal (or backstopped), so if a stale/duplicate seed job for the
  // same scene is still sitting queued/running we must not re-arm another
  // defer on it — that would loop forever on a stalled queue (codex review).
  return advanceAfterSceneSettled(projectId, { skipSeedDeferSceneId: sceneId });
}

export async function advanceAfterSceneSettled(projectId, opts = {}) {
  // #1929: when a seed-frame defer's wait resolves, the re-advance passes the
  // scene id here so this pass renders it immediately instead of re-arming a
  // fresh defer on a stale/stalled duplicate seed job (which would loop).
  const skipSeedDeferSceneId = opts.skipSeedDeferSceneId || null;
  const project = await getProject(projectId);
  if (!project) return;
  if (project.status === 'paused' || project.status === 'failed') return;

  // No treatment yet → enqueue treatment task.
  if (!project.treatment) {
    // Skip if our in-memory dedup set has this project — covers the
    // updateProject→enqueueTreatmentTask window between two concurrent
    // advance calls. The `planning` status check is intentionally omitted:
    // the start route pre-flips new projects to `planning` before calling
    // startCreativeDirectorProject, so checking status here would cause
    // brand-new projects to get stuck (treatment task never enqueued).
    const hasInflightTreatmentRun = (project.runs || []).some(
      (r) => r.kind === 'treatment' && r.status !== 'completed' && r.status !== 'failed'
    );
    if (hasInflightTreatmentRun || inflightTreatment.has(projectId)) return;
    inflightTreatment.add(projectId);
    await updateProject(project.id, { status: 'planning' })
      .catch((e) => { inflightTreatment.delete(projectId); throw e; });
    const fresh = await getProject(project.id);
    await enqueueTreatmentTask(fresh)
      .finally(() => inflightTreatment.delete(projectId));
    return;
  }

  let scenes = (project.treatment.scenes || []).slice().sort((a, b) => a.order - b.order);

  // Resume-after-pause path: a scene left in `evaluating` with a
  // renderedJobId set means handleRenderCompleted persisted the render
  // (the user paused before the evaluator could be enqueued, or recovery
  // reaped the live evaluate task on restart). Re-fire the evaluator
  // here so the existing rendered clip isn't wasted on a pointless
  // re-render. Skip if a fresh evaluate run is already in flight (don't
  // double-enqueue mid-resume).
  // jobIds in the queue are crypto.randomUUID(); accept the lowercase-hex
  // UUID v4 shape and reject anything else. Persisted scene.renderedJobId
  // is editable via PATCH /:id/scenes/:sceneId so a crafted payload could
  // otherwise make ffmpeg/ffprobe read+write outside PATHS.videos /
  // PATHS.video-thumbnails. (sampleEvaluationFrames builds paths via
  // string concat, not via PATHS.join + safety check.)
  const isSafeJobId = (id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
  const noLiveEvaluateRun = (s) => !(project.runs || []).some(
    (r) => r.kind === 'evaluate' && r.sceneId === s.sceneId && r.status !== 'completed' && r.status !== 'failed',
  );
  // Reset any 'evaluating' scenes whose renderedJobId is unsafe (tampered
  // PATCH, missing, etc.) — without this they'd stay 'evaluating' forever
  // and the inflight check at the bottom of the function would block
  // every future advance() call, wedging the project. Mark them failed
  // so the orchestrator can either fall through to the next scene or
  // mark the whole project failed if no scene was ever accepted.
  const wedged = scenes.filter((s) =>
    s.status === 'evaluating' && !isSafeJobId(s.renderedJobId) && noLiveEvaluateRun(s),
  );
  for (const w of wedged) {
    console.log(`❌ CD scene ${w.sceneId} on ${project.id} is 'evaluating' with an unsafe renderedJobId (${JSON.stringify(w.renderedJobId)}) — marking failed to prevent project wedge.`);
    await updateScene(project.id, w.sceneId, {
      status: 'failed',
      evaluation: {
        accepted: false,
        notes: 'Scene wedged: invalid renderedJobId in persisted state. Re-render to recover.',
        sampledAt: new Date().toISOString(),
      },
    }).catch((e) => console.log(`⚠️ CD wedge-reset for ${w.sceneId} failed: ${e.message}`));
  }
  // Re-read scenes so the subsequent orphan/pending/inflight checks see the
  // updated statuses — the wedge-reset writes above are not reflected in the
  // in-memory `scenes` slice we sorted at the top of this function.
  if (wedged.length > 0) {
    const refreshed = await getProject(project.id);
    if (!refreshed) return;
    scenes = (refreshed.treatment?.scenes || []).slice().sort((a, b) => a.order - b.order);
  }
  const orphanedEvaluating = scenes.find((s) =>
    s.status === 'evaluating' &&
    isSafeJobId(s.renderedJobId) &&
    noLiveEvaluateRun(s),
  );
  if (orphanedEvaluating) {
    const evalKey = `${project.id}:${orphanedEvaluating.sceneId}`;
    if (inflightEvaluator.has(evalKey)) return;
    inflightEvaluator.add(evalKey);
    try {
      if (project.status !== 'rendering') {
        await updateProject(project.id, { status: 'rendering' });
      }
      // Verify the rendered .mp4 file is still on disk BEFORE deciding what
      // to do about frames. The video file is the prerequisite for every
      // evaluator branch: the multi-frame path reads the sampled frames
      // (which only exist because the video does), and the
      // single-thumbnail fallback (`{{^multiFrame}}` in cd-evaluate.md)
      // reads `/data/video-thumbnails/{renderedJobId}.jpg`. If the user
      // deleted the rendered video while the project was paused, all
      // three artifacts are gone (videoGen/local#deleteHistoryItem unlinks
      // the .mp4, its thumbnail, AND every `${jobId}-fN.jpg` evaluation
      // frame in one shot). If we don't catch this here — even when the
      // CACHED `evaluationFrames` array still happens to be on disk — the
      // evaluator may accept the scene, only for the later stitch to
      // crash on a missing input file.
      const videoStillExists = existsSync(join(PATHS.videos, `${orphanedEvaluating.renderedJobId}.mp4`));
      if (!videoStillExists) {
        console.log(`❌ CD resume: rendered video missing for scene ${orphanedEvaluating.sceneId} on ${project.id} — video deleted while paused, marking scene failed`);
        let sceneFailed = false;
        await updateScene(project.id, orphanedEvaluating.sceneId, {
          status: 'failed',
          evaluation: {
            accepted: false,
            notes: 'Evaluation frames unavailable: rendered video was deleted while project was paused.',
            sampledAt: new Date().toISOString(),
          },
        })
          .then(() => { sceneFailed = true; })
          .catch((e) => console.log(`⚠️ CD scene fail-deleted-video for ${orphanedEvaluating.sceneId} failed: ${e.message}`));
        if (!sceneFailed) {
          // updateScene errored; don't recurse, otherwise the same orphan
          // would be re-detected next pass with no progress.
          return;
        }
        // Release the per-scene evaluator lock manually so the recursive
        // advance below isn't short-circuited by the inflightEvaluator
        // guard at the top of this branch. The `finally` will delete()
        // it a second time, which is a no-op on Set. The recursion
        // re-fetches the project; since the scene is now 'failed', the
        // orphan check won't re-match and the function falls through to
        // nextPending / project-failure / stitch logic.
        inflightEvaluator.delete(evalKey);
        return advanceAfterSceneSettled(project.id);
      }
      // Re-sample evaluation frames if they weren't captured during the
      // original completion path (pause landed before frame sampling) OR
      // if any of the persisted frame files is missing on disk. Frames
      // can disappear if the user deleted the underlying video from
      // history while the project was paused — videoGen/local#deleteVideo
      // unlinks `${jobId}-fN.jpg` thumbnails as part of its cleanup.
      // Without this on-disk check, the evaluator would receive broken
      // image paths and reject every render with "frame not found".
      let frames = orphanedEvaluating.evaluationFrames || [];
      const allFramesExist = frames.length > 0 && frames.every((f) => existsSync(join(PATHS.videoThumbnails, f)));
      if (!allFramesExist) {
        frames = await sampleEvaluationFrames(orphanedEvaluating.renderedJobId)
          .catch((err) => {
            console.error(`❌ CD resume sampleEvaluationFrames failed for ${orphanedEvaluating.renderedJobId.slice(0, 8)}: ${err.message}`);
            return [];
          });
        // sampleEvaluationFrames can return [] for non-fatal reasons
        // (ffmpeg missing on PATH, ffprobe miscount, transient I/O). The
        // video file is still on disk (we checked above), so the
        // evaluator template's single-thumbnail fallback path
        // (`{{^multiFrame}}` in cd-evaluate.md) can still produce a
        // verdict against `/data/video-thumbnails/{renderedJobId}.jpg`.
        // Mirror the normal render-completion path (sceneRunner.js): hand
        // off whatever frames we got, even an empty array, rather than
        // bailing here and leaving the project wedged in `rendering`.
        await updateScene(project.id, orphanedEvaluating.sceneId, { evaluationFrames: frames });
      }
      // Pause race re-check after the expensive frame-sampling step. The
      // user could re-pause the project mid-resume; without this the
      // evaluator would fire against a now-paused project, which is
      // exactly the race the render-completion path already guards
      // against. Bail without enqueueing — the next Resume click will
      // pick up the freshly-sampled frames since we just persisted them.
      const recheck = await getProject(project.id);
      if (recheck?.status === 'paused' || recheck?.status === 'failed') {
        console.log(`⏸️  CD resume: project ${project.id} flipped to ${recheck.status} during frame sampling — skipping evaluator enqueue (next resume will reuse the sampled frames).`);
        return;
      }
      console.log(`▶️  CD resume: re-firing evaluator for orphaned 'evaluating' scene ${orphanedEvaluating.sceneId} on project ${project.id} (renderedJobId preserved from pre-pause render).`);
      const sceneRefreshed = recheck?.treatment?.scenes?.find((s) => s.sceneId === orphanedEvaluating.sceneId);
      if (recheck && sceneRefreshed) {
        await dispatchSceneEvaluation(recheck, { ...sceneRefreshed, evaluationFrames: frames });
      }
      return;
    } finally {
      inflightEvaluator.delete(evalKey);
    }
  }

  // Find next pending scene. nextPendingScene returns the lowest-order
  // scene whose status is pending/rendering/evaluating — but since
  // sceneRunner sets status='rendering' the moment it kicks off, and
  // 'evaluating' once the render completes, we want the lowest-order scene
  // whose status is exactly 'pending' (i.e. not yet started OR
  // re-requested by the evaluator).
  const nextPending = scenes.find((s) => s.status === 'pending');
  if (nextPending) {
    // #1929: first-pass seeded reference frames are enqueued fire-and-forget
    // right after the treatment is written (firstPassGen.js), and this hook
    // fires the moment the treatment task settles. For the very first scene
    // that renders after auto-compose, this almost always beats the just-
    // queued image-gen job — so runSceneRender would read an empty
    // sourceImageFile and render text-to-video instead of picking up the
    // seeded frame (silently degrading the establishing shot). If the project
    // opted into first-pass gen, the scene has no reference frame yet, AND its
    // seed job is still queued/running on the media-job queue, defer this
    // render: re-fire advanceAfterSceneSettled once the seed job settles
    // (creativeDirectorSceneImageHook will have filed sourceImageFile by then,
    // since it's serialized on the same 'completed' event). Later scenes have
    // a natural multi-minute buffer (each renders only after the prior scene's
    // full video render + evaluation), so this only matters for scene-0.
    if (project.generateFirstPass && !nextPending.sourceImageFile
        && nextPending.sceneId !== skipSeedDeferSceneId) {
      const seedJob = findPendingSeedFrameJob(
        listJobs({ kind: 'image' }), project.id, nextPending.sceneId,
      );
      if (seedJob) {
        const deferKey = `${project.id}:${nextPending.sceneId}`;
        if (inflightSeedDefer.has(deferKey)) {
          console.log(`⏳ CD scene ${nextPending.sceneId} on ${project.id}: seed frame still generating — defer already armed, waiting.`);
          return;
        }
        inflightSeedDefer.add(deferKey);
        console.log(`⏳ CD scene ${nextPending.sceneId} on ${project.id}: deferring render until seeded reference frame job ${seedJob.id.slice(0, 8)} settles.`);
        const sceneId = nextPending.sceneId;
        let fired = false;
        const fireOnce = () => {
          if (fired) return;
          fired = true;
          clearTimeout(backstopTimer);
          mediaJobEvents.off('completed', onSeedSettled);
          mediaJobEvents.off('failed', onSeedSettled);
          mediaJobEvents.off('canceled', onSeedSettled);
          inflightSeedDefer.delete(deferKey);
          seedDeferCleanups.delete(deferKey);
          // Re-advance once a seed job for this scene is terminal. On success
          // the scene-image hook (creativeDirectorSceneImageHook) fires on the
          // SAME 'completed' event to file sourceImageFile — but both handlers
          // run async, so the write can still be in flight when we re-read.
          // Poll briefly for sourceImageFile before falling through to
          // runSceneRender so scene-0 reliably picks up its seeded frame. On
          // failure/cancel the frame never lands and the scene renders
          // text-to-video, exactly as the fire-and-forget contract allowed.
          // Runs outside the request lifecycle — never throw.
          waitForSeedFrameThenAdvance(project.id, sceneId)
            .catch((e) => console.log(`⚠️ CD deferred advance for ${project.id}/${sceneId} failed: ${e.message}`));
        };
        // Match by scene TAG, not the single job id we happened to sample: if
        // a duplicate/re-queued seed job for the same scene completes first and
        // attaches sourceImageFile, that's just as good — wake on it rather
        // than waiting for the specific job we first saw (codex review).
        const onSeedSettled = (job) => {
          const tag = job?.params?.creativeDirector;
          if (job?.kind === 'image' && tag?.projectId === project.id && tag?.sceneId === sceneId) fireOnce();
        };
        mediaJobEvents.on('completed', onSeedSettled);
        mediaJobEvents.on('failed', onSeedSettled);
        mediaJobEvents.on('canceled', onSeedSettled);
        // Backstop: a seed job that never emits a terminal event (worker
        // crash, queue stall, restart that drops the in-memory job) would
        // otherwise leave these listeners + the inflightSeedDefer entry
        // attached forever, wedging the scene in 'pending' permanently. Force
        // a fall-through after the backstop; the re-advance passes
        // skipSeedDeferSceneId so it renders this scene instead of re-arming a
        // fresh defer on the same stalled job (which would loop). Unref so the
        // timer can't hold the process open.
        const backstopTimer = setTimeout(() => {
          console.log(`⏳ CD scene ${sceneId} on ${project.id}: seed frame job ${seedJob.id.slice(0, 8)} never settled within ${SEED_DEFER_BACKSTOP_MS}ms — proceeding without waiting.`);
          fireOnce();
        }, SEED_DEFER_BACKSTOP_MS);
        backstopTimer.unref?.();
        // Record a teardown so tests (and future callers) can cancel an armed
        // defer cleanly — clears the listeners, timer, and dedup entry without
        // firing the advance.
        seedDeferCleanups.set(deferKey, () => {
          clearTimeout(backstopTimer);
          mediaJobEvents.off('completed', onSeedSettled);
          mediaJobEvents.off('failed', onSeedSettled);
          mediaJobEvents.off('canceled', onSeedSettled);
        });
        // Close the race where the job settled between the listJobs() read
        // above and attaching the listeners — its terminal event already
        // fired and would never fire again, wedging the scene in 'pending'
        // forever. Re-check now that we're listening; if it's already gone,
        // fire immediately.
        if (!findPendingSeedFrameJob(listJobs({ kind: 'image' }), project.id, sceneId)) {
          fireOnce();
        }
        return;
      }
    }
    if (project.status !== 'rendering') {
      await updateProject(project.id, { status: 'rendering' });
    }
    const updated = await getProject(project.id);
    // Re-read may return null if the project was deleted between calls,
    // or sceneFresh may be undefined if the treatment was rewritten
    // concurrently. Bail rather than passing null/undefined into
    // runSceneRender (which would crash on the first .property access).
    const sceneFresh = updated?.treatment?.scenes?.find((s) => s.sceneId === nextPending.sceneId);
    if (!updated || !sceneFresh) {
      console.log(`⚠️ CD advance: project ${projectId} or scene ${nextPending.sceneId} disappeared between reads — bailing`);
      return;
    }
    await runSceneRender(updated, sceneFresh);
    return;
  }

  // No pending scenes — but maybe one is mid-flight (rendering / evaluating)?
  // Don't double-trigger; just wait for it to settle and re-fire this hook.
  const inflight = scenes.find((s) => s.status === 'rendering' || s.status === 'evaluating');
  if (inflight) {
    console.log(`⏳ CD project ${projectId}: scene ${inflight.sceneId} is ${inflight.status} — waiting for it to settle`);
    return;
  }

  // All scenes terminal. If at least one was accepted, stitch; else fail.
  const accepted = scenes.filter((s) => s.status === 'accepted');
  if (!accepted.length) {
    await updateProject(project.id, { status: 'failed' })
      .catch((e) => console.log(`⚠️ CD updateProject(failed) for ${projectId} failed: ${e.message}`));
    console.log(`❌ CD project ${projectId}: every scene failed — marking project failed`);
    return;
  }
  if (project.finalVideoId) {
    if (project.status !== 'complete') {
      await updateProject(project.id, { status: 'complete' });
    }
    return;
  }
  // Run stitch (programmatic, no agent task). Skip if already stitching
  // OR if a stitch is in flight from a concurrent advance call (the
  // status flip to 'stitching' happens inside runStitch, leaving a window
  // where two callers could both reach this line).
  if (project.status === 'stitching' || inflightStitch.has(projectId)) return;
  inflightStitch.add(projectId);
  await runStitch(projectId).finally(() => inflightStitch.delete(projectId));
}

/**
 * Convenience: kick off the project from the user's "Start" button. Skips
 * straight to advancing.
 */
export async function startCreativeDirectorProject(projectId) {
  return advanceAfterSceneSettled(projectId);
}

// Test-only: clear the module-level in-memory dedup sets so suites that leave
// a seed-frame defer armed (deferred but never fired the settle event) don't
// bleed the deferKey into a later test that reuses the same projectId.
export function __resetInflightState() {
  // Tear down any armed seed-frame defers (real listeners + backstop timers),
  // not just the dedup set — a deferred-but-never-settled test would otherwise
  // leak a live listener that fires a stray advance into a later test.
  for (const cleanup of seedDeferCleanups.values()) cleanup();
  seedDeferCleanups.clear();
  inflightTreatment.clear();
  inflightStitch.clear();
  inflightEvaluator.clear();
  inflightSeedDefer.clear();
}
