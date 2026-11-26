/**
 * Handles agent pause, resume, relaunch, and termination.
 */

import { taskExecutionOptions } from '../../lib/executionOptions.js';
import { reconcileAssignmentForTask } from '../../lib/claimContinuation.js';
import { hasClaimFlowContract } from '../../lib/claimFlowTaskTypes.js';
import { isFalsyMeta, isTruthyMeta } from '../../lib/metadataFlags.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { releaseAgentReservation } from './agentMaintenanceReservations.js';
import { ServerError } from '../../lib/errorHandler.js';
import { emitLog } from '../cos/cosEvents.js';
// The DEFINING module, not a barrel (#3450). This module is one
// of the three `agentOrchestrator.js` imports, so it can never reach a transition
// through the facade — an import back from here closes the loop the facade exists
// to open. Inside the closure the single address for a transition is the module
// that declares it; a barrel would be a third answer to "where does completeAgent
// live", which is the thing this sequencing keeps removing.
import { completeAgent, updateAgent, getAgents, getAgentRecord } from '../cos/cosAgentLifecycle.js';
import { updateTask, addTask, getTaskById, reviveBlockedTask } from '../cos/cosTaskStore.js';
import { forceSpawnTask } from '../cos/cos.js';
import { AGENT_PAUSED_CATEGORY, PAUSE_METADATA_KEYS, pauseMetadata, isAgentPausedTask, isResumablePausedTask, registerPauseReleaseAdapter } from '../../lib/taskPauseHold.js';
import { killAgentViaRunner, pauseAgentViaRunner } from '../cos/cosRunnerClient.js';
import { activeAgents, runnerAgents, dropRunnerAgent, userTerminatedAgents, pausedAgents, whenPausedAgentExits, unregisterSpawnedAgent } from './agentState.js';
import { resolveTaskResumePatch } from './agentWorktreeCleanup.js';
import { RETRY_HOLD_KEY, RETRY_HOLD_SINCE_KEY } from '../../lib/taskRetryHold.js';
import { CLAIM_METADATA_KEYS } from '../cos/cosTaskClaim.js';
import { REQUEUED_AT_KEY, LAST_SPAWNED_AT_KEY } from '../../lib/taskRequeue.js';
import { resolveTaskTargetBranch } from '../../lib/taskTargetBranch.js';
import { flushRunnerOutputBatcher } from './agentRunnerOutputBatchers.js';
import { appendRunEvent } from './agentRunEventLog.js';
import { killProcessTree } from '../../lib/bufferedSpawn.js';
import * as shellService from '../shell.js';
import { closePausedRun } from './agentOrphanRecovery.js';

export { cleanupOrphanedAgents, handleOrphanedTask, settleOrphanedCreativeDirectorRun } from './agentOrphanRecovery.js';
export { getAgentProcessStats, isPidAlive } from './agentProcessProbe.js';

/**
 * Map a failed runner-op result (`{ error?, status? }`) to a ServerError.
 * A genuine runner 404 — the agent is gone / the runner restarted out of sync
 * with `runnerAgents` — preserves the missing-agent contract (404 NOT_FOUND);
 * any other runner/RPC failure is a 500 operational error under `failCode`.
 */
function runnerFailureError(result, fallbackMessage, failCode) {
  const notFound = result?.status === 404;
  return new ServerError(result?.error || fallbackMessage, {
    status: notFound ? 404 : 500,
    code: notFound ? 'NOT_FOUND' : failCode,
  });
}

/**
 * Runner-mode kill path for killAgent. Calls runnerFn, marks the task
 * blocked, and cleans up. Returns the runner result shape
 * (`{ success, error?, status? }`); the runner's HTTP `status` is preserved on
 * failure so killAgent can distinguish a genuine 404 from a 5xx infra error.
 */
async function terminateRunnerAgent(agentId, runnerFn, errorMessage, blockedReason) {
  const agentInfo = runnerAgents.get(agentId);
  if (agentInfo?.initializationTimeout) clearTimeout(agentInfo.initializationTimeout);
  const result = await runnerFn(agentId).catch(err => ({ success: false, error: err.message, status: err.status }));
  if (result.success) {
    // Drain + drop this agent's runner output batcher before the terminal
    // record so pending ~250ms-batched output lands first, and the Map entry
    // doesn't leak if the runner never emits a later completion event.
    // flushRunnerOutputBatcher is a no-op if no batcher exists.
    await flushRunnerOutputBatcher(agentId);
    await completeAgent(agentId, { success: false, error: errorMessage });
    await releaseAgentReservation(agentId);
    const task = agentInfo?.task;
    if (task) {
      await updateTask(task.id, {
        status: 'blocked',
        metadata: {
          ...task.metadata,
          blockedReason,
          blockedCategory: 'user-terminated',
          blockedAt: new Date().toISOString()
        }
      }, task.taskType || 'user');
    }
    dropRunnerAgent(agentId);
  }
  return result;
}

// The agent-addressed half of the pause release (#3730). `updateTask` drops the
// pause bookkeeping whenever a task leaves `blocked`, but the resumed run also has
// to be POINTED at the branch/worktree the paused run left behind — and resolving
// that needs the paused agent's record. `cosTaskStore.js` cannot import this module
// (static cycle, see `server/test/guards/modules/serviceImportCycles.test.js`), so it reaches these two steps
// through the registration below, the way `sharing/recordEvents.js` registers its
// subscription adapter. That is what makes the Tasks-tab status toggle and
// `reviveBlockedTask` resume in place instead of spawning clean, not just the
// Resume dialog.
registerPauseReleaseAdapter({
  /**
   * Same `resolveTaskResumePatch` every other dead-run path uses, addressed by the
   * agent the task's own pause bookkeeping names.
   */
  resolvePausedTaskResume: async (task) => {
    const agentId = task?.metadata?.pausedAgentId;
    if (!agentId) return {};
    const agent = await getAgentRecord(agentId).catch(() => null);
    return resolveTaskResumePatch({ task, agentId, agentMetadata: agent?.metadata || null });
  },

  /**
   * Retire the paused record the moment its task is running again, rather than
   * leaving the card stranded until the next `retireStrandedPausedAgents` sweep.
   * Guarded on the record still being `paused`, and it writes the SAME verdict
   * `resumeAgent` would — so whichever of the two fires first, the record reads
   * identically and the other is a no-op through `completeAgent`'s idempotence.
   */
  retirePausedAgent: async (agentId, taskId, branchName) => {
    const agent = await getAgentRecord(agentId).catch(() => null);
    if (agent?.status !== 'paused') return;
    await closePausedRun(agent);
    pausedAgents.delete(agentId);
    await completeAgent(agentId, {
      success: false,
      resumed: true,
      resumedTaskId: taskId,
      error: resumeSummary(agentId, { taskId, mode: 'requeued', branchName })
    });
  }
});

async function markPausedTask(agentInfo, agentId, pausedAt, reason) {
  const task = agentInfo?.task || (agentInfo?.taskId ? await getTaskById(agentInfo.taskId).catch(() => null) : null);
  if (!task) return;
  await updateTask(task.id, {
    status: 'blocked',
    metadata: {
      ...task.metadata,
      blockedReason: reason ? `Paused by user: ${reason}` : 'Paused by user',
      blockedCategory: AGENT_PAUSED_CATEGORY,
      blockedAt: pausedAt,
      ...pauseMetadata({ agentId, pausedAt, workspacePath: agentInfo?.workspacePath, runId: agentInfo?.runId })
    }
  }, task.taskType || 'user');
}

/**
 * Record a stop REQUEST against a live run (#4540).
 *
 * The request is the fact, not the exit it causes: a run still reading
 * `interrupted` with no `run.finalized` after it is a kill that never took —
 * the process ignored SIGTERM, or the runner RPC failed — and that discrepancy
 * is invisible in the mutable record, which only ever shows the last state
 * something managed to write.
 *
 * Ids come from whichever ownership map holds the agent: neither is
 * authoritative alone (a runner-backed TUI registers in `activeAgents` while a
 * runner-spawned CLI lives in `runnerAgents`), so reading only one would
 * silently drop half the runs. An agent in NEITHER map has nothing to interrupt
 * — its caller is about to 404 or return not-found — so no event is written
 * rather than minting a projection for a run that isn't there.
 *
 * No explicit idempotency key: every termination request is a distinct fact,
 * including a second one aimed at an agent that ignored the first.
 */
async function recordInterrupt(agentId, data) {
  const info = activeAgents.get(agentId) ?? runnerAgents.get(agentId);
  if (!info) return;
  await appendRunEvent({
    kind: 'run.interrupted',
    runId: info.runId ?? null,
    agentId,
    taskId: info.taskId ?? null,
    data: { ...data, mode: runnerAgents.has(agentId) ? 'runner' : 'direct' },
  });
}

async function markAgentPaused(agentId, agentInfo, pausedAt, reason) {
  await updateAgent(agentId, {
    status: 'paused',
    pausedAt,
    metadata: {
      phase: 'paused',
      pauseReason: reason || null,
      pausedAt,
      resumeWorkspacePath: agentInfo?.workspacePath || null
    }
  });
  await markPausedTask(agentInfo, agentId, pausedAt, reason);
  // Recorded AFTER the persist, not before (#4540): both pause arms funnel
  // through here, and both roll their in-memory flag back when this function
  // throws. An event written ahead of the writes would leave the projection
  // reading `paused` for a pause that never stuck — the exact class of lie the
  // ledger exists to catch. `at: pausedAt` is the same instant the agent record
  // carries, so the content-derived id is stable and a retried persist files one
  // paused event rather than two.
  await appendRunEvent({
    kind: 'run.paused',
    runId: agentInfo?.runId ?? null,
    agentId,
    taskId: agentInfo?.taskId ?? null,
    at: pausedAt,
    data: { reason: reason || null, workspacePath: agentInfo?.workspacePath ?? null },
  });
}

/**
 * Pause an agent without finalizing its task or cleaning up its worktree.
 * The underlying process is stopped, but the persisted agent remains paused
 * so a later resume task can use the same workspace/change context.
 */
export async function pauseAgent(agentId, reason = null) {
  return maintenance.withResource('agent', agentId, () =>
    maintenance.continueSettlement(() => pauseAdmittedAgent(agentId, reason)));
}

async function pauseAdmittedAgent(agentId, reason) {
  const pausedAt = new Date().toISOString();

  if (runnerAgents.has(agentId)) {
    const agentInfo = runnerAgents.get(agentId);
    if (agentInfo?.initializationTimeout) clearTimeout(agentInfo.initializationTimeout);
    pausedAgents.set(agentId, { pausedAt, reason });
    const result = await pauseAgentViaRunner(agentId, reason).catch(err => ({ success: false, error: err.message, status: err.status }));
    if (!result.success) {
      pausedAgents.delete(agentId);
      throw runnerFailureError(result, 'Failed to pause runner agent', 'AGENT_PAUSE_FAILED');
    }
    // Persist failure must roll back the in-memory flag too, or the maps drift
    // (pausedAgents set, runnerAgents never deleted) until the next restart.
    const persistedRunner = await markAgentPaused(agentId, agentInfo, pausedAt, reason).then(() => true, (err) => {
      pausedAgents.delete(agentId);
      emitLog('error', `❌ Failed to persist pause for runner agent ${agentId}: ${err.message}`, { agentId });
      return false;
    });
    if (!persistedRunner) {
      throw new ServerError('Failed to persist paused state', { status: 500, code: 'AGENT_PAUSE_FAILED' });
    }
    dropRunnerAgent(agentId);
    emitLog('info', `⏸️ Paused runner agent ${agentId}${reason ? `: ${reason}` : ''}`, { agentId, reason });
    return { success: true, agentId, pausedAt, mode: 'runner' };
  }

  const agent = activeAgents.get(agentId);
  if (!agent) {
    throw new ServerError('Agent not found or not running', { status: 404, code: 'NOT_FOUND' });
  }

  pausedAgents.set(agentId, { pausedAt, reason });
  // Persist BEFORE killing the process, and roll back the in-memory flag on a
  // persist failure — otherwise a throw here leaves the agent flagged paused
  // in-memory while its process keeps running (the kill below never executes).
  const persisted = await markAgentPaused(agentId, agent, pausedAt, reason).then(() => true, (err) => {
    pausedAgents.delete(agentId);
    emitLog('error', `❌ Failed to persist pause for agent ${agentId}: ${err.message}`, { agentId });
    return false;
  });
  if (!persisted) {
    throw new ServerError('Failed to persist paused state', { status: 500, code: 'AGENT_PAUSE_FAILED' });
  }

  if (agent.tuiSessionId) {
    shellService.writeToSession(agent.tuiSessionId, '\x1b');
    setTimeout(() => {
      if (activeAgents.has(agentId)) shellService.killSession(agent.tuiSessionId);
    }, 250);
  } else {
    // killProcessTree so a Windows cmd.exe-wrapped CLI shim's real child is
    // taken down, not orphaned (#2243). `processGroup` (set at spawn time by
    // agentCliSpawning) additionally reaches the harness behind a credential-
    // bootstrap wrapper on POSIX; it is false for every other agent, so their
    // teardown is unchanged (#7496).
    killProcessTree(agent.process, 'SIGTERM', { processGroup: agent.processGroup });
    const killTimer = setTimeout(() => {
      if (activeAgents.has(agentId)) {
        killProcessTree(agent.process, 'SIGKILL', { processGroup: agent.processGroup });
      }
    }, 5000);
    const agentEntry = activeAgents.get(agentId);
    if (agentEntry) agentEntry.killTimer = killTimer;
  }

  emitLog('info', `⏸️ Paused agent ${agentId}${reason ? `: ${reason}` : ''}`, { agentId, reason });
  return { success: true, agentId, pausedAt, mode: agent.tuiSessionId ? 'tui' : 'direct' };
}

/**
 * What resuming `agentId` should actually DO, given the current state of the task
 * its pause parked. Four outcomes, and only one of them creates anything:
 *
 * - `requeued` — the task is still BLOCKED and is ours to restart. That covers the
 *   pause itself and any later block the task fell into (a failed retry, a cooldown,
 *   a config block): the user asking to resume is an explicit dispatch, and
 *   `reviveBlockedTask` resets the spawn/orphan budgets so it can actually run.
 * - `superseded` — a DIFFERENT agent has since paused it. That pause is live and
 *   belongs to someone else; ours is spent, so we retire our record and touch nothing.
 * - `already-active` — the task is `pending` or `in_progress`: some other path
 *   (a dedupe revive, an autopilot re-dispatch, a cooldown expiry, a human unblocking
 *   it) already put it back in flight. Queueing anything here is what spawned the
 *   SECOND agent users kept seeing — the work is already running, so we only retire
 *   the stale paused record.
 * - `new-task` — the task is gone or `completed`. Nothing to restart, so the fresh
 *   task the dialog described is the honest answer.
 */
function classifyResume(task, agentId) {
  if (!task) return 'new-task';
  if (task.status === 'pending' || task.status === 'in_progress') return 'already-active';
  if (task.status === 'blocked') {
    return isAgentPausedTask(task) && !isResumablePausedTask(task, agentId) ? 'superseded' : 'requeued';
  }
  return 'new-task';
}

/**
 * Resume a PAUSED agent: requeue the agent's OWN task, pointed at the branch and
 * worktree its paused run left behind, and retire the paused agent record.
 *
 * Before this, "resume" was a client-side illusion — the UI queued a brand-new
 * `[Resume] <description>` task carrying the old run's context as prose. That
 * produced three wrong outcomes at once: a second agent spawned on a clean
 * worktree off the default branch (so the paused run's work was redone, or lost),
 * the original task stayed `blocked` as `agent-paused` forever, and the paused
 * agent record sat in `paused` with nothing left to resume it.
 *
 * The requeue reuses the retry machinery: `resolveTaskResumePatch` decides what
 * the paused run actually left behind (adopt its surviving worktree, attach to
 * its branch, or nothing) and `agentWorkspacePrep` already honors the resulting
 * `existingBranch`/`resumeWorktreePath` pointer — so resuming needs no new spawn
 * plumbing, and `resumedFromAgentId` gets the prompt's resume banner for free.
 *
 * `overrides` carries the resume dialog's edits: extra `context` (appended to the
 * task's, never replacing it), and provider/model/effort/app changes for the new
 * run. A falsy value means "unchanged" — the dialog seeds its selects from the
 * paused run, so blank is absence, not an intentional clear.
 *
 * `classifyResume` decides which of the four outcomes applies; only `new-task`
 * creates anything. The agent record is retired on ALL of them, so a resume never
 * leaves a stale `paused` row next to a task that has moved on — that stale row is
 * what made the next resume click read its own pause as spent and queue a duplicate.
 *
 * The retirement carries `resumed: true`, which is what keeps a pause from reading
 * as a failure downstream: `completeAgent` skips the `stats.errors` bump and the
 * learning listener (taskLearning/lifecycle.js) skips the record entirely. Both
 * matter because the run is a CONTINUATION — the resumed run records the real
 * verdict, so counting this one charges a phantom failure and double-counts the task.
 *
 * @param {string} agentId
 * @param {{context?: string, description?: string, provider?: string, model?: string, effort?: string, app?: string, screenshots?: string[]}} overrides
 * @returns {Promise<{success: true, agentId: string, taskId: string|null, mode: 'requeued'|'already-active'|'superseded'|'new-task', created: boolean, branchName: string|null}>}
 */
export async function resumeAgent(agentId, overrides = {}) {
  maintenance.assertOpen();
  const agent = await getAgentRecord(agentId);
  if (!agent) {
    throw new ServerError('Agent not found', { status: 404, code: 'NOT_FOUND' });
  }
  if (agent.status !== 'paused') {
    throw new ServerError(`Agent ${agentId} is ${agent.status}, not paused`, {
      status: 409, code: 'AGENT_NOT_PAUSED'
    });
  }

  const taskId = agent.taskId || agent.metadata?.taskId || null;
  let task = taskId ? await getTaskById(taskId).catch(() => null) : null;
  const taskType = task?.taskType || agent.metadata?.taskType || 'user';

  const mode = classifyResume(task, agentId);
  if (mode === 'requeued' || mode === 'new-task') {
    const priorClaim = isTruthyMeta(agent.metadata?.configClaimFlow) || hasClaimFlowContract({ ...agent, taskType: agent.metadata?.taskType });
    // Missing task metadata cannot be reconstructed from caller prose. Only a
    // positively generic registration may use the historical description fallback.
    if ((!task && (priorClaim || !isFalsyMeta(agent.metadata?.configClaimFlow)))
      || (task && priorClaim && !hasClaimFlowContract(task))) {
      throw new ServerError('Resume blocked: the original task configuration is unavailable, so claim authority cannot be verified. Restore the original task or start a new task from its configured workflow.', {
        status: 409, code: 'AGENT_RESUME_CONTRACT_MISSING'
      });
    }
    if (hasClaimFlowContract(task)) {
      task = { ...task, metadata: { ...task.metadata, claimFlow: true } };
    }
  }
  let resumed;
  switch (mode) {
    case 'requeued':
      resumed = await requeuePausedTask({ task, taskType, overrides });
      break;
    case 'new-task':
      resumed = await replacePausedTask({ agentId, agent, task, taskType, overrides });
      break;
    default:
      // `already-active` / `superseded` — the task needs nothing done to it.
      resumed = { taskId: task.id, mode, branchName: null };
  }
  const summary = resumeSummary(agentId, resumed);

  // Retire the paused record LAST: `completeAgent` emits `agent:completed`, whose
  // handler dequeues — so the task must already be `pending` and pointed at the
  // resume branch before the spawn it triggers can pick it up. Paused records are
  // explicitly completable (see the idempotence guard in `completeAgent`).
  pausedAgents.delete(agentId);
  // A paused run was released back to the queue (#4540). Only the modes that
  // actually CONTINUE the work qualify: 'already-active' and 'superseded' retire
  // the paused record without queueing anything, so recording them as a resume
  // would show a run going back to `running` that nothing is running. `mode` is
  // the part the mutable record still loses — 'requeued' and 'new-task' both
  // read as a completed paused agent afterwards, and only one left a fresh task.
  if (mode === 'requeued' || mode === 'new-task') {
    await appendRunEvent({
      kind: 'run.resumed',
      runId: agent.metadata?.runId ?? null,
      agentId,
      taskId: resumed.taskId ?? taskId,
      data: { mode: resumed.mode ?? mode, branchName: resumed.branchName ?? null },
    });
  }
  await closePausedRun(agent);
  await completeAgent(agentId, {
    success: false,
    resumed: true,
    resumedTaskId: resumed.taskId,
    error: summary
  });

  emitLog('info', `▶️ ${summary}`, {
    agentId, taskId: resumed.taskId, branchName: resumed.branchName, mode: resumed.mode
  });

  // Dispatched AFTER the retirement above, for the same reason that retirement is
  // last: the task has to be `pending` and pointed at its resume branch before
  // anything can spawn it.
  const dispatch = await dispatchResumedTask(resumed);

  // `created` says whether anything was queued, so a caller doesn't have to keep its
  // own copy of the mode enum to know — a client that guesses would go on announcing
  // "created a resume task" for a future non-creating mode, which is the exact false
  // claim this change exists to delete.
  return { success: true, agentId, created: mode === 'new-task', ...resumed, ...dispatch };
}

/**
 * Start the resumed task NOW, when the agent pool has room for it.
 *
 * The requeue alone only makes the task ELIGIBLE. What actually spawns it is the
 * automatic dequeue `completeAgent` schedules, and that path admits pending USER
 * tasks plus auto-approved system tasks under CoS auto-run in `execute` mode — so
 * a resumed internal task on an install with auto-run off, or one still awaiting
 * approval, sat `pending` until the user opened the task list and pressed Run.
 * That turns the one-click Resume/Relaunch into a two-step, on the exact screen
 * the user just acted from.
 *
 * This sits in `resumeAgent` rather than in `relaunchAgent` because relaunch is
 * defined as a pause plus a resume — it inherits the dispatch through that
 * composition, so the rule has one address. It does NOT sit deeper, in
 * `reviveBlockedTask` or the `tasks:changed` unblock listener, because those are
 * shared with the autonomous revival paths (investigation retry, orphan cooldown,
 * completion cleanup), and force-spawning there would strip the auto-run gate that
 * deliberately withholds unattended spawns. Both doors into here are a human
 * clicking a button, which is what makes the explicit dispatch correct.
 *
 * It goes through `forceSpawnTask`, the same door "Run now" uses, and inherits its
 * refusals rather than restating them. Best-effort by design: a stopped/paused
 * daemon, an unreachable runner, a task needing approval, and a full agent pool all
 * mean "leave it queued", which is the pre-existing behavior. The refusal is
 * reported as `spawnHold` so the dialog can say which, instead of toasting a resume
 * that silently didn't start.
 */
async function dispatchResumedTask({ taskId, mode }) {
  // `already-active` and `superseded` queue nothing on purpose — the task is
  // either already in flight or owned by a later pause, and dispatching it here
  // is exactly the duplicate spawn `classifyResume` exists to prevent.
  if (!taskId || (mode !== 'requeued' && mode !== 'new-task')) return { spawned: false, spawnHold: null };

  const result = await forceSpawnTask(taskId).catch(err => ({ error: err?.message || String(err) }));
  if (result?.success) return { spawned: true, spawnHold: null };

  // The dequeue `completeAgent` schedules races this call, so a refusal can mean
  // "already claimed" rather than "held". Read the state back and treat a real
  // claim as started — string-matching the refusal would drift the moment
  // forceSpawnTask reworded one of them.
  //
  // BOTH halves are load-bearing. A spawn registers its agent as `running`
  // BEFORE it flips the task off `pending` (the window `forceSpawnTask`'s own
  // holder guard exists for), so mid-spawn the task still reads `pending` while
  // the run is genuinely under way — and the refusal that lands there is that
  // holder guard, so checking only the task status would report a hold for a
  // task that is already running. The holder half is only reachable while that
  // guard is refusing, i.e. while the holder is young enough to be mid-spawn:
  // an older, zombie holder is superseded by `forceSpawnTask` instead, so this
  // can't read a dead agent's record as a live run.
  const [task, agents] = await Promise.all([
    getTaskById(taskId).catch(() => null),
    getAgents().catch(() => []),
  ]);
  const heldByRunningAgent = agents.some(agent =>
    agent.status === 'running' && (agent.taskId === taskId || agent.metadata?.taskId === taskId));
  if (task?.status === 'in_progress' || heldByRunningAgent) return { spawned: true, spawnHold: null };

  const spawnHold = result?.error || 'Task could not be spawned';
  emitLog('info', `⏳ Resumed task ${taskId} stays queued — ${spawnHold}`, { taskId });
  return { spawned: false, spawnHold };
}

/**
 * How long a relaunch waits for a LOCAL paused run's process to actually exit.
 * The pause path escalates SIGTERM → SIGKILL after 5s, so the close handler has
 * landed well inside this window in every observed case; the cap only exists so
 * a wedged child can't hold the request open forever.
 */
const RELAUNCH_EXIT_TIMEOUT_MS = 15000;

/**
 * Relaunch a RUNNING agent's task on a different provider/model/effort.
 *
 * The motivating case is a run that is alive but going nowhere — a CLI sitting on
 * a provider usage limit. Pausing and resuming already does exactly the right
 * thing (stop the process, keep the worktree, requeue the same task with new
 * provider/model/effort overrides), but as two clicks it is neither discoverable
 * nor safe to do quickly. This composes the two so one click switches providers.
 *
 * Composition, not a third code path: `pauseAgent` owns stopping the process and
 * preserving the worktree, `resumeAgent` owns the requeue and the four resume
 * modes. The only thing between them is waiting for the stopped process to be
 * gone — a human clicking Pause then Resume takes seconds, but collapsing the two
 * into one request does not, and resuming first is what loses the worktree
 * (`whenPausedAgentExits` in agentState.js has the mechanism).
 *
 * @param {string} agentId
 * @param {{context?: string, provider?: string, model?: string, effort?: string, app?: string, reason?: string}} overrides
 */
export async function relaunchAgent(agentId, overrides = {}) {
  maintenance.assertOpen();
  const agent = await getAgentRecord(agentId);
  if (!agent) {
    throw new ServerError('Agent not found', { status: 404, code: 'NOT_FOUND' });
  }
  if (agent.status !== 'running') {
    throw new ServerError(`Agent ${agentId} is ${agent.status}, not running`, {
      status: 409, code: 'AGENT_NOT_RUNNING'
    });
  }

  const { reason, ...resumeOverrides } = overrides;
  const pauseReason = reason || relaunchReason(resumeOverrides);
  const paused = await pauseAgent(agentId, pauseReason);

  if (!await whenPausedAgentExits(agentId, RELAUNCH_EXIT_TIMEOUT_MS)) {
    // Keep the pause flag until the actual exit: retiring it early makes a late
    // exit finalize the old run and clean up the worktree the retry needs.
    throw new ServerError('The previous agent has not exited yet. Its task and worktree remain paused; resume after it stops.', {
      status: 409, code: 'AGENT_EXIT_PENDING'
    });
  }

  // `resumeAgent` already force-spawned the requeued task where it could
  // (`dispatchResumedTask`), so `spawned`/`spawnHold` ride along in `resumed` —
  // relaunch inherits the immediate dispatch through the composition rather than
  // repeating it.
  const resumed = await resumeAgent(agentId, resumeOverrides);
  emitLog('info', `🔁 Relaunched agent ${agentId} — ${pauseReason}`, {
    agentId, taskId: resumed.taskId, mode: resumed.mode
  });
  return { ...resumed, relaunched: true, pausedAt: paused.pausedAt };
}

/** The pause reason a relaunch records, naming what the user actually changed. */
function relaunchReason({ provider, model, effort }) {
  const target = [provider, model, effort].filter(Boolean).join(' / ');
  return `Relaunched by user${target ? ` on ${target}` : ''}`;
}

/** One line naming what the resume actually did — used for the log and the record. */
function resumeSummary(agentId, { taskId, mode, branchName }) {
  switch (mode) {
    case 'requeued':
      return `Resumed agent ${agentId} — task ${taskId} requeued${branchName ? ` on ${branchName}` : ' from a clean workspace'}`;
    case 'already-active':
      return `Resumed agent ${agentId} — task ${taskId} is already queued or running, nothing to restart`;
    case 'superseded':
      return `Resumed agent ${agentId} — task ${taskId} is paused by a later agent, leaving that pause intact`;
    default:
      return `Resumed agent ${agentId} — its task was no longer resumable, queued ${taskId} instead`;
  }
}

/**
 * The in-place resume: flip the paused task back to `pending` carrying the resume
 * pointer and the dialog's overrides, in ONE write — the task must never be
 * spawnable before it is pointed, or the dequeue `completeAgent` triggers could
 * grab it mid-transition and start clean.
 *
 * Since #3730 this is a thin agent-addressed wrapper contributing ONLY the dialog's
 * overrides: the pointer, the pause release, and the record's retirement belong to
 * `cosTaskStore.updateTask`, which performs them for every caller of the flip.
 *
 * Through `reviveBlockedTask`, the shared address for "an explicit dispatch path
 * un-blocks a blocked task": on top of updateTask's blocked-transition clear it
 * resets the spawn/orphan retry budgets, so a task paused near the MAX_TOTAL_SPAWNS
 * ceiling doesn't resume straight into `max-spawns`.
 */
async function requeuePausedTask({ task, taskType, overrides }) {
  // Only the dialog's edits. The resume pointer and the pause release belong to
  // `updateTask` (#3730) so every OTHER door into this flip gets them too — resolving
  // them here as well would run the same git probe twice per Resume click and put a
  // second copy of the rule where it can drift.
  //
  // `pending` is non-terminal, so the pointer that write lands survives it
  // (updateTask only strips a resume pointer on a terminal status).
  const result = await reviveBlockedTask(task.id, {
    metadata: {
      ...resumeOverrideMetadata(overrides, task.metadata),
      ...(hasClaimFlowContract(task) ? { claimFlow: true } : {})
    }
  }, taskType);
  if (result?.error) {
    throw new ServerError(`Failed to requeue task ${task.id}: ${result.error}`, {
      status: 500, code: 'AGENT_RESUME_FAILED'
    });
  }
  return { taskId: task.id, mode: 'requeued', branchName: resolveTaskTargetBranch(result?.metadata) };
}

// A replacement is a fresh task, but its task-type payload/configuration still
// defines what the run must do. Preserve that durable contract while dropping
// state owned by the spent task/run so the replacement gets a new retry budget,
// lease, workspace pointer, and output-hook dispatch.
const REPLACEMENT_RUNTIME_METADATA_KEYS = new Set([
  'blockedReason', 'blockedCategory', 'blockedAt', 'blocker', 'failureCount',
  'lastErrorCategory', 'lastFailureAt', 'cooldownUntil', 'totalSpawnCount',
  'orphanRetryCount', 'lastOrphanedAt', 'lastOrphanedAgentId', 'worktreeBusyAttempts',
  LAST_SPAWNED_AT_KEY, 'interruptedByRestart', 'lastInterruptedAt', 'lastInterruptedAgentId',
  'outputHookDispatchedAt', 'existingBranch', 'resumedFromAgentId', 'resumeWorktreePath', 'claimResumeInPlace',
  'autoRetryCount', 'autoRetriedByInvestigation', 'autoRetriedAt', 'autoRetryExhaustedAt',
  'resolution', 'autoExpiredReason', 'autoExpiredAt',
  REQUEUED_AT_KEY, RETRY_HOLD_KEY, RETRY_HOLD_SINCE_KEY,
  ...PAUSE_METADATA_KEYS, ...CLAIM_METADATA_KEYS,
]);

/**
 * A replacement queued because the original task is gone still has to be the same
 * kind of run. Registration projects `analysisType` onto the agent as
 * `taskAnalysisType` and does not copy it back, so a missing task became a generic
 * commit task: the live checkout was probed, a correct no-op failed delivery, and
 * the retry budget spawned more agents. Fill only keys the task record did not
 * already carry. The assignment is accepted only when it still validates as this
 * task's own snapshot — resume prose cannot supply one.
 */
function inheritPausedCoordinatorContract(metadata, agentMeta, { app, taskType }) {
  if (!agentMeta) return;
  if ((metadata.analysisType == null || metadata.analysisType === '')
    && typeof agentMeta.taskAnalysisType === 'string' && agentMeta.taskAnalysisType.trim()) {
    metadata.analysisType = agentMeta.taskAnalysisType;
  }
  // `false` and the TASKS.md string `"false"` are the load-bearing values.
  if (metadata.worktreeChangesExpected == null && agentMeta.worktreeChangesExpected != null) {
    metadata.worktreeChangesExpected = agentMeta.worktreeChangesExpected;
  }
  // Strict boolean: a string `"true"` is not the on-demand lane marker.
  if (metadata.onDemand == null && agentMeta.taskOnDemand === true) metadata.onDemand = true;
  if (metadata.analysisType === 'branch-reconcile' && metadata.reconcileAssignment == null) {
    const validated = reconcileAssignmentForTask({
      taskType,
      metadata: {
        // Top-level `app` overwrites a metadata seed at intake, so a dialog
        // switch has to win here too. Otherwise the previous app's snapshot
        // would be stored on the task the replacement actually runs.
        app: app || metadata.app,
        analysisType: 'branch-reconcile',
        reconcileAssignment: agentMeta.reconcileAssignment,
      },
    });
    if (validated) metadata.reconcileAssignment = validated;
  }
}

/**
 * The fallback: the paused run's task is gone or completed, so queue the fresh task
 * the caller described instead. Same outcome the pre-fix client always took, kept
 * only for the case where it is actually correct.
 *
 * Everything the original task carried that SHAPES the run — its app, its
 * provider/model/effort, its context — is INHERITED as the base, with the dialog's
 * edits layered on top through the same `resumeOverrideMetadata` the requeue path
 * uses, so both resumes merge by one rule. A bare description is not a runnable
 * substitute for a task that was scoped to a managed app or pinned to a provider:
 * dropping those is how the replacement ended up running against the wrong repo, or
 * against a default model the user had deliberately moved off.
 */
async function replacePausedTask({ agentId, agent, task, taskType, overrides }) {
  const description = overrides.description
    || task?.description
    || agent?.metadata?.taskDescription
    || `Resume ${agentId}`;
  // `prompt` rides along with `context` (#4153): on a task written by current
  // code the agent-facing payload lives there, and a replacement queued without
  // it would run with nothing but the one-line description.
  const taskMeta = task?.metadata || {};
  const agentMeta = agent?.metadata || {};
  const context = taskMeta.context ?? agentMeta.context;
  const prompt = taskMeta.prompt ?? agentMeta.prompt;
  const provider = taskMeta.provider ?? agentMeta.providerId ?? agentMeta.provider;
  const model = taskMeta.model ?? agentMeta.model;
  const effort = taskMeta.effort ?? agentMeta.effort;
  const executionOptions = taskMeta.executionOptions ?? taskExecutionOptions(agentMeta.executionOptions);
  const app = taskMeta.app ?? agentMeta.taskApp ?? agentMeta.app;
  const inheritedMetadata = { ...taskMeta };
  if (!task && agent?.metadata) {
    if (agent.metadata.taskDescription) inheritedMetadata.taskDescription = agent.metadata.taskDescription;
    if (agent.metadata.jobId) inheritedMetadata.jobId = agent.metadata.jobId;
    if (agent.metadata.taskApp) inheritedMetadata.taskApp = agent.metadata.taskApp;
  }
  for (const key of REPLACEMENT_RUNTIME_METADATA_KEYS) delete inheritedMetadata[key];
  if (agentId) inheritedMetadata.resumedFromAgentId = agentId;
  // Validate against the app the replacement will actually run, including a
  // dialog switch, so a snapshot for the previous app is not attached as a grant.
  const overridesPatch = resumeOverrideMetadata(overrides, task?.metadata || agent?.metadata);
  inheritPausedCoordinatorContract(inheritedMetadata, agent?.metadata, {
    app: overridesPatch.app || app, taskType,
  });
  const replacement = {
    description,
    context, prompt, provider, model, effort, executionOptions, app,
    metadata: inheritedMetadata,
    ...overridesPatch
  };
  let created;
  if (!task && (agentMeta.featureAgentId || isTruthyMeta(agentMeta.featureAgentRun))) {
    const { queueFeatureAgentReplacement } = await import('../featureAgents.js');
    created = await queueFeatureAgentReplacement(replacement, agent);
  } else {
    created = await addTask(replacement, taskType);
  }
  if (created?.error) {
    throw new ServerError(`Failed to queue resume task: ${created.error}`, {
      status: 500, code: 'AGENT_RESUME_FAILED'
    });
  }
  return { taskId: created.id, mode: 'new-task', branchName: null };
}

/**
 * The dialog's edits as a task-metadata patch. Every field is "unchanged unless
 * supplied" — the dialog seeds its selects from the paused run, so a blank value
 * is absence rather than an intentional clear (AGENTS.md's absent-vs-empty rule).
 * `context` APPENDS to `existingContext`: the task's own note is what the
 * original run was given, and dropping it would resume with less information than
 * the run that paused. It never touches `metadata.prompt` — the dialog edits the
 * NOTE, and folding a note into the agent-facing payload would make the two
 * indistinguishable again (#4153).
 */
function resumeOverrideMetadata({ context, provider, model, effort, executionOptions, app, screenshots }, priorMetadata = {}) {
  const patch = {};
  if (context) {
    patch.context = [priorMetadata?.context, context].filter(Boolean).join('\n\n');
  }
  if (provider) patch.provider = provider;
  if (model) patch.model = model;
  if (effort) patch.effort = effort;
  if (executionOptions !== undefined) patch.executionOptions = executionOptions;
  if (app) patch.app = app;
  if (screenshots?.length) patch.screenshots = screenshots;
  // The one place blank does NOT mean unchanged: a provider SWITCH invalidates a
  // model or effort pinned to the provider being left behind. `selectModelForTask`
  // returns `metadata.model` verbatim as the user's choice, so carrying
  // `claude-opus-5` across to codex hands that CLI a model it does not have and the
  // requeued run dies on its first spawn. Both dialogs clear their model select when
  // the provider changes, so blank here is the user seeing "Default model" — clear the
  // stale pin and let the new provider resolve its own.
  if (provider && provider !== priorMetadata?.provider) {
    if (!model) patch.model = '';
    if (!effort) patch.effort = '';
    if (executionOptions === undefined) patch.executionOptions = {};
  }
  return patch;
}

/**
 * Get list of active agents.
 */
export function getActiveAgents() {
  const agents = [];

  // Direct mode agents
  for (const [agentId, agent] of activeAgents) {
    agents.push({
      id: agentId,
      taskId: agent.taskId,
      startedAt: agent.startedAt,
      runningTime: Date.now() - agent.startedAt,
      mode: 'direct'
    });
  }

  // Runner mode agents
  for (const [agentId, agent] of runnerAgents) {
    agents.push({
      id: agentId,
      taskId: agent.taskId,
      startedAt: agent.startedAt,
      runningTime: Date.now() - agent.startedAt,
      mode: 'runner'
    });
  }

  return agents;
}

/**
 * Force kill an agent immediately with SIGKILL (no graceful shutdown).
 */
export async function killAgent(agentId) {
  await recordInterrupt(agentId, { reason: 'killed-by-user', signal: 'SIGKILL' });

  // Check if agent is in runner mode
  if (runnerAgents.has(agentId)) {
    const result = await terminateRunnerAgent(agentId, killAgentViaRunner, 'Agent force killed by user (SIGKILL)', 'Force killed by user');
    // Surface a runner failure to the kill route as a ServerError instead of
    // the old result-shape 404 string-match (issue #2534): a genuine runner
    // 404 (agent gone / runner out of sync) stays NOT_FOUND, any other
    // runner-RPC failure is a 500 AGENT_KILL_FAILED.
    if (!result.success) {
      throw runnerFailureError(result, 'Failed to kill runner agent', 'AGENT_KILL_FAILED');
    }
    return result;
  }

  // Direct mode
  const agent = activeAgents.get(agentId);

  if (!agent) {
    throw new ServerError('Agent not found or not running', { status: 404, code: 'NOT_FOUND' });
  }

  // Track as user-terminated so the close handler doesn't re-queue
  userTerminatedAgents.add(agentId);

  // Drain pending batched stdout/stderr before the terminal record so it
  // doesn't land after completion (the close handler also drains; idempotent).
  await agent.flushOutput?.();

  // Mark agent as completed immediately with kill status
  await completeAgent(agentId, { success: false, error: 'Agent force killed by user (SIGKILL)' });

  // Block task immediately
  if (agent.taskId) {
    const task = await getTaskById(agent.taskId).catch(() => null);
    if (task) {
      await updateTask(agent.taskId, {
        status: 'blocked',
        metadata: {
          ...task.metadata,
          blockedReason: 'Force killed by user',
          blockedCategory: 'user-terminated',
          blockedAt: new Date().toISOString()
        }
      }, task.taskType || 'user');
    }
  }

  // Kill the process immediately with SIGKILL — killProcessTree so a Windows
  // cmd.exe-wrapped shim's real child isn't orphaned (#2243), and
  // `processGroup` so a credential-bootstrap wrapper's harness dies too (#7496).
  killProcessTree(agent.process, 'SIGKILL', { processGroup: agent.processGroup });

  unregisterSpawnedAgent(agent.pid);
  activeAgents.delete(agentId);

  return { success: true, agentId, pid: agent.pid, signal: 'SIGKILL' };
}
