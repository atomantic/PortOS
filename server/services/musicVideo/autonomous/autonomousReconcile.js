/** Reconcile the autonomous run with the production, Cast & Sets, review and render it delegated. */

import { CAST_SETS_WORKING } from '../castAndSets.js';
import { SONG_CHANGED_DURING_RENDER } from '../renderSettlement.js';
import { trimTo } from '../../../lib/textUtils.js';
import { productionTargets } from '../production.js';
import { AUTONOMOUS_LIMIT_BOUNDS, isOrchestratedRun } from '../../../lib/musicVideo/musicVideoAutonomous.js';
import { getProject } from '../projects.js';
import { musicVideoEvents } from '../events.js';
import { musicVideoDependencyChanges } from '../../../lib/musicVideo/musicVideoDependencies.js';
import {
  PROCESS_ID,
  short,
  deps,
  projectAutonomousRun,
  latestRun,
  patchRun,
  stagePatch,
  RENDER_STEP,
  CAST_STEP,
  park,
} from './autonomousRunStore.js';
import {
  rendersFromCode,
  orchestrateFinal,
  FINAL_REVISION_STEP,
  settleOverlayText,
  settleStills,
  settleBlockedProduction,
  ensureFootageComposition,
} from './autonomousOrchestration.js';

/**
 * How a run continues on its produce stage, read from the checkpoint ids in its
 * output. Those ids overlap on purpose — `patchRun` merges output, so each later
 * checkpoint is written beside the earlier ones, never in place of them:
 * `productionRunId` stays set once production completes (`finishFromProduction`
 * adds `productionDone`, and maybe an adopted `renderJobId`), and `renderJobId`
 * stays set while the orchestrator reviews that film and while a footage
 * revision (`finalAutoReviewId`) works on it. So this is two views, not a phase:
 *
 * - `finalDelivery`: the film is being rendered, reviewed or revised — after
 *   production, or straight after code generation for a code-only brief.
 *   `productionDone` alone counts (production finished, the render has not
 *   started), and it does not mean the autonomous run is done.
 * - `resume`: the one continuation Resume takes, latest checkpoint first —
 *   `final-revision` (its review id), else `final-render` (the render id, or
 *   null when none started), else `production` (its run id), else `advance`.
 *
 * Neither proves anything finished: callers keep their own status, step and
 * identity checks, and check the render job, document and history themselves.
 */
export function produceContinuation(run) {
  const output = run?.stage === 'produce' ? run.output : null;
  if (!output) return { finalDelivery: false, resume: { kind: 'advance', id: null } };
  const finalDelivery = Boolean(output.renderJobId || output.productionDone);
  const resume = output.finalAutoReviewId ? { kind: 'final-revision', id: output.finalAutoReviewId }
    : finalDelivery ? { kind: 'final-render', id: output.renderJobId || null }
      : output.productionRunId ? { kind: 'production', id: output.productionRunId }
        : { kind: 'advance', id: null };
  return { finalDelivery, resume };
}

// ---- production completion -------------------------------------------------------

const PRODUCTION_PARKED = new Set(['limit-reached', 'blocked', 'needs-replan', 'needs-human', 'stopped']);

/**
 * A run whose director chose no generation limit outgrows the default: when
 * production stops at its generation limit with stills or clips still to make,
 * the limit becomes what is spent plus two per shot left (a retry or
 * regeneration each), within the bound, and production resumes. Returns
 * whether it did; a chosen limit, or one already that high, parks as before.
 */
async function raiseSizedLimit(projectId, runId, run, project, production) {
  const limit = production.limits?.maxGenerations || 0;
  const used = production.usage?.generations || 0;
  if (!run.brief.sizedGenerations || used < limit) return false;
  const targets = productionTargets(project);
  const left = targets.frame.filter((scene) => !scene.referenceImageId).length
    + (production.stopBefore === 'clips' ? 0 : targets.clip.filter((scene) => !scene.videoHistoryId).length);
  const raised = Math.min(used + left * 2, AUTONOMOUS_LIMIT_BOUNDS.maxGenerations.max);
  if (raised <= limit) return false;
  const resumed = await deps.resumeProduction(projectId, runId, { acceptBasis: true, limits: { maxGenerations: raised } })
    .then(() => true, (err) => { console.warn(`⚠️ Autonomous music video ${short(run.id)} could not raise its generation limit: ${err.message}`); return false; });
  if (resumed) console.log(`🎬 Autonomous music video ${short(run.id)} raised its default generation limit to ${raised} for ${left} shot${left === 1 ? '' : 's'} left`);
  return resumed;
}

/**
 * A production run this autonomous run delegated to advanced. Mirrors its
 * terminal state onto the run: completed → kick off the final render and
 * finish; failed → failed; any parked state → needs-human (resume continues it).
 */
export async function onProductionEvent({ projectId, runId, run: production }) {
  // Production emits on every step; only a terminal or parked state concerns us, and
  // the project is read only once one arrives.
  if (!projectId || !(['completed', 'failed', 'canceled', 'awaiting-video'].includes(production?.status) || PRODUCTION_PARKED.has(production?.status))) return;
  const project = await getProject(projectId).catch(() => null);
  const run = projectAutonomousRun(project);
  if (!run || run.stage !== 'produce' || run.output.productionRunId !== runId) return;
  if (!['running', 'needs-human'].includes(run.status)) return;
  const reason = trimTo(production.stopReason || production.error || '', 500);
  if (production.status === 'completed') {
    // A repeated completion event must not start a second render.
    if (run.output.renderJobId) return;
    await finishFromProduction(projectId, runId, { status: 'running', processId: PROCESS_ID });
  } else if (production.status === 'failed') {
    await park(projectId, 'failed', { error: reason || 'Production failed', errorCode: 'PRODUCTION_FAILED' });
  } else if (production.status === 'canceled') {
    // Production canceled on its own (not by canceling this run): park, so Resume can adopt
    // the director's replacement run or start a new one.
    await park(projectId, 'needs-human', { error: reason || 'Production was canceled', errorCode: 'PRODUCTION_CANCELED' });
  } else if (production.status === 'awaiting-video') {
    if (run.status === 'running') await settleStills(projectId, run, runId);
  } else if (production.status === 'limit-reached' && run.status === 'running' && await raiseSizedLimit(projectId, runId, run, project, production)) {
    // The default generation limit grew to the planned shots and production goes on.
  } else if (['blocked', 'stopped'].includes(production.status) && run.status === 'running' && await settleBlockedProduction(projectId, run, runId)) {
    // A run set to approve settled the stop itself and production goes on.
  } else if (PRODUCTION_PARKED.has(production.status) && run.status === 'running') {
    await park(projectId, 'needs-human', { error: reason || `Production is ${production.status}`, errorCode: production.stopCode === 'MUSIC_VIDEO_APPROVAL_REQUIRED' ? 'MUSIC_VIDEO_APPROVAL_REQUIRED' : 'PRODUCTION_PARKED' });
  }
}

/**
 * The job id of a completed production run's own final render (code-first runs
 * render the accepted document themselves), or null when there is none or it is
 * no longer the project's current final video: a later render replaced it, the
 * selected document changed, or the film's dependencies moved since it rendered.
 */
function currentProductionRenderJobId(project, productionRunId) {
  const production = (project.productionRuns || []).find((r) => r.id === productionRunId);
  const render = production?.finalRender;
  if (render?.status !== 'completed' || !render.jobId || project.renderHistoryId !== render.jobId) return null;
  if (production.documentCheckpoint?.directory !== project.composition?.document?.directory) return null;
  return project.renderDependencies && !musicVideoDependencyChanges(project, project.renderDependencies).length ? render.jobId : null;
}

/**
 * Production completed: adopt its own final render when it is still current
 * (the reconcile then finishes on it, final review included), otherwise render
 * the film — legacy and footage-only runs leave no render behind.
 */
export async function finishFromProduction(projectId, productionRunId, patch = {}) {
  const adopted = currentProductionRenderJobId(await getProject(projectId), productionRunId);
  await patchRun(projectId, () => ({ ...patch, output: { productionDone: true, ...(adopted ? { renderJobId: adopted } : {}) } }));
  if (adopted) console.log(`🎬 Autonomous music video adopted production's final render [${short(adopted)}]`);
  await reconcileFinalRender(projectId, { restart: true });
}

// ---- Cast & Sets completion ------------------------------------------------------

/**
 * Settle a run waiting on Cast & Sets from the project's own record: still
 * working → keep waiting; failed → park failed with its error; otherwise
 * (review/approved/skipped) re-enter `produce`, which now has a guide to review.
 */
export async function reconcileCastAndSets(projectId, advanceInBackground) {
  const project = await getProject(projectId).catch(() => null);
  const run = projectAutonomousRun(project);
  if (!run || run.stage !== 'produce' || run.status !== 'running' || run.processId !== PROCESS_ID || run.stages.produce?.step !== CAST_STEP) return;
  const stage = project.castAndSets;
  if (CAST_SETS_WORKING.includes(stage?.status)) return;
  if (stage?.status === 'failed') {
    const error = trimTo(`Cast & Sets failed: ${stage.stopReason || stage.error || 'unknown error'}`, 500);
    await patchRun(projectId, (r) => stagePatch(r, 'produce', { status: 'failed', error, step: null }));
    await park(projectId, 'failed', { error, errorCode: 'CAST_SETS_FAILED' });
    return;
  }
  advanceInBackground(projectId);
}


// ---- final render completion -----------------------------------------------------

/** Park the run as failed on its final render, with the stage marked failed so Retry re-renders only. */
async function failFinalRender(projectId, message, errorCode = 'FINAL_RENDER_FAILED') {
  // A cancel/stop that landed while the render prepared is not a failure.
  if (projectAutonomousRun(await getProject(projectId))?.status !== 'running') return;
  const error = trimTo(message, 500);
  await patchRun(projectId, (r) => stagePatch(r, 'produce', { status: 'failed', error, step: null }));
  await park(projectId, 'failed', { error, errorCode });
}

// projectId -> the final review in flight, so a render event and a reconcile
// that both see the finished render share one look instead of reviewing twice.
const finalReviews = new Map();

async function completeFinalRender(projectId, run) {
  if (isOrchestratedRun(run) && run.output.finalReviewedJobId !== run.output.renderJobId) {
    if (finalReviews.has(projectId)) return finalReviews.get(projectId);
    const review = (async () => {
      await patchRun(projectId, (r) => stagePatch(r, 'produce', { status: 'running', step: 'final-review' }));
      const next = await orchestrateFinal(projectId, run);
      await patchRun(projectId, () => ({ output: { finalReviewedJobId: run.output.renderJobId || null } }));
      return next;
    })();
    finalReviews.set(projectId, review);
    let next;
    try { next = await review; } finally { finalReviews.delete(projectId); }
    // Stopped or canceled while the orchestrator watched: leave that state alone.
    if ((await latestRun(projectId))?.status !== 'running') return;
    // A revision: the re-rendered film comes back here for the next review.
    if (next === 'rerender') return startFinalRender(projectId, run);
    if (next === 'wait') return;
  }
  await patchRun(projectId, (r) => ({
    status: 'completed',
    ...stagePatch(r, 'produce', { status: 'done', finishedAt: new Date().toISOString(), error: null, step: null }),
    error: null, errorCode: null,
  }));
  console.log(`✅ Autonomous music video ${short(run.id)} finished — final video rendered`);
}

/**
 * The run, when it is running with its final-delivery checkpoint set
 * (produceContinuation): rendering the film — with a job id or not yet started —
 * reviewing it, or revising its footage. Deliberately broader than an active
 * render: the revision handler is admitted through it too, and each caller adds
 * its own identity and step checks.
 */
const runInFinalDelivery = (project) => {
  const run = projectAutonomousRun(project);
  return run?.status === 'running' && produceContinuation(run).finalDelivery ? run : null;
};

/**
 * Settle a run waiting on its final render from the project's own record — the
 * race where the render ended before its job id was stored, and a resume after
 * a restart (the job died with the process). Still rendering → keep waiting;
 * `renderHistoryId` equal to the job id → it finished; otherwise it failed, or
 * with `restart` (an explicit resume, or production just completed) render again.
 */
export async function reconcileFinalRender(projectId, { restart = false } = {}) {
  const project = await getProject(projectId).catch(() => null);
  const run = runInFinalDelivery(project);
  if (!run) return;
  const jobId = run.output.renderJobId || null;
  if (jobId && (project.status === 'rendering' || (await deps.activeRenderJobId(projectId)) === jobId)) {
    await patchRun(projectId, (r) => stagePatch(r, 'produce', { status: 'running', step: RENDER_STEP }));
    return;
  }
  if (jobId && project.renderHistoryId === jobId) return completeFinalRender(projectId, run);
  if (!restart) return failFinalRender(projectId, project.renderError || 'The final render did not finish');
  return startFinalRender(projectId, run);
}


/** Render the film (again) and wait for the render's own event. */
export async function startFinalRender(projectId, run) {
  if (!await settleOverlayText(projectId, run)) return;
  if (!rendersFromCode(await getProject(projectId), run)) await ensureFootageComposition(projectId);
  const render = await deps.renderVideo(projectId).catch((err) => ({ error: err }));
  if (render.error) return failFinalRender(projectId, `The final render did not start: ${render.error.message}`, render.error.code || 'FINAL_RENDER_FAILED');
  let stopped = false;
  await patchRun(projectId, (r) => {
    stopped = r.status !== 'running';
    return stopped ? {} : { output: { renderJobId: render.jobId || null }, ...stagePatch(r, 'produce', { status: 'running', error: null, step: RENDER_STEP }), error: null, errorCode: null };
  });
  if (stopped) {
    // Canceled/stopped while the render prepared: the cancel saw no job id, so stop the fresh job here.
    if (render.jobId) await deps.cancelRender(render.jobId).catch((err) => console.warn(`⚠️ Autonomous music video ${short(run.id)} could not cancel render ${render.jobId}: ${err.message}`));
    return;
  }
  console.log(`🎬 Autonomous music video ${short(run.id)} is rendering the final video`);
  // A render that settled before its id was stored.
  await reconcileFinalRender(projectId);
}

/**
 * The orchestrator's footage revision ended. One that handed off to a human
 * (`needs-human`) or failed leaves its revision open, so the run parks with the
 * reason and keeps the revision's id: Resume, once the director has finished
 * it, renders and reviews the film again. Otherwise the film is rendered again
 * for the next final review; a run it left resumable (stopped or
 * limit-reached) is closed first so it does not hold the revision slot.
 */
export async function onAutoReviewEvent({ projectId, runId, run: review }) {
  if (!projectId || !runId || !review || review.status === 'running') return;
  const project = await getProject(projectId).catch(() => null);
  const run = runInFinalDelivery(project);
  if (!run || run.output.finalAutoReviewId !== runId || run.stages.produce?.step !== FINAL_REVISION_STEP) return;
  if (['needs-human', 'failed'].includes(review.status)) {
    const reason = [review.stopReason, review.error].find((v) => typeof v === 'string' && v.trim()) || `the revision ${review.status === 'failed' ? 'failed' : 'needs a director'}`;
    await park(projectId, 'needs-human', { error: trimTo(`The revision of the final video was left for a director: ${reason}`, 500), errorCode: 'FINAL_REVISION_NEEDS_HUMAN' });
    return;
  }
  await patchRun(projectId, () => ({ output: { finalAutoReviewId: null } }));
  if (['stopped', 'limit-reached'].includes(review.status)) {
    await deps.cancelAutoReview(projectId, runId).catch((err) => console.warn(`⚠️ Autonomous music video ${short(run.id)} could not close its revision: ${trimTo(err.message, 200)}`));
  }
  console.log(`🎬 Autonomous music video ${short(run.id)} revision ${review.status}; rendering the film again`);
  await startFinalRender(projectId, run);
}

export async function onRenderEvent({ projectId, jobId, status, error, abandoned }) {
  if (!projectId || !jobId) return;
  const project = await getProject(projectId).catch(() => null);
  const run = runInFinalDelivery(project);
  if (!run || run.output.renderJobId !== jobId) return;
  // The file exists but the project does not name it: the song changed while it rendered (#15158).
  if (status === 'completed' && abandoned) return failFinalRender(projectId, SONG_CHANGED_DURING_RENDER);
  if (status === 'completed') return completeFinalRender(projectId, run);
  return failFinalRender(projectId, error || (status === 'canceled' ? 'The final render was cancelled' : 'The final render failed'));
}

export function registerReconciliation(advanceInBackground) {
  musicVideoEvents.on('cast-and-sets', ({ projectId }) => {
    if (!projectId) return;
    reconcileCastAndSets(projectId, advanceInBackground).catch((err) => console.error(`❌ Autonomous music video could not settle on Cast & Sets: ${err.message}`));
  });

  musicVideoEvents.on('render', (event) => {
    onRenderEvent(event).catch((err) => console.error(`❌ Autonomous music video could not settle on its final render: ${err.message}`));
  });

  musicVideoEvents.on('auto-review', (event) => {
    onAutoReviewEvent(event).catch((err) => console.error(`❌ Autonomous music video could not settle on its final revision: ${err.message}`));
  });

  musicVideoEvents.on('production', (event) => {
    onProductionEvent(event).catch((err) => console.error(`❌ Autonomous music video could not settle on production: ${err.message}`));
  });
}
