/**
 * Sub-Agent Spawner Service
 *
 * Orchestrator module: imports from focused sub-modules and re-exports
 * everything for backward compatibility. Keeps module-level initialization
 * (initSpawner, event wiring) and shared state references.
 */

import { join } from 'path';
import { readFile, readdir, rm, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { emitLog, cosEvents } from './cosEvents.js';
import { appendAgentOutput, updateAgent, completeAgent } from './cosAgents.js';
import { initProviderStatus } from './providerStatus.js';
import { onCosRunnerEvent, initCosRunnerConnection, isRunnerAvailable } from './cosRunnerClient.js';
import { ensureDir, loadSlashdoFile, PATHS } from '../lib/fileUtils.js';

// ─── Shared state (imported from agentState.js) ──────────────────────────────
export { activeAgents, runnerAgents, userTerminatedAgents, spawningTasks, useRunner, isTruthyMeta, isFalsyMeta } from './agentState.js';
import { activeAgents, runnerAgents, setUseRunner } from './agentState.js';

// ─── Sub-module re-exports ────────────────────────────────────────────────────
export { selectModelForTask } from './agentModelSelection.js';
export { createAgentRun, completeAgentRun, checkForTaskCommit, extractErrorFromOutput } from './agentRunTracking.js';
export { ERROR_PATTERNS, analyzeAgentFailure, createInvestigationTask, API_ACCESS_ERROR_CATEGORIES, maybeCreateInvestigationTask, resolveFailedTaskUpdate, MAX_TASK_RETRIES } from './agentErrorAnalysis.js';
export { buildAgentPrompt, getAppWorkspace, getAppDataForTask, generateJiraTitle, createJiraTicketForTask, getClaudeMdContext, buildCompactionSection, detectSkillTemplate, loadSkillTemplate } from './agentPromptBuilder.js';
export { spawnDirectly, createStreamJsonParser, summarizeToolInput, safeParse, buildCliSpawnConfig, isClaudeCliProvider, getClaudeSettingsEnv } from './agentCliSpawning.js';
export { syncRunnerAgents, spawnAgentForTask, waitForRunnerStability, spawnViaRunner, extractFinalSummary, extractPipelineOutputSummary, handlePipelineProgression, handleAgentCompletion, cleanupAgentWorktree, spawnMergeRecoveryTask } from './agentLifecycle.js';
export { terminateAgent, getActiveAgents, killAgent, getAgentProcessStats, killAllAgents, isPidAlive, cleanupOrphanedAgents, handleOrphanedTask } from './agentManagement.js';
export { processAgentCompletion } from './agentCompletion.js';

const ROOT_DIR = PATHS.root;
const RUNS_DIR = PATHS.runs;


/**
 * Load a slashdo command from the bundled submodule, resolving !`cat` lib includes inline.
 */
export async function loadSlashdoCommand(commandName) {
  const content = await loadSlashdoFile(commandName);
  if (content) console.log(`📋 Loaded slashdo command: do:${commandName}`);
  return content;
}

/**
 * Get list of active agent IDs (for zombie detection).
 * Includes both direct mode and runner mode agents.
 */
export function getActiveAgentIds() {
  const directIds = Array.from(activeAgents.keys());
  const runnerIds = Array.from(runnerAgents.keys());
  return [...directIds, ...runnerIds];
}

/**
 * Initialize the spawner — listen for task:ready events.
 */
export async function initSpawner() {
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
  const { syncRunnerAgents, handleAgentCompletion, cleanupAgentWorktree } = await import('./agentLifecycle.js');
  const { cleanupOrphanedAgents, handleOrphanedTask } = await import('./agentManagement.js');
  const { spawnAgentForTask } = await import('./agentLifecycle.js');
  const { terminateAgent } = await import('./agentManagement.js');
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
      await appendAgentOutput(agentId, text);

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
        await handleAgentCompletion(orphan.agentId, orphan.exitCode, orphan.success, 0);
      }
    });

    onCosRunnerEvent('agent:error', async (data) => {
      const { agentId, error } = data;
      console.error(`❌ Agent ${agentId} error from runner: ${error}`);
      cosEvents.emit('agent:error', { agentId, error });
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
}

// Initialize spawner when module loads (async)
initSpawner().catch(err => {
  console.error(`❌ Failed to initialize spawner: ${err.message}`);
});

// Initialize task learning system
import('./taskLearning.js').then(taskLearning => {
  taskLearning.initTaskLearning();
}).catch(err => {
  console.error(`❌ Failed to initialize task learning: ${err.message}`);
});

// Clean up orphaned agents after a short delay (let other services init first)
import('./agentManagement.js').then(({ cleanupOrphanedAgents }) => {
  setTimeout(cleanupOrphanedAgents, 2000);
}).catch(err => {
  console.error(`❌ Failed to schedule orphan cleanup: ${err.message}`);
});
