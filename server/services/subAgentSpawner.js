import { withBackupAssetPublication } from '../lib/backupSnapshotBoundary.js';
import { maintenance, isMaintenanceHold } from '../lib/maintenanceAdmission.js';
import { isHostShuttingDown } from '../lib/hostShutdown.js';
/**
 * Sub-Agent Spawner Service — the agent cluster's EVENT WIRING.
 *
 * Owns `initSpawner()`: the CoS Runner connection, the runner event handlers
 * (`agent:output` / `agent:completed` / `agents:orphaned` / `agent:error`), the
 * `task:ready` → spawn listener, run-directory
 * pruning, and the delayed orphan sweep. Nothing else.
 *
 * Not a barrel: consumers import `initSpawner` (`bootstrap.js`) and `loadSlashdoCommand` (CoS agent prompts) from
 * here and everything else from the module that defines it, or `agentOrchestrator.js` for a lifecycle transition.
 * Load the transition implementation only when a runner or task event requires it.
 *
 * NOTE: importing this module is side-effect-free — `initSpawner()` must be called explicitly (see
 * `server/index.js`), so test imports don't re-arm event listeners and timers on every suite.
 */

import { join } from 'path';
import { readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { emitLog, cosEvents } from './cos/cosEvents.js';
import { updateAgent } from './cos/cosAgentLifecycle.js';
import { initProviderStatus } from './provider/providerStatus.js';
import { onCosRunnerEvent, initCosRunnerConnection, isRunnerAvailable, isRunnerReachable } from './cos/cosRunnerClient.js';
import { PATHS, rmGuarded } from '../lib/fileUtils.js';
import { loadSlashdoFile } from '../lib/slashdoLoader.js';
import { getRunnerOutputBatcher, flushRunnerOutputBatcher } from './agent/agentRunnerOutputBatchers.js';
import { syncRunnerAgents } from './agent/agentRunnerSync.js';
import { cleanupOrphanedAgents } from './agent/agentManagement.js';
import { completeAgentRun } from './agent/agentRunTracking.js';
import { appendRunEvent } from './agent/agentRunEventLog.js';
import { activeAgents, dropRunnerAgent, runnerAgents, setUseRunner, useRunner } from './agent/agentState.js';
import { releaseAppReviewMarker } from './appActivity.js';
import { isUpdateInProgress } from './updateChecker.js';
import { loadState } from './cos/cosState.js';
import { acquireLocalEndpointSpawnSlot } from './cos/cosLocalEndpointSlots.js';
import { checkoutOwnerHoldReason } from './checkoutOwnership.js';
import { acquireCosGlobalSlot } from './cos/cosAdmissionReservations.js';
import { releaseAgentReservation } from './agent/agentMaintenanceReservations.js';
import { parseRunnerSecurityScanEvidence } from '../lib/securityScanEvidence.js';

const RUNS_DIR = PATHS.runs;

// Coalesce reconnect storms (a crash-looping runner) into one dequeue.
const RECONNECT_DEQUEUE_DEBOUNCE_MS = 1000;
let reconnectDequeueTimer = null;
// In-flight runner reconciliation, awaited by the reconnect dequeue so held tasks resume against a settled
// `runnerAgents` map.
let runnerRecovery = Promise.resolve();

const HOST_SHUTDOWN_HOLD = 'PortOS is shutting down';

/**
 * Decline a `task:ready` dispatch WITHOUT failing the task.
 *
 * The task record is left untouched (still `pending`), so the next dequeue tick picks it up once `reason` clears:
 * no status write, no retry charged. What must still be undone is the state the emitter bound for a spawn:
 *
 *   - the synthetic app-review marker, or the app reads "in review" for the whole outage;
 *   - `spawningJobIds` for a scheduled job, cleared by `job:spawn-failed` (which also re-registers the cron
 *     schedule), or the job sits wedged until the scheduler's 5-minute spawn timeout.
 *
 * Shared by every hold condition so a new one can't ship with only half the releases.
 */
async function holdTask(task, reason) {
  emitLog('debug', `⏸️ Holding task ${task.id} — ${reason}`, { taskId: task.id });
  await releaseAppReviewMarker(task.metadata?.app).catch(err =>
    emitLog('warn', `Failed to release app review marker for ${task.metadata?.app}: ${err.message}`, { taskId: task.id })
  );
  if (task.metadata?.jobId) {
    cosEvents.emit('job:spawn-failed', { jobId: task.metadata.jobId, reason: 'held' });
  }
  // Unpersisted tasks (feature-agent runs) hold a pending pointer that only a
  // lifecycle event clears; a held dispatch emits none of the usual ones.
  cosEvents.emit('task:held', { taskId: task.id, reason });
}

/**
 * Adopt agents the runner is already driving that this process does not own.
 *
 * Runs on both edges that can find a live runner with pre-existing agents: the boot seed (agents that outlived a
 * `portos-server` restart) and a mid-life promotion. Agents this process spawned DIRECTLY are never adopted
 * (`syncRunnerAgents` skips anything `isAgentOwnedLocally` claims); they complete via their own close handler.
 */
async function recoverRunnerAgents() {
  const synced = await syncRunnerAgents().catch(err => {
    console.error(`❌ Failed to sync runner agents: ${err.message}`);
    return 0;
  });
  if (synced > 0) console.log(`🔄 Recovered ${synced} agents from CoS Runner`);
}

/**
 * Load a slashdo command from the bundled submodule, resolving !`cat` lib includes inline.
 */
export async function loadSlashdoCommand(commandName) {
  const content = await loadSlashdoFile(commandName);
  if (content) console.log(`📋 Loaded slashdo command: do:${commandName}`);
  return content;
}

// Memoized init promise (init is an explicit call). A shared promise makes the call idempotent AND safe under a
// concurrent second caller: both await the same in-flight init and see "ready" only once the `task:ready`
// listener + orphan timer are wired, which a boolean-at-entry guard wouldn't guarantee. Reset to null on failure
// so a later call can retry.
let spawnerInitPromise = null;

/**
 * Dispatch a ready task — the single chokepoint every `task:ready` emitter funnels through.
 *
 * A named function so the registration can attach a `.catch`: `cosEvents` is a plain `EventEmitter` that neither
 * awaits nor catches an async listener, so the awaits ahead of the `try` below would otherwise escape as an
 * unhandled rejection and silently leave a queued task undispatched.
 */
async function handleTaskReady(task) {
  // The on-demand generator normally clears approval for a user-triggered Run, but a task type can retain a
    // non-bypassable approval marker (e.g. a public review that would let a later coordinator act on external PRs).
    // Checked at the shared chokepoint so every emitter honors it.
  if (task?.approvalRequired === true) {
    return holdTask(task, 'task requires approval');
  }
  // ── HOLDS, at the one chokepoint all `task:ready` emitters funnel through. Each leaves the task queued (no status
    // write, no retry charged) for a condition that clears on its own.
    //
    // Held HERE rather than inside `runAgentSpawn`: a hold below this line would return past
    // `releaseAppReviewMarker`, stranding the synthetic "in review" marker. The releases in `holdTask` are the same
    // ones the spawn body owns.
    //
    // 1. Self-update in progress. `/api/update/execute` refuses while an agent is live, but `update.sh` spends
    //    seconds in `git pull` / `npm install` before `pm2 delete`; an agent spawned in that window is severed by
    //    the restart. The flag reads synchronously, so nothing slips between check and spawn.
  if (maintenance.held()) return holdTask(task, 'maintenance is holding new work');
  // Host shutdown. An agent registered after the shutdown marker was snapshotted is charged as a genuine orphan
    // on the next boot. Rechecked just before the spawn, since the awaits below can straddle the signal.
  if (isHostShuttingDown()) return holdTask(task, HOST_SHUTDOWN_HOLD);
  if (isUpdateInProgress()) {
    return holdTask(task, 'a PortOS self-update is in progress');
  }
  // 2. Runner down. Dispatching into a stopped runner is not a task failure, but both spawn arms recorded it as
    //    one (retries walking every queued task into `blocked`, or an actionable `spawn-error` parking it for a
    //    human over an app the user turned off).
  if (useRunner && !(await isRunnerReachable())) {
    return holdTask(task, 'CoS Runner is down');
  }
  // 3. Forge unreachable, for a task that cannot finish without it. An agent promising a change request fails to
    //    push and finalizes non-actionable `forge-unreachable`, so each retry re-runs the whole agent against the
    //    same dead network. See cosForgeSpawnGate.js for the narrowings that keep a wrong hold from becoming a wedge.
  const { forgeSpawnHoldReason } = await import('./cos/cosForgeSpawnGate.js');
  const forgeHold = await forgeSpawnHoldReason(task);
  if (forgeHold) return holdTask(task, forgeHold);
  // 3b. Checkout recovery while the operator's own interactive agent session owns that checkout: every run could
    //     only report the same blocker.
  const ownerHold = await checkoutOwnerHoldReason(task);
  if (ownerHold) return holdTask(task, ownerHold);
  // 4. Global capacity. Reserve across the spawn window so direct persistent turns and ordinary agents cannot both
    //    pass a stale pre-registration snapshot.
  const capacityState = await loadState();
  const globalSlot = acquireCosGlobalSlot({
    agents: capacityState.agents,
    limit: capacityState.config?.maxConcurrentAgents,
    reservationId: task.id,
  });
  if (!globalSlot.ok) return holdTask(task, globalSlot.reason);

  // 5. Local inference endpoint at capacity. A CoS agent runs a vendor CLI with its own connection to the local
    //    model server, so promptRunner's in-flight gate never sees it; without this two agents can hit one GPU and
    //    OOM. Held HERE because `dequeueNextTask` is only one emitter (evaluateTasks, forceSpawnTask, the job
    //    scheduler and the Creative Director bridge reach this listener directly). The slot is reserved across the
    //    spawn window and released below, since the agent isn't countable until it reaches `running`.
  try {
    const localSlot = await acquireLocalEndpointSpawnSlot(task, capacityState.agents);
    if (!localSlot.ok) return holdTask(task, localSlot.reason);
    if (isHostShuttingDown()) return holdTask(task, HOST_SHUTDOWN_HOLD);
    try {
      const { spawnAgentForTask } = await import('./agent/agentOrchestrator.js');
      await spawnAgentForTask(task);
    } catch (err) {
      if (isMaintenanceHold(err)) return holdTask(task, err.message);
      emitLog('error', `Failed to spawn agent for task ${task.id}: ${err?.message || err}`, { taskId: task.id });
      const jobId = task.metadata?.jobId;
      if (jobId) {
        cosEvents.emit('job:spawn-failed', { jobId, reason: 'failed', error: err?.message || String(err) });
      }
      // Same task-level error contract as the workspace-prep failure path.
      cosEvents.emit('agent:error', { taskId: task.id, error: err?.message || String(err) });
    } finally {
      localSlot.release();
    }
  } finally {
    globalSlot.release();
  }
}

/**
 * Initialize the spawner — listen for task:ready events. Idempotent: repeated calls return the same promise (and
 * re-run only after a failed attempt).
 */
export function initSpawner() {
  if (!spawnerInitPromise) {
    spawnerInitPromise = runInitSpawner().catch(err => {
      spawnerInitPromise = null;
      throw err;
    });
  }
  return spawnerInitPromise;
}

async function runInitSpawner() {
  // Initialize provider status tracking
  await initProviderStatus().catch(err => {
    console.error(`⚠️ Failed to initialize provider status: ${err.message}`);
  });

  // Prune old run data (keep 30 days)
  if (existsSync(RUNS_DIR)) {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const entries = await readdir(RUNS_DIR, { withFileTypes: true }).catch(() => []);
    let pruned = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runDir = join(RUNS_DIR, entry.name);
      const dirStat = await stat(runDir).catch(() => null);
      if (dirStat && dirStat.mtime.getTime() < cutoff) {
        await withBackupAssetPublication(() => rmGuarded(runDir, { recursive: true })).catch(() => {});
        pruned++;
      }
    }
    if (pruned > 0) console.log(`🗑️ Pruned ${pruned} old run directories (>30 days)`);
  }

  // ── SPAWN MODE. Runner mode is NOT a boot-time verdict. The probe is only the COLD-START SEED: `portos-cos` is a
    // separate PM2 app that can come up after `portos-server`, and trusting one probe left this process in direct
    // mode for its lifetime (every agent a child of `portos-server`, dying with it). The socket reconnects forever
    // with capped backoff, so it is the standing authority on whether the runner is there.
  setUseRunner(await isRunnerAvailable());
  console.log(`🤖 Sub-agent spawner initialized (${useRunner ? 'using CoS Runner' : 'direct mode — CoS Runner not up yet'})`);

  initCosRunnerConnection();

  // Sync any agents that were running before server restart
  if (useRunner) await recoverRunnerAgents();

  // Runner liveness → the queue holds, then re-drives. In runner mode `portos-cos` owns every agent process, so
    // while it is down dispatch HOLDS tasks as `pending` rather than failing them. These two events are the
    // outage's edges: one warning when it goes, one dequeue when it returns, not a line per held task.
    //
    // The reconnect is debounced because `reconnectionAttempts` is unbounded: a crash-looping runner would drive one
    // full dequeue cycle per restart.
  onCosRunnerEvent('connection:lost', () => {
    // Deliberately NOT a demotion to direct mode: `useRunner` stays true so the dispatch gate keeps HOLDING tasks;
        // flipping it would convert every held task into a direct spawn (a child of `portos-server`, the orphaning
        // runner mode prevents). The outage clears on `connection:ready` below.
        //
        // Drop any armed reconnect dequeue: a drop inside the debounce window would otherwise announce "resuming" and
        // dequeue into a runner that is gone again. A reconnect re-arms it.
    clearTimeout(reconnectDequeueTimer);
    emitLog('info', '⏸️ CoS Runner disconnected — staying in runner mode, holding agent tasks until it returns');
  });

  onCosRunnerEvent('connection:ready', () => {
    // MID-LIFE PROMOTION: the runner came up after this server, so take over from the cold-start seed. Agents
        // already spawned directly are untouched: ownership is keyed by agent id (`isAgentOwnedLocally`), so their
        // close handlers still finalize them and the recovery sweep refuses to adopt them.
    if (!useRunner) {
      setUseRunner(true);
      // Through `emitLog` like the disconnect warning: both edges belong in the CoS log stream the UI reads.
      emitLog('info', '🔼 CoS Runner came up — promoting agent spawning from direct to runner mode');
    }
    // Refresh receipts even for locally owned agents after a brief socket gap.
    runnerRecovery = runnerRecovery.then(() => recoverRunnerAgents());
    clearTimeout(reconnectDequeueTimer);
    reconnectDequeueTimer = setTimeout(() => {
      // Resume only once reconciliation has settled, so the dequeue counts the agents the runner already drives.
            // `recoverRunnerAgents` swallows its own failures, so this never rejects on a timer callback.
      runnerRecovery
        .then(() => {
          emitLog('info', '▶️ CoS Runner reconnected — resuming held agent tasks');
          cosEvents.emit('cos:dequeue-requested');
        })
        .catch(err => console.error(`❌ Failed to resume held agent tasks: ${err.message}`));
    }, RECONNECT_DEQUEUE_DEBOUNCE_MS);
    reconnectDequeueTimer.unref?.();
  });

  // Runner event handlers are registered unconditionally: registering only when the boot probe succeeded left a
    // promoted process connected to a runner whose output nothing listened for.
    //
    // Nothing fires before a promotion: events arrive over a connected socket, and the `connect` that carries them
    // dispatches `connection:ready` first, so this process is in runner mode by then. A directly-spawned agent is
    // safe regardless: the per-agent handlers key off `runnerAgents`, which only `spawnViaRunner` populates.
  onCosRunnerEvent('agent:output', async (data) => {
    const { agentId, text } = data;
    // Drop output for an agent already finalized/removed. The runner registers the agent in `runnerAgents` before
        // spawning, so this never drops legitimate early output, only a stray post-completion event that would
        // create a never-drained batcher (Map leak).
    if (!runnerAgents.has(agentId)) return;
    getRunnerOutputBatcher(agentId).push(text);

    const agent = runnerAgents.get(agentId);
    // Once per run, on the first byte the runner forwards. Own flag rather than `hasStartedWorking`, which also
        // flips on a 3s no-output timeout; a run that never spoke must not get an output event.
    if (agent && !agent.firstOutputRecorded) {
      agent.firstOutputRecorded = true;
      await appendRunEvent({
        kind: 'run.output',
        runId: agent.runId ?? null,
        agentId,
        taskId: agent.taskId ?? null,
        eventId: `output:${agentId}:${agent.runId || 'no-run'}:first`,
        data: { source: 'runner', firstChunkChars: typeof text === 'string' ? text.length : null },
      });
    }

    // Update phase on first output
    if (agent && !agent.hasStartedWorking) {
      agent.hasStartedWorking = true;
      clearTimeout(agent.initializationTimeout);
      await updateAgent(agentId, { metadata: { phase: 'working' } });
      emitLog('info', `Agent ${agentId} working...`, { agentId, phase: 'working' });
    }
  });

  onCosRunnerEvent('agent:security-scan', async ({ agentId, evidence }) => {
    const { persistAgentSecurityScan } = await import('./agent/agentSecurityScan.js');
    const observed = parseRunnerSecurityScanEvidence(evidence);
    const refusal = observed?.status === 'refused' ? activeAgents.get(agentId)?.refuseScanner?.() : null;
    await Promise.all([refusal, persistAgentSecurityScan(agentId, evidence)]);
  });

  onCosRunnerEvent('agent:completed', async (data) => {
    const { agentId, exitCode, success, duration, fallbackAnalysis, finalSummary, rawStreamTail } = data;
    const agent = runnerAgents.get(agentId);
    // A runner-owned TUI is finalized by spawnTuiAgent while this server stays connected; only a TUI recovered into
        // runnerAgents after a restart should use the generic runner completion path. `syncRunnerAgents` must not adopt
        // an agent this process already owns (`isAgentOwnedLocally`), or this guard passes for a live TUI and
        // double-finalizes it; the sibling `agent:output` and `agent:error` handlers key off the same membership.
    if (!agent) return;
    clearTimeout(agent.initializationTimeout);
    // Drain pending output before completion so the final lines land in
    // state before handleAgentCompletion writes the terminal record.
    await flushRunnerOutputBatcher(agentId);
    const { handleAgentCompletion } = await import('./agent/agentLifecycle.js');
    await handleAgentCompletion(agentId, exitCode, success, duration, { fallbackAnalysis, finalSummary, rawStreamTail });
  });

  // Batch handler for orphaned agents (runner startup cleanup)
  onCosRunnerEvent('agents:orphaned', async (data) => {
    const { agents, count } = data;
    console.log(`🧹 Processing ${count} orphaned agents from runner`);
    for (const orphan of agents) {
      const agent = runnerAgents.get(orphan.agentId);
      if (agent) {
        clearTimeout(agent.initializationTimeout);
      }
      await flushRunnerOutputBatcher(orphan.agentId);
      const { handleAgentCompletion } = await import('./agent/agentLifecycle.js');
      await handleAgentCompletion(orphan.agentId, orphan.exitCode, orphan.success, 0, orphan);
    }
  });

  onCosRunnerEvent('agent:error', async (data) => {
    const { agentId, error } = data;
    console.error(`❌ Agent ${agentId} error from runner: ${error}`);
    cosEvents.emit('agent:error', { agentId, error });
    await flushRunnerOutputBatcher(agentId);
    const agent = runnerAgents.get(agentId);
    if (agent) {
      clearTimeout(agent.initializationTimeout);
      // Runner-level error before the run could produce work: no success criterion was evaluated, so validation is
            // the null sentinel, never a false that would look like a declared-and-failed run.
      const { completeAgent } = await import('./agent/agentOrchestrator.js');
      await completeAgent(agentId, { success: false, validationPassed: null, error });
      await releaseAgentReservation(agentId);
      await completeAgentRun(agent.runId, '', 1, 0, { message: error, category: 'runner-error' });
      dropRunnerAgent(agentId);
    }
  });

  // `cosEvents` does not await or catch a listener's promise, so the async body is wrapped (same reason as the
    // guarded orphan sweep below). `emitLog` rather than `console.error`: the CoS Logs tab is where an operator looks
    // for a task that never started.
    // The settled promise is RETURNED though EventEmitter discards it, so a test can `await` a dispatch.
  cosEvents.on('task:ready', (task) =>
    handleTaskReady(task).catch(err =>
      emitLog('error', `Task ${task?.id} could not be dispatched: ${err?.message || err}`, { taskId: task?.id })));

  // Clean up orphaned agents after a short delay (let other services finish init).
  // setTimeout runs outside the request lifecycle, so guard the async callback.
  setTimeout(() => {
    cleanupOrphanedAgents().catch(err => {
      console.error(`❌ Failed to clean up orphaned agents: ${err.message}`);
    });
  }, 2000);
}
