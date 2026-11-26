/**
 * Retires stranded agents and settles the tasks their processes left behind.
 */

import { isTruthyMeta } from '../../lib/metadataFlags.js';
import { reconcileStaleAgentReservations, releaseAgentReservation } from './agentMaintenanceReservations.js';
import { reconcileDeadOwnerReservations } from '../deadOwnerReservations.js';
import { MAX_ORPHAN_RETRIES, ORPHAN_GUARDS, buildOrphanOutcome, classifyOrphanGuard, decideOrphanRetry } from './agentOrphanPolicy.js';
import { matchesLatestTaskDispatch } from './agentCompletionTaskHandoff.js';
import { currentTaskTypeName } from '../../lib/taskTypeRenames.js';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { completeAgentRun } from './agentRunTracking.js';
import { isPrivateSecurityTask } from '../../lib/privateSecurityPolicy.js';
import { emitLog } from '../cos/cosEvents.js';
import { completeAgent, updateAgent, getAgents, AGENT_RECORD_UNREADABLE, isLiveAgentRecord, readAgentRecordOrUnreadable } from '../cos/cosAgentLifecycle.js';
import { updateTask, getTaskById } from '../cos/cosTaskStore.js';
import { evaluateTasks } from '../cos/cosTaskGenerator.js';
import { isResumablePausedTask } from '../../lib/taskPauseHold.js';
import { getActiveAgentsFromRunner } from '../cos/cosRunnerClient.js';
import { runnerEntryShieldsRunningRecord } from '../../lib/runnerAgentLiveness.js';
import { MAX_TOTAL_SPAWNS } from '../../lib/cos/cosTaskMetadata.js';
import { isInternalTaskId } from '../../lib/taskParser.js';
import { activeAgents, runnerAgents, dropRunnerAgent, trackRunnerAgent, completingAgents, spawningTasks, pausedAgents } from './agentState.js';
import { cleanupAgentWorktree, resolveTaskResumePatch } from './agentWorktreeCleanup.js';
import { RETRY_HOLD_KEY, isRetryHeld, clearedRetryHoldMetadata, isDeliveryCleanupHeld } from '../../lib/taskRetryHold.js';
import { LAST_SPAWNED_AT_KEY } from '../../lib/taskRequeue.js';
import { resolveTaskTargetBranch } from '../../lib/taskTargetBranch.js';
import { holdRecoveredRunnerOllamaWork, readRunnerCompletionReceipt, syncRunnerAgents } from './agentRunnerSync.js';
import { appendRunEvent } from './agentRunEventLog.js';
import { committedDuringRun, toEpochMs } from '../../lib/gitCommitProbe.js';
import { fileInvestigationTask } from '../investigationTaskProducer.js';
import { buildInvestigationFingerprint } from '../../lib/investigationTasks.js';
import { PATHS, tryReadFile } from '../../lib/fileUtils.js';
import { readHostShutdownMarker, clearHostShutdownMarker, HOST_SHUTDOWN_REASON } from '../../lib/hostShutdown.js';
import { isPidAlive } from './agentProcessProbe.js';

export { MAX_ORPHAN_RETRIES, ORPHAN_GUARDS, ORPHAN_RETRY_COOLDOWN_MS, buildOrphanOutcome, classifyOrphanGuard, decideOrphanRetry } from './agentOrphanPolicy.js';

const ROOT_DIR = PATHS.root;

// The sweep's callers overlap: cos.start() awaits it before the first dequeue,
// the spawner's delayed safety sweep follows its event wiring, and agent list
// reads and "Run now" arrive at any time. Keep the whole sweep single-flight so
// two callers cannot read the same running agent and each requeue it (which
// would emit duplicate wakeups and dispatch the same claim task twice).
let orphanCleanupPromise = null;

// Close the stopped execution before retiring its agent. This bypasses provider
// failure handling: a pause has no delivery verdict, and its continuation owns it.
export async function closePausedRun(agent) {
  const runId = agent.metadata?.runId;
  if (!runId) return;
  const output = isPrivateSecurityTask(agent)
    ? 'Private security assessment interrupted; inspect its local assessment archive.'
    : await tryReadFile(join(PATHS.cosAgents, agent.id, 'output.txt'));
  await completeAgentRun(runId, output || '', 143, 0, {
    category: 'interrupted', origin: 'operator', message: 'Paused execution retired for continuation',
  }, false, null, { endedAt: agent.pausedAt ?? agent.metadata?.pausedAt });
}

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
  const { updateRun, getProject } = await import('../creativeDirector/local.js');
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
      const { advanceAfterPlanStepSettled } = await import('../creativeDirector/planAdvance.js');
      advanceAfterPlanStepSettled(cd.projectId)
        .catch((e) => console.log(`⚠️ CD orphan settle: plan advance for ${cd.projectId} failed: ${e.message}`));
    } else {
      const { advanceAfterSceneSettled } = await import('../creativeDirector/completionHook.js');
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
  for (const listed of agents) {
    if (listed.status !== 'paused') continue;
    const agent = await readCurrentRecord(listed, 'paused');
    if (!agent) continue;
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
    await closePausedRun(agent);
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

// A running record with no pid this young may still be mid-spawn.
const SPAWN_GRACE_MS = 30000;

/**
 * The record behind a sweep-list entry as it stands now, or null when it has
 * left `status` (or cannot be read, which proves nothing either way).
 *
 * The sweep reads its list once and then awaits forge, git and hook work for
 * every record it retires, so by a later record's turn the listed copy can be
 * minutes old: a spawn has since recorded its pid, or the run has completed.
 * Judging that copy retires a live agent or finalizes a finished one twice.
 */
async function readCurrentRecord(listed, status) {
  const current = await readAgentRecordOrUnreadable(listed.id);
  return current !== AGENT_RECORD_UNREADABLE && current?.status === status ? current : null;
}

/**
 * The one reaper for `running` agent records whose process is gone (#18637).
 * Boot, the health-check interval, the spawner's startup sweep, `GET
 * /api/cos/agents` and `forceSpawnTask` all call this; nothing else writes a
 * terminal record for a dead run.
 *
 * A record is left running while any of these holds:
 * - its completion is in flight (`completingAgents`);
 * - this process holds its handle (`activeAgents`);
 * - its task is still inside the spawn guard (`spawningTasks`);
 * - it is runner-owned and the runner cannot be asked;
 * - the runner lists it with corroborated liveness;
 * - it has no pid yet and is younger than `SPAWN_GRACE_MS`, unless the
 *   host-shutdown marker names it;
 * - its pid answers.
 *
 * Any other record is retired once, through `completeAgent`: from the
 * runner's completion receipt when one is on disk, otherwise as an orphan (or
 * as interrupted when the host-shutdown marker names it), after which its
 * task is retried or blocked by `handleOrphanedTask`.
 *
 * Single-flight through `orphanCleanupPromise`.
 *
 * @returns {Promise<number>} records retired as orphans or interrupted
 */
export function cleanupOrphanedAgents() {
  if (!orphanCleanupPromise) {
    orphanCleanupPromise = runCleanupOrphanedAgents().finally(() => {
      orphanCleanupPromise = null;
    });
  }
  return orphanCleanupPromise;
}

async function runCleanupOrphanedAgents() {
  const agents = await getAgents();
  let cleanedCount = 0;
  const orphanedTaskIds = [];
  // Agents retired by this sweep, with or without a task: each still holds the
  // maintenance reservation its original spawn took, and retireDeadAgent does
  // not release it.
  const retiredAgentIds = [];

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
  const runnerById = new Map();
  const runnerAgentsList = runnerProbe.agents;
  for (const row of runnerAgentsList) {
    if (row?.id) runnerById.set(row.id, row);
  }

  // Also sync runner agents to our local map for event handling
  if (runnerAgentsList.length > 0) {
    const synced = await syncRunnerAgents();
    if (synced > 0) {
      console.log(`🔄 Synced ${synced} agents from CoS Runner`);
    }
  }

  // The reverse pass: drop `runnerAgents` entries with nothing behind them.
  // The sweep below walks durable RECORDS, so it can never reach a map entry
  // that has no record — and nothing else prunes the map either, so a phantom
  // adopted from the runner survived until the process restarted. It then
  // over-protected worktrees from the cleanup job, and counted against the
  // update gate that blocks a restart, which is the one thing that would have
  // cleared it.
  //
  // Scoped to `runnerAgents` on purpose. `activeAgents` entries hold live
  // PTY/child handles owned by this process's own spawn closures; dropping one
  // would flip `isAgentOwnedLocally` to false and re-open the #4540
  // double-finalize that `agentRunnerSync`'s ownership check exists to prevent.
  // A runner-side entry is only ever a mirror, so losing it costs nothing but a
  // re-adoption on the next sweep if the runner still advertises it.
  for (const agentId of [...runnerAgents.keys()]) {
    const read = await readAgentRecordOrUnreadable(agentId);
    if (read === AGENT_RECORD_UNREADABLE || isLiveAgentRecord(read)) continue;
    dropRunnerAgent(agentId);
    emitLog('info', `🧹 Dropped stale runner-agent tracking for ${agentId} — no live record behind it`, { agentId });
  }

  for (const listed of agents) {
    if (listed.status === 'running') {
      const agent = await readCurrentRecord(listed, 'running');
      if (!agent) continue;
      // In-process ownership first, with no await since the read above: a spawn
      // records its pid before it leaves `spawningTasks`, so a record read
      // without a pid is still covered here.
      if (completingAgents.has(agent.id)) continue;
      // Direct-spawn handles in this process are live. Leftover runnerAgents
      // ownership from an earlier adopt is not — a stale listing must not keep
      // the durable record running forever.
      if (activeAgents.has(agent.id)) continue;
      // The record is written before the spawn finishes (prompt build, task claim,
      // forge/env lookups, PTY open), and that window can run for minutes under
      // load. While the dispatch still owns the task, a missing pid means "not
      // spawned yet"; retiring it here completes a run that goes on to launch,
      // and its claim ownership bind then fails with owner-not-running.
      if (agent.taskId && spawningTasks.has(agent.taskId)) continue;

      // A runner-owned agent may still be alive while the runner is booting or
      // reconnecting. Its absence from a failed probe is not evidence that the
      // process died. Leave the durable record in_progress so the next
      // connection can re-adopt it; requeueing here would race a second claim
      // agent onto the same work. Old records use `useRunner`, while newer
      // records carry the more precise executionMode.
      const executionMode = agent.metadata?.executionMode;
      const runnerOwned = isTruthyMeta(agent.metadata?.useRunner)
        || executionMode === 'runner'
        || executionMode === 'runner-tui';
      if (!runnerProbe.available && runnerOwned) {
        emitLog('debug', `Skipping orphan cleanup for runner-owned agent ${agent.id} — runner is unavailable`, { agentId: agent.id });
        continue;
      }

      // A runner listing shields only when corroborated (live pid, or the
      // runner's own onExit bookkeeping); see runnerAgentLiveness.js.
      if (await runnerEntryShieldsRunningRecord(runnerById.get(agent.id), isPidAlive)) continue;
      // A shutdown-marked dispatch cannot still be initializing in this process.
      // Retire it now; otherwise the grace skips it and we consume its marker,
      // so the next sweep charges a genuine host interruption as an orphan.
      if (!agent.pid && !interruptedByRestart.has(agent.id)) {
        const startedAtMs = agent.startedAt ? Date.parse(agent.startedAt) : 0;
        if (Date.now() - startedAtMs < SPAWN_GRACE_MS) continue;
      }
      // Before marking as orphaned, check if the process is actually still running.
      // Any leftover entry stays until the pid is known dead: a live Ollama-backed
      // harness must never be uncounted as in-flight daemon work (#17342).
      const tracked = runnerAgents.get(agent.id);
      if (agent.pid) {
        const stillAlive = await isPidAlive(agent.pid);
        if (stillAlive) {
          console.log(`🔄 Agent ${agent.id} (PID ${agent.pid}) still running, re-syncing to runner tracking`);
          const inferredType = isInternalTaskId(agent.taskId) ? 'internal' : 'user';
          const current = runnerAgents.get(agent.id);
          const acquired = current?.releaseOllamaWork ? null : await holdRecoveredRunnerOllamaWork(agent);
          // Another sweep or spawn re-tracked or dropped it while this one awaited.
          if (runnerAgents.get(agent.id) !== current) {
            acquired?.();
            continue;
          }
          // The stub carries the existing hold over, so replacing the entry keeps
          // it; one that appeared on the entry during the await wins over ours.
          const carried = current?.releaseOllamaWork ?? acquired;
          if (acquired && carried !== acquired) acquired();
          trackRunnerAgent(agent.id, {
            id: agent.id, pid: agent.pid, taskId: agent.taskId,
            task: { id: agent.taskId, taskType: inferredType, description: 'Re-synced from PID check' },
            releaseOllamaWork: carried
          });
          continue;
        }
      }
      // A spawn or sync that tracked this id during the liveness probe owns it now.
      const replacement = runnerAgents.get(agent.id);
      if (replacement && replacement !== tracked) continue;
      dropRunnerAgent(agent.id);

      // Recheck after the awaited pid probes: completion owns its terminal write.
      if (completingAgents.has(agent.id)) continue;

      // An exit while no server was connected (the restart window) loses only
      // the runner's `agent:completed` broadcast; its verdict is on disk. Finish
      // it through the same path that event takes instead of charging an orphan
      // retry and rerunning finished work (#14261). The runner is known to be
      // available here — an unavailable one skipped runner-owned records above.
      // Deferred import: agentLifecycle statically imports this module.
      if (runnerOwned) {
        const receipt = await readRunnerCompletionReceipt(agent.id, { taskId: agent.taskId, startedAt: agent.startedAt });
        if (receipt) {
          console.log(`📬 Finalizing runner agent ${agent.id} from its completion receipt (exit ${receipt.exitCode})`);
          const { handleAgentCompletion } = await import('./agentLifecycle.js');
          await handleAgentCompletion(agent.id, receipt.exitCode, receipt.success, receipt.duration, receipt);
          continue;
        }
      }

      const interrupted = interruptedByRestart.has(agent.id);
      // The pid is written only after a successful spawn, so a record that never
      // got one never launched: "terminated unexpectedly" would point at a crash
      // when the cause is upstream, at spawn time. A recorded pid of 0 (Windows
      // ConPTY) is a process that did start.
      const neverStarted = agent.pid == null;
      const errorMessage = interrupted
        ? 'Agent was interrupted by a PortOS server restart'
        : neverStarted
          ? 'Agent never started — no process was ever launched (check the provider command and CoS Runner logs)'
          : 'Agent process terminated unexpectedly';
      console.log(interrupted
        ? `🛑 Recovering agent ${agent.id} interrupted by a PortOS restart (PID ${agent.pid || 'unknown'} not running)`
        : `🧹 Cleaning up orphaned agent ${agent.id} (${neverStarted ? 'no process was ever launched' : `PID ${agent.pid} not running`})`);
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
      const startedAt = Date.parse(agent.startedAt);
      // Same shared step list the post-restart recovery in agentLifecycle.js uses
      // (issue #8440) — output hook, sentinel removal, run-record close, agent
      // completion, in that order. A hard kill (`pm2 restart`, reboot) lands here,
      // so this is the path that leaves dirt in a managed app repo if any of it
      // is skipped.
      const { retireDeadAgent } = await import('./agentFinalization.js');
      const retirement = await retireDeadAgent({
        agent,
        task,
        success: false,
        exitCode: interrupted ? 143 : 1,
        duration: Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : 0,
        errorMessage,
        category: interrupted ? 'interrupted' : 'orphaned',
        // Post-mortem telemetry on the agent record (nothing reads it yet — the
        // human-visible distinction is the `error` string above). Worth persisting
        // because an infrastructure interruption and a real agent fault are
        // indistinguishable from the process's point of view once the record is
        // written. Kept off the shared `retireDeadAgent` shape since the
        // post-restart path has no equivalent fact to report.
        agentResultExtra: { interruptedByRestart: interrupted },
      });
      cleanedCount++;
      retiredAgentIds.push(agent.id);

      if (agent.taskId && !retirement.deliveryHeld) {
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

  // Same release order as a normal completion (agentLifecycle): only after the
  // run is retired, its worktree cleaned and its task settled. Without it the
  // reservation outlives the process and every later status read parses it.
  // finishResource reads the journal synchronously and throws while it needs
  // recovery; that must not abort the marker clear and stranded-agent sweep below.
  for (const agentId of retiredAgentIds) await releaseAgentReservation(agentId);
  // Backstop for reservations a previous process leaked on any other exit path.
  // Sweep-start snapshot plus what this sweep retired: `completed` is terminal and a
  // dead owner pid cannot belong to an agent spawned meanwhile, so no re-read is needed.
  const retired = new Set(retiredAgentIds);
  await reconcileStaleAgentReservations({ agents: agents.map(a => retired.has(a.id) ? { ...a, status: 'completed' } : a) });
  // Same sweep, different kinds: publication residue is stamped, and only a
  // cli-run or mind-turn whose owning record proves completion is released.
  reconcileDeadOwnerReservations();

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
 * @param {boolean} [options.providerStopped] - the runner killed the provider on a usage-limit / auth signal,
 *   so an existing commit must not be read as the task having finished.
 */
export async function handleOrphanedTask(taskId, agentId, getTaskByIdFn, { agentMetadata = null, agentStartedAt = null, interrupted = null, providerStopped = false } = {}) {
  // Callers that watched the agent die (the orphan sweep, which reads the
  // host-shutdown marker) say so explicitly. The ones that didn't —
  // `resetOrphanedTasks`, post-restart completion recovery — fall back to the
  // breadcrumb the abandon path stamped on the agent itself, so an interrupted
  // run is still recognized no matter which recovery path reaches it first.
  // Without this, correctness depended on `cleanupOrphanedAgents` happening to
  // run before `resetOrphanedTasks` in cos.js's boot sequence.
  const wasInterrupted = interrupted ?? (agentMetadata?.interruptedBy === HOST_SHUTDOWN_REASON);
  const task = await getTaskByIdFn(taskId).catch(() => null);
  if (!task) {
    emitLog('warn', `Could not find task ${taskId} for orphaned agent ${agentId}`, { taskId, agentId });
    return;
  }

  if (isDeliveryCleanupHeld(task.metadata)) return;
  const ctx = { taskId, agentId, task, agentMetadata, agentStartedAt };
  const guard = classifyOrphanGuard(task, agentMetadata);
  // Retrying is this run's to grant only while it is still the task's latest
  // dispatch; a superseded or receipt-less run leaves the task and its checkout.
  if ((!guard || guard === 'retry-held') && (!agentStartedAt
    || !matchesLatestTaskDispatch({ taskId, metadata: agentMetadata }, task))) {
    emitLog('warn', `Holding orphaned task ${taskId}: agent ${agentId} is not its latest dispatch; inspect its checkout and reset its spawn budget to run it again`, { taskId, agentId });
    return;
  }
  await consumeInterruptedBreadcrumb(agentId, agentMetadata, wasInterrupted);
  if (isPrivateSecurityTask({ metadata: agentMetadata })) await removePrivateSecurityScratch(agentId);

  if (guard) return ORPHAN_GUARD_HANDLERS[guard](ctx);
  // A release coordinator runs in a shared checkout and a commit alone cannot
  // prove publication and synchronization. Preserve its same-task recovery.
  const releaseTask = agentMetadata?.taskAnalysisType === 'do-release'
    || currentTaskTypeName(task.metadata?.analysisType || task.metadata?.selfImprovementType) === 'do-release';
  if (!releaseTask && !providerStopped && await completeIfCommitted(ctx)) return;

  const decision = decideOrphanRetry({ task, wasInterrupted, now: Date.now() });
  await applyOrphanDecision(ctx, decision);
}

/**
 * Consume the interrupted breadcrumb the moment it's honored, exactly as the
 * marker is consumed after the sweep. It is written once and would otherwise stay
 * on the agent record forever: `resetOrphanedTasks` keys on the most recent agent
 * per task, so a respawn that dies before creating its own agent record would keep
 * re-deriving `wasInterrupted` from this same stale breadcrumb — and, because an
 * interrupted run bypasses the cooldown, respawn on EVERY 15-minute sweep instead
 * of once per 30 minutes.
 */
async function consumeInterruptedBreadcrumb(agentId, agentMetadata, wasInterrupted) {
  if (!wasInterrupted || agentMetadata?.interruptedBy !== HOST_SHUTDOWN_REASON) return;
  await updateAgent(agentId, { metadata: { interruptedBy: null } })
    .catch(err => emitLog('warn', `Could not clear interrupted breadcrumb on ${agentId}: ${err.message}`, { agentId }));
}

async function removePrivateSecurityScratch(agentId) {
  const { privateSecurityScratchCwd } = await import('../../lib/privateSecuritySandbox.js');
  await rm(privateSecurityScratchCwd(agentId), { recursive: true, force: true });
}

function skipTerminalBlockedOrphan({ taskId, agentId, task }) {
  emitLog('info', `⏭️ Skipping orphaned task ${taskId} — ${task.metadata.blockedCategory}`, { taskId, agentId });
}

function skipHandledOrphan({ taskId, agentId, task }) {
  const { blockedCategory } = task.metadata;
  emitLog('info', `⏭️ Skipping orphaned task ${taskId} — already handled (${blockedCategory})`, { taskId, agentId, blockedCategory });
}

async function stampOrphanVerdict(taskUpdate, task, outcome) {
  const { stampLiExecutionVerdict } = await import('./agentFinalization.js');
  return stampLiExecutionVerdict(taskUpdate, task, outcome);
}

function skipCompletedOrphan({ taskId, agentId }) {
  emitLog('debug', `⏭️ Skipping orphaned task ${taskId} — already completed`, { taskId, agentId });
}

async function recoverPrivateSecurityOrphan({ taskId, agentId, task }) {
  if (task.status === 'completed') return;
  await removePrivateSecurityScratch(agentId);
  const taskUpdate = await stampOrphanVerdict({ status: 'blocked', metadata: { ...task.metadata,
    blockedAt: new Date().toISOString(), blockedCategory: 'private-security-assessment-failed',
    blockedReason: 'Private assessment was interrupted. Inspect its local output and explicitly rerun it; no automatic investigation or provider fallback will run.',
  } }, task, { success: false });
  await updateTask(taskId, taskUpdate, task.taskType || 'user');
}

async function recoverRefusedOrphan({ taskId, task, agentMetadata, agentStartedAt }) {
  const interruption = agentMetadata.executionInterruption;
  // Do not let an older refused run block a newer invocation.
  const startedAt = toEpochMs(agentStartedAt);
  if (startedAt && toEpochMs(task.metadata?.[LAST_SPAWNED_AT_KEY]) > startedAt) return;
  await updateTask(taskId, await stampOrphanVerdict({ status: 'blocked', metadata: {
    ...task.metadata, ...clearedRetryHoldMetadata(), executionInterruption: interruption,
    blockedAt: new Date().toISOString(), blockedCategory: interruption.category,
    blockedReason: 'Provider safety refusal; automatic continuation, retries and provider fallback are disabled.',
  } }, task, { success: false }), task.taskType || 'user');
}

async function recoverDeepAuditOrphan({ taskId, agentId, task, agentMetadata, agentStartedAt }) {
  if (task.status !== 'in_progress') return;
  const held = isRetryHeld(task.metadata);
  if (held && task.metadata[RETRY_HOLD_KEY] !== agentId) return;
  if (!held) {
    const spawnedAt = toEpochMs(task.metadata?.[LAST_SPAWNED_AT_KEY]);
    const startedAt = toEpochMs(agentStartedAt);
    // A legacy/unknown owner cannot authorize parking a newer invocation.
    if (!spawnedAt || !startedAt || spawnedAt > startedAt) return;
    const agents = await getAgents();
    if (!Array.isArray(agents) || agents.some(entry => entry.taskId === taskId && entry.id !== agentId
      && (entry.status === 'running' || toEpochMs(entry.startedAt) > startedAt))) return;
  }
  const resumePatch = await resolveTaskResumePatch({ task, agentId, agentMetadata });
  await updateTask(taskId, { status: 'blocked', metadata: {
    ...resumePatch, ...clearedRetryHoldMetadata(), blockedCategory: 'deep-audit-partial',
    blockedReason: 'Interrupted Deep audit; inspect checkpoint and resume explicitly', blockedAt: new Date().toISOString(),
  } }, task.taskType || 'user', { expectedStatus: 'in_progress',
    expectedMetadata: held ? { [RETRY_HOLD_KEY]: agentId } : { [LAST_SPAWNED_AT_KEY]: task.metadata[LAST_SPAWNED_AT_KEY] },
  });
}

/**
 * The run's verdict is already persisted — it failed, and was budgeted a retry —
 * so this is not a fresh orphan: finish the transition the dead process started
 * (resolve the pointer, flip to `pending`, drop the marker) rather than charging
 * it orphan budget for a decision already made. Precedes the commit check: a failed
 * run that committed is exactly the case the resume pointer exists for, and
 * completing the task on that evidence would discard the retry finalizeAgent granted.
 */
async function recoverRetryHeldOrphan({ taskId, agentId, task, agentMetadata, agentStartedAt }) {
  const resumePatch = await resolveTaskResumePatch({ task, agentId, agentMetadata }).catch(err => {
    emitLog('warn', `Resume pointer for held task ${taskId} could not be resolved: ${err.message}`, { taskId, agentId });
    return {};
  });
  const targetBranch = resolveTaskTargetBranch(resumePatch);
  const result = await updateTask(taskId, {
    status: 'pending',
    metadata: { ...resumePatch, ...clearedRetryHoldMetadata() }
  }, task.taskType || 'user', {
    expectedStatus: 'in_progress', expectedMetadata: { [RETRY_HOLD_KEY]: task.metadata[RETRY_HOLD_KEY] },
    expectedTask: { description: task.description, priority: task.priority, metadata: task.metadata },
    recoveryOwner: { id: agentId, startedAt: agentStartedAt },
  });
  if (result?.error) {
    emitLog('error', `Interrupted retry transition for task ${taskId} failed: ${result.error}`, { taskId, agentId });
    return;
  }
  if (result?.statusChanged) return;
  emitLog('info', `🔓 Completed interrupted retry transition for task ${taskId}${targetBranch ? ` — resuming ${targetBranch}` : ''}`, {
    taskId, agentId, branchName: targetBranch
  });
}

// One handler per `ORPHAN_GUARDS` reason; the precedence lives in that list.
const ORPHAN_GUARD_HANDLERS = {
  'terminal-block': skipTerminalBlockedOrphan,
  'private-security': recoverPrivateSecurityOrphan,
  'already-handled': skipHandledOrphan,
  'completed': skipCompletedOrphan,
  'content-refusal': recoverRefusedOrphan,
  'deep-audit': recoverDeepAuditOrphan,
  'retry-held': recoverRetryHeldOrphan,
};
for (const { reason } of ORPHAN_GUARDS) {
  if (!ORPHAN_GUARD_HANDLERS[reason]) throw new Error(`No orphan recovery handler for guard "${reason}"`);
}

/**
 * Did the agent actually commit work before it died? Scoped to the dead run's OWN
 * window (#3637): the retired task-id commit marker was never emitted by anything,
 * and an unbounded `git log` would credit this task with any commit in the repo —
 * including another agent's. `toEpochMs` accepts both shapes the agent record can
 * carry (the persisted ISO string and a raw epoch-ms number); without a start time
 * the probe is skipped.
 */
async function completeIfCommitted({ taskId, agentId, task, agentMetadata, agentStartedAt }) {
  const runStartedAt = toEpochMs(agentStartedAt);
  const commitFound = Number.isFinite(runStartedAt)
    && await committedDuringRun(agentMetadata?.workspacePath || ROOT_DIR, runStartedAt);
  if (!commitFound) return false;
  emitLog('info', `✅ Orphaned agent ${agentId} actually completed work - commit found for task ${taskId}`, { taskId, agentId });
  const taskUpdate = await stampOrphanVerdict({ status: 'completed' }, task, { success: true });
  await updateTask(taskId, taskUpdate, task.taskType || 'user', {
    expectedStatus: task.status, expectedTask: { description: task.description, priority: task.priority, metadata: task.metadata },
    recoveryOwner: { id: agentId, startedAt: agentStartedAt },
  });
  // A competing owner or edit owns the task; do not fall through to a retry.
  return true;
}

function logOrphanDecision(taskId, decision) {
  const { outcome, interrupted, retryCount, totalSpawns, cooldownMinutes, reason } = decision;
  if (outcome === 'requeue') {
    emitLog('info', interrupted
      ? `Resuming task ${taskId} interrupted by a PortOS restart (no retry charged; total spawns ${totalSpawns}/${MAX_TOTAL_SPAWNS})`
      : `Resetting orphaned task ${taskId} for retry (attempt ${retryCount}/${MAX_ORPHAN_RETRIES}, total spawns ${totalSpawns}/${MAX_TOTAL_SPAWNS})`, {
      taskId, retryCount, totalSpawns, interrupted, maxRetries: MAX_ORPHAN_RETRIES
    });
  } else if (outcome === 'cooldown') {
    emitLog('info', `⏳ Orphan retry for task ${taskId} in cooldown (${cooldownMinutes}m remaining)`, { taskId, cooldownMinutes, retryCount });
  } else {
    emitLog('warn', `Task ${taskId} blocked: ${reason}, creating investigation task`, { taskId, retryCount, totalSpawns });
  }
}

/** Persist the retry decision: requeue, orphan-cooldown block, or max-retries block + investigation. */
async function applyOrphanDecision({ taskId, agentId, task, agentMetadata, agentStartedAt }, decision) {
  const requeue = decision.outcome === 'requeue';
  // Point the retry at whatever the dead run left behind — its branch, or the
  // whole worktree when the process died mid-edit and the uncommitted work is
  // still sitting in it. Folded into THIS write rather than stamped separately
  // beforehand: the flip to `pending` emits `tasks:changed`, which can spawn the
  // retry immediately, so a pointer written afterwards could land too late.
  // Release retries check live Git/GitHub activity before reserving a fresh candidate.
  const resumePatch = requeue
    ? await resolveTaskResumePatch({ task, agentId, agentMetadata }).catch(err => {
      emitLog(err.recoveryReason ? 'info' : 'warn', `Resume pointer for task ${taskId} could not be resolved: ${err.message}`, { taskId, agentId });
      return {};
    })
    : {};
  const outcome = buildOrphanOutcome({ decision, task, agentId, now: Date.now(), resumePatch });
  logOrphanDecision(taskId, decision);
  const taskUpdate = requeue ? outcome : await stampOrphanVerdict(outcome, task, { success: false });
  const saved = await updateTask(taskId, taskUpdate, task.taskType || 'user', {
    expectedStatus: task.status, expectedTask: { description: task.description, priority: task.priority, metadata: task.metadata },
    recoveryOwner: { id: agentId, startedAt: agentStartedAt },
    ...(requeue && decision.interrupted ? { spawnBudgetOperation: { kind: 'reset' } } : {}),
  });
  if (!saved?.error && !saved?.statusChanged && decision.outcome === 'blocked') await fileOrphanInvestigation({ taskId, agentId, task, decision });
}

async function fileOrphanInvestigation({ taskId, agentId, task, decision }) {
  const { retryCount, totalSpawns, reason } = decision;
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
