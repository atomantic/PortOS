/**
 * Agent Management
 *
 * Handles agent termination, process stats, kill-all, orphan cleanup,
 * and orphaned task retry logic.
 */

import { join } from 'path';
import { ServerError } from '../lib/errorHandler.js';
import { emitLog } from './cosEvents.js';
import { completeAgent, updateAgent } from './cosAgents.js';
import { updateTask, addTask, getTaskById } from './cos.js';
import { terminateAgentViaRunner, killAgentViaRunner, pauseAgentViaRunner, getAgentStatsFromRunner, getActiveAgentsFromRunner } from './cosRunnerClient.js';
import { unregisterSpawnedAgent } from './agents.js';
import { MAX_TOTAL_SPAWNS } from '../lib/validation.js';
import { isInternalTaskId } from '../lib/taskParser.js';
import { activeAgents, runnerAgents, userTerminatedAgents, pausedAgents, useRunner } from './agentState.js';
import { cleanupAgentWorktree, syncRunnerAgents } from './agentLifecycle.js';
import { checkForTaskCommit } from './agentRunTracking.js';
import { PATHS } from '../lib/fileUtils.js';
import { killProcessTree } from '../lib/bufferedSpawn.js';
import { release } from './executionLanes.js';
import { completeExecution, errorExecution } from './toolStateMachine.js';
import * as shellService from './shell.js';

const ROOT_DIR = PATHS.root;

// Max retries before creating investigation task
const MAX_ORPHAN_RETRIES = 3;
// Minimum cooldown between orphan retries (30 minutes)
const ORPHAN_RETRY_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Shared runner-mode termination path for terminateAgent and killAgent.
 * Calls runnerFn, marks the task blocked, and cleans up. Returns the runner
 * result shape (`{ success, error? }`) — callers decide whether a failure
 * throws (killAgent, whose route surfaces status) or is returned for internal
 * orchestration to inspect (terminateAgent, whose route is fire-and-forget).
 */
async function terminateRunnerAgent(agentId, runnerFn, errorMessage, blockedReason) {
  const agentInfo = runnerAgents.get(agentId);
  if (agentInfo?.initializationTimeout) clearTimeout(agentInfo.initializationTimeout);
  const result = await runnerFn(agentId).catch(err => ({ success: false, error: err.message }));
  if (result.success) {
    // Drain + drop this agent's runner output batcher before the terminal
    // record so pending ~250ms-batched output lands first, and the Map entry
    // doesn't leak if the runner never emits a later completion event. Dynamic
    // import avoids a static cycle (subAgentSpawner statically re-exports this
    // module). flushRunnerOutputBatcher is a no-op if no batcher exists.
    const { flushRunnerOutputBatcher } = await import('./subAgentSpawner.js');
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

async function markPausedTask(agentInfo, agentId, pausedAt, reason) {
  const task = agentInfo?.task || (agentInfo?.taskId ? await getTaskById(agentInfo.taskId).catch(() => null) : null);
  if (!task) return;
  const metadata = {
    ...task.metadata,
    blockedReason: reason ? `Paused by user: ${reason}` : 'Paused by user',
    blockedCategory: 'agent-paused',
    blockedAt: pausedAt,
    pausedAt,
    pausedAgentId: agentId
  };
  if (agentInfo?.workspacePath) metadata.resumeWorkspacePath = agentInfo.workspacePath;
  if (agentInfo?.runId) metadata.resumeRunId = agentInfo.runId;
  await updateTask(task.id, {
    status: 'blocked',
    metadata
  }, task.taskType || 'user');
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
    const result = await pauseAgentViaRunner(agentId, reason).catch(err => ({ success: false, error: err.message }));
    if (!result.success) {
      pausedAgents.delete(agentId);
      throw new ServerError(result.error || 'Failed to pause runner agent', {
        status: 500,
        code: 'AGENT_PAUSE_FAILED',
      });
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
 * Terminate an agent (graceful SIGTERM with SIGKILL fallback).
 */
export async function terminateAgent(agentId) {
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
  // Check if agent is in runner mode
  if (runnerAgents.has(agentId)) {
    const result = await terminateRunnerAgent(agentId, killAgentViaRunner, 'Agent force killed by user (SIGKILL)', 'Force killed by user');
    // The agent was present in runnerAgents, so a failure here is an
    // operational runner-RPC error (not a missing agent) — surface it as a
    // 500 so the kill route renders the standard envelope instead of the old
    // result-shape 404 string-match (issue #2534).
    if (!result.success) {
      throw new ServerError(result.error || 'Failed to kill runner agent', {
        status: 500,
        code: 'AGENT_KILL_FAILED',
      });
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

    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    const psCmd = process.platform === 'win32'
      ? `tasklist /FI "PID eq ${agent.pid}" /FO CSV /NH`
      : `ps -p ${agent.pid} -o pid=,pcpu=,rss=,state=`;
    const result = await execAsync(psCmd, { windowsHide: true }).catch(() => ({ stdout: '' }));
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
export async function cleanupOrphanedAgents() {
  const { getAgents, completeAgent: markComplete, evaluateTasks, getTaskById: getTask } = await import('./cos.js');
  const agents = await getAgents();
  let cleanedCount = 0;
  const orphanedTaskIds = [];

  // Get list of agents actively running in the CoS Runner
  const runnerActiveIds = new Set();
  const runnerAgentsList = await getActiveAgentsFromRunner().catch(() => []);
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
      const inLocalDirect = activeAgents.has(agent.id);
      const inLocalRunner = runnerAgents.has(agent.id);
      const inRemoteRunner = runnerActiveIds.has(agent.id);

      if (!inLocalDirect && !inLocalRunner && !inRemoteRunner) {
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

        console.log(`🧹 Cleaning up orphaned agent ${agent.id} (PID ${agent.pid || 'unknown'} not running)`);
        await markComplete(agent.id, {
          success: false,
          error: 'Agent process terminated unexpectedly',
          orphaned: true
        });
        cleanedCount++;

        if (agent.taskId) {
          orphanedTaskIds.push({ taskId: agent.taskId, agentId: agent.id });
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

  // Handle orphaned tasks - reset for retry or create investigation task
  for (const { taskId, agentId } of orphanedTaskIds) {
    await handleOrphanedTask(taskId, agentId, getTask);
  }

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
 */
export async function handleOrphanedTask(taskId, agentId, getTaskByIdFn) {
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

  // Check if the agent actually committed work before treating as orphaned
  const commitFound = await checkForTaskCommit(taskId, ROOT_DIR);
  if (commitFound) {
    emitLog('info', `✅ Orphaned agent ${agentId} actually completed work - commit found for task ${taskId}`, { taskId, agentId });
    await updateTask(taskId, { status: 'completed' }, task.taskType || 'user');
    return;
  }

  // Get current retry count from task metadata
  const retryCount = (Number(task.metadata?.orphanRetryCount) || 0) + 1;
  const totalSpawns = Number(task.metadata?.totalSpawnCount) || 0;
  const taskType = task.taskType || 'user';

  // Block if total spawn count across all retry types is exhausted
  const totalExceeded = totalSpawns >= MAX_TOTAL_SPAWNS;

  // Enforce cooldown between orphan retries
  const lastOrphanedAt = task.metadata?.lastOrphanedAt ? new Date(task.metadata.lastOrphanedAt).getTime() : 0;
  const cooldownRemaining = lastOrphanedAt ? ORPHAN_RETRY_COOLDOWN_MS - (Date.now() - lastOrphanedAt) : 0;
  const inCooldown = cooldownRemaining > 0;

  if (retryCount < MAX_ORPHAN_RETRIES && !totalExceeded && !inCooldown) {
    emitLog('info', `Resetting orphaned task ${taskId} for retry (attempt ${retryCount}/${MAX_ORPHAN_RETRIES}, total spawns ${totalSpawns}/${MAX_TOTAL_SPAWNS})`, {
      taskId,
      retryCount,
      totalSpawns,
      maxRetries: MAX_ORPHAN_RETRIES
    });

    await updateTask(taskId, {
      status: 'pending',
      metadata: {
        ...task.metadata,
        orphanRetryCount: retryCount,
        lastOrphanedAt: new Date().toISOString(),
        lastOrphanedAgentId: agentId
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

Once the issue is resolved, reset the original task to pending.`;

    await addTask({
      description,
      priority: 'HIGH',
      context: `Auto-generated from repeated orphan failures for task ${taskId}`,
      // Requires approval, matching every other error-driven task creator
      // (autoFixer.js, agentErrorAnalysis.js) — repeated orphaning is an
      // infra/process-flakiness signal, not a diagnosed code bug, so an
      // unsupervised agent shouldn't be turned loose on the codebase from it.
      approvalRequired: true
    }, 'internal').catch(err => {
      emitLog('error', `Failed to create investigation task: ${err.message}`, { taskId, error: err.message });
    });
  }
}
