/**
 * Creative Director — production-plan advance loop (CDO Phase 2, #2184).
 *
 * The generalized sibling of completionHook.js#advanceAfterSceneSettled. For a
 * DIRECTIVE-driven project (`project.directive` present), "what happens next" is
 * a pure function of the plan DAG on the project record — never a stored cursor:
 *
 *   - No plan yet          → enqueue the planner agent (cd-plan) to write one.
 *   - A runnable step       → dispatch it through the gated creative tool
 *                             registry (`dispatchCreativeTool`), one at a time,
 *                             sequentially, respecting `dependsOn`.
 *   - A long-running step   → stays `running` until its media job settles (a
 *                             completion event re-fires this loop).
 *   - A step failed         → bounded re-plan (MAX_REPLAN_ROUNDS), then pause
 *                             with residuals for human review.
 *   - A blocked step        → pause with the block reason (never silently retry
 *                             around a human-review pause).
 *   - All steps terminal    → the project is complete.
 *
 * Legacy video projects (no `directive`/`plan`) never enter here — the treatment/
 * scene flow in completionHook.js is unchanged. Idempotent + driven by CoS
 * completions (the planner task), media-job events (long-running steps), and boot
 * recovery — the same shape as the scene loop.
 */

import { getProject, updateProject, updatePlanStep, recordRun, updateRun } from './local.js';
import { enqueuePlanTask } from './agentBridge.js';
import { dispatchCreativeTool } from '../creative/toolRegistry.js';
import { listJobs, mediaJobEvents } from '../mediaJobQueue/index.js';
import { MAX_REPLAN_ROUNDS, PLAN_STEP_TERMINAL_SUCCESS } from '../../lib/creativeDirectorPresets.js';

const nowISO = () => new Date().toISOString();

/**
 * Pure next-step derivation over a plan DAG. Exported + side-effect-free so the
 * ordering/dependency/terminal logic is unit-tested directly against fixtures.
 *
 * Returns one of:
 *   - `{ type: 'empty' }`             — plan has no steps → nothing to execute.
 *   - `{ type: 'waiting', step }`     — a step is `running`; wait for it to settle.
 *   - `{ type: 'blocked', step }`     — a step is `blocked` (human-review pause).
 *   - `{ type: 'run', step }`         — the next runnable pending step (deps all
 *                                       terminal-success), in listed order.
 *   - `{ type: 'stuck', steps }`      — pending steps remain but none is runnable
 *                                       (a dependency failed or is missing).
 *   - `{ type: 'failed', steps }`     — every step terminal and ≥1 failed.
 *   - `{ type: 'complete' }`          — every step done/skipped.
 *
 * Sequential by construction: even when two pending steps are both runnable it
 * returns the FIRST (array order) — v1 has no parallel branches.
 *
 * @param {{steps?: Array<object>}} plan
 */
export function deriveNextPlanAction(plan) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  if (!steps.length) return { type: 'empty' };
  const byId = new Map(steps.map((s) => [s.stepId, s]));

  const running = steps.find((s) => s.status === 'running');
  if (running) return { type: 'waiting', step: running };

  const blocked = steps.find((s) => s.status === 'blocked');
  if (blocked) return { type: 'blocked', step: blocked };

  const depsSatisfied = (s) => (Array.isArray(s.dependsOn) ? s.dependsOn : []).every((id) => {
    const dep = byId.get(id);
    return dep && PLAN_STEP_TERMINAL_SUCCESS.has(dep.status);
  });

  const pending = steps.filter((s) => s.status === 'pending');
  const runnable = pending.find(depsSatisfied);
  if (runnable) return { type: 'run', step: runnable };
  // No pending step is runnable and nothing is running → the plan can't progress
  // (a dependency failed/missing, or a cycle). Surface as residuals.
  if (pending.length) return { type: 'stuck', steps: pending };

  const failed = steps.filter((s) => s.status === 'failed');
  if (failed.length) return { type: 'failed', steps: failed };
  return { type: 'complete' };
}

// In-memory dedup, same role as completionHook's inflight sets. `inflightPlanner`
// covers the updateProject→enqueue window for the planner; `inflightPlanStep`
// covers the getProject→recordRun window for a dispatch (released once the
// persisted `running` step+run guard re-entry). `planJobCleanups` holds the
// teardown for every armed long-running media-job listener so tests can drop them.
const inflightPlanner = new Set();
const inflightPlanStep = new Set();
const planJobCleanups = new Map();

async function pausePlanWithResidual(projectId, reason) {
  await updateProject(projectId, { status: 'paused', failureReason: reason })
    .catch((e) => console.log(`⚠️ CD plan pause for ${projectId} failed: ${e.message}`));
  console.log(`⏸️  CD plan ${projectId} paused: ${reason}`);
}

async function finishRun(projectId, runId, status, failureReason) {
  if (!runId) return;
  await updateRun(projectId, runId, {
    status,
    completedAt: nowISO(),
    ...(failureReason ? { failureReason } : {}),
  }).catch((e) => console.log(`⚠️ CD plan finishRun ${runId} on ${projectId} failed: ${e.message}`));
}

// Compact, id-only summary of a tool result so the plan step's `result` never
// bloats with a full render payload / record body (mirrors the run ledger's
// digest-not-payload rule).
function summarizeResult(result) {
  if (!result || typeof result !== 'object') return {};
  const out = {};
  for (const k of ['id', 'jobId', 'seriesId', 'issueId', 'universeId', 'name', 'status']) {
    if (result[k] != null) out[k] = result[k];
  }
  return out;
}

async function enqueuePlannerOnce(project) {
  const projectId = project.id;
  const hasInflightPlanRun = (project.runs || []).some(
    (r) => r.kind === 'plan' && r.status !== 'completed' && r.status !== 'failed',
  );
  if (hasInflightPlanRun || inflightPlanner.has(projectId)) return;
  inflightPlanner.add(projectId);
  await updateProject(projectId, { status: 'planning' })
    .catch((e) => { inflightPlanner.delete(projectId); throw e; });
  const fresh = await getProject(projectId);
  await enqueuePlanTask(fresh).finally(() => inflightPlanner.delete(projectId));
}

/**
 * The generalized advance loop. Pure next-step over the plan, idempotent, safe
 * to call from a CoS completion, a media-job settle, boot recovery, or a manual
 * resume — it re-reads project state and derives the one next action every time.
 *
 * @param {string} projectId
 */
export async function advanceAfterPlanStepSettled(projectId) {
  const project = await getProject(projectId).catch(() => null);
  if (!project) return;
  if (project.status === 'paused' || project.status === 'failed') return;
  // Legacy video project — the scene loop owns it; never plan-advance it.
  if (!project.directive) return;

  // No plan yet → enqueue the planner (mirrors the no-treatment branch).
  if (!Array.isArray(project.plan?.steps)) {
    return enqueuePlannerOnce(project);
  }

  const action = deriveNextPlanAction(project.plan);
  switch (action.type) {
    case 'waiting':
      // A step is running (a long-running job in flight). Its settle re-fires us.
      return;
    case 'blocked':
      return pausePlanWithResidual(
        projectId,
        `Step "${action.step.stepId}" is blocked: ${action.step.result?.reason || 'awaiting human review'}`,
      );
    case 'stuck':
      return pausePlanWithResidual(
        projectId,
        `No runnable step — ${action.steps.length} pending step(s) blocked by a failed or missing dependency`,
      );
    case 'failed':
      // Safety net: a step is 'failed' but the executor didn't route it (e.g. a
      // hand-edited/legacy record). Send it through the failure handler.
      return handlePlanStepFailure(projectId, action.steps[0]);
    case 'empty':
    case 'complete':
      if (project.status !== 'complete') {
        await updateProject(projectId, { status: 'complete' })
          .catch((e) => console.log(`⚠️ CD plan complete for ${projectId} failed: ${e.message}`));
        console.log(`✅ CD plan ${projectId} complete`);
      }
      return;
    case 'run':
      return runPlanStep(project, action.step);
    default:
      return;
  }
}

async function runPlanStep(project, step) {
  const projectId = project.id;
  const key = `${projectId}:${step.stepId}`;
  if (inflightPlanStep.has(key)) return;
  // A persisted 'running' run for this step means a concurrent advance already
  // dispatched it — don't double-dispatch.
  const alreadyRunning = (project.runs || []).some(
    (r) => r.kind === 'plan-step' && r.stepId === step.stepId && r.status === 'running',
  );
  if (alreadyRunning) return;
  inflightPlanStep.add(key);
  let run;
  try {
    if (project.status !== 'rendering') await updateProject(projectId, { status: 'rendering' });
    await updatePlanStep(projectId, step.stepId, { status: 'running', startedAt: nowISO() });
    run = await recordRun(projectId, {
      kind: 'plan-step', stepId: step.stepId, toolName: step.toolName, status: 'running',
    });
  } finally {
    // The persisted 'running' step + run row now guard re-entry — release the
    // in-memory key so a raced advance sees the persisted state and bails.
    inflightPlanStep.delete(key);
  }
  console.log(`▶️  CD plan ${projectId}: dispatching step "${step.stepId}" (${step.toolName})`);
  // Outside the request lifecycle — catch so a throw becomes a settle, never an
  // unhandled rejection.
  const dispatch = await dispatchCreativeTool(step.toolName, step.args || {}, { projectId })
    .catch((err) => ({ ok: false, threw: true, error: err.message }));
  return settlePlanStepDispatch(projectId, step, run?.runId, dispatch);
}

async function settlePlanStepDispatch(projectId, step, runId, dispatch) {
  // Gate rejection (autonomy off / over budget / wrapped-service refusal): the
  // step did no work. Block it + pause so a human can raise the budget / flip
  // autonomy and Resume — the CD never silently retries around a governance stop.
  if (!dispatch || (dispatch.ok !== true && !dispatch.threw)) {
    const reason = dispatch?.reason || 'rejected';
    await finishRun(projectId, runId, 'failed', reason);
    await updatePlanStep(projectId, step.stepId, { status: 'blocked', result: { reason } });
    return pausePlanWithResidual(
      projectId,
      `Step "${step.stepId}" (${step.toolName}) rejected by the creative gate: ${reason}`,
    );
  }
  // Real tool error → mark failed, then bounded re-plan or pause.
  if (dispatch.threw) {
    const error = dispatch.error || 'tool error';
    await finishRun(projectId, runId, 'failed', error);
    const bumped = (step.retryCount || 0) + 1;
    await updatePlanStep(projectId, step.stepId, { status: 'failed', retryCount: bumped, result: { error } });
    return handlePlanStepFailure(projectId, { ...step, retryCount: bumped });
  }
  // dry-run — the whole plan is walked as a preview (no side effects executed).
  if (dispatch.planned || dispatch.mode === 'dry-run') {
    await finishRun(projectId, runId, 'completed');
    await updatePlanStep(projectId, step.stepId, { status: 'done', result: { planned: true } });
    return advanceAfterPlanStepSettled(projectId);
  }
  // Long-running (media render / job): stay `running` until the underlying job
  // settles; a completion event re-fires the loop.
  if (dispatch.longRunning) {
    const jobId = dispatch.result?.jobId;
    if (jobId) return armPlanJobListener(projectId, step.stepId, jobId, runId);
    // A long-running tool with no observable job handle — Series Autopilot returns
    // a run handle, not a jobId; its in-process progress/pause event bridge lands
    // in CDO Phase 3. For now a successful START counts as step completion so the
    // plan makes progress; the underlying run continues on its own.
    console.log(`⚠️ CD plan ${projectId}: step "${step.stepId}" (${step.toolName}) is long-running with no jobId — marking done on start (event bridge lands in Phase 3)`);
    await finishRun(projectId, runId, 'completed');
    await updatePlanStep(projectId, step.stepId, { status: 'done', result: summarizeResult(dispatch.result) });
    return advanceAfterPlanStepSettled(projectId);
  }
  // Synchronous success (free / llm non-long-running).
  await finishRun(projectId, runId, 'completed');
  await updatePlanStep(projectId, step.stepId, { status: 'done', result: summarizeResult(dispatch.result) });
  console.log(`✅ CD plan ${projectId}: step "${step.stepId}" done`);
  return advanceAfterPlanStepSettled(projectId);
}

// Bounded re-planning (autopilot's convergence-pause contract): on a step
// failure the planner may revise the remaining steps at most MAX_REPLAN_ROUNDS
// times, then the project pauses with residuals for human review.
async function handlePlanStepFailure(projectId, step) {
  const project = await getProject(projectId).catch(() => null);
  if (!project || project.status === 'paused' || project.status === 'failed') return;
  const rounds = project.plan?.replanRounds || 0;
  if (rounds < MAX_REPLAN_ROUNDS && !inflightPlanner.has(projectId)) {
    console.log(`🔁 CD plan ${projectId}: step "${step.stepId}" failed — re-planning (round ${rounds + 1}/${MAX_REPLAN_ROUNDS})`);
    inflightPlanner.add(projectId);
    await updateProject(projectId, { status: 'planning' })
      .catch((e) => { inflightPlanner.delete(projectId); throw e; });
    const fresh = await getProject(projectId);
    await enqueuePlanTask(fresh).finally(() => inflightPlanner.delete(projectId));
    return;
  }
  return pausePlanWithResidual(
    projectId,
    `Step "${step.stepId}" (${step.toolName || 'tool'}) failed after ${rounds} re-plan round(s) — paused for human review`,
  );
}

// Register a one-shot listener that settles a long-running plan step when its
// media job reaches a terminal state. Idempotent teardown; closes the race where
// the job already settled between dispatch returning and the listener attaching.
function armPlanJobListener(projectId, stepId, jobId, runId) {
  const key = `${projectId}:${stepId}`;
  let fired = false;
  const teardown = () => {
    mediaJobEvents.off('completed', settle);
    mediaJobEvents.off('failed', settle);
    mediaJobEvents.off('canceled', settle);
    planJobCleanups.delete(key);
  };
  function settle(job) {
    if (fired || job?.id !== jobId) return;
    fired = true;
    teardown();
    const success = job.status === 'completed';
    // Runs outside the request lifecycle (media-queue emitter) — never throw out.
    (async () => {
      await finishRun(projectId, runId, success ? 'completed' : 'failed', success ? undefined : `job ${job.status}`);
      if (success) {
        await updatePlanStep(projectId, stepId, { status: 'done', result: { jobId } });
        await advanceAfterPlanStepSettled(projectId);
      } else {
        await updatePlanStep(projectId, stepId, { status: 'failed', result: { jobId, jobStatus: job.status } });
        await handlePlanStepFailure(projectId, { stepId, toolName: '(long-running job)', retryCount: 0 });
      }
    })().catch((e) => console.log(`⚠️ CD plan ${projectId} job settle for ${stepId} failed: ${e.message}`));
  }
  mediaJobEvents.on('completed', settle);
  mediaJobEvents.on('failed', settle);
  mediaJobEvents.on('canceled', settle);
  planJobCleanups.set(key, teardown);
  console.log(`⏳ CD plan ${projectId}: step "${stepId}" waiting on job ${String(jobId).slice(0, 8)}`);
  // The job may already be terminal (settled between dispatch and attach) — its
  // event fired and won't repeat. Re-check and settle immediately if so.
  const current = listJobs().find((j) => j.id === jobId);
  if (current && (current.status === 'completed' || current.status === 'failed' || current.status === 'canceled')) {
    settle(current);
  }
}

// Test-only: clear module-level dedup + tear down any armed media-job listeners
// so a suite that leaves a long-running step pending can't leak a live listener
// into a later test.
export function __resetPlanInflightState() {
  for (const teardown of planJobCleanups.values()) teardown();
  planJobCleanups.clear();
  inflightPlanner.clear();
  inflightPlanStep.clear();
}
