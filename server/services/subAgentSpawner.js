/**
 * Sub-Agent Spawner Service — the agent cluster's EVENT WIRING.
 *
 * Owns `initSpawner()`: the CoS Runner connection, the runner event handlers
 * (`agent:output` / `agent:completed` / `agents:orphaned` / `agent:error`), the
 * `task:ready` → spawn and `agent:terminate` → terminate listeners, run-directory
 * pruning, and the delayed orphan sweep. Nothing else.
 *
 * ## It is no longer a barrel (#3450)
 *
 * Until #3450 this file also re-exported ~40 symbols from nine sibling modules
 * "for backward compatibility" — a second, partial view of the cluster layered
 * over the `cosAgents.js` barrel (since retired too) and `cos.js`'s agent block,
 * including three process-layer transitions `agentOrchestrator.js` also owns.
 * Two barrels naming the same transition is how a caller ends up importing the
 * wrong one and the layering stops meaning anything. The re-exports are gone;
 * the surviving consumers of this module import `initSpawner` (`bootstrap.js`)
 * and `loadSlashdoCommand` (CoS agent prompts), and everything else now imports
 * the module that actually defines it — or, for a lifecycle transition,
 * `agentOrchestrator.js`.
 *
 * That is also why this module can take a static `agentOrchestrator.js` import
 * while the modules it wires cannot: with the barrel retired, nothing in the
 * facade's closure imports this file at all.
 *
 * NOTE: importing this module is side-effect-free — `initSpawner()` must be
 * called explicitly (see `server/index.js`). This keeps test imports from
 * re-arming the event listeners and timers on every suite.
 */

import { join } from 'path';
import { readdir, rm, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { emitLog, cosEvents } from './cosEvents.js';
import { updateAgent } from './cosAgentLifecycle.js';
import { initProviderStatus } from './providerStatus.js';
import { onCosRunnerEvent, initCosRunnerConnection, isRunnerAvailable, isRunnerReachable } from './cosRunnerClient.js';
import { PATHS } from '../lib/fileUtils.js';
import { loadSlashdoFile } from '../lib/slashdoLoader.js';
import { getRunnerOutputBatcher, flushRunnerOutputBatcher } from './agentRunnerOutputBatchers.js';
import { syncRunnerAgents } from './agentRunnerSync.js';
import { handleAgentCompletion } from './agentLifecycle.js';
import { cleanupOrphanedAgents } from './agentManagement.js';
import { completeAgentRun } from './agentRunTracking.js';
import { runnerAgents, setUseRunner, useRunner } from './agentState.js';
import { releaseAppReviewMarker } from './appActivity.js';
import { isUpdateInProgress } from './updateChecker.js';
// This module's own event wiring drives three LIFECYCLE TRANSITIONS, so it takes
// them from the facade rather than from the three separate leaves that happen to
// implement them (#3450). It can: nothing the facade imports imports this module
// back, so the edge stays one-directional.
import { completeAgent, spawnAgentForTask, terminateAgent } from './agentOrchestrator.js';

const RUNS_DIR = PATHS.runs;

// Coalesce reconnect storms (a crash-looping runner) into one dequeue.
const RECONNECT_DEQUEUE_DEBOUNCE_MS = 1000;
let reconnectDequeueTimer = null;
// In-flight runner reconciliation, awaited by the reconnect dequeue so held
// tasks resume against a settled `runnerAgents` map — the ordering the boot
// path gets for free by awaiting recovery before it wires anything.
let runnerRecovery = Promise.resolve();

/**
 * Decline a `task:ready` dispatch WITHOUT failing the task.
 *
 * The task record is left untouched (still `pending`), so the next dequeue tick
 * picks it up once `reason` clears — no status write, no retry charged, no
 * `blocked` walk. What must still be undone is the state the emitter bound in
 * anticipation of a spawn:
 *
 *   - the synthetic app-review marker, or the app reads "in review" for the
 *     whole outage (issue #989);
 *   - `spawningJobIds` for a scheduled job, cleared by `job:spawn-failed`,
 *     which also re-registers the cron schedule. Without it an autonomous job
 *     sits wedged until the scheduler's 5-minute spawn timeout — per job, per
 *     outage.
 *
 * Shared by both hold conditions (self-update in progress, runner down) so a
 * third one can't ship with only half the releases.
 */
async function holdTask(task, reason) {
  emitLog('debug', `⏸️ Holding task ${task.id} — ${reason}`, { taskId: task.id });
  await releaseAppReviewMarker(task.metadata?.app).catch(err =>
    emitLog('warn', `Failed to release app review marker for ${task.metadata?.app}: ${err.message}`, { taskId: task.id })
  );
  if (task.metadata?.jobId) {
    cosEvents.emit('job:spawn-failed', { jobId: task.metadata.jobId });
  }
}

/**
 * Adopt agents the runner is already driving that this process does not own.
 *
 * Runs on both edges that can find a live runner with pre-existing agents: the
 * boot seed (agents that outlived a `portos-server` restart) and a mid-life
 * promotion (a runner that was already up before this server took over). Agents
 * this process spawned DIRECTLY are never adopted — `syncRunnerAgents` skips
 * anything `isAgentOwnedLocally` claims, so they keep completing through their
 * own child-process close handler.
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

// Memoized init promise. Module import is side-effect-free now, so init is an
// explicit call (server/index.js). Returning a shared promise makes the call
// idempotent AND safe under a concurrent second caller: both await the same
// in-flight init and only observe "ready" once the `task:ready` listener +
// orphan timer are actually wired — a plain boolean-at-entry guard would let a
// concurrent caller return early before that. Reset to null on failure so a
// later call can retry instead of being stuck on a half-initialized spawner.
let spawnerInitPromise = null;

/**
 * Initialize the spawner — listen for task:ready events. Idempotent: repeated
 * calls return the same promise (and re-run only after a failed attempt).
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
        await rm(runDir, { recursive: true }).catch(() => {});
        pruned++;
      }
    }
    if (pruned > 0) console.log(`🗑️ Pruned ${pruned} old run directories (>30 days)`);
  }

  // ── SPAWN MODE. Runner mode is NOT a boot-time verdict (issue #4134).
  //
  // The probe is only the COLD-START SEED, for the window before the socket's
  // first `connect` lands: `portos-cos` is a separate PM2 app that can come up
  // after `portos-server`, and treating one probe as the answer left this
  // process in direct mode for its whole lifetime — every agent a child of
  // `portos-server`, dying with it, which is the exact orphaning runner mode
  // exists to prevent. The socket reconnects forever with capped backoff, so it,
  // not the probe, is the standing authority on whether the runner is there.
  setUseRunner(await isRunnerAvailable());
  console.log(`🤖 Sub-agent spawner initialized (${useRunner ? 'using CoS Runner' : 'direct mode — CoS Runner not up yet'})`);

  initCosRunnerConnection();

  // Sync any agents that were running before server restart
  if (useRunner) await recoverRunnerAgents();

  // Runner liveness → the queue holds, then re-drives. `portos-cos` is a
  // separate PM2 app the user can stop, and in runner mode it owns every agent
  // process — so while it is down, dispatch HOLDS tasks as `pending` (see the
  // `task:ready` listener below and `dequeueNextTask`'s gate) rather than
  // failing them. These two events are the outage's edges: one warning when it
  // goes, one dequeue when it returns, instead of a line per held task.
  //
  // The reconnect is debounced because `reconnectionAttempts` is unbounded: a
  // crash-looping runner would otherwise drive one full five-tier dequeue
  // cycle per restart.
  onCosRunnerEvent('connection:lost', () => {
    // Deliberately NOT a demotion back to direct mode. `useRunner` stays true so
    // the dispatch gate keeps HOLDING tasks as `pending`; flipping it to false
    // here would silently convert every held task into a direct spawn — a child
    // of `portos-server` again — which is the orphaning runner mode exists to
    // prevent. The outage is a hold; it clears on `connection:ready` below.
    //
    // Drop any armed reconnect dequeue: a drop inside the debounce window would
    // otherwise still announce "resuming held agent tasks" and drive a dequeue
    // cycle into a runner that is gone again. A reconnect re-arms it.
    clearTimeout(reconnectDequeueTimer);
    emitLog('warn', '⏸️ CoS Runner disconnected — staying in runner mode, holding agent tasks until it returns');
  });

  onCosRunnerEvent('connection:ready', () => {
    // MID-LIFE PROMOTION (#4134): the runner came up after this server did, so
    // take over from the cold-start seed. Agents already spawned directly are
    // untouched — ownership is keyed by agent id in both maps
    // (`isAgentOwnedLocally`), so their close handlers still finalize them and
    // the recovery sweep below refuses to adopt them.
    if (!useRunner) {
      setUseRunner(true);
      // Through `emitLog`, like the disconnect warning above: both edges belong
      // in the CoS log stream the UI reads, or a remote install sees the outage
      // reported and never its resolution.
      emitLog('info', '🔼 CoS Runner came up — promoting agent spawning from direct to runner mode');
      runnerRecovery = recoverRunnerAgents();
    }
    clearTimeout(reconnectDequeueTimer);
    reconnectDequeueTimer = setTimeout(() => {
      // Resume only once reconciliation has settled, so the dequeue counts the
      // agents the runner was already driving. `recoverRunnerAgents` swallows
      // its own failures, so this never rejects — which matters here, on a timer
      // callback outside any request lifecycle.
      runnerRecovery
        .then(() => {
          emitLog('info', '▶️ CoS Runner reconnected — resuming held agent tasks');
          cosEvents.emit('cos:dequeue-requested');
        })
        .catch(err => console.error(`❌ Failed to resume held agent tasks: ${err.message}`));
    }, RECONNECT_DEQUEUE_DEBOUNCE_MS);
    reconnectDequeueTimer.unref?.();
  });

  // Runner event handlers are registered unconditionally. Registering them only
  // when the boot probe succeeded left a promoted process connected to a runner
  // whose output and completions nothing was listening for.
  //
  // Nothing fires before a promotion: these events only arrive over a connected
  // socket, and the `connect` that carries them dispatches `connection:ready`
  // first (same handler in `cosRunnerClient`), so this process is already in
  // runner mode by the time any of them lands. A directly-spawned agent is safe
  // regardless — the three per-agent handlers key off `runnerAgents`, which only
  // `spawnViaRunner` populates.
  onCosRunnerEvent('agent:output', async (data) => {
    const { agentId, text } = data;
    // Drop output for an agent that's already finalized/removed. The runner
    // registers the agent in `runnerAgents` before it spawns the process
    // (agentLifecycle spawnViaRunner), so this never drops legitimate early
    // output — it only ignores a stray event arriving after completion, which
    // would otherwise lazily create a never-drained batcher (Map leak).
    if (!runnerAgents.has(agentId)) return;
    getRunnerOutputBatcher(agentId).push(text);

    // Update phase on first output
    const agent = runnerAgents.get(agentId);
    if (agent && !agent.hasStartedWorking) {
      agent.hasStartedWorking = true;
      clearTimeout(agent.initializationTimeout);
      await updateAgent(agentId, { metadata: { phase: 'working' } });
      emitLog('info', `Agent ${agentId} working...`, { agentId, phase: 'working' });
    }
  });

  onCosRunnerEvent('agent:completed', async (data) => {
    const { agentId, exitCode, success, duration } = data;
    const agent = runnerAgents.get(agentId);
    // A runner-owned TUI is finalized by spawnTuiAgent while this server
    // remains connected. Only a TUI recovered into runnerAgents after a
    // server restart should use the generic runner completion path.
    // That invariant is upheld elsewhere — `syncRunnerAgents` must not adopt an
    // agent this process already owns (see `isAgentOwnedLocally`). When it did,
    // this guard passed for a live TUI and double-finalized it; the sibling
    // `agent:output` and `agent:error` handlers key off the same membership.
    if (!agent) return;
    clearTimeout(agent.initializationTimeout);
    // Drain pending output before completion so the final lines land in
    // state before handleAgentCompletion writes the terminal record.
    await flushRunnerOutputBatcher(agentId);
    await handleAgentCompletion(agentId, exitCode, success, duration);
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
      await handleAgentCompletion(orphan.agentId, orphan.exitCode, orphan.success, 0);
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
      // Runner-level error before the run could produce work — no success
      // criterion was evaluated, so validation is the null sentinel (issue
      // #2344), never a false that would look like a declared-and-failed run.
      await completeAgent(agentId, { success: false, validationPassed: null, error });
      await completeAgentRun(agent.runId, '', 1, 0, { message: error, category: 'runner-error' });
      runnerAgents.delete(agentId);
    }
  });

  cosEvents.on('task:ready', async (task) => {
    // ── HOLDS, at the one chokepoint all seven `task:ready` emitters funnel
    // through. Both leave the task queued (no status write, no retry charged)
    // for a condition that clears on its own.
    //
    // Held HERE rather than inside `runAgentSpawn`: a hold below this line would
    // return past `releaseAppReviewMarker`, stranding the synthetic "in review"
    // marker for the whole outage — issue #989's exact failure mode. The
    // releases in `holdTask` are the same ones the spawn body owns.
    //
    // 1. Self-update in progress (issue #4124). `/api/update/execute` refuses to
    //    start while an agent is live, but `update.sh` then spends multiple
    //    seconds in `git pull` / submodule update / `npm install` before it
    //    reaches `pm2 delete` — an agent spawned inside that window is severed
    //    by the restart (its PTY/child process is a child of this server). The
    //    flag reads synchronously, so nothing can slip between the check and the
    //    spawn; the task runs on the other side of the restart.
    if (isUpdateInProgress()) {
      return holdTask(task, 'a PortOS self-update is in progress');
    }
    // 2. Runner down. Dispatching into a stopped runner is not a task failure,
    //    but both spawn arms recorded it as one: the CLI arm finalized
    //    `spawn-rejected` (a retry each time, so a runner left off overnight
    //    walked every queued task through its retry budget into `blocked`), and
    //    the TUI arm threw into the actionable `spawn-error`, parking the task
    //    for a human over an app the user simply turned off.
    if (useRunner && !(await isRunnerReachable())) {
      return holdTask(task, 'CoS Runner is down');
    }
    try {
      await spawnAgentForTask(task);
    } catch (err) {
      emitLog('error', `Failed to spawn agent for task ${task.id}: ${err?.message || err}`, { taskId: task.id });
      const jobId = task.metadata?.jobId;
      if (jobId) {
        cosEvents.emit('job:spawn-failed', { jobId });
      }
    }
  });

  cosEvents.on('agent:terminate', async (agentId) => {
    await terminateAgent(agentId);
  });

  // Clean up orphaned agents after a short delay (let other services finish init).
  // setTimeout runs outside the request lifecycle, so guard the async callback.
  setTimeout(() => {
    cleanupOrphanedAgents().catch(err => {
      console.error(`❌ Failed to clean up orphaned agents: ${err.message}`);
    });
  }, 2000);
}
