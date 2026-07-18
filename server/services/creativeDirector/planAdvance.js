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
import { autopilotEvents, isAutopilotActive, AUTOPILOT_TERMINAL_TYPES } from '../pipeline/seriesAutopilot.js';
import { getSeries } from '../pipeline/series.js';
import { MAX_REPLAN_ROUNDS, PLAN_STEP_TERMINAL_SUCCESS } from '../../lib/creativeDirectorPresets.js';

// The registry tool that runs Series Autopilot as a plan step. A long-running
// step whose dispatch returns a run handle (a `runId`, not a media `jobId`)
// settles via the in-process autopilot event bus (CDO Phase 3, #2185).
const AUTOPILOT_TOOL_NAME = 'pipeline_startSeriesAutopilot';

const nowISO = () => new Date().toISOString();

// The registry tool a plan step uses to render a video. Its done result carries
// `{ jobId }`, and a video history entry's id === its jobId — so the last such
// step's jobId is the project's final video (see the `complete` branch below).
const VIDEO_RENDER_TOOL_NAME = 'media_enqueueVideoJob';

/**
 * The jobId of the LAST done video-render step in a plan (or null). Used to
 * promote a directive plan's produced video to the project's `finalVideoId` on
 * completion so the CD overview surfaces it. Pure + last-wins: a multi-render
 * plan resolves to its final cut in listed order.
 */
export function lastRenderedVideoJobId(plan) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (step?.toolName === VIDEO_RENDER_TOOL_NAME && step.status === 'done' && step.result?.jobId) {
      return step.result.jobId;
    }
  }
  return null;
}

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

// A single cross-step result reference: `{{steps.<stepId>.result.<dotpath>}}`.
// The reference resolves to a value produced by an EARLIER (terminal-success)
// step's persisted `result` — the id-only summary `summarizeResult` stored (e.g.
// a created series' `result.id`). stepIds allow letters/digits/`_`/`-`; the path
// is a dotted key list into the result object.
// One source for the reference grammar; the anchored form (whole-value → raw
// type preserved) and the global form (embedded → stringified) derive from it so
// widening the id/path character classes can't diverge the two.
const STEP_REF_BODY = String.raw`\{\{\s*steps\.([\w-]+)\.result\.([\w.-]+)\s*\}\}`;
const STEP_REF_ANCHORED = new RegExp(`^${STEP_REF_BODY}$`);
const STEP_REF_GLOBAL = new RegExp(STEP_REF_BODY, 'g');

/**
 * Resolve `{{steps.<stepId>.result.<path>}}` references in a plan step's `args`
 * against the plan's already-completed steps (#2773). The executor otherwise
 * dispatches `args` verbatim and never interpolated prior results — so a step
 * that needs a just-minted id (the classic case: a `series` commission where
 * `pipeline_startSeriesAutopilot` needs the id `pipeline_createSeries` mints)
 * had no way to reference it, and could only ever create an empty series.
 *
 * A whole-string reference (`"{{steps.create-series.result.id}}"`) substitutes
 * the RAW resolved value (type preserved); an embedded reference inside a longer
 * string is stringified in place. References are resolved recursively through
 * nested arrays/objects in `args`.
 *
 * Pure + side-effect-free (exported for direct unit testing). Returns
 * `{ args, error }`: `error` is a non-null human-readable string when any
 * reference points at an unknown step, a step that is not terminal-success, or a
 * missing result key — the executor treats that as a planning error (fail the
 * step → bounded re-plan) rather than dispatching an unresolved `{{…}}` literal.
 *
 * @param {{stepId?: string, args?: object}} step
 * @param {{steps?: Array<object>}} plan
 */
export function resolvePlanStepArgs(step, plan) {
  const args = step?.args || {};
  // Fast path: the vast majority of steps carry no references. Every reference
  // contains the `{{steps.` sentinel, so a cheap serialize-and-scan returns the
  // args untouched without building the step index or walking/cloning the tree.
  if (!JSON.stringify(args).includes('{{steps.')) return { args, error: null };

  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const byId = new Map(steps.map((s) => [s.stepId, s]));
  const errors = [];

  const resolveRef = (stepId, path) => {
    const dep = byId.get(stepId);
    if (!dep) { errors.push(`references unknown step "${stepId}"`); return undefined; }
    if (!PLAN_STEP_TERMINAL_SUCCESS.has(dep.status)) {
      errors.push(`references step "${stepId}" which is not complete (status: ${dep.status || 'pending'})`);
      return undefined;
    }
    let val = dep.result;
    for (const seg of path.split('.')) val = val == null ? undefined : val[seg];
    if (val === undefined || val === null) {
      errors.push(`references missing result "${path}" on step "${stepId}"`);
      return undefined;
    }
    return val;
  };

  const resolveString = (str) => {
    if (!str.includes('{{')) return str;
    const whole = STEP_REF_ANCHORED.exec(str);
    if (whole) {
      const v = resolveRef(whole[1], whole[2]);
      return v === undefined ? str : v;
    }
    return str.replace(STEP_REF_GLOBAL, (m, stepId, path) => {
      const v = resolveRef(stepId, path);
      return v === undefined ? m : String(v);
    });
  };

  const resolveValue = (val) => {
    if (typeof val === 'string') return resolveString(val);
    if (Array.isArray(val)) return val.map(resolveValue);
    if (val && typeof val === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(val)) out[k] = resolveValue(v);
      return out;
    }
    return val;
  };

  const resolvedArgs = resolveValue(args);
  return { args: resolvedArgs, error: errors.length ? `Step "${step?.stepId}" ${errors.join('; ')}` : null };
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
    case 'complete': {
      // Promote the plan's produced video so the CD overview has an artifact to
      // show. Unlike the legacy scene/stitch flow (stitchRunner sets
      // finalVideoId), the directive-plan flow historically only flipped status
      // to `complete` — so a finished video commission looked like it "did
      // nothing" even though a render landed in the media library. A video
      // history entry's id === its jobId, so the last done video-render step's
      // jobId IS the final video id. Null when already set or a video-less plan
      // (e.g. a comic) — which also keeps a re-entry from re-writing state.
      const videoId = project.finalVideoId ? null : lastRenderedVideoJobId(project.plan);
      if (project.status !== 'complete' || videoId) {
        const patch = { status: 'complete', ...(videoId ? { finalVideoId: videoId } : {}) };
        await updateProject(projectId, patch)
          .catch((e) => console.log(`⚠️ CD plan complete for ${projectId} failed: ${e.message}`));
        console.log(`✅ CD plan ${projectId} complete${videoId ? ` (final video ${videoId})` : ''}`);
      }
      return;
    }
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
  // Resolve cross-step result references in the args (#2773) so this step can
  // consume a prior step's minted id (e.g. a created series' `result.id`). A
  // reference that can't be resolved is a planning error (a mis-authored plan) →
  // fail the step and route through bounded re-plan, never dispatch a literal
  // `{{…}}`. The RESOLVED step flows onward so downstream settle logic (e.g. the
  // autopilot listener's `step.args.seriesId`) sees the concrete id, not the ref.
  const resolved = resolvePlanStepArgs(step, project.plan);
  if (resolved.error) {
    await finishRun(projectId, run?.runId, 'failed', resolved.error);
    const bumped = (step.retryCount || 0) + 1;
    await updatePlanStep(projectId, step.stepId, { status: 'failed', retryCount: bumped, result: { error: resolved.error } });
    console.log(`❌ CD plan ${projectId}: step "${step.stepId}" ${resolved.error}`);
    return handlePlanStepFailure(projectId, { ...step, retryCount: bumped });
  }
  const resolvedStep = { ...step, args: resolved.args };
  console.log(`▶️  CD plan ${projectId}: dispatching step "${step.stepId}" (${step.toolName})`);
  // Outside the request lifecycle — catch so a throw becomes a settle, never an
  // unhandled rejection.
  const dispatch = await dispatchCreativeTool(resolvedStep.toolName, resolvedStep.args, { projectId })
    .catch((err) => ({ ok: false, threw: true, error: err.message }));
  return settlePlanStepDispatch(projectId, resolvedStep, run?.runId, dispatch);
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
    // Series Autopilot returns a run handle (`runId`), not a media jobId — settle
    // this step off the in-process autopilot event bus (CDO Phase 3, #2185): the
    // step stays `running` until the underlying autopilot run reaches a terminal
    // frame. A pause surfaces as a BLOCKED step (never auto-retried); an error
    // routes through the failure handler. `alreadyRunning` means the tool
    // attached to a live run instead of double-starting — we observe it the same.
    const seriesId = step.args?.seriesId;
    if (step.toolName === AUTOPILOT_TOOL_NAME && seriesId && dispatch.result?.runId) {
      return armAutopilotListener(projectId, step.stepId, seriesId, runId, dispatch.result);
    }
    // A long-running tool with no observable handle at all — mark done on start so
    // the plan makes progress; the underlying work continues on its own.
    console.log(`⚠️ CD plan ${projectId}: step "${step.stepId}" (${step.toolName}) is long-running with no observable handle — marking done on start`);
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

// Compact summary of an autopilot terminal frame for the plan step `result` —
// carries the run id + the "clean complete but with residual concerns" counters
// the autopilot's own `complete` frame surfaces (#1572/#1573), so a plan reader
// sees the same qualifications an SSE client would.
function summarizeAutopilotResult(payload) {
  const out = {};
  for (const k of ['runId', 'steps', 'craftGapIssues', 'craftGapFindings', 'editorialCheckErrors']) {
    if (payload?.[k] != null) out[k] = payload[k];
  }
  return out;
}

// Map an autopilot terminal frame onto the plan step's persisted state.
//   - complete            → step `done`, advance the plan.
//   - paused / canceled   → step `blocked` (human-review pause; never auto-retried).
//   - error               → step `failed`, route through bounded re-plan.
// Runs off the event bus / a marker read — outside any request lifecycle — so it
// must never throw out (the caller wraps it, but keep it self-contained).
async function settleAutopilotStep(projectId, stepId, runId, payload) {
  const type = payload?.type;
  if (type === 'complete') {
    await finishRun(projectId, runId, 'completed');
    await updatePlanStep(projectId, stepId, { status: 'done', result: summarizeAutopilotResult(payload) });
    console.log(`✅ CD plan ${projectId}: autopilot step "${stepId}" complete`);
    return advanceAfterPlanStepSettled(projectId);
  }
  if (type === 'paused' || type === 'canceled') {
    const reason = payload?.reason
      || (type === 'canceled' ? 'autopilot run was canceled' : 'autopilot paused for human review');
    await finishRun(projectId, runId, 'failed', reason);
    // BLOCKED, not failed — a pause is a human-review gate. The advance loop sees
    // the blocked step and pauses the whole plan with the reason; it is never
    // silently retried around (the autopilot pause contract).
    await updatePlanStep(projectId, stepId, {
      status: 'blocked',
      result: { reason, residualFindings: payload?.residualFindings || [], pauseKind: payload?.pauseKind || null },
    });
    console.log(`⏸️  CD plan ${projectId}: autopilot step "${stepId}" blocked: ${reason}`);
    return advanceAfterPlanStepSettled(projectId);
  }
  // error frame.
  const error = payload?.error || 'autopilot run error';
  await finishRun(projectId, runId, 'failed', error);
  await updatePlanStep(projectId, stepId, { status: 'failed', result: { error } });
  return handlePlanStepFailure(projectId, { stepId, toolName: '(series autopilot)', retryCount: 0 });
}

// Read the persisted autopilot marker for the race where the run reached a
// terminal state between dispatch returning and our listener attaching (its
// event fired and won't repeat). Returns a synthetic terminal frame or null when
// the run is still `running`/absent (the live listener will catch the real one).
async function readAutopilotMarker(seriesId) {
  const series = await getSeries(seriesId).catch(() => null);
  const marker = series?.autopilot;
  if (!marker) return null;
  if (marker.status === 'done') {
    return { type: 'complete', runId: marker.runId, craftGapIssues: marker.craftGapIssues, craftGapFindings: marker.craftGapFindings, editorialCheckErrors: marker.editorialCheckErrors };
  }
  if (marker.status === 'paused') {
    return { type: 'paused', runId: marker.runId, reason: marker.lastError, residualFindings: marker.residualFindings || [], pauseKind: marker.pauseKind || null };
  }
  if (marker.status === 'error') {
    return { type: 'error', runId: marker.runId, error: marker.lastError };
  }
  return null; // 'running' or unknown — not terminal.
}

// Attach a listener to the in-process autopilot event bus for `seriesId`, settling
// the plan step on the first terminal frame. Idempotent teardown (reuses the
// shared planJobCleanups map so __resetPlanInflightState drops it too). Closes the
// already-terminal race via the persisted marker, mirroring armPlanJobListener.
function armAutopilotListener(projectId, stepId, seriesId, runId, apResult) {
  const key = `${projectId}:${stepId}`;
  let fired = false;
  const teardown = () => {
    autopilotEvents.off(seriesId, handler);
    planJobCleanups.delete(key);
  };
  function handler(payload) {
    if (fired || !payload || !AUTOPILOT_TERMINAL_TYPES.has(payload.type)) return;
    fired = true;
    teardown();
    settleAutopilotStep(projectId, stepId, runId, payload)
      .catch((e) => console.log(`⚠️ CD plan ${projectId} autopilot settle for ${stepId} failed: ${e.message}`));
  }
  autopilotEvents.on(seriesId, handler);
  planJobCleanups.set(key, teardown);
  console.log(`⏳ CD plan ${projectId}: step "${stepId}" attached to autopilot run for series ${String(seriesId).slice(0, 8)}${apResult?.alreadyRunning ? ' (already running)' : ''}`);
  // The run may already have reached a terminal state (settled between dispatch
  // returning and this attach) — its event fired and won't repeat. Re-check via
  // isAutopilotActive + the persisted marker and settle immediately if so.
  if (!isAutopilotActive(seriesId)) {
    (async () => {
      const marker = await readAutopilotMarker(seriesId);
      if (marker && !fired) {
        fired = true;
        teardown();
        await settleAutopilotStep(projectId, stepId, runId, marker);
      }
    })().catch((e) => console.log(`⚠️ CD plan ${projectId} autopilot marker settle for ${stepId} failed: ${e.message}`));
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
