/**
 * Agent Management
 *
 * Handles agent termination, process stats, kill-all, orphan cleanup,
 * and orphaned task retry logic.
 */

import { join } from 'path';
import { emitLog } from './cosEvents.js';
import { completeAgent } from './cosAgents.js';
import { updateTask, addTask, getTaskById } from './cos.js';
import { terminateAgentViaRunner, killAgentViaRunner, getAgentStatsFromRunner, getActiveAgentsFromRunner } from './cosRunnerClient.js';
import { unregisterSpawnedAgent } from './agents.js';
import { MAX_TOTAL_SPAWNS } from '../lib/validation.js';
import { activeAgents, runnerAgents, userTerminatedAgents, useRunner } from './agentState.js';
import { cleanupAgentWorktree, syncRunnerAgents } from './agentLifecycle.js';
import { cleanupOrphanedWorktrees } from './worktreeManager.js';
import { checkForTaskCommit } from './agentRunTracking.js';
import { PATHS } from '../lib/fileUtils.js';

const ROOT_DIR = PATHS.root;

// Max retries before creating investigation task
const MAX_ORPHAN_RETRIES = 3;
// Minimum cooldown between orphan retries (30 minutes)
const ORPHAN_RETRY_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Terminate an agent (graceful SIGTERM with SIGKILL fallback).
 */
export async function terminateAgent(agentId) {
  // Check if agent is in runner mode
  if (runnerAgents.has(agentId)) {
    const agentInfo = runnerAgents.get(agentId);
    if (agentInfo?.initializationTimeout) {
      clearTimeout(agentInfo.initializationTimeout);
    }
    const result = await terminateAgentViaRunner(agentId).catch(err => ({
      success: false,
      error: err.message
    }));
    if (result.success) {
      await completeAgent(agentId, { success: false, error: 'Agent terminated by user' });
      const task = agentInfo?.task;
      if (task) {
        await updateTask(task.id, {
          status: 'blocked',
          metadata: {
            ...task.metadata,
            blockedReason: 'Terminated by user',
            blockedCategory: 'user-terminated',
            blockedAt: new Date().toISOString()
          }
        }, task.taskType || 'user');
      }
      runnerAgents.delete(agentId);
    }
    return result;
  }

  // Direct mode
  const agent = activeAgents.get(agentId);

  if (!agent) {
    return { success: false, error: 'Agent not found or not running' };
  }

  // Track as user-terminated so the close handler doesn't re-queue
  userTerminatedAgents.add(agentId);

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

  // Kill the process
  agent.process.kill('SIGTERM');

  // Give it a moment, then force kill if needed
  setTimeout(() => {
    if (activeAgents.has(agentId)) {
      agent.process.kill('SIGKILL');
      unregisterSpawnedAgent(agent.pid);
      activeAgents.delete(agentId);
    }
  }, 5000);

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
    const agentInfo = runnerAgents.get(agentId);
    if (agentInfo?.initializationTimeout) {
      clearTimeout(agentInfo.initializationTimeout);
    }
    const result = await killAgentViaRunner(agentId).catch(err => ({
      success: false,
      error: err.message
    }));
    if (result.success) {
      await completeAgent(agentId, { success: false, error: 'Agent force killed by user (SIGKILL)' });
      const task = agentInfo?.task;
      if (task) {
        await updateTask(task.id, {
          status: 'blocked',
          metadata: {
            ...task.metadata,
            blockedReason: 'Force killed by user',
            blockedCategory: 'user-terminated',
            blockedAt: new Date().toISOString()
          }
        }, task.taskType || 'user');
      }
      runnerAgents.delete(agentId);
    }
    return result;
  }

  // Direct mode
  const agent = activeAgents.get(agentId);

  if (!agent) {
    return { success: false, error: 'Agent not found or not running' };
  }

  // Track as user-terminated so the close handler doesn't re-queue
  userTerminatedAgents.add(agentId);

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

  // Kill the process immediately with SIGKILL
  agent.process.kill('SIGKILL');

  unregisterSpawnedAgent(agent.pid);
  activeAgents.delete(agentId);

  return { success: true, agentId, pid: agent.pid, signal: 'SIGKILL' };
}

/**
 * Get process stats for an agent (CPU, memory usage).
 */
export async function getAgentProcessStats(agentId) {
  // Check if agent is in runner mode - use runner endpoint
  if (runnerAgents.has(agentId) || useRunner) {
    const stats = await getAgentStatsFromRunner(agentId);
    return stats;
  }

  // Direct mode - get stats locally
  const agent = activeAgents.get(agentId);
  if (!agent) {
    return null;
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

  return { active: true, agentId, pid: agent.pid, cpu: 0, memoryKb: 0, memoryMb: 0, state: 'unknown' };
}

/**
 * Kill all active agents.
 */
export async function killAllAgents() {
  const directIds = Array.from(activeAgents.keys());
  const runnerIds = Array.from(runnerAgents.keys());

  for (const agentId of directIds) {
    await terminateAgent(agentId);
  }

  for (const agentId of runnerIds) {
    await terminateAgent(agentId);
  }

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
            const inferredType = agent.taskId?.startsWith('sys-') ? 'internal' : 'user';
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

  // Clean up worktrees for orphaned agents
  for (const { agentId } of orphanedTaskIds) {
    await cleanupAgentWorktree(agentId, false);
  }

  // Also clean up any orphaned worktrees not tracked by any agent
  const activeIds = new Set([...activeAgents.keys(), ...runnerAgents.keys()]);
  await cleanupOrphanedWorktrees(ROOT_DIR, activeIds).catch(err => {
    console.log(`⚠️ Orphaned worktree cleanup failed: ${err.message}`);
  });

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

  // Skip tasks already completed
  if (task.status === 'completed') {
    emitLog('debug', `⏭️ Skipping orphaned task ${taskId} — already completed`, { taskId, agentId });
    return;
  }

  // Check if the agent actually committed work before treating as orphaned
  const commitFound = checkForTaskCommit(taskId, ROOT_DIR);
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
      approvalRequired: false // Auto-approved for orphan issues
    }, 'internal').catch(err => {
      emitLog('error', `Failed to create investigation task: ${err.message}`, { taskId, error: err.message });
    });
  }
}
