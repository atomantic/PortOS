/**
 * Sub-Agent Spawner Service
 *
 * Orchestrator module: imports from focused sub-modules and re-exports
 * everything for backward compatibility. Owns the explicit `initSpawner()`
 * entry point (event wiring + orphan cleanup) and shared state references.
 *
 * NOTE: importing this module is side-effect-free — `initSpawner()` must be
 * called explicitly (see `server/index.js`). This keeps test imports from
 * re-arming the event listeners and timers on every suite.
 */

import { join } from 'path';
import { readFile, readdir, rm, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { emitLog, cosEvents } from './cosEvents.js';
import { createAgentOutputBatcher, updateAgent, completeAgent } from './cosAgents.js';
import { initProviderStatus } from './providerStatus.js';
import { onCosRunnerEvent, initCosRunnerConnection, isRunnerAvailable } from './cosRunnerClient.js';
import { ensureDir, loadSlashdoFile, PATHS } from '../lib/fileUtils.js';

// ─── Shared state (imported from agentState.js) ──────────────────────────────
export { activeAgents, runnerAgents, userTerminatedAgents, spawningTasks, useRunner, isTruthyMeta, isFalsyMeta, getActiveAgentIds } from './agentState.js';
import { runnerAgents, setUseRunner } from './agentState.js';

// ─── Sub-module re-exports ────────────────────────────────────────────────────
export { selectModelForTask } from './agentModelSelection.js';
export { createAgentRun, completeAgentRun, checkForTaskCommit, extractErrorFromOutput } from './agentRunTracking.js';
export { ERROR_PATTERNS, analyzeAgentFailure, createInvestigationTask, API_ACCESS_ERROR_CATEGORIES, maybeCreateInvestigationTask, resolveFailedTaskUpdate, MAX_TASK_RETRIES } from './agentErrorAnalysis.js';
export { buildAgentPrompt, getAppWorkspace, getAppDataForTask, generateJiraTitle, createJiraTicketForTask, getClaudeMdContext, buildCompactionSection, detectSkillTemplate, loadSkillTemplate } from './agentPromptBuilder.js';
export { spawnDirectly, createStreamJsonParser, summarizeToolInput, safeParse, buildCliSpawnConfig, isClaudeCliProvider, isTuiProvider, getClaudeSettingsEnv } from './agentCliSpawning.js';
export { syncRunnerAgents, spawnAgentForTask, waitForRunnerStability, spawnViaRunner, extractFinalSummary, extractPipelineOutputSummary, handlePipelineProgression, handleAgentCompletion, cleanupAgentWorktree, spawnMergeRecoveryTask, spawnReviewLoopFollowUp } from './agentLifecycle.js';
export { terminateAgent, pauseAgent, getActiveAgents, killAgent, getAgentProcessStats, killAllAgents, isPidAlive, cleanupOrphanedAgents, handleOrphanedTask } from './agentManagement.js';
export { processAgentCompletion } from './agentCompletion.js';

const ROOT_DIR = PATHS.root;
const RUNS_DIR = PATHS.runs;

// Per-agent debounced output batchers for the CoS Runner stream path. The
// runner emits `agent:output` per parsed line (see cos-runner/index.js), so a
// chatty agent would otherwise trigger a full state load+save per line. Each
// batcher coalesces a ~250ms window; we drain + drop it when the agent
// completes/errors so the final lines persist before the completion event.
const runnerOutputBatchers = new Map();

function getRunnerOutputBatcher(agentId) {
  let batcher = runnerOutputBatchers.get(agentId);
  if (!batcher) {
    batcher = createAgentOutputBatcher(agentId);
    runnerOutputBatchers.set(agentId, batcher);
  }
  return batcher;
}

export async function flushRunnerOutputBatcher(agentId) {
  const batcher = runnerOutputBatchers.get(agentId);
  if (!batcher) return;
  // Flush BEFORE deleting: the agent is still in `runnerAgents` at this point
  // (handleAgentCompletion removes it afterwards), so a line racing in during
  // the awaited flush lands in this same batcher instead of orphaning a new
  // one. The `agent:output` guard below drops any truly post-completion stray.
  await batcher.flush();
  runnerOutputBatchers.delete(agentId);
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

  // Check if CoS Runner is available
  const runnerAvailable = await isRunnerAvailable();
  setUseRunner(runnerAvailable);

  // Lazy-import lifecycle functions (avoids circular dep at module init time)
  const { syncRunnerAgents, handleAgentCompletion, spawnAgentForTask } = await import('./agentLifecycle.js');
  const { cleanupOrphanedAgents, terminateAgent } = await import('./agentManagement.js');
  const { completeAgentRun } = await import('./agentRunTracking.js');

  if (runnerAvailable) {
    console.log('🤖 Sub-agent spawner initialized (using CoS Runner)');
    initCosRunnerConnection();

    // Sync any agents that were running before server restart
    const synced = await syncRunnerAgents().catch(err => {
      console.error(`❌ Failed to sync runner agents: ${err.message}`);
      return 0;
    });
    if (synced > 0) {
      console.log(`🔄 Recovered ${synced} agents from CoS Runner`);
    }

    // Set up event handlers for runner events
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
      if (agent) {
        clearTimeout(agent.initializationTimeout);
      }
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
        await completeAgent(agentId, { success: false, error });
        await completeAgentRun(agent.runId, '', 1, 0, { message: error, category: 'runner-error' });
        runnerAgents.delete(agentId);
      }
    });
  } else {
    console.log('🤖 Sub-agent spawner initialized (direct mode - CoS Runner not available)');
  }

  cosEvents.on('task:ready', async (task) => {
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
