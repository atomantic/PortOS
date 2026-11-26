/**
 * Plans and queues continuation work when a perpetual CoS task completes.
 */

import { ON_DEMAND_ORIGINS } from '../taskScheduleConstants.js';
import { loadState, isImprovementEnabled, canQueueImprovementTasks, isDaemonRunning } from './cosState.js';
import { emitLog } from './cosEvents.js';
import { getCosTasks } from './cosTaskStore.js';

/**
 * The scheduled task type a completed agent belongs to, if any — the key
 * `schedule.tasks` and the perpetual-refill gates look up. Reads the same three
 * projections agentLifecycle stamps onto the agent, newest-name first.
 */
export function agentScheduledType(agent) {
  return agent?.metadata?.taskAnalysisType
    || agent?.metadata?.analysisType
    || agent?.metadata?.selfImprovementType
    || null;
}

/**
 * The on-demand origins whose completed perpetual run may re-issue itself: a
 * human Run, and the drain re-issuing itself through the same lane. Everything
 * else — a quota burn today, whatever is added tomorrow — stops after one unit.
 */
const DRAINABLE_ON_DEMAND_ORIGINS = new Set([ON_DEMAND_ORIGINS.USER, ON_DEMAND_ORIGINS.REFILL]);

/** Decides whether this completion can refill its drain before the next scheduled check. */
export function isPerpetualRefillCandidate(agent, schedule) {
  const analysisType = agentScheduledType(agent);
  if (!analysisType) return false;
  const taskDef = schedule?.tasks?.[analysisType];
  // A manual branch reconciliation owns a bounded sweep even when recurring
  // dispatch is off. Other task types retain their saved perpetual policy.
  const manualBranchSweep = analysisType === 'branch-reconcile' && agent?.metadata?.taskOnDemand;
  return Boolean(taskDef?.enabled) && (taskDef?.perpetual === true || Boolean(manualBranchSweep));
}

/**
 * Decide which "lane" a completed drain run must continue in. Pure, so the
 * branch is unit-testable without a live daemon.
 *
 *   - `'skip'`     — not a drain refill candidate (disabled/non-draining/no
 *                    analysis type); nothing to refill.
 *   - `'onDemand'` — the completed run was a MANUAL "Run Now" drain, marked by
 *                    the on-demand spawn engines (`metadata.onDemand`, projected
 *                    onto the agent as `taskOnDemand`). It continues in the SAME
 *                    user-initiated lane it started in: re-issue an on-demand
 *                    request for the exact `taskType` + `appId`, gated only on the
 *                    master Improve flag — what `RunTaskButton` itself gates on —
 *                    NOT on `canQueueImprovementTasks`. This is the fix for a
 *                    manual drain stalling after ONE item whenever CoS auto-run is
 *                    off/dry-run or idle-review is off: those are exactly the
 *                    postures in which a user reaches for "Run Now". The manual
 *                    run is allowed to START (Priority-0 on-demand only checks
 *                    `isImprovementEnabled`), but the autonomous refill's
 *                    `canQueueImprovementTasks` gate then refuses to continue it.
 *                    Re-issuing an on-demand request is scoped to just that
 *                    type+app, so it can't leak unrelated rotation/idle autonomous
 *                    work past the auto-run kill switch, and the on-demand path
 *                    re-runs the work-detector and PARKS when the drain is done —
 *                    so it converges exactly like the scheduled drain.
 *   - `'queue'`    — a SCHEDULED perpetual run: the autonomous queue path, gated
 *                    on `canQueueImprovementTasks` (auto-run = execute).
 */
export function perpetualRefillPlan(agent, schedule) {
  if (!isPerpetualRefillCandidate(agent, schedule)) return { lane: 'skip' };
  // A run narrowed to ONE pull request is a one-shot the user asked for on a
  // specific row. A refill carries no target, so continuing the drain here would
  // silently promote that click into a sweep of every open contributor PR.
  if (agent?.metadata?.taskTargetPullRequest) return { lane: 'skip' };
  if (agent?.metadata?.taskOnDemand) {
    // Which ORIGINS may keep draining in this lane, as an allowlist rather than
    // a growing list of exclusions — so an automated origin added later fails
    // CLOSED. A QUOTA BURN invokes exactly ONE unit of its referenced task: the
    // burn has its own continuation (quotaBurnRunner#onBurnAgentCompleted) behind
    // the window/reserve/cap ladder, and refilling here as well would walk the
    // whole backlog outside every one of those gates, on the very subscription
    // the plan was rationing. An unrecorded origin is a human Run — that is what
    // a task queued before the field existed is.
    const origin = agent?.metadata?.taskOnDemandOrigin || ON_DEMAND_ORIGINS.USER;
    if (!DRAINABLE_ON_DEMAND_ORIGINS.has(origin)) return { lane: 'skip' };
    // Reconciliation is per-repository: an app-less legacy run would re-issue itself forever.
    if (agentScheduledType(agent) === 'branch-reconcile' && !agent?.metadata?.taskApp) return { lane: 'skip' };
    return { lane: 'onDemand', taskType: agentScheduledType(agent), appId: agent?.metadata?.taskApp || null };
  }
  return { lane: 'queue' };
}

/**
 * When a perpetual-schedule agent finishes, re-queue the next eligible task
 * right away so the backlog drains back-to-back rather than stalling until the
 * next improvement-check tick. `perpetualRefillPlan` picks the lane (see there):
 * a MANUAL drain re-issues an on-demand request; a SCHEDULED drain uses the
 * auto-run-gated `queueEligibleImprovementTasks` (which already enforces per-app
 * cooldown, the one-pending-per-app cap, and the work-detector park, so it
 * converges and can't fan out past the `dequeueNextTask` concurrency limits).
 */
export async function refillPerpetualForCompletedAgent(agent) {
  const branchSweep = agentScheduledType(agent) === 'branch-reconcile';
  const interrupted = async (reason) => {
    if (!branchSweep) return;
    const { recordBranchReconcileOutcome } = await import('../branchReconcileOutcome.js');
    await recordBranchReconcileOutcome(agent?.metadata?.taskApp || null, {
      status: 'incomplete', reason, nextAction: 'Resolve the interruption, then run branch reconciliation again.',
    });
  };
  if (!isDaemonRunning()) return interrupted('daemon-stopped');
  // Only a SUCCESSFUL perpetual run drains to the next item immediately. A failed
  // run (provider/setup/test failure) must NOT refill back-to-back: perpetual
  // completions skip the per-app cooldown, and the work-detector will usually
  // still see the same issue as actionable — so an immediate refill would spin
  // the daemon through repeated failures. On failure, fall back to the task
  // retry/backoff and the improvement-check recheck cadence (the park IS the
  // throttle only once work genuinely runs out, not when a run errors).
  if (!agent?.result?.success) return interrupted('agent-failed');
  if ((await loadState()).paused) return interrupted('daemon-paused');

  const taskScheduleMod = await import('../taskSchedule.js');
  const schedule = await taskScheduleMod.loadSchedule();
  const plan = perpetualRefillPlan(agent, schedule);
  if (plan.lane === 'skip') return interrupted('continuation-disabled');

  const state = await loadState();

  if (plan.lane === 'onDemand') {
    // Manual drain: gate on the master Improve flag (what the manual trigger
    // itself uses), NOT canQueueImprovementTasks, and re-issue an on-demand
    // request. `emit: false` — the completion handler's subsequent
    // dequeueNextTask({ ignoreTaskId }) drains the re-issue dedup-safely against
    // the still-`in_progress` completing task; letting triggerOnDemandTask emit
    // its event would fire a redundant SECOND dequeue of the same request.
    if (!isImprovementEnabled(state)) return interrupted('improvement-disabled');
    // A PARK STOPS A REFILL (#3848). Park elapse used to be read only by the
    // SCHEDULED lane, so a drain that parked itself (idle detector, no-progress,
    // drain cap) could still be re-issued here on the very next completion — the
    // park meant nothing on the one lane that does the re-dispatching, and the
    // work-detector re-deciding was the only brake left. A human "Run Now" is
    // unaffected: applyOnDemandRunResets clears the park first for a USER-origin
    // request, and only a refill reaches this line with the park intact.
    if (await taskScheduleMod.isPerpetualParkActive(plan.taskType, plan.appId)) {
      emitLog('debug', `Perpetual refill for ${plan.taskType} skipped: parked until its recheck cadence`, { appId: plan.appId });
      return;
    }
    // `queuePerpetualRefill` stamps the automated `origin: 'refill'` pair — this
    // re-issue borrows the on-demand LANE but is not a human pressing Run, so
    // the drain engines must leave the park, convergence signature, and dispatch
    // counter intact. Without that pair the refill wipes its own convergence
    // state on every hop and the drain never parks while one actionable item remains.
    const refill = await taskScheduleMod.queuePerpetualRefill(plan.taskType, plan.appId).catch(async (err) => {
      await interrupted('refill-failed');
      throw err;
    });
    if (refill?.error) await interrupted('refill-rejected');
    return;
  }

  // Scheduled drain — autonomous queue path, gated on CoS auto-run.
  if (!canQueueImprovementTasks(state)) return interrupted('automatic-dispatch-disabled');

  // `agent:completed` fires from `completeAgent` BEFORE the completion flow's
  // `updateTask` marks this agent's task done (agentLifecycle.js: completeAgent
  // emits, THEN updateTask persists). So the just-finished task can still read as
  // `in_progress` both in this snapshot AND on disk when queueEligible's addTask
  // re-reads COS-TASKS.md. Pass its id as `ignoreTaskId` so the per-app busy cap,
  // the per-type dedup set, and addTask's disk-level duplicate scan all treat it
  // as already done — otherwise a perpetual schedule (claim-issue/claim-work
  // regenerates an identical first-line per app) is rejected as a duplicate of
  // the completing task and the drain stalls until the next scheduler tick.
  const cosTaskData = await getCosTasks();
  const { queueEligibleImprovementTasks } = await import('./cosImprovementTasks.js');
  await queueEligibleImprovementTasks(state, cosTaskData, {
    ignoreTaskId: agent?.taskId,
    wakeAfterRecord: false,
    // Continue only this completed drain: its cron slot already initiated it.
    perpetualContinuation: { taskType: agentScheduledType(agent), appId: agent?.metadata?.taskApp || null }
  });
  // NOTE: the caller (the agent:completed handler) runs dequeueNextTask AFTER
  // this resolves, so the freshly-queued perpetual task is on the queue before
  // slots are filled. Do not dequeue here — that would re-introduce the ordering
  // race where generic dequeue claims the freed slot with idle-review work.
}
