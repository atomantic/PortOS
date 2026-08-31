/**
 * Agent Management
 *
 * Handles agent termination, process stats, kill-all, orphan cleanup,
 * and orphaned task retry logic.
 */

import { join } from 'path';
import { ServerError } from '../lib/errorHandler.js';
import { emitLog } from './cosEvents.js';
// The DEFINING module, not a barrel (#3450). This module is one
// of the three `agentOrchestrator.js` imports, so it can never reach a transition
// through the facade — an import back from here closes the loop the facade exists
// to open. Inside the closure the single address for a transition is the module
// that declares it; a barrel would be a third answer to "where does completeAgent
// live", which is the thing this sequencing keeps removing.
import { completeAgent, updateAgent, getAgents, getAgentRecord } from './cosAgentLifecycle.js';
import { updateTask, addTask, getTaskById, reviveBlockedTask, evaluateTasks } from './cos.js';
import { AGENT_PAUSED_CATEGORY, PAUSE_METADATA_KEYS, pauseMetadata, isAgentPausedTask, isResumablePausedTask, registerPauseReleaseAdapter } from '../lib/taskPauseHold.js';
import { terminateAgentViaRunner, killAgentViaRunner, pauseAgentViaRunner, getAgentStatsFromRunner, getActiveAgentsFromRunner } from './cosRunnerClient.js';
import { MAX_TOTAL_SPAWNS } from '../lib/validation.js';
import { isInternalTaskId } from '../lib/taskParser.js';
import { activeAgents, runnerAgents, userTerminatedAgents, pausedAgents, useRunner, isAgentOwnedLocally, unregisterSpawnedAgent } from './agentState.js';
// Both were extracted out of agentLifecycle.js (issue #2837) so this module no
// longer depends on the lifecycle orchestrator — which depends on THIS module
// for handleOrphanedTask. Importing them from their own leaf modules is what
// lets that edge be a plain static import instead of a dynamic-import dodge.
import { cleanupAgentWorktree, resolveTaskResumePatch } from './agentWorktreeCleanup.js';
import { RETRY_HOLD_KEY, RETRY_HOLD_SINCE_KEY, isRetryHeld, clearedRetryHoldMetadata } from '../lib/taskRetryHold.js';
import { CLAIM_METADATA_KEYS } from './cosTaskClaim.js';
import { REQUEUED_AT_KEY, LAST_SPAWNED_AT_KEY } from '../lib/taskRequeue.js';
import { resolveTaskTargetBranch } from '../lib/taskTargetBranch.js';
import { syncRunnerAgents } from './agentRunnerSync.js';
import { flushRunnerOutputBatcher } from './agentRunnerOutputBatchers.js';
import { completeAgentRun } from './agentRunTracking.js';
import { appendRunEvent } from './agentRunEventLog.js';
import { committedDuringRun, toEpochMs } from '../lib/gitCommitProbe.js';
import { dispatchRecoveredTaskOutputHook } from './agentFinalization.js';
import { fileInvestigationTask } from './investigationTaskProducer.js';
import { buildInvestigationFingerprint } from '../lib/investigationTasks.js';
import { PATHS, tryReadFile } from '../lib/fileUtils.js';
import { readHostShutdownMarker, clearHostShutdownMarker, HOST_SHUTDOWN_REASON } from '../lib/hostShutdown.js';
import { killProcessTree } from '../lib/bufferedSpawn.js';
import { release } from './executionLanes.js';
import { completeExecution, errorExecution } from './toolStateMachine.js';
import * as shellService from './shell.js';

const ROOT_DIR = PATHS.root;

// Max retries before creating investigation task
const MAX_ORPHAN_RETRIES = 3;
// Minimum cooldown between orphan retries (30 minutes)
const ORPHAN_RETRY_COOLDOWN_MS = 30 * 60 * 1000;

// Startup has two callers for this sweep: cos.start() awaits it before the
// first dequeue, while the spawner's delayed safety sweep runs shortly after
// its event wiring. Keep the whole sweep single-flight so both callers cannot
// read the same running agent and each requeue it (which would emit duplicate
// wakeups and dispatch the same claim task twice).
let orphanCleanupPromise = null;

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
 * Shared runner-mode termination path for terminateAgent and killAgent.
 * Calls runnerFn, marks the task blocked, and cleans up. Returns the runner
 * result shape (`{ success, error?, status? }`) — callers decide whether a
 * failure throws (killAgent, whose route surfaces status) or is returned for
 * internal orchestration to inspect (terminateAgent, whose route is
 * fire-and-forget). The runner's HTTP `status` is preserved on failure so
 * killAgent can distinguish a genuine 404 from a 5xx infra error.
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
    runnerAgents.delete(agentId);
  }
  return result;
}

// The agent-addressed half of the pause release (#3730). `updateTask` drops the
// pause bookkeeping whenever a task leaves `blocked`, but the resumed run also has
// to be POINTED at the branch/worktree the paused run left behind — and resolving
// that needs the paused agent's record. `cosTaskStore.js` cannot import this module
// (static cycle, see `agentImportCycles.test.js`), so it reaches these two steps
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
  release(agentId);
  if (agentInfo?.executionId) {
    errorExecution(agentInfo.executionId, { message: reason ? `Agent paused by user: ${reason}` : 'Agent paused by user', code: 'agent-paused' });
    completeExecution(agentInfo.executionId, { success: false, paused: true });
  }
}

/**
 * Pause an agent without finalizing its task or cleaning up its worktree.
 * The underlying process is stopped, but the persisted agent remains paused
 * so a later resume task can use the same workspace/change context.
 */
export async function pauseAgent(agentId, reason = null) {
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
    runnerAgents.delete(agentId);
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
    // taken down, not orphaned (#2243). No behavior change on POSIX.
    killProcessTree(agent.process, 'SIGTERM');
    const killTimer = setTimeout(() => {
      if (activeAgents.has(agentId)) {
        killProcessTree(agent.process, 'SIGKILL');
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
  const task = taskId ? await getTaskById(taskId).catch(() => null) : null;
  const taskType = task?.taskType || agent.metadata?.taskType || 'user';

  const mode = classifyResume(task, agentId);
  let resumed;
  switch (mode) {
    case 'requeued':
      resumed = await requeuePausedTask({ task, taskType, overrides });
      break;
    case 'new-task':
      resumed = await replacePausedTask({ agentId, task, taskType, overrides });
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
  await completeAgent(agentId, {
    success: false,
    resumed: true,
    resumedTaskId: resumed.taskId,
    error: summary
  });

  emitLog('info', `▶️ ${summary}`, {
    agentId, taskId: resumed.taskId, branchName: resumed.branchName, mode: resumed.mode
  });

  // `created` says whether anything was queued, so a caller doesn't have to keep its
  // own copy of the mode enum to know — a client that guesses would go on announcing
  // "created a resume task" for a future non-creating mode, which is the exact false
  // claim this change exists to delete.
  return { success: true, agentId, created: mode === 'new-task', ...resumed };
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
    metadata: resumeOverrideMetadata(overrides, task.metadata?.context)
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
  'outputHookDispatchedAt', 'existingBranch', 'resumedFromAgentId', 'resumeWorktreePath',
  'autoRetryCount', 'autoRetriedByInvestigation', 'autoRetriedAt', 'autoRetryExhaustedAt',
  'resolution', 'autoExpiredReason', 'autoExpiredAt',
  REQUEUED_AT_KEY, RETRY_HOLD_KEY, RETRY_HOLD_SINCE_KEY,
  ...PAUSE_METADATA_KEYS, ...CLAIM_METADATA_KEYS,
]);

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
async function replacePausedTask({ agentId, task, taskType, overrides }) {
  const description = overrides.description
    || task?.description
    || `Resume ${agentId}`;
  // `prompt` rides along with `context` (#4153): on a task written by current
  // code the agent-facing payload lives there, and a replacement queued without
  // it would run with nothing but the one-line description.
  const { context, prompt, provider, model, effort, app } = task?.metadata || {};
  const inheritedMetadata = { ...(task?.metadata || {}) };
  for (const key of REPLACEMENT_RUNTIME_METADATA_KEYS) delete inheritedMetadata[key];
  const created = await addTask({
    description,
    context, prompt, provider, model, effort, app,
    metadata: inheritedMetadata,
    ...resumeOverrideMetadata(overrides, context)
  }, taskType);
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
function resumeOverrideMetadata({ context, provider, model, effort, app, screenshots }, existingContext) {
  const patch = {};
  if (context) {
    patch.context = [existingContext, context].filter(Boolean).join('\n\n');
  }
  if (provider) patch.provider = provider;
  if (model) patch.model = model;
  if (effort) patch.effort = effort;
  if (app) patch.app = app;
  if (screenshots?.length) patch.screenshots = screenshots;
  return patch;
}

/**
 * Terminate an agent (graceful SIGTERM with SIGKILL fallback).
 */
export async function terminateAgent(agentId) {
  // Recorded ahead of both arms, so the request lands whichever one runs.
  await recordInterrupt(agentId, { reason: 'terminated-by-user', signal: 'SIGTERM' });

  // Check if agent is in runner mode
  if (runnerAgents.has(agentId)) {
    return terminateRunnerAgent(agentId, terminateAgentViaRunner, 'Agent terminated by user', 'Terminated by user');
  }

  // Direct mode
  const agent = activeAgents.get(agentId);

  // terminateAgent stays result-shaped (not a throw): its route path is
  // fire-and-forget (cosAgentLifecycle emits `agent:terminate` and returns
  // `{ success: true }` before termination runs), and its other callers are
  // internal orchestration (the event handler, killAllAgents' bulk sweep) that
  // inspect the result rather than a thrown ServerError. Only pauseAgent and
  // killAgent — whose routes surface an HTTP status — throw (issue #2534).
  if (!agent) {
    return { success: false, error: 'Agent not found or not running' };
  }

  // Track as user-terminated so the close handler doesn't re-queue
  userTerminatedAgents.add(agentId);

  // Drain pending batched stdout/stderr before the terminal record so it
  // doesn't land after completion (the close handler also drains; idempotent).
  await agent.flushOutput?.();

  // Mark agent as completed immediately with termination status
  await completeAgent(agentId, { success: false, error: 'Agent terminated by user' });

  // Block task immediately (don't defer to close handler — prevents requeue on server restart)
  if (agent.taskId) {
    const task = await getTaskById(agent.taskId).catch(() => null);
    if (task) {
      await updateTask(agent.taskId, {
        status: 'blocked',
        metadata: {
          ...task.metadata,
          blockedReason: 'Terminated by user',
          blockedCategory: 'user-terminated',
          blockedAt: new Date().toISOString()
        }
      }, task.taskType || 'user');
    }
  }

  // Kill the process — killProcessTree so a Windows cmd.exe-wrapped shim's
  // real child isn't orphaned (#2243). POSIX behavior unchanged.
  killProcessTree(agent.process, 'SIGTERM');

  // Give it a moment, then force kill if still running
  const killTimer = setTimeout(() => {
    if (activeAgents.has(agentId)) {
      killProcessTree(agent.process, 'SIGKILL');
      unregisterSpawnedAgent(agent.pid);
      activeAgents.delete(agentId);
    }
  }, 5000);

  // Store the timer so the close handler can clear it when the process exits cleanly
  const agentEntry = activeAgents.get(agentId);
  if (agentEntry) agentEntry.killTimer = killTimer;

  return { success: true, agentId };
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
  // cmd.exe-wrapped shim's real child isn't orphaned (#2243). POSIX unchanged.
  killProcessTree(agent.process, 'SIGKILL');

  unregisterSpawnedAgent(agent.pid);
  activeAgents.delete(agentId);

  return { success: true, agentId, pid: agent.pid, signal: 'SIGKILL' };
}

/**
 * Parse a single CSV row as emitted by `tasklist /FO CSV /NH`.
 * Handles quoted fields (quotes are stripped; commas inside quotes are not splits).
 * Returns an array of unquoted field strings.
 */
function parseTasklistCsvRow(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { fields.push(cur); cur = ''; continue; }
    cur += ch;
  }
  fields.push(cur);
  return fields;
}

/**
 * Get process stats for an agent (CPU, memory usage).
 */
export async function getAgentProcessStats(agentId) {
  const agent = activeAgents.get(agentId);
  if (agent) {
    // TUI agents may have a null pid until the PTY child is fully attached;
    // ps/tasklist with a non-numeric pid produces misleading "dead" output.
    if (!Number.isFinite(agent.pid)) {
      return { active: true, agentId, pid: null, cpu: 0, memoryKb: 0, memoryMb: 0, state: 'unknown' };
    }

    const { exec } = await import('../lib/childProcess.js');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    const psCmd = process.platform === 'win32'
      ? `tasklist /FI "PID eq ${agent.pid}" /FO CSV /NH`
      : `ps -p ${agent.pid} -o pid=,pcpu=,rss=,state=`;
    const result = await execAsync(psCmd).catch(() => ({ stdout: '' }));
    const line = result.stdout.trim();

    if (!line) {
      return { active: false, pid: agent.pid, cpu: 0, memoryKb: 0, memoryMb: 0, state: 'dead' };
    }

    if (process.platform === 'win32') {
      // tasklist /FO CSV /NH columns: Image Name, PID, Session Name, Session#, Memory Usage
      // Memory Usage looks like: 82,156 K (comma as thousands separator, space before K)
      // CPU is not available from basic tasklist; use 0 as an honest default.
      const fields = parseTasklistCsvRow(line);
      if (fields.length >= 5) {
        const pid = parseInt(fields[1], 10);
        const memoryKb = parseInt(fields[4].replace(/,/g, '').replace(/\s*K$/i, '').trim(), 10) || 0;
        return {
          active: true,
          agentId,
          pid,
          cpu: 0,
          memoryKb,
          memoryMb: Math.round(memoryKb / 1024 * 10) / 10,
          state: 'running'
        };
      }
    } else {
      const parts = line.split(/\s+/).filter(Boolean);
      if (parts.length >= 3) {
        return {
          active: true,
          agentId,
          pid: parseInt(parts[0], 10),
          cpu: parseFloat(parts[1]) || 0,
          memoryKb: parseInt(parts[2], 10) || 0,
          memoryMb: Math.round((parseInt(parts[2], 10) || 0) / 1024 * 10) / 10,
          state: parts[3] || 'unknown'
        };
      }
    }

    return { active: true, agentId, pid: agent.pid, cpu: 0, memoryKb: 0, memoryMb: 0, state: 'unknown' };
  }

  if (runnerAgents.has(agentId) || useRunner) {
    return await getAgentStatsFromRunner(agentId);
  }

  return null;
}

/**
 * Kill all active agents.
 */
export async function killAllAgents() {
  const directIds = Array.from(activeAgents.keys());
  const runnerIds = Array.from(runnerAgents.keys());

  await Promise.all([...directIds, ...runnerIds].map(agentId => terminateAgent(agentId)));
  return { killed: directIds.length + runnerIds.length };
}

/**
 * Check if a process is running by PID.
 */
export async function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clean up orphaned agents on startup.
 * Agents marked as "running" in state but not tracked anywhere are orphaned.
 *
 * Must check:
 * 1. Local activeAgents map (direct-spawned)
 * 2. Local runnerAgents map (recently spawned via runner)
 * 3. CoS Runner service (may have agents from before server restart)
 *
 * After cleanup:
 * - Resets associated tasks to pending for auto-retry
 * - Creates investigation task after max retries exceeded
 * - Triggers evaluation to spawn new agents
 */

/**
 * Settle a Creative Director run tied to an orphaned/reaped agent (issue #2705).
 *
 * A CD plan/treatment agent that dies without issuing its completion PATCH leaves
 * its `runs[]` row stuck `running`. `maybeEnqueuePlan`'s guard then treats that
 * non-terminal run as "a worker is already on it" and refuses to re-dispatch — so
 * the project wedges in `planning` until the NEXT server restart runs boot
 * recovery (`recoverInFlightProjects`). This helper reproduces recovery's per-project
 * reap so the project recovers without a restart. It does THREE things, in the
 * same order and shape recovery does — this is boot-ordering-critical:
 *
 *   1. **Fail the stuck run** so `maybeEnqueuePlan`'s non-terminal-run guard clears.
 *   2. **Retire the CoS task** (`status:'completed'`), NOT leave it running for
 *      `handleOrphanedTask` to requeue. This is load-bearing for boot ordering:
 *      `cleanupOrphanedAgents` runs BEFORE `recoverInFlightProjects` awaits its gate
 *      (`cos.js` start sequence), and recovery only reaps runs still marked
 *      `running` — so once we've failed the run in step 1, recovery would no longer
 *      retire this task. If we left it, `handleOrphanedTask` would requeue a stale
 *      agent that races recovery's fresh dispatch. Retiring it here makes
 *      `handleOrphanedTask` skip it (it skips `completed` tasks) — matching exactly
 *      what recovery's own `updateTask(status:'completed')` reap does. (#2705 review)
 *   3. **Re-dispatch via the deduped advance loop** (`advanceAfterPlanStepSettled` for
 *      directive projects, `advanceAfterSceneSettled` otherwise) — the SAME functions
 *      recovery calls, so the project retries on its own in steady state, and at boot
 *      the call is idempotent with recovery's advance (both go through the in-memory
 *      inflight-dedup guards, so no double dispatch). This deliberately does NOT use
 *      `handleOrphanedTask`/`resetOrphanedTasks`' raw task respawn, which the
 *      `cdRecoveryDone` gate exists to keep from racing recovery.
 *
 * No-op for non-CD tasks; the CD-module imports are deferred so non-CD orphans pay
 * nothing. Exported for unit testing.
 *
 * @param {object|null} task - the orphaned agent's task record.
 * @returns {Promise<boolean>} true if a CD run was settled, false for a non-CD task.
 */
export async function settleOrphanedCreativeDirectorRun(task) {
  const cd = task?.metadata?.creativeDirector;
  if (!cd?.projectId || !cd?.runId) return false;
  const now = new Date().toISOString();
  const { updateRun, getProject } = await import('./creativeDirector/local.js');
  // 1. Fail the stuck run (clears the maybeEnqueuePlan non-terminal-run guard).
  await updateRun(cd.projectId, cd.runId, {
    status: 'failed',
    completedAt: now,
    failureReason: 'agent process terminated unexpectedly (orphaned)',
  }).catch((err) => console.log(`⚠️ CD orphan settle: run ${cd.runId?.slice(0, 8)} of ${cd.projectId} failed: ${err.message}`));
  // 2. Retire the task the same way recovery does, so handleOrphanedTask (which
  //    skips `completed` tasks) can't requeue a stale agent to race recovery.
  //    CD tasks are internal (agentBridge#persistAndEmit adds them as 'internal').
  if (task.id) {
    await updateTask(task.id, {
      status: 'completed',
      metadata: { ...task.metadata, orphanedRunSettledAt: now },
    }, 'internal').catch((err) => console.log(`⚠️ CD orphan settle: retire task ${task.id} failed: ${err.message}`));
  }
  // 3. Re-dispatch via the deduped advance loop (fire-and-forget, like recovery).
  const project = await getProject(cd.projectId).catch(() => null);
  if (project && project.status !== 'paused' && project.status !== 'failed') {
    if (project.directive) {
      const { advanceAfterPlanStepSettled } = await import('./creativeDirector/planAdvance.js');
      advanceAfterPlanStepSettled(cd.projectId)
        .catch((e) => console.log(`⚠️ CD orphan settle: plan advance for ${cd.projectId} failed: ${e.message}`));
    } else {
      const { advanceAfterSceneSettled } = await import('./creativeDirector/completionHook.js');
      advanceAfterSceneSettled(cd.projectId)
        .catch((e) => console.log(`⚠️ CD orphan settle: advance for ${cd.projectId} failed: ${e.message}`));
    }
  }
  return true;
}

/**
 * How long after a pause the sweep leaves a paused record alone regardless of what
 * its task says. `markAgentPaused` writes the agent record BEFORE the task's pause
 * hold, so for a moment a genuinely-paused agent has a task that doesn't know it —
 * and if that second write fails outright, the sweep is the recovery, just not
 * within the same minute.
 */
const PAUSE_SETTLE_GRACE_MS = 60 * 1000;

/**
 * Retire `paused` agent records whose task has moved on without them.
 *
 * A pause is a two-part state: the agent record says `paused`, and its task holds
 * the matching pause (see lib/taskPauseHold.js). Plenty of paths legitimately take
 * the task half back — a dedupe revive, an autopilot re-dispatch, a cooldown expiry,
 * a human unblocking it, another agent pausing it later. None of them know about the
 * agent record, so it used to sit in `paused` forever: visible in the paused list,
 * and — because a stale pause reads as spent — turning the next resume click into a
 * duplicate task on a second agent.
 *
 * Only the record is retired. The worktree stays on disk: whoever picked the task up
 * may be running on that very branch, and the scheduled `agent-data-cleanup` job is
 * what reaps worktrees with no live agent.
 */
async function retireStrandedPausedAgents(agents) {
  const now = Date.now();
  for (const agent of agents) {
    if (agent.status !== 'paused') continue;
    // No task to compare against — nothing proves the pause is spent, so leave it.
    const taskId = agent.taskId || agent.metadata?.taskId || null;
    if (!taskId) continue;
    const pausedAt = Date.parse(agent.pausedAt ?? agent.metadata?.pausedAt ?? '');
    if (Number.isFinite(pausedAt) && now - pausedAt < PAUSE_SETTLE_GRACE_MS) continue;

    const task = await getTaskById(taskId).catch(() => null);
    if (isResumablePausedTask(task, agent.id)) continue;

    const reason = !task
      ? `its task ${taskId} no longer exists`
      : `task ${taskId} is ${task.status} and no longer holds this pause`;
    pausedAgents.delete(agent.id);
    // `resumed: true` for the same reason `resumeAgent` uses it: this run produced no
    // verdict of its own, so charging it an error would invent a failure the task
    // never had — whoever ran the task records the real outcome.
    await completeAgent(agent.id, {
      success: false,
      resumed: true,
      error: `Pause retired — ${reason}`
    });
    emitLog('info', `⏹️ Retired stranded paused agent ${agent.id} — ${reason}`, { agentId: agent.id, taskId });
  }
}

export function cleanupOrphanedAgents() {
  if (!orphanCleanupPromise) {
    orphanCleanupPromise = runCleanupOrphanedAgents().finally(() => {
      orphanCleanupPromise = null;
    });
  }
  return orphanCleanupPromise;
}

async function runCleanupOrphanedAgents() {
  // Was `await import('./cos.js')` destructuring all four of these (#3450). The
  // deferral bought nothing — this module already imports `./cos.js` statically
  // at the top, so the module was loaded either way — while routing two agent
  // functions through the `cos.js` re-export block, i.e. reaching a transition
  // through a barrel. `completeAgent`/`getAgents` now come from the module that
  // declares them and `evaluateTasks` joined the existing static `cos.js` import.
  const agents = await getAgents();
  let cleanedCount = 0;
  const orphanedTaskIds = [];

  // Agents the PREVIOUS process owned when it was signalled down (#3202). Their
  // processes died because PortOS restarted, not because they failed — so they
  // are *interrupted*, and must not be charged orphan-retry budget or held in the
  // 30-minute orphan cooldown. A missing/garbled marker yields an empty set,
  // which is exactly the pre-existing behavior (everything is an ordinary orphan).
  const shutdownMarker = await readHostShutdownMarker();
  const interruptedByRestart = new Set(shutdownMarker?.agentIds || []);
  if (interruptedByRestart.size > 0) {
    emitLog('info', `🛑 Host restart marker: ${interruptedByRestart.size} agent(s) were interrupted by a PortOS restart`, {
      count: interruptedByRestart.size,
      shutdownAt: shutdownMarker?.at ?? null,
    });
  }

  // Get list of agents actively running in the CoS Runner
  const runnerProbe = await getActiveAgentsFromRunner().then(
    (agents) => Array.isArray(agents)
      ? { available: true, agents }
      : { available: false, agents: [] },
    (err) => {
      emitLog('debug', `Runner agent recovery probe unavailable: ${err.message}`);
      return { available: false, agents: [] };
    },
  );
  const runnerActiveIds = new Set();
  const runnerAgentsList = runnerProbe.agents;
  for (const agent of runnerAgentsList) {
    runnerActiveIds.add(agent.id);
  }

  // Also sync runner agents to our local map for event handling
  if (runnerAgentsList.length > 0) {
    const synced = await syncRunnerAgents();
    if (synced > 0) {
      console.log(`🔄 Synced ${synced} agents from CoS Runner`);
    }
  }

  for (const agent of agents) {
    if (agent.status === 'running') {
      const inRemoteRunner = runnerActiveIds.has(agent.id);

      // A runner-owned agent may still be alive while the runner is booting or
      // reconnecting. Its absence from a failed probe is not evidence that the
      // process died. Leave the durable record in_progress so the next
      // connection can re-adopt it; requeueing here would race a second claim
      // agent onto the same work. Old records use `useRunner`, while newer
      // records carry the more precise executionMode.
      const executionMode = agent.metadata?.executionMode;
      const runnerOwned = agent.metadata?.useRunner === true
        || agent.metadata?.useRunner === 'true'
        || executionMode === 'runner'
        || executionMode === 'runner-tui';
      if (!runnerProbe.available && runnerOwned) {
        emitLog('debug', `Skipping orphan cleanup for runner-owned agent ${agent.id} — runner is unavailable`, { agentId: agent.id });
        continue;
      }

      if (!isAgentOwnedLocally(agent.id) && !inRemoteRunner) {
        // Before marking as orphaned, check if the process is actually still running
        if (agent.pid) {
          const stillAlive = await isPidAlive(agent.pid);
          if (stillAlive) {
            console.log(`🔄 Agent ${agent.id} (PID ${agent.pid}) still running, re-syncing to runner tracking`);
            const inferredType = isInternalTaskId(agent.taskId) ? 'internal' : 'user';
            runnerAgents.set(agent.id, {
              id: agent.id, pid: agent.pid, taskId: agent.taskId,
              task: { id: agent.taskId, taskType: inferredType, description: 'Re-synced from PID check' }
            });
            continue;
          }
        }

        const interrupted = interruptedByRestart.has(agent.id);
        const errorMessage = interrupted
          ? 'Agent was interrupted by a PortOS server restart'
          : 'Agent process terminated unexpectedly';
        console.log(interrupted
          ? `🛑 Recovering agent ${agent.id} interrupted by a PortOS restart (PID ${agent.pid || 'unknown'} not running)`
          : `🧹 Cleaning up orphaned agent ${agent.id} (PID ${agent.pid || 'unknown'} not running)`);
        // Record the reap in the lifecycle ledger BEFORE the run is closed
        // (#4540), so the ordered stream reads "orphaned, then finalized" and a
        // replay can tell an agent that died from one that exited. Emitted even
        // when the agent record carries no `runId` — a survivor whose run id
        // never landed is precisely the case the mutable records cannot explain,
        // so it keys off the agent instead of disappearing.
        await appendRunEvent({
          kind: 'run.orphan-recovered',
          // Explicit natural key rather than the content-derived default: this
          // sweep runs every 15 minutes and can re-observe the same dead agent
          // if the `completeAgent` write below ever fails to land, and the
          // content hash covers the wall-clock `at`, so a retry would otherwise
          // mint a second "this agent died" fact. An agent dies once per life,
          // and `id + startedAt` names exactly that.
          eventId: `orphan:${agent.id}:${agent.startedAt || 'unknown'}`,
          runId: agent.metadata?.runId,
          agentId: agent.id,
          taskId: agent.taskId,
          data: {
            interruptedByRestart: interrupted,
            pid: agent.pid ?? null,
            hasRunId: Boolean(agent.metadata?.runId),
            startedAt: agent.startedAt ?? null,
          },
        });
        const task = agent.taskId ? await getTaskById(agent.taskId).catch(() => null) : null;
        await dispatchRecoveredTaskOutputHook({
          agentId: agent.id,
          task,
          success: false,
          workspacePath: agent.metadata?.workspacePath || null,
        });
        if (agent.metadata?.runId) {
          const bufferedOutput = Array.isArray(agent.output)
            ? agent.output.map((entry) => typeof entry === 'string' ? entry : entry?.line).filter(Boolean).join('\n')
            : '';
          const output = await tryReadFile(join(PATHS.cosAgents, agent.id, 'output.txt')) ?? bufferedOutput;
          const startedAt = Date.parse(agent.startedAt);
          const duration = Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : 0;
          // Close the run BEFORE the agent record. If the run write fails, the
          // agent remains eligible for the next sweep; if the later agent write
          // fails, completeAgentRun's endTime guard makes this retry harmless.
          await completeAgentRun(agent.metadata.runId, output, interrupted ? 143 : 1, duration, {
            message: errorMessage,
            category: interrupted ? 'interrupted' : 'orphaned',
          });
        }
        await completeAgent(agent.id, {
          success: false,
          error: errorMessage,
          orphaned: true,
          // Post-mortem telemetry on the agent record (nothing reads it yet —
          // the human-visible distinction is the `error` string above). Worth
          // persisting because an infrastructure interruption and a real agent
          // fault are indistinguishable from the process's point of view once
          // the record is written.
          interruptedByRestart: interrupted,
        });
        cleanedCount++;

        if (agent.taskId) {
          // Carry the agent's metadata forward rather than re-reading the record
          // later: `getAgent` on a completed agent still hits the disk to hydrate
          // its output.txt tail (capped since #3498, but not free), and the
          // worktree fields the resume pointer needs are stamped once at
          // registerAgent and never mutated.
          // `startedAt` rides along too — it's the window the commit probe in
          // handleOrphanedTask needs to tell this run's commits from the repo's.
          orphanedTaskIds.push({ taskId: agent.taskId, agentId: agent.id, agentMetadata: agent.metadata, agentStartedAt: agent.startedAt });
        }
      }
    }
  }

  // Clean up worktrees for the specific agents detected as orphaned this cycle.
  // The blanket "reap every worktree dir with no live agent" sweep lives in the
  // scheduled `agent-data-cleanup` job (autonomousJobs.js), NOT here — running it
  // on the 15-min health-check hot path gave it a wide window to remove a human's
  // in-flight `/claim` worktree mid-review. Targeted cleanup of a known-dead
  // agent's own worktree is safe and stays.
  for (const { agentId } of orphanedTaskIds) {
    await cleanupAgentWorktree(agentId, false);
  }

  // Settle any Creative Director run tied to an orphaned agent (issue #2705)
  // BEFORE the retry below, so the project can advance without a server restart.
  for (const { taskId } of orphanedTaskIds) {
    const task = await getTaskById(taskId).catch(() => null);
    await settleOrphanedCreativeDirectorRun(task);
  }

  // Handle orphaned tasks - reset for retry or create investigation task.
  // `agentMetadata` rides along so the retry can resume what this run left behind
  // (see handleOrphanedTask). Runs AFTER cleanupAgentWorktree above so the resume
  // pointer reflects what actually survived — a dirty tree aborts removal, leaving
  // the whole worktree in place.
  for (const { taskId, agentId, agentMetadata, agentStartedAt } of orphanedTaskIds) {
    await handleOrphanedTask(taskId, agentId, getTaskById, {
      agentMetadata,
      agentStartedAt,
      // `|| null`, not a bare boolean: a plain `false` would hard-override the
      // per-agent breadcrumb fallback, leaving this — the path that handles
      // essentially all boot recovery — with the marker as its ONLY signal. The
      // marker is best-effort (a stalled disk can blow the 1.5s shutdown grace,
      // or the write can simply fail), and when it's the only signal its loss
      // silently reinstates the original bug. `null` means "no verdict from me,
      // check the breadcrumb"; `true` still short-circuits it.
      interrupted: interruptedByRestart.has(agentId) || null,
    });
  }

  // Consume the marker. Doing it AFTER the retry pass (not before) means a crash
  // mid-sweep leaves it in place and the next boot still classifies these agents
  // correctly; re-reading a stale marker is harmless because the sweep only ever
  // looks at agents still marked `running`.
  //
  // Gated on the marker EXISTING, not on it naming anyone: a truncated or
  // malformed marker parses to zero agent ids, and gating on the id count would
  // leave that file on disk to be re-read and re-parsed on every boot and every
  // 15-minute sweep, forever.
  if (shutdownMarker) await clearHostShutdownMarker();

  // Paused records whose task moved on without them. Not orphans (nothing died) and
  // not counted as such — but this is the sweep that already holds the agent list,
  // and leaving them stranded is what turns a later resume click into a duplicate.
  await retireStrandedPausedAgents(agents);

  // Trigger evaluation to spawn new agents for retried tasks
  if (cleanedCount > 0) {
    emitLog('info', `Cleaned up ${cleanedCount} orphaned agents, triggering evaluation`, { cleanedCount });
    setTimeout(() => {
      evaluateTasks().catch(err => {
        console.error(`❌ Failed to evaluate tasks after orphan cleanup: ${err.message}`);
      });
    }, 1000);
  }

  return cleanedCount;
}

/**
 * Handle an orphaned task - retry or create investigation.
 *
 * Every path that retires a run whose process vanished funnels through here —
 * the boot/health-check orphan sweep, `resetOrphanedTasks`, and the post-restart
 * completion recovery — so the retry's resume pointer is resolved HERE rather than
 * at each call site. Callers that know which agent died pass its `agentMetadata`;
 * without it the retry simply starts clean, which is the pre-existing behavior.
 *
 * @param {object} [options]
 * @param {object} [options.agentMetadata] - the dead agent's registered metadata
 *   (`isWorktree` / `sourceWorkspace` / `worktreeBranch` / `workspacePath`), used
 *   to work out whether its branch or worktree is worth resuming.
 * @param {string|number|null} [options.agentStartedAt] - when the dead run began. It is
 *   the window for the commit probe below; without it the probe is skipped rather than
 *   run unbounded, which would credit this task with any commit already in the repo (#3637).
 * @param {boolean|null} [options.interrupted] - the run died because PortOS itself
 *   was restarted, not because the agent failed. Such a run is requeued immediately
 *   WITHOUT charging orphan-retry budget or arming the orphan cooldown — see the
 *   retry-budget note below (#3202). Pass it when the caller knows (the orphan sweep
 *   reads the host-shutdown marker); leave it null to derive from `agentMetadata`.
 */
export async function handleOrphanedTask(taskId, agentId, getTaskByIdFn, { agentMetadata = null, agentStartedAt = null, interrupted = null } = {}) {
  // Callers that watched the agent die (the orphan sweep, which reads the
  // host-shutdown marker) say so explicitly. The ones that didn't —
  // `resetOrphanedTasks`, post-restart completion recovery — fall back to the
  // breadcrumb the abandon path stamped on the agent itself, so an interrupted
  // run is still recognized no matter which recovery path reaches it first.
  // Without this, correctness depended on `cleanupOrphanedAgents` happening to
  // run before `resetOrphanedTasks` in cos.js's boot sequence.
  const wasInterrupted = interrupted ?? (agentMetadata?.interruptedBy === HOST_SHUTDOWN_REASON);
  // Consume the breadcrumb the moment it's honored, exactly as the marker is
  // consumed after the sweep. It is written once and would otherwise stay on the
  // agent record forever: `resetOrphanedTasks` keys on the most recent agent per
  // task, so a respawn that dies before creating its own agent record would keep
  // re-deriving `wasInterrupted` from this same stale breadcrumb — and, because
  // an interrupted run bypasses the cooldown, respawn on EVERY 15-minute sweep
  // instead of once per 30 minutes.
  if (wasInterrupted && agentMetadata?.interruptedBy === HOST_SHUTDOWN_REASON) {
    await updateAgent(agentId, { metadata: { interruptedBy: null } })
      .catch(err => emitLog('warn', `Could not clear interrupted breadcrumb on ${agentId}: ${err.message}`, { agentId }));
  }
  const task = await getTaskByIdFn(taskId).catch(() => null);
  if (!task) {
    emitLog('warn', `Could not find task ${taskId} for orphaned agent ${agentId}`, { taskId, agentId });
    return;
  }

  // Never requeue tasks that were explicitly terminated by the user
  if (task.status === 'blocked' && task.metadata?.blockedCategory === 'user-terminated') {
    emitLog('info', `⏭️ Skipping orphaned task ${taskId} — user-terminated`, { taskId, agentId });
    return;
  }

  // If a prior orphan in this sweep already routed the task through this handler
  // (max-retries → investigation task created, or orphan-cooldown → blocked until later),
  // skip — otherwise each additional orphaned agent for the same task spawns a
  // duplicate investigation task and inflates orphanRetryCount past its ceiling.
  if (task.status === 'blocked' &&
      (task.metadata?.blockedCategory === 'max-retries' ||
       task.metadata?.blockedCategory === 'orphan-cooldown')) {
    emitLog('info', `⏭️ Skipping orphaned task ${taskId} — already handled (${task.metadata.blockedCategory})`, {
      taskId, agentId, blockedCategory: task.metadata.blockedCategory
    });
    return;
  }

  // Skip tasks already completed
  if (task.status === 'completed') {
    emitLog('debug', `⏭️ Skipping orphaned task ${taskId} — already completed`, { taskId, agentId });
    return;
  }

  // A retry hold whose process died mid-transition (#3373). The run's verdict is
  // already persisted — it failed, and was budgeted a retry — so this is not a
  // fresh orphan: finish the transition the dead process started (resolve the
  // pointer, flip to `pending`, drop the marker) rather than charging it orphan
  // budget for a decision that was already made. Runs BEFORE the commit check
  // below: a failed run that committed is exactly the case the resume pointer
  // exists for, and completing the task on that evidence would discard the retry
  // finalizeAgent already granted.
  if (isRetryHeld(task.metadata)) {
    const resumePatch = await resolveTaskResumePatch({ task, agentId, agentMetadata }).catch(err => {
      emitLog('warn', `Resume pointer for held task ${taskId} could not be resolved: ${err.message}`, { taskId, agentId });
      return {};
    });
    const targetBranch = resolveTaskTargetBranch(resumePatch);
    emitLog('info', `🔓 Completing interrupted retry transition for task ${taskId}${targetBranch ? ` — resuming ${targetBranch}` : ''}`, {
      taskId, agentId, branchName: targetBranch
    });
    await updateTask(taskId, {
      status: 'pending',
      metadata: { ...resumePatch, ...clearedRetryHoldMetadata() }
    }, task.taskType || 'user');
    return;
  }

  // Check if the agent actually committed work before treating as orphaned.
  // Scoped to the dead run's OWN window (#3637): the retired task-id commit marker
  // was never emitted by anything, and an unbounded `git log` would credit this
  // task with any commit in the repo — including another agent's.
  // Both shapes the agent record can carry — the persisted ISO string and a raw
  // epoch-ms number (see toEpochMs for why a bare Date.parse drops the latter).
  const orphanRunStartedAt = toEpochMs(agentStartedAt);
  const commitFound = Number.isFinite(orphanRunStartedAt)
    && await committedDuringRun(agentMetadata?.workspacePath || ROOT_DIR, orphanRunStartedAt);
  if (commitFound) {
    emitLog('info', `✅ Orphaned agent ${agentId} actually completed work - commit found for task ${taskId}`, { taskId, agentId });
    await updateTask(taskId, { status: 'completed' }, task.taskType || 'user');
    return;
  }

  // Get current retry count from task metadata.
  //
  // Retry budget and the cooldown exist to stop a task that keeps KILLING ITS OWN
  // agent from spawning forever. A PortOS host restart is not that: the agent was
  // healthy and PortOS took it down (#3202). Charging it a retry — and arming the
  // 30-minute cooldown — punishes the task for our maintenance, and three routine
  // restarts were enough to exhaust the budget and block the task outright. So an
  // interrupted run costs no retry and arms no cooldown; it just requeues with a
  // resume pointer. `MAX_TOTAL_SPAWNS` still applies, so nothing can spawn
  // unboundedly even under a restart loop.
  const priorOrphanRetries = Number(task.metadata?.orphanRetryCount) || 0;
  const retryCount = wasInterrupted ? priorOrphanRetries : priorOrphanRetries + 1;
  const taskType = task.taskType || 'user';

  // `totalSpawnCount` is incremented when a task goes `in_progress`, so the run a
  // restart destroyed already consumed a spawn. REFUND it: that spawn produced no
  // work and was ended by PortOS, not by the task. Without the refund the fix is
  // only half-done — the ceiling moves from 3 restarts to MAX_TOTAL_SPAWNS, after
  // which the task is still blocked `max-retries` AND an "[Auto-Fix] Investigate
  // repeated agent orphaning" task is filed blaming an agent that never failed.
  // The refund keeps a real ceiling on genuine failures (each still costs a
  // spawn) while making a restart cost nothing.
  const priorTotalSpawns = Number(task.metadata?.totalSpawnCount) || 0;
  const totalSpawns = wasInterrupted ? Math.max(0, priorTotalSpawns - 1) : priorTotalSpawns;

  // Block if total spawn count across all retry types is exhausted
  const totalExceeded = totalSpawns >= MAX_TOTAL_SPAWNS;

  // Enforce cooldown between orphan retries
  const lastOrphanedAt = task.metadata?.lastOrphanedAt ? new Date(task.metadata.lastOrphanedAt).getTime() : 0;
  const cooldownRemaining = lastOrphanedAt ? ORPHAN_RETRY_COOLDOWN_MS - (Date.now() - lastOrphanedAt) : 0;
  const inCooldown = !wasInterrupted && cooldownRemaining > 0;

  // An interrupted run is exempt from the orphan ceiling for the same reason it
  // is exempt from the counter: it isn't one of the failures the ceiling counts.
  // `totalExceeded` still gates it, so a restart loop can't spawn without bound.
  const withinOrphanBudget = wasInterrupted || retryCount < MAX_ORPHAN_RETRIES;

  if (withinOrphanBudget && !totalExceeded && !inCooldown) {
    emitLog('info', wasInterrupted
      ? `Resuming task ${taskId} interrupted by a PortOS restart (no retry charged; total spawns ${totalSpawns}/${MAX_TOTAL_SPAWNS})`
      : `Resetting orphaned task ${taskId} for retry (attempt ${retryCount}/${MAX_ORPHAN_RETRIES}, total spawns ${totalSpawns}/${MAX_TOTAL_SPAWNS})`, {
      taskId,
      retryCount,
      totalSpawns,
      interrupted: wasInterrupted,
      maxRetries: MAX_ORPHAN_RETRIES
    });

    // Point the retry at whatever the dead run left behind — its branch, or the
    // whole worktree when the process died mid-edit and the uncommitted work is
    // still sitting in it. Folded into THIS write rather than stamped separately
    // beforehand: the flip to `pending` emits `tasks:changed`, which can spawn the
    // retry immediately, so a pointer written afterwards could land too late.
    // Fails open to "start clean": requeueing the task matters far more than
    // resuming it, and a throw here would strand it in_progress until the next sweep.
    const resumePatch = await resolveTaskResumePatch({ task, agentId, agentMetadata }).catch(err => {
      emitLog('warn', `Resume pointer for task ${taskId} could not be resolved: ${err.message}`, { taskId, agentId });
      return {};
    });

    // An interrupted run records WHAT happened without touching the orphan
    // bookkeeping: `lastOrphanedAt` stays as-is so a later genuine orphan's
    // cooldown is still measured from the last genuine orphan, not from our
    // restart. The genuine-orphan branch clears `interruptedByRestart` — the
    // metadata spread below carries every prior key forward, so leaving it set
    // would make a task that was once restarted look permanently restart-
    // interrupted, through this orphan and every later one.
    const now = new Date().toISOString();
    const recoveryMetadata = wasInterrupted
      ? {
        // Persist the refunded count (see the totalSpawns note above) so the
        // restart's spawn is genuinely given back rather than just ignored once.
        totalSpawnCount: totalSpawns,
        lastInterruptedAt: now,
        lastInterruptedAgentId: agentId,
        interruptedByRestart: true,
      }
      : {
        orphanRetryCount: retryCount,
        lastOrphanedAt: now,
        lastOrphanedAgentId: agentId,
        interruptedByRestart: false,
      };

    await updateTask(taskId, {
      status: 'pending',
      metadata: {
        ...task.metadata,
        ...recoveryMetadata,
        ...resumePatch
      }
    }, taskType);
  } else if (inCooldown && retryCount < MAX_ORPHAN_RETRIES && !totalExceeded) {
    const cooldownMinutes = Math.ceil(cooldownRemaining / 60000);
    emitLog('info', `⏳ Orphan retry for task ${taskId} in cooldown (${cooldownMinutes}m remaining)`, {
      taskId, cooldownMinutes, retryCount
    });

    await updateTask(taskId, {
      status: 'blocked',
      metadata: {
        ...task.metadata,
        orphanRetryCount: retryCount,
        lastOrphanedAt: new Date().toISOString(),
        lastOrphanedAgentId: agentId,
        // Cleared for the same reason the requeue branch clears it: the metadata
        // spread carries every prior key forward, so a task interrupted once
        // would read as restart-interrupted through every later outcome.
        interruptedByRestart: false,
        blockedReason: `Orphan retry cooldown (${cooldownMinutes}m remaining)`,
        blockedCategory: 'orphan-cooldown',
        blockedAt: new Date().toISOString(),
        cooldownUntil: new Date(Date.now() + cooldownRemaining).toISOString()
      }
    }, taskType);
  } else {
    const reason = totalExceeded
      ? `total spawns exceeded (${totalSpawns}/${MAX_TOTAL_SPAWNS})`
      : `orphan retries exceeded (${retryCount}/${MAX_ORPHAN_RETRIES})`;
    emitLog('warn', `Task ${taskId} blocked: ${reason}, creating investigation task`, {
      taskId,
      retryCount,
      totalSpawns
    });

    await updateTask(taskId, {
      status: 'blocked',
      metadata: {
        ...task.metadata,
        orphanRetryCount: retryCount,
        // See the requeue branch: the metadata spread carries prior keys forward.
        interruptedByRestart: false,
        blockedReason: reason,
        blockedCategory: 'max-retries',
        blockedAt: new Date().toISOString()
      }
    }, taskType);

    const description = `[Auto-Fix] Investigate repeated agent orphaning for task ${taskId}

**Original Task**: ${(task.description || '').substring(0, 200)}
**Orphan Retries**: ${retryCount}
**Total Spawns**: ${totalSpawns}
**Last Orphaned Agent**: ${agentId}
**Blocked Reason**: ${reason}

This task has been blocked after ${totalSpawns} total agent spawns. Investigate:
1. Check CoS Runner logs for errors
2. Verify process spawning is working correctly
3. Look for resource constraints (memory, CPU)
4. Check for network/connection issues between services

Once the issue is resolved, task \`${taskId}\` is retried automatically — completing this task revives it.`;

    // Filed through the shared producer so this participates in the same
    // loop-aware approval policy, storm counter, and fingerprint dedup as every
    // other investigation (#3714), and so `affectedTasks` closes the loop: the
    // orphaned task comes back on its own when this one completes. Hardcoding
    // `approvalRequired: true` here is what turned one repeatedly-orphaned task
    // into a queue of approvals nobody asked for.
    await fileInvestigationTask({
      description,
      priority: 'HIGH',
      context: `Auto-generated from repeated orphan failures for task ${taskId}`,
      fingerprint: buildInvestigationFingerprint(task, { category: 'max-retries' }),
      affectedTasks: [taskId]
    }).catch(err => {
      emitLog('error', `Failed to create investigation task: ${err.message}`, { taskId, error: err.message });
    });
  }
}
