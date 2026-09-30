/**
 * Music Video — server-owned production run (#9066): the orchestrator over the
 * pure checkpoint in production.js, the pool rules in productionPool.js and
 * the browserless scene lanes in productionDispatch.js.
 *
 * `advanceProduction` derives the run's next step from the record and the
 * media queue and keeps taking steps until it has to wait — for generation
 * jobs, or for the auto-review run it handed the finished draft to. The
 * browser is never in the loop: frames, clips and the review's revised
 * sections are all dispatched from here, so closing the tab stalls nothing.
 *
 * What moves a run forward:
 *   - the director — Start, Resume;
 *   - completion events of work THIS run put in flight: a take landing on a
 *     scene (`scene-image` / `scene-video`), one of its jobs failing or being
 *     cancelled, and its review run handing out revised sections or ending.
 * Nothing at boot advances a run. A run is pinned to the process that started
 * or resumed it (`processId`), so after a restart its checkpoint loads and
 * late completion events still settle their steps, but nothing is dispatched
 * — and no provider is called — until the director resumes. Advances for one
 * run are coalesced in-process, and every dispatch reserves its step in a
 * serialized write first, so an event arriving mid-step cannot dispatch twice.
 */

import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { getProject, mutateProjectRecord } from './projects.js';
import { musicVideoEvents } from './events.js';
import { withAutopilotCutting } from './composition.js';
import {
  attachProductionReview,
  assertProductionStepOpen,
  cancelProductionOnProject,
  findProductionRun,
  haltProduction,
  markProductionCastAndSets,
  markProductionPlanned,
  normalizeProductionPool,
  nextProductionStep,
  projectProductionRuns,
  reconcileProductionSteps,
  remainingProductionGenerations,
  reserveProductionStep,
  resumeProductionOnProject,
  settleProductionStep,
  startProductionOnProject,
  stepForJob,
  stopProductionOnProject,
} from './production.js';
import {
  assertPoolEligible,
  assertRouteAllowed,
  chooseProductionRoute,
  loadPoolEnv,
  poolPricing,
  stepPriceUsd,
  sceneRequirement,
} from './productionPool.js';

// One id per server process: a run records the process that may dispatch for it.
const PROCESS_ID = `proc-${randomUUID()}`;
const MAX_STEPS_PER_ADVANCE = 32;
// The review's revision budget is bounded by the auto-review run's own limit.
const AUTO_REVIEW_MAX_GENERATIONS = 100;
// Refusals that mean "this run cannot continue as configured" — never retried.
const LIMIT_CODES = new Set(['PRODUCTION_SPEND_LIMIT', 'PRODUCTION_BUDGET_EXHAUSTED']);

const advancing = new Map();
const short = (id) => String(id || '').slice(5, 13);

// Test seam: the heavy collaborators (live settings/catalogs, the queue, the
// generation lanes) are swappable so orchestration is testable with injected
// queue events. Production code never calls the setter.
const defaults = {
  loadEnv: loadPoolEnv,
  chooseRoute: chooseProductionRoute,
  dispatch: async (args) => (await import('./productionDispatch.js')).dispatchProductionStep(args),
  queue: async () => import('../mediaJobQueue/index.js'),
  planProject: async (...args) => (await import('./planner.js')).planProject(...args),
  startCastAndSets: async (...args) => (await import('./castAndSetsService.js')).startCastAndSets(...args),
  autoReview: async () => import('./autoReviewService.js'),
  releaseRevisionSection: async (...args) => (await import('./revisionService.js')).releaseRevisionSection(...args),
};
let deps = { ...defaults };
export function __setProductionDepsForTests(overrides) { deps = { ...defaults, ...overrides }; }
export function __advanceProductionForTests(projectId, runId) { return advanceProduction(projectId, runId); }

async function requireProject(projectId) {
  const project = await getProject(projectId);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  return project;
}

/** Read the newest record at the queue boundary, after provider preparation. */
export async function assertProductionSubmission(projectId, runId, stepKey, input) {
  const project = await requireProject(projectId);
  assertProductionStepOpen(project, runId, stepKey, { ...input, processId: PROCESS_ID });
}

async function liveJobs() {
  const { listJobs } = await deps.queue();
  return [...listJobs({ kind: 'image' }), ...listJobs({ kind: 'video' })];
}

/** The run as reported to the director: `interrupted` when a restart unpinned it. */
const present = (run) => ({ ...run, interrupted: run.status === 'running' && run.processId !== PROCESS_ID });

function publish(projectId, project, run, action) {
  musicVideoEvents.emit('production', { projectId, runId: run.id, run: present(run), action, project });
}

async function halt(projectId, runId, { status, reason, error = null }) {
  const out = await mutateProjectRecord(projectId, (current) => haltProduction(current, runId, { status, reason, error }));
  const log = status === 'failed' ? console.error : status === 'completed' ? console.log : console.warn;
  log(`${status === 'completed' ? '✅' : status === 'failed' ? '❌' : '⏸️'} Music Video production ${short(runId)} ${status}${reason ? `: ${reason}` : ''}`);
  return out;
}

// ---- dispatching one generation ----------------------------------------------

/**
 * Choose a pool route for one scene slot, enforce it, reserve the step, and
 * enqueue. Returns `{ ok: true }`, or `{ halt: {status, reason} }` when the
 * run cannot continue as configured, or `{ ok: false }` when the slot is
 * simply busy (another advance got there first).
 */
async function dispatchSlot(projectId, runId, { stepKind, sceneId, revisionId = null }) {
  const project = await requireProject(projectId);
  const run = findProductionRun(project, runId);
  const scene = (project.scenes || []).find((s) => s.sceneId === sceneId);
  if (!scene) return { ok: false };
  const requirement = sceneRequirement(project, scene, stepKind);
  const env = await deps.loadEnv();
  const choice = await deps.chooseRoute(run, requirement, env);
  if (!choice?.route) {
    return { halt: { status: 'blocked', reason: `No allowed route can generate the ${stepKind} for "${scene.label || sceneId}": ${(choice?.reasons || []).join('; ')}` } };
  }
  // Enforced for ANY chooser — a model's pick outside the pool never reaches the queue.
  const refused = await assertRouteAllowed(run, choice.route, requirement, env).then(() => null, (err) => err);
  if (refused) return { halt: { status: 'blocked', reason: refused.message } };

  const reserved = await mutateProjectRecord(projectId, (current) => reserveProductionStep(current, runId, {
    kind: stepKind, sceneId, revisionId, route: choice.route, rationale: choice.rationale, processId: PROCESS_ID,
    costUsd: stepPriceUsd({ route: choice.route, project, scene, stepKind }),
  })).catch((err) => ({ error: err }));
  if (reserved.error) {
    const code = reserved.error.code;
    if (LIMIT_CODES.has(code)) return { halt: { status: 'limit-reached', reason: reserved.error.message } };
    if (code === 'PRODUCTION_STEP_IN_FLIGHT' || code === 'PRODUCTION_NOT_RUNNING' || code === 'PRODUCTION_INTERRUPTED') return { ok: false };
    throw reserved.error;
  }
  const { step } = reserved;
  const tag = { projectId, sceneId, productionRunId: runId, productionStepKey: step.key, ...(revisionId ? { revisionId } : {}) };
  const sent = await deps.dispatch({ stepKind, project, scene, route: choice.route, tag, settings: env.settings })
    .catch((err) => ({ error: err }));
  if (sent.error) {
    await mutateProjectRecord(projectId, (current) => settleProductionStep(current, runId, step.key, { status: 'refused', error: sent.error.message }));
    if (revisionId) await deps.releaseRevisionSection(projectId, revisionId, sceneId).catch(() => {});
    console.warn(`⚠️ Music Video production ${short(runId)} ${stepKind} for ${sceneId} refused: ${sent.error.message}`);
    return { halt: { status: 'blocked', reason: `The ${stepKind} for "${scene.label || sceneId}" was refused: ${sent.error.message}` } };
  }
  const linked = await mutateProjectRecord(projectId, (current) => settleProductionStep(current, runId, step.key, { status: 'queued', jobId: sent.jobId }));
  console.log(`🎬 Music Video production ${short(runId)} ${stepKind} ${sceneId} → ${choice.route.mode}${choice.route.model ? `/${choice.route.model}` : ''} job ${String(sent.jobId).slice(0, 8)}`);
  // Stopped while this submission was in flight: its job must not run.
  if (linked.run.status !== 'running') await cancelOwnedJobs(runId, { includeRunning: false, jobIds: [sent.jobId] });
  return { ok: true };
}

// ---- the step loop --------------------------------------------------------------

async function takeSteps(projectId, runId) {
  for (let i = 0; i < MAX_STEPS_PER_ADVANCE; i += 1) {
    const project = await requireProject(projectId);
    const run = findProductionRun(project, runId);
    const step = nextProductionStep(project, run, { jobs: await liveJobs(), processId: PROCESS_ID });

    if (step.type === 'idle' || step.type === 'wait') return { project, run, action: step };

    if (step.type === 'halt') {
      const out = await halt(projectId, runId, { status: step.status, reason: step.reason });
      return { ...out, action: { type: 'idle' } };
    }

    if (step.type === 'cast-and-sets') {
      // Marked first, like the plan: a failed start halts instead of looping.
      await mutateProjectRecord(projectId, (current) => markProductionCastAndSets(current, runId));
      const started = await deps.startCastAndSets(projectId, {
        productionRunId: runId,
        ...(run.reviewer?.providerId ? { providerId: run.reviewer.providerId } : {}),
        ...(run.reviewer?.model ? { model: run.reviewer.model } : {}),
      }).catch((err) => ({ error: err }));
      if (started.error) {
        const out = await halt(projectId, runId, { status: 'blocked', reason: `The Cast & Sets check-in could not start: ${started.error.message}` });
        return { ...out, action: { type: 'idle' } };
      }
      console.log(`🎭 Music Video production ${short(runId)} started the Cast & Sets check-in`);
      continue;
    }

    if (step.type === 'plan') {
      // Marked first: a crash mid-plan must not re-plan (and re-pay) on resume.
      await mutateProjectRecord(projectId, (current) => markProductionPlanned(current, runId));
      const planned = await deps.planProject(projectId, { seedPrompts: true, directive: run.directive }).catch((err) => ({ error: err }));
      if (planned.error) {
        const out = await halt(projectId, runId, { status: 'blocked', reason: `Planning failed: ${planned.error.message}` });
        return { ...out, action: { type: 'idle' } };
      }
      console.log(`🪄 Music Video production ${short(runId)} planned ${planned.scenesAdded} scene(s)`);
      continue;
    }

    if (step.type === 'dispatch') {
      const res = await dispatchSlot(projectId, runId, { stepKind: step.kind, sceneId: step.sceneId });
      if (res.halt) {
        const out = await halt(projectId, runId, res.halt);
        return { ...out, action: { type: 'idle' } };
      }
      if (!res.ok) {
        const fresh = await requireProject(projectId);
        return { project: fresh, run: findProductionRun(fresh, runId), action: { type: 'wait', on: 'generation' } };
      }
      continue;
    }

    if (step.type === 'review') {
      const { startAutoReview } = await deps.autoReview();
      const started = await startAutoReview(projectId, {
        startSec: step.startSec,
        endSec: step.endSec,
        limits: {
          maxAttempts: run.limits.maxReviewAttempts,
          maxGenerations: Math.min(AUTO_REVIEW_MAX_GENERATIONS, remainingProductionGenerations(run)),
        },
        reviewer: run.reviewer,
        productionRunId: runId,
      }).catch((err) => ({ error: err }));
      if (started.error) {
        const out = await halt(projectId, runId, { status: 'blocked', reason: `The draft review could not start: ${started.error.message}` });
        return { ...out, action: { type: 'idle' } };
      }
      await mutateProjectRecord(projectId, (current) => attachProductionReview(current, runId, started.run.id));
      console.log(`🔎 Music Video production ${short(runId)} handed the draft [${step.startSec}, ${step.endSec}]s to review ${short(started.run.id)}`);
      continue;
    }
    throw new Error(`Unknown production step ${step.type}`);
  }
  const project = await requireProject(projectId);
  return { project, run: findProductionRun(project, runId), action: { type: 'wait', on: 'step-budget' } };
}

/**
 * Advance a run as far as it can go right now. Concurrent calls for one run
 * coalesce onto the in-flight advance, which then takes one more pass.
 * Returns `{ project, run, action }`.
 */
function advanceProduction(projectId, runId) {
  const live = advancing.get(runId);
  if (live) {
    live.again = true;
    return live.promise;
  }
  const entry = { again: false, promise: null };
  entry.promise = (async () => {
    try {
      let result;
      do {
        entry.again = false;
        result = await takeSteps(projectId, runId);
      } while (entry.again);
      publish(projectId, result.project, result.run, result.action);
      return result;
    } finally {
      advancing.delete(runId);
    }
  })();
  advancing.set(runId, entry);
  return entry.promise;
}

function advanceInBackground(projectId, runId) {
  armJobListeners();
  return advanceProduction(projectId, runId).catch(async (err) => {
    console.error(`❌ Music Video production ${short(runId)} step failed: ${err.message}`);
    await halt(projectId, runId, { status: 'stopped', reason: `A step failed: ${err.message}`, error: err.message })
      .then((out) => publish(projectId, out.project, out.run, { type: 'idle' }))
      .catch(() => {});
  });
}

/** Cancel this run's queued (and optionally running) jobs. Evidence (records, takes, steps) is kept. */
async function cancelOwnedJobs(runId, { includeRunning = false, jobIds = null } = {}) {
  const { cancelJob } = await deps.queue();
  const owned = (await liveJobs()).filter((job) => job.params?.musicVideo?.productionRunId === runId
    && (job.status === 'queued' || (includeRunning && job.status === 'running'))
    && (!jobIds || jobIds.includes(job.id)));
  for (const job of owned) {
    await cancelJob(job.id).catch((err) => console.error(`❌ Music Video production ${short(runId)} could not cancel job ${job.id.slice(0, 8)}: ${err.message}`));
  }
  if (owned.length) console.log(`🛑 Music Video production ${short(runId)} cancelled ${owned.length} job(s)`);
  return owned.map((j) => j.id);
}

// ---- director actions -----------------------------------------------------------

/**
 * Start a run (explicit director request). Every pool route must be eligible
 * now. Returns `{ project, run }`; the run advances in the background.
 */
export async function startProduction(projectId, { directive, pool: requested, limits, reviewer }) {
  await requireProject(projectId);
  const pool = normalizeProductionPool(requested);
  await assertPoolEligible(pool, await deps.loadEnv());
  // The autopilot cuts on the song (#9290) unless the director chose how it
  // cuts — set before the run captures its creative-setup basis.
  const out = await mutateProjectRecord(projectId, (current) => startProductionOnProject(withAutopilotCutting(current), {
    directive, pool, limits, reviewer, processId: PROCESS_ID, pricing: poolPricing(pool, current),
  }));
  console.log(`🎬 Music Video production ${short(out.run.id)} started: ${out.run.pool.length} allowed route(s), ≤${out.run.limits.maxGenerations} generations, ≤${out.run.limits.maxReviewAttempts} reviews`);
  advanceInBackground(projectId, out.run.id);
  return { project: out.project, run: present(out.run) };
}

/**
 * Resume a run: settle its steps against the queue, re-pin it to this process
 * (optionally raising limits / accepting a changed creative setup), resume its
 * paused review, and continue. Returns `{ project, run }`.
 */
export async function resumeProduction(projectId, runId, { limits, acceptBasis = false } = {}) {
  const jobs = await liveJobs();
  await mutateProjectRecord(projectId, (current) => reconcileProductionSteps(current, runId, jobs));
  const out = await mutateProjectRecord(projectId, (current) => resumeProductionOnProject(current, runId, { limits, acceptBasis, processId: PROCESS_ID }));
  const review = out.run.reviewRunId
    ? (out.project.autoReviews || []).find((r) => r.id === out.run.reviewRunId)
    : null;
  if (review && (review.status === 'stopped' || review.status === 'limit-reached')) {
    const { resumeAutoReview } = await deps.autoReview();
    const headroom = Math.min(AUTO_REVIEW_MAX_GENERATIONS, review.usage.generations + remainingProductionGenerations(out.run));
    await resumeAutoReview(projectId, review.id, {
      limits: {
        maxAttempts: Math.max(review.limits.maxAttempts, out.run.limits.maxReviewAttempts),
        maxGenerations: Math.max(review.limits.maxGenerations, headroom),
      },
    }).catch((err) => console.warn(`⚠️ Music Video production ${short(runId)} could not resume its review: ${err.message}`));
  }
  advanceInBackground(projectId, runId);
  const fresh = await requireProject(projectId);
  return { project: fresh, run: present(findProductionRun(fresh, runId)) };
}

/** Stop: nothing new is dispatched and queued owned jobs are cancelled; running ones land. */
export async function stopProduction(projectId, runId) {
  const out = await mutateProjectRecord(projectId, (current) => stopProductionOnProject(current, runId));
  await cancelOwnedJobs(runId);
  const review = out.run.reviewRunId ? (out.project.autoReviews || []).find((r) => r.id === out.run.reviewRunId) : null;
  if (review?.status === 'running') {
    const { stopAutoReview } = await deps.autoReview();
    await stopAutoReview(projectId, review.id).catch(() => {});
  }
  const fresh = await requireProject(projectId);
  const run = findProductionRun(fresh, runId);
  publish(projectId, fresh, run, { type: 'idle' });
  return { project: fresh, run: present(run) };
}

/** Cancel (terminal): every owned job still live is cancelled, and the review with its revision. */
export async function cancelProduction(projectId, runId) {
  const out = await mutateProjectRecord(projectId, (current) => cancelProductionOnProject(current, runId));
  await cancelOwnedJobs(runId, { includeRunning: true });
  const review = out.run.reviewRunId ? (out.project.autoReviews || []).find((r) => r.id === out.run.reviewRunId) : null;
  if (review && ['running', 'stopped', 'limit-reached'].includes(review.status)) {
    const { cancelAutoReview } = await deps.autoReview();
    await cancelAutoReview(projectId, review.id).catch(() => {});
  }
  const fresh = await requireProject(projectId);
  const run = findProductionRun(fresh, runId);
  publish(projectId, fresh, run, { type: 'idle' });
  return { project: fresh, run: present(run) };
}

/** One run as the director sees it (`interrupted` after a restart). */
export async function getProduction(projectId, runId) {
  const project = await requireProject(projectId);
  return { run: present(findProductionRun(project, runId)) };
}

// ---- completion events of work a run put in flight --------------------------------

const runningHere = (run) => run?.status === 'running' && run.processId === PROCESS_ID;

/** A job this run dispatched ended: settle its step (idempotent), then continue. */
async function onProductionJobEnded(job) {
  const tag = job?.params?.musicVideo;
  if (!tag?.projectId || !tag.productionRunId) return;
  const project = await getProject(tag.projectId);
  const run = project ? projectProductionRuns(project).find((r) => r.id === tag.productionRunId) : null;
  if (!run || !stepForJob(run, job)) return;
  const status = job.status === 'completed' ? 'completed' : job.status === 'canceled' ? 'canceled' : 'failed';
  const out = await mutateProjectRecord(tag.projectId, (current) => {
    const r = findProductionRun(current, tag.productionRunId);
    const step = stepForJob(r, job);
    return step ? settleProductionStep(current, r.id, step.key, { status, jobId: job.id, error: status === 'completed' ? null : (job.error || job.status) }) : { project: current, changed: false };
  });
  if (out.changed && status !== 'completed' && runningHere(out.run)) await advanceProduction(tag.projectId, tag.productionRunId);
}

/**
 * The review run a production owns advanced: dispatch the revised sections it
 * handed out (the board never submits those), or continue when it ended.
 */
async function onOwnedReviewAdvanced({ projectId, run: review, action } = {}) {
  if (!projectId || !review?.productionRunId) return;
  const project = await getProject(projectId);
  const run = project ? projectProductionRuns(project).find((r) => r.id === review.productionRunId) : null;
  if (!runningHere(run)) return;
  if (action?.type === 'generate' && review.status === 'running' && action.sections?.length) {
    for (const section of action.sections) {
      const stepKind = section.kind === 'image' ? 'frame' : 'clip';
      const res = await dispatchSlot(projectId, run.id, { stepKind, sceneId: section.sceneId, revisionId: action.revisionId });
      if (res.halt) {
        // The revision's claim is released so a resume hands the section out again.
        await deps.releaseRevisionSection(projectId, action.revisionId, section.sceneId).catch(() => {});
        const out = await halt(projectId, run.id, res.halt);
        publish(projectId, out.project, out.run, { type: 'idle' });
        const { stopAutoReview } = await deps.autoReview();
        await stopAutoReview(projectId, review.id).catch(() => {});
        return;
      }
    }
    return;
  }
  if (review.status !== 'running') await advanceProduction(projectId, run.id);
}

/** A take landed on a scene: a running run waiting on generation continues. */
async function onSceneTake({ projectId } = {}) {
  if (!projectId) return;
  const project = await getProject(projectId);
  const run = project ? projectProductionRuns(project).find(runningHere) : null;
  if (run) await advanceProduction(projectId, run.id);
}

const guarded = (label, fn) => (payload) => {
  Promise.resolve().then(() => fn(payload))
    .catch((err) => console.error(`❌ Music Video production could not continue after ${label}: ${err.message}`));
};

musicVideoEvents.on('scene-image', guarded('a frame landed', onSceneTake));
musicVideoEvents.on('scene-video', guarded('a clip landed', onSceneTake));
musicVideoEvents.on('auto-review', guarded('its review advanced', onOwnedReviewAdvanced));

/** The Cast & Sets check-in settled (approved, skipped) or failed: a run waiting on it continues or halts. */
async function onCastAndSetsAdvanced({ projectId, stage } = {}) {
  if (!projectId || !['approved', 'skipped', 'failed'].includes(stage?.status)) return;
  const project = await getProject(projectId);
  const run = project ? projectProductionRuns(project).find(runningHere) : null;
  if (run && !run.planned) await advanceProduction(projectId, run.id);
}
musicVideoEvents.on('cast-and-sets', guarded('its Cast & Sets check-in advanced', onCastAndSetsAdvanced));

// The queue listener is armed on a run's first Start/Resume (never at boot);
// the queue module is deferred because only this path needs it.
let jobListenersArmed = false;
function armJobListeners() {
  if (jobListenersArmed) return;
  jobListenersArmed = true;
  deps.queue().then(({ mediaJobEvents }) => {
    const onEnded = guarded('a job ended', onProductionJobEnded);
    for (const event of ['completed', 'failed', 'canceled']) mediaJobEvents.on(event, onEnded);
  }).catch((err) => {
    jobListenersArmed = false;
    console.error(`❌ Music Video production could not watch generation jobs: ${err.message}`);
  });
}
