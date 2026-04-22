/**
 * Chief of Staff (CoS) Service
 *
 * Manages the autonomous agent manager that watches TASKS.md,
 * spawns sub-agents, and orchestrates task completion.
 *
 * Decomposed modules:
 * - cosState.js    — shared state management (loadState, saveState, config, mutex)
 * - cosAgents.js   — agent lifecycle (register, complete, archive, feedback)
 * - cosReports.js  — reports, briefings, and activity tracking
 * - cosEvents.js   — event emitter and logging
 */

import { readFile, writeFile, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { exec, execFile } from 'child_process';
import { execPm2 } from './pm2.js';
import { promisify } from 'util';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { getActiveProvider } from './providers.js';
import { parseTasksMarkdown, groupTasksByStatus, getNextTask, getAutoApprovedTasks, getAwaitingApprovalTasks, updateTaskStatus, generateTasksMarkdown, hasKnownPrefix, isInternalTaskId } from '../lib/taskParser.js';
import { isAppOnCooldown, getNextAppForReview, markAppReviewStarted, markIdleReviewStarted } from './appActivity.js';
import { getActiveApps, getAppTaskTypeOverrides } from './apps.js';
import { getAdaptiveCooldownMultiplier, getSkippedTaskTypes, getPerformanceSummary, checkAndRehabilitateSkippedTasks, getLearningInsights, getTaskTypeConfidence } from './taskLearning.js';
import { schedule as scheduleEvent, cancel as cancelEvent, getStats as getSchedulerStats, parseCronToNextRun } from './eventScheduler.js';
import { generateProactiveTasks as generateMissionTasks, getStats as getMissionStats } from './missions.js';
import { generateTaskFromJob, recordJobExecution, recordJobGateSkip, isScriptJob, executeScriptJob, isShellJob, executeShellJob } from './autonomousJobs.js';
import { checkJobGate, hasGate } from './jobGates.js';
import { ensureDir, formatDuration, safeJSONParse, PATHS } from '../lib/fileUtils.js';
import { sanitizeTaskMetadata, PIPELINE_BEHAVIOR_FLAGS, MAX_TOTAL_SPAWNS } from '../lib/validation.js';
import { addNotification, NOTIFICATION_TYPES } from './notifications.js';
import { recordDecision, DECISION_TYPES } from './decisionLog.js';
import { getUserTimezone, getLocalParts, nextLocalTime, todayInTimezone } from '../lib/timezone.js';
import { PORTOS_UI_URL } from '../lib/ports.js';

// Shared state management (extracted to avoid circular deps)
import { loadState, saveState, withStateLock, ensureDirectories, AGENTS_DIR, REPORTS_DIR, SCRIPTS_DIR, ROOT_DIR, isDaemonRunning, setDaemonRunning } from './cosState.js';

// Events and logging (canonical source: cosEvents.js)
import { cosEvents, emitLog } from './cosEvents.js';
export { cosEvents, emitLog };

// Agent lifecycle (re-export for backward compat with `import * as cos`)
export { registerAgent, updateAgent, completeAgent, appendAgentOutput, getAgents, getAgentDates, getAgentsByDate, getAgent, terminateAgent, killAgent, sendBtwToAgent, getAgentProcessStats, cleanupZombieAgents, deleteAgent, submitAgentFeedback, getFeedbackStats, extractTaskType, archiveStaleAgents, clearCompletedAgents, pruneOldAgentArchives } from './cosAgents.js';

// Reports and activity (re-export for backward compat with `import * as cos`)
export { generateReport, getReport, getTodayReport, listReports, listBriefings, getBriefing, getLatestBriefing, getTodayActivity, getRecentTasks, formatRelativeTime } from './cosReports.js';

const _execAsync = promisify(exec);
const _execFileAsync = promisify(execFile);
const execAsync = (cmd, opts) => _execAsync(cmd, { ...opts, windowsHide: true });
const execFileAsync = (cmd, args, opts) => _execFileAsync(cmd, args, { ...opts, windowsHide: true });

// MAX_TOTAL_SPAWNS imported from validation.js (shared with subAgentSpawner.js)

/**
 * Block a task that has exceeded the max spawn limit. Returns true if blocked.
 */
async function blockIfExceedsMaxSpawns(task, taskType) {
  const totalSpawns = Number(task.metadata?.totalSpawnCount) || 0;
  if (totalSpawns < MAX_TOTAL_SPAWNS) return false;
  emitLog('info', `🚫 Blocking task ${task.id} — exceeded max spawns (${totalSpawns}/${MAX_TOTAL_SPAWNS})`, { taskId: task.id });
  await updateTask(task.id, {
    status: 'blocked',
    metadata: { ...task.metadata, blockedReason: `Max total spawns exceeded (${totalSpawns}/${MAX_TOTAL_SPAWNS})`, blockedCategory: 'max-spawns', blockedAt: new Date().toISOString() }
  }, taskType).catch(err => {
    emitLog('warn', `Failed to block task ${task.id}: ${err.message}`, { taskId: task.id });
  });
  return true;
}

let initialStartup = false;

// Internal imports for functions used in this module
import { pruneOldAgentArchives, archiveStaleAgents as _archiveStaleAgents, loadAgentIndex } from './cosAgents.js';

/**
 * Get current CoS status
 */
export async function getStatus() {
  const state = await loadState();
  const provider = await getActiveProvider();
  const idx = await loadAgentIndex();

  // Count active agents from state
  const activeAgents = Object.values(state.agents).filter(a => a.status === 'running').length;

  // Derive tasksCompleted from union of index (disk) + state completed agents,
  // since state.stats.tasksCompleted can drift after state resets
  const stateCompletedIds = Object.keys(state.agents).filter(id => state.agents[id].status === 'completed');
  const stateOnlyCompleted = stateCompletedIds.filter(id => !idx.has(id)).length;
  const tasksCompleted = Math.max(state.stats.tasksCompleted, idx.size + stateOnlyCompleted);

  return {
    running: isDaemonRunning(),
    paused: state.paused || false,
    pausedAt: state.pausedAt,
    pauseReason: state.pauseReason,
    config: state.config,
    stats: { ...state.stats, tasksCompleted },
    activeAgents,
    provider: provider ? { id: provider.id, name: provider.name } : null
  };
}

/**
 * Get current configuration
 */
export async function getConfig() {
  const state = await loadState();
  return state.config;
}

/**
 * Update configuration
 */
export async function updateConfig(updates) {
  const config = await withStateLock(async () => {
    const state = await loadState();
    state.config = { ...state.config, ...updates };
    await saveState(state);
    return state.config;
  });
  cosEvents.emit('config:changed', config);
  return config;
}

/**
 * Start the CoS daemon
 */
export async function start() {
  if (isDaemonRunning()) {
    emitLog('warn', 'CoS already running');
    return { success: false, error: 'Already running' };
  }

  emitLog('info', 'Starting Chief of Staff daemon...');

  const state = await withStateLock(async () => {
    const s = await loadState();
    s.running = true;
    await saveState(s);
    return s;
  });

  setDaemonRunning(true);

  // First clean up orphaned agents (agents marked running but no live process)
  const { cleanupOrphanedAgents } = await import('./subAgentSpawner.js');
  const cleanedAgents = await cleanupOrphanedAgents();
  if (cleanedAgents > 0) {
    emitLog('info', `Cleaned up ${cleanedAgents} orphaned agent(s)`);
  }

  // Then reset any orphaned in_progress tasks (no running agent)
  await resetOrphanedTasks();

  // Archive stale completed agents from state.json on startup
  const { archived } = await _archiveStaleAgents().catch(() => ({ archived: 0 }));
  if (archived > 0) {
    emitLog('info', `📦 Startup: archived ${archived} stale agent(s) from state`);
  }

  // Prune agent archives older than 90 days
  await pruneOldAgentArchives(90).catch(() => {});

  // Health check + orphan cleanup (15 min)
  scheduleEvent({
    id: 'cos-health-check',
    type: 'interval',
    intervalMs: state.config.healthCheckIntervalMs,
    handler: async () => {
      await runHealthCheck();
      const cleaned = await cleanupOrphanedAgents();
      if (cleaned > 0) {
        emitLog('info', `🧹 Periodic cleanup: ${cleaned} orphaned agent(s)`);
      }
      await resetOrphanedTasks();
      const { archived } = await _archiveStaleAgents().catch(() => ({ archived: 0 }));
      if (archived > 0) {
        emitLog('info', `📦 Auto-archived ${archived} stale agent(s) from state`);
      }
    },
    metadata: { description: 'CoS health check + orphan cleanup + agent archival' }
  });

  // Performance summary (10 min)
  scheduleEvent({
    id: 'cos-performance-summary',
    type: 'interval',
    intervalMs: 10 * 60 * 1000,
    handler: async () => {
      const perfSummary = await getPerformanceSummary().catch(() => null);
      if (perfSummary && perfSummary.totalCompleted > 0) {
        emitLog('info', `Performance: ${perfSummary.overallSuccessRate}% success over ${perfSummary.totalCompleted} tasks`, {
          successRate: perfSummary.overallSuccessRate,
          totalCompleted: perfSummary.totalCompleted,
          topPerformers: perfSummary.topPerformers.length,
          needsAttention: perfSummary.needsAttention.length
        });
      }
    },
    metadata: { description: 'CoS performance summary' }
  });

  // Learning insights (20 min)
  scheduleEvent({
    id: 'cos-learning-insights',
    type: 'interval',
    intervalMs: 20 * 60 * 1000,
    handler: async () => {
      const learningInsights = await getLearningInsights().catch(() => null);
      if (learningInsights?.recommendations?.length > 0) {
        const recommendations = learningInsights.recommendations.slice(0, 3);
        for (const rec of recommendations) {
          const level = rec.type === 'warning' ? 'warn' : rec.type === 'action' ? 'info' : 'debug';
          emitLog(level, `🧠 Learning: ${rec.message}`, { recommendationType: rec.type });
        }
        cosEvents.emit('learning:recommendations', {
          recommendations,
          insights: {
            bestPerforming: learningInsights.insights?.bestPerforming?.slice(0, 2) || [],
            worstPerforming: learningInsights.insights?.worstPerforming?.slice(0, 2) || [],
            commonErrors: learningInsights.insights?.commonErrors?.slice(0, 2) || []
          },
          totals: learningInsights.totals
        });
      }
    },
    metadata: { description: 'CoS learning insights' }
  });

  // Rehabilitation check (2 hours)
  scheduleEvent({
    id: 'cos-rehabilitation-check',
    type: 'interval',
    intervalMs: 2 * 60 * 60 * 1000,
    handler: async () => {
      const s = await loadState();
      const gracePeriodMs = (s.config.rehabilitationGracePeriodDays || 7) * 24 * 60 * 60 * 1000;
      const result = await checkAndRehabilitateSkippedTasks(gracePeriodMs).catch(() => ({ count: 0 }));
      if (result.count > 0) {
        emitLog('success', `Auto-rehabilitated ${result.count} skipped task type(s)`, {
          rehabilitated: result.rehabilitated?.map(r => r.taskType) || []
        });
      }
    },
    metadata: { description: 'CoS rehabilitation check for skipped tasks' }
  });

  // Register autonomous job schedules (individual timers per job)
  await registerJobSchedules();

  // Schedule improvement task checks based on next due time
  await scheduleNextImprovementCheck();

  // Run initial evaluation to pick up existing pending tasks, then health check
  // Skip improvement task generation on startup to avoid spawning agents on fresh installs
  emitLog('info', 'Running initial task evaluation...');
  initialStartup = true;
  await evaluateTasks();
  initialStartup = false;
  await runHealthCheck();

  cosEvents.emit('status', { running: true });
  emitLog('success', 'CoS daemon started');

  // Queue due improvement tasks shortly after startup (not during initial eval
  // to avoid overwhelming fresh installs, but soon enough to not stall)
  setTimeout(() => {
    if (!isDaemonRunning()) return;
    loadState().then(async (state) => {
      if (!state.config.idleReviewEnabled) return;
      const cosTaskData = await getCosTasks();
      await queueEligibleImprovementTasks(state, cosTaskData);
      setImmediate(() => dequeueNextTask());
    }).catch(err => emitLog('warn', `Post-startup improvement queuing failed: ${err.message}`));
  }, 30000);

  return { success: true };
}

/**
 * Stop the CoS daemon
 */
export async function stop() {
  if (!isDaemonRunning()) {
    return { success: false, error: 'Not running' };
  }

  // Cancel all scheduled events
  cancelEvent('cos-health-check');
  cancelEvent('cos-performance-summary');
  cancelEvent('cos-learning-insights');
  cancelEvent('cos-rehabilitation-check');
  cancelEvent('cos-improvement-check');
  await unregisterJobSchedules();

  await withStateLock(async () => {
    const state = await loadState();
    state.running = false;
    await saveState(state);
  });

  setDaemonRunning(false);
  cosEvents.emit('status', { running: false });
  return { success: true };
}

/**
 * Pause the CoS daemon (for always-on mode)
 * Daemon stays running but skips evaluations
 */
export async function pause(reason = null) {
  return withStateLock(async () => {
    const state = await loadState();

    if (state.paused) {
      return { success: false, error: 'Already paused' };
    }

    state.paused = true;
    state.pausedAt = new Date().toISOString();
    state.pauseReason = reason;
    await saveState(state);

    emitLog('info', `CoS paused${reason ? `: ${reason}` : ''}`);
    cosEvents.emit('status:paused', { paused: true, pausedAt: state.pausedAt, reason });
    return { success: true, pausedAt: state.pausedAt };
  });
}

/**
 * Resume the CoS daemon from pause
 */
export async function resume() {
  const result = await withStateLock(async () => {
    const state = await loadState();

    if (!state.paused) {
      return { success: false, error: 'Not paused' };
    }

    state.paused = false;
    state.pausedAt = null;
    state.pauseReason = null;
    await saveState(state);

    emitLog('info', 'CoS resumed');
    cosEvents.emit('status:resumed', { paused: false });
    return { success: true };
  });

  // Trigger immediate task dequeue on resume (outside lock to avoid holding it)
  if (result.success && isDaemonRunning()) {
    setTimeout(() => dequeueNextTask(), 500);
  }

  return result;
}

/**
 * Check if CoS is paused
 */
export async function isPaused() {
  const state = await loadState();
  return state.paused || false;
}

/**
 * Get user tasks from TASKS.md
 */
export async function getUserTasks(tasksFilePath = null) {
  const state = await loadState();
  const filePath = tasksFilePath || join(ROOT_DIR, state.config.userTasksFile);

  if (!existsSync(filePath)) {
    return { tasks: [], grouped: groupTasksByStatus([]), file: filePath, exists: false, type: 'user' };
  }

  const content = await readFile(filePath, 'utf-8');
  const tasks = parseTasksMarkdown(content);
  const grouped = groupTasksByStatus(tasks);

  return { tasks, grouped, file: filePath, exists: true, type: 'user' };
}

/**
 * Get CoS internal tasks from COS-TASKS.md
 */
export async function getCosTasks(tasksFilePath = null) {
  const state = await loadState();
  const filePath = tasksFilePath || join(ROOT_DIR, state.config.cosTasksFile);

  if (!existsSync(filePath)) {
    return { tasks: [], grouped: groupTasksByStatus([]), file: filePath, exists: false, type: 'internal' };
  }

  const content = await readFile(filePath, 'utf-8');
  const tasks = parseTasksMarkdown(content);
  const grouped = groupTasksByStatus(tasks);
  const autoApproved = getAutoApprovedTasks(tasks);
  const awaitingApproval = getAwaitingApprovalTasks(tasks);

  return { tasks, grouped, file: filePath, exists: true, type: 'internal', autoApproved, awaitingApproval };
}

/**
 * Get all tasks (user + internal)
 */
export async function getAllTasks() {
  const [userTasks, cosTasks] = await Promise.all([getUserTasks(), getCosTasks()]);
  return { user: userTasks, cos: cosTasks };
}

/**
 * Alias for backward compatibility
 */
export const getTasks = getUserTasks;

/**
 * Get a specific task by ID from any task source
 */
export async function getTaskById(taskId) {
  const { user: userTasks, cos: cosTasks } = await getAllTasks();

  // Search user tasks
  const userTask = userTasks.tasks?.find(t => t.id === taskId);
  if (userTask) {
    return { ...userTask, taskType: 'user' };
  }

  // Search CoS internal tasks
  const cosTask = cosTasks.tasks?.find(t => t.id === taskId);
  if (cosTask) {
    return { ...cosTask, taskType: 'internal' };
  }

  return null;
}

/**
 * Force-spawn a pending task by ID, bypassing cooldowns and evaluation intervals.
 */
export async function forceSpawnTask(taskId) {
  const task = await getTaskById(taskId);
  if (!task) return { error: 'Task not found' };
  if (task.status !== 'pending') return { error: `Task is ${task.status}, not pending` };
  if (task.approvalRequired) return { error: 'Task requires approval before it can be spawned' };

  const state = await loadState();
  if (state.paused) return { error: 'CoS daemon is paused — resume before force-spawning tasks' };
  const runningAgents = Object.values(state.agents).filter(a => a.status === 'running').length;
  if (runningAgents >= state.config.maxConcurrentAgents) {
    return { error: `No available agent slots (${runningAgents}/${state.config.maxConcurrentAgents})` };
  }

  cosEvents.emit('task:ready', { ...task, taskType: task.taskType || 'internal' });
  return { success: true, taskId };
}

/**
 * Reset orphaned in_progress tasks back to pending
 * (tasks marked in_progress but no running agent)
 */
async function resetOrphanedTasks() {
  const state = await loadState();
  const { user: userTaskData, cos: cosTaskData } = await getAllTasks();

  const runningAgentTaskIds = Object.values(state.agents)
    .filter(a => a.status === 'running')
    .map(a => a.taskId);

  // Also track tasks with recently-completed agents to avoid race condition:
  // Between completeAgent() and updateTask(), the agent is "completed" but the
  // task is still "in_progress". Without this check, resetOrphanedTasks treats
  // such tasks as orphaned and increments orphanRetryCount spuriously.
  const recentlyCompletedTaskIds = new Set(
    Object.values(state.agents)
      .filter(a => a.status === 'completed' && a.completedAt &&
        (Date.now() - new Date(a.completedAt).getTime()) < 60000)
      .map(a => a.taskId)
  );

  // Track tasks whose agents completed successfully — if handleAgentCompletion's
  // updateTask call failed silently (e.g., file write race after server restart),
  // we should complete the task here rather than treating it as orphaned.
  const successfullyCompletedTaskIds = new Map();
  for (const agent of Object.values(state.agents)) {
    if (agent.status === 'completed' && agent.result?.success) {
      successfullyCompletedTaskIds.set(agent.taskId, agent.id);
    }
  }

  emitLog('debug', `Running agents: ${runningAgentTaskIds.length}, recently completed: ${recentlyCompletedTaskIds.size}`, { taskIds: runningAgentTaskIds });

  // Route orphaned tasks through handleOrphanedTask for consistent retry counting,
  // cooldown enforcement, and max-spawn limits (prevents runaway respawning)
  const { handleOrphanedTask } = await import('./subAgentSpawner.js');

  const processOrphanedTasks = async (tasks) => {
    for (const task of tasks) {
      if (runningAgentTaskIds.includes(task.id)) continue;
      // Skip tasks whose agent just completed — updateTask will set them to
      // completed shortly; treating them as orphaned causes spurious retries
      if (recentlyCompletedTaskIds.has(task.id)) {
        emitLog('debug', `Skipping task ${task.id} — agent recently completed, awaiting task status update`, { taskId: task.id });
        continue;
      }
      // If the agent completed successfully but task wasn't updated (silent updateTask failure),
      // complete the task now instead of treating it as orphaned
      const successAgentId = successfullyCompletedTaskIds.get(task.id);
      if (successAgentId) {
        emitLog('warn', `🔧 Task ${task.id} still in_progress but agent ${successAgentId} completed successfully — completing task now (missed update)`, { taskId: task.id, agentId: successAgentId });
        await updateTask(task.id, { status: 'completed' }, task.taskType || (isInternalTaskId(task.id) ? 'internal' : 'user'));
        continue;
      }
      emitLog('info', `Found orphaned in_progress task ${task.id}, routing through retry handler`, { taskId: task.id });
      await handleOrphanedTask(task.id, 'unknown-reset', getTaskById);
    }
  };

  if (userTaskData.exists) {
    await processOrphanedTasks(userTaskData.grouped.in_progress || []);
  }

  if (cosTaskData.exists) {
    await processOrphanedTasks(cosTaskData.grouped.in_progress || []);
  }
}

/**
 * Count running agents grouped by project (app ID).
 * Agents without an app (self-improvement, PortOS tasks) are grouped under '_self'.
 */
function countRunningAgentsByProject(agents) {
  const counts = {};
  for (const agent of Object.values(agents)) {
    if (agent.status !== 'running') continue;
    const project = agent.metadata?.taskApp || agent.metadata?.app || '_self';
    counts[project] = (counts[project] || 0) + 1;
  }
  return counts;
}

/**
 * Check if a task would exceed the per-project concurrency limit.
 * Returns true if the task can be spawned (within limit), false otherwise.
 */
function isWithinProjectLimit(task, agentsByProject, perProjectLimit) {
  const project = task.metadata?.app || '_self';
  const current = agentsByProject[project] || 0;
  return current < perProjectLimit;
}

/**
 * Evaluate tasks and decide what to spawn
 *
 * Priority order:
 * 1. User tasks (not on cooldown)
 * 2. Auto-approved system tasks (not on cooldown)
 * 3. Generate idle review task if no other work
 */
export async function evaluateTasks() {
  if (!isDaemonRunning()) return;

  // Check if paused - skip evaluation if so
  const paused = await isPaused();
  if (paused) {
    emitLog('debug', 'CoS is paused - skipping evaluation');
    return;
  }

  // Update evaluation timestamp with lock to prevent race conditions
  const state = await withStateLock(async () => {
    const s = await loadState();
    s.stats.lastEvaluation = new Date().toISOString();
    await saveState(s);
    return s;
  });

  // Get both user and CoS tasks
  const { user: userTaskData, cos: cosTaskData } = await getAllTasks();

  // Unblock tasks whose orphan-retry cooldown has expired
  const allBlocked = [
    ...(userTaskData.grouped?.blocked || []),
    ...(cosTaskData.grouped?.blocked || [])
  ];
  for (const task of allBlocked) {
    if (task.metadata?.blockedCategory === 'orphan-cooldown' && task.metadata?.cooldownUntil) {
      if (new Date(task.metadata.cooldownUntil).getTime() <= Date.now()) {
        const taskType = task.taskType || (userTaskData.grouped?.blocked?.includes(task) ? 'user' : 'internal');
        emitLog('info', `⏰ Orphan cooldown expired for task ${task.id}, unblocking`, { taskId: task.id });
        await updateTask(task.id, {
          status: 'pending',
          metadata: {
            ...task.metadata,
            blockedReason: undefined,
            blockedCategory: undefined,
            blockedAt: undefined,
            cooldownUntil: undefined
          }
        }, taskType);
      }
    }
  }

  // Count running agents and available slots (global + per-project)
  const runningAgentEntries = Object.values(state.agents).filter(a => a.status === 'running');
  const runningAgents = runningAgentEntries.length;
  const availableSlots = state.config.maxConcurrentAgents - runningAgents;

  const perProjectLimit = state.config.maxConcurrentAgentsPerProject || state.config.maxConcurrentAgents;
  const agentsByProject = countRunningAgentsByProject(state.agents);

  if (availableSlots <= 0) {
    emitLog('warn', `Max concurrent agents reached (${runningAgents}/${state.config.maxConcurrentAgents})`);
    await recordDecision(
      DECISION_TYPES.CAPACITY_FULL,
      `All ${state.config.maxConcurrentAgents} agent slots occupied`,
      { running: runningAgents, max: state.config.maxConcurrentAgents }
    );
    cosEvents.emit('evaluation', { message: 'Max concurrent agents reached', running: runningAgents });
    return;
  }

  const tasksToSpawn = [];
  // Track per-project counts including tasks we're about to spawn in this batch
  const spawnProjectCounts = { ...agentsByProject };

  // Helper: check if a task can spawn (within both global and per-project limits)
  const canSpawnTask = (task) => {
    if (tasksToSpawn.length >= availableSlots) return false;
    const project = task.metadata?.app || '_self';
    return (spawnProjectCounts[project] || 0) < perProjectLimit;
  };
  // Helper: track a spawned task's project
  const trackSpawn = (task) => {
    const project = task.metadata?.app || '_self';
    spawnProjectCounts[project] = (spawnProjectCounts[project] || 0) + 1;
  };

  // Priority 0: On-demand task requests (highest priority - user explicitly requested these)
  const taskSchedule = await import('./taskSchedule.js');
  const onDemandRequests = await taskSchedule.getOnDemandRequests();

  if (onDemandRequests.length > 0 && tasksToSpawn.length < availableSlots) {
    for (const request of onDemandRequests) {
      if (tasksToSpawn.length >= availableSlots) break;

      // Unified on-demand handling (no category split)
      const improvementEnabled = state.config.improvementEnabled ??
        (state.config.selfImprovementEnabled || state.config.appImprovementEnabled);

      if (!improvementEnabled) {
        await taskSchedule.clearOnDemandRequest(request.id);
        continue;
      }

      let task = null;
      // Determine target app (if any)
      const apps = await getActiveApps().catch(() => []);
      let targetApp = null;

      if (request.appId) {
        targetApp = apps.find(a => a.id === request.appId);
        if (!targetApp) {
          emitLog('warn', `On-demand request for unknown app: ${request.appId}`, { requestId: request.id });
          await taskSchedule.clearOnDemandRequest(request.id);
          continue;
        }
      }

      await taskSchedule.clearOnDemandRequest(request.id);

      if (targetApp) {
        emitLog('info', `Processing on-demand improvement: ${request.taskType} for ${targetApp.name}`, { requestId: request.id, appId: targetApp.id });
        await markAppReviewStarted(targetApp.id, `on-demand-${Date.now()}`);
        await taskSchedule.recordExecution(`task:${request.taskType}`, targetApp.id);
        task = await generateManagedAppImprovementTaskForType(request.taskType, targetApp, state, { skipPreconditions: true });
      } else {
        emitLog('info', `Processing on-demand improvement: ${request.taskType}`, { requestId: request.id });
        await taskSchedule.recordExecution(`task:${request.taskType}`);
        await withStateLock(async () => {
          const s = await loadState();
          s.stats.lastSelfImprovement = new Date().toISOString();
          s.stats.lastSelfImprovementType = request.taskType;
          await saveState(s);
        });
        task = await generateSelfImprovementTaskForType(request.taskType, state);
      }

      if (task && canSpawnTask(task)) {
        const persisted = await addTask(task, 'internal', { raw: true });
        if (!persisted?.duplicate) {
          tasksToSpawn.push(task);
          trackSpawn(task);
        }
      }
    }
  }

  // Priority 1: User tasks (always run - cooldown only applies to system tasks)
  const pendingUserTasks = userTaskData.grouped?.pending || [];
  for (const task of pendingUserTasks) {
    if (tasksToSpawn.length >= availableSlots) break;
    if (await blockIfExceedsMaxSpawns(task, 'user')) continue;
    const userTask = { ...task, taskType: 'user' };
    if (!canSpawnTask(userTask)) {
      const project = task.metadata?.app || '_self';
      emitLog('debug', `⏳ Queued user task ${task.id} - per-project limit reached for ${project}`);
      await recordDecision(
        DECISION_TYPES.CAPACITY_FULL,
        `User task ${task.id} deferred — per-project limit (${perProjectLimit}) reached for ${project}`,
        { taskId: task.id, project, limit: perProjectLimit }
      );
      continue;
    }
    tasksToSpawn.push(userTask);
    trackSpawn(userTask);
  }

  // Priority 2: Auto-approved system tasks (if slots available)
  if (tasksToSpawn.length < availableSlots && cosTaskData.exists) {
    const autoApproved = cosTaskData.autoApproved || [];
    for (const task of autoApproved) {
      if (tasksToSpawn.length >= availableSlots) break;

      if (await blockIfExceedsMaxSpawns(task, 'internal')) continue;

      // Check if task's app is on cooldown (pipeline continuations bypass cooldown)
      const appId = task.metadata?.app;
      const isPipelineContinuation = task.metadata?.pipeline?.currentStage > 0;
      if (appId && !isPipelineContinuation) {
        const onCooldown = await isAppOnCooldown(appId, state.config.appReviewCooldownMs);
        if (onCooldown) {
          emitLog('debug', `Skipping system task ${task.id} - app ${appId} on cooldown`);
          await recordDecision(
            DECISION_TYPES.COOLDOWN_ACTIVE,
            `System task ${task.id} skipped — app ${appId} on cooldown (${Math.round(state.config.appReviewCooldownMs / 60000)}min window)`,
            { taskId: task.id, appId, cooldownMs: state.config.appReviewCooldownMs }
          );
          continue;
        }
      }

      const sysTask = { ...task, taskType: 'internal' };
      if (!canSpawnTask(sysTask)) {
        const sysProject = appId || '_self';
        emitLog('debug', `⏳ Queued system task ${task.id} - per-project limit reached for ${sysProject}`);
        await recordDecision(
          DECISION_TYPES.CAPACITY_FULL,
          `System task ${task.id} deferred — per-project limit (${perProjectLimit}) reached for ${sysProject}`,
          { taskId: task.id, project: sysProject, limit: perProjectLimit }
        );
        continue;
      }
      tasksToSpawn.push(sysTask);
      trackSpawn(sysTask);
    }
  }

  // Check if there are pending user tasks (even if on cooldown)
  // If user tasks exist, don't run self-improvement - wait for user tasks to be ready
  const hasPendingUserTasks = pendingUserTasks.length > 0;

  // Background: Queue eligible self-improvement tasks as system tasks
  // Only queue if there are NO pending user tasks (user tasks always take priority)
  // Skip on initial startup to avoid auto-spawning agents on fresh installs
  if (state.config.idleReviewEnabled && !hasPendingUserTasks && !initialStartup) {
    await queueEligibleImprovementTasks(state, cosTaskData);
  }

  // Priority 3: Mission-driven proactive tasks (if no user tasks)
  if (tasksToSpawn.length < availableSlots && !hasPendingUserTasks && state.config.proactiveMode) {
    const missionTasks = await generateMissionTasks({ maxTasks: availableSlots - tasksToSpawn.length }).catch(err => {
      emitLog('debug', `Mission task generation failed: ${err.message}`);
      return [];
    });

    for (const missionTask of missionTasks) {
      if (tasksToSpawn.length >= availableSlots) break;
      // Convert mission task to COS task format
      const cosTask = {
        id: missionTask.id,
        description: missionTask.description,
        priority: missionTask.priority?.toUpperCase() || 'MEDIUM',
        status: 'pending',
        metadata: missionTask.metadata,
        taskType: 'internal',
        approvalRequired: !missionTask.autoApprove
      };
      if (!canSpawnTask(cosTask)) continue;
      tasksToSpawn.push(cosTask);
      trackSpawn(cosTask);
      emitLog('info', `Generated mission task: ${missionTask.id} (${missionTask.metadata?.missionName})`, {
        missionId: missionTask.metadata?.missionId,
        appId: missionTask.metadata?.appId
      });
    }
  }

  // Priority 3.5: Autonomous jobs are handled by registerJobSchedules() which
  // sets up individual one-shot timers per job via executeScheduledJob().
  // Previously this section also checked getDueJobs() and spawned tasks here,
  // which caused duplicate agent spawns on startup when both paths fired
  // for the same past-due job within seconds of each other.

  // Priority 3.6: Feature Agents (after autonomous jobs, yield to user tasks)
  if (tasksToSpawn.length < availableSlots && !hasPendingUserTasks) {
    const { getDueFeatureAgents, generateTaskFromFeatureAgent, setCurrentAgent } = await import('./featureAgents.js');
    const dueAgents = await getDueFeatureAgents().catch(err => {
      emitLog('debug', `Feature agents check failed: ${err.message}`);
      return [];
    });
    for (const fa of dueAgents) {
      if (tasksToSpawn.length >= availableSlots) break;
      const task = generateTaskFromFeatureAgent(fa);
      if (!canSpawnTask(task)) continue;
      tasksToSpawn.push(task);
      trackSpawn(task);
      // Mark agent as having a pending task to prevent duplicate spawns
      await setCurrentAgent(fa.id, task.id).catch(() => {});
      emitLog('info', `Feature agent due: ${fa.name}`, { featureAgentId: fa.id });
    }
  }

  // Priority 4: Only generate direct idle task if:
  // 1. Nothing to spawn
  // 2. No pending user tasks (even on cooldown)
  // 3. No system tasks queued
  if (tasksToSpawn.length === 0 && state.config.idleReviewEnabled && !hasPendingUserTasks) {
    const freshCosTasks = await getCosTasks();
    const pendingSystemTasks = freshCosTasks.autoApproved?.length || 0;
    if (pendingSystemTasks === 0) {
      const idleTask = await generateIdleReviewTask(state);
      if (idleTask && canSpawnTask(idleTask)) {
        tasksToSpawn.push(idleTask);
        trackSpawn(idleTask);
      }
    }
  }

  // Emit evaluation status
  const pendingUserCount = userTaskData.grouped?.pending?.length || 0;
  const inProgressCount = userTaskData.grouped?.in_progress?.length || 0;
  const pendingSystemCount = cosTaskData.grouped?.pending?.length || 0;

  const evalLevel = tasksToSpawn.length > 0 ? 'info' : 'debug';
  emitLog(evalLevel, `Evaluation: ${pendingUserCount} user pending, ${inProgressCount} in_progress, ${pendingSystemCount} system, spawning ${tasksToSpawn.length}`, {
    pendingUser: pendingUserCount,
    inProgress: inProgressCount,
    pendingSystem: pendingSystemCount,
    toSpawn: tasksToSpawn.length,
    availableSlots
  });

  // Note: Performance summaries, learning insights, and rehabilitation checks
  // are now handled by dedicated maintenance intervals (cos-performance-summary,
  // cos-learning-insights, cos-rehabilitation-check) instead of evalCount gating.

  // Spawn all ready tasks (up to available slots)
  for (const task of tasksToSpawn) {
    emitLog('success', `Spawning task: ${task.id} (${task.priority || 'MEDIUM'})`, {
      taskId: task.id,
      taskType: task.taskType,
      app: task.metadata?.app
    });
    cosEvents.emit('task:ready', task);
  }

  // Emit awaiting approval count if any
  if (cosTaskData.exists && cosTaskData.awaitingApproval?.length > 0) {
    emitLog('info', `${cosTaskData.awaitingApproval.length} tasks awaiting approval`);
    cosEvents.emit('evaluation', {
      message: 'Tasks awaiting approval',
      awaitingApproval: cosTaskData.awaitingApproval.length
    });
  }

  if (tasksToSpawn.length === 0) {
    const awaitingCount = cosTaskData.awaitingApproval?.length || 0;
    const idleReason = awaitingCount > 0
      ? `${awaitingCount} task(s) awaiting approval, none auto-approved`
      : hasPendingUserTasks
        ? 'User tasks exist but all on cooldown or at capacity'
        : 'No user tasks, system tasks, or idle work available';
    emitLog('debug', `No tasks to process - idle: ${idleReason}`);
    await recordDecision(
      DECISION_TYPES.IDLE,
      idleReason,
      { pendingUser: pendingUserCount, pendingSystem: pendingSystemCount, awaitingApproval: awaitingCount, runningAgents }
    );
    cosEvents.emit('evaluation', { message: 'No pending tasks to process' });
  }
}

/**
 * Generate an idle task when no user/system tasks are pending
 * Alternates between:
 * 1. Self-improvement tasks (UI analysis, security, code quality)
 * 2. App reviews for managed apps
 *
 * @param {Object} state - Current CoS state
 * @returns {Object|null} Generated task or null if nothing to do
 */
async function generateIdleReviewTask(state) {
  // Check if improvement tasks are enabled (unified flag, with backward compat)
  const improvementEnabled = state.config.improvementEnabled ??
    (state.config.selfImprovementEnabled || state.config.appImprovementEnabled);

  if (!improvementEnabled) {
    emitLog('debug', 'Improvement tasks are disabled');
    return null;
  }

  // Get all active (non-archived) managed apps (including PortOS)
  const apps = await getActiveApps().catch(() => []);

  if (apps.length > 0) {
    // Find next app eligible for review (not on cooldown, oldest review first)
    const nextApp = await getNextAppForReview(apps, state.config.appReviewCooldownMs);

    if (nextApp) {
      // Mark that we're starting an idle review
      await markIdleReviewStarted();
      await markAppReviewStarted(nextApp.id, `idle-review-${Date.now()}`);

      // Update lastIdleReview timestamp
      await withStateLock(async () => {
        const s = await loadState();
        s.stats.lastIdleReview = new Date().toISOString();
        await saveState(s);
      });

      emitLog('info', `Generating improvement task for ${nextApp.name}`, { appId: nextApp.id });
      return await generateManagedAppImprovementTask(nextApp, state);
    }
  }

  emitLog('debug', 'No idle tasks available');
  return null;
}

/**
 * Queue eligible self-improvement and app improvement tasks as system tasks
 * Called during every evaluation to ensure system tasks are queued even when user tasks exist
 * Tasks are queued to COS-TASKS.md and will be picked up in Priority 2
 */
async function queueEligibleImprovementTasks(state, cosTaskData) {
  const { getDueTasks, shouldRunTask, getNextTaskType, recordExecution } = await import('./taskSchedule.js');

  // Check unified improvement flag (with backward compat)
  const improvementEnabled = state.config.improvementEnabled ??
    (state.config.selfImprovementEnabled || state.config.appImprovementEnabled);
  if (!improvementEnabled) return;

  // Get existing pending/in_progress system tasks to avoid duplicates
  // Also skip task types where a user-terminated blocked task exists (user intentionally killed it)
  const existingTasks = cosTaskData.tasks || [];
  const existingTaskTypes = new Set();

  for (const task of existingTasks) {
    const isActive = task.status === 'pending' || task.status === 'in_progress';
    const isUserTerminated = task.status === 'blocked' && task.metadata?.blockedCategory === 'user-terminated';
    if (isActive || isUserTerminated) {
      const analysisType = task.metadata?.analysisType ||
        task.metadata?.selfImprovementType ||
        task.description?.match(/\[(?:self-improvement|improvement)\]\s*(\w[\w-]*)/i)?.[1];
      const appId = task.metadata?.app;
      if (analysisType) {
        existingTaskTypes.add(appId ? `app:${appId}:${analysisType}` : analysisType);
      }
    }
  }

  let queued = 0;

  // Queue eligible improvement tasks for all managed apps (including PortOS)
  const apps = await getActiveApps().catch(() => []);
  for (const app of apps) {
    // Check if app is on cooldown
    const onCooldown = await isAppOnCooldown(app.id, state.config.appReviewCooldownMs);
    if (onCooldown) continue;

    // Get next eligible improvement type for this app
    const nextTypeResult = await getNextTaskType(app.id).catch(() => null);
    if (!nextTypeResult) continue;
    const nextType = nextTypeResult.taskType;

    const taskKey = `app:${app.id}:${nextType}`;
    if (existingTaskTypes.has(taskKey)) {
      emitLog('debug', `Improvement task ${nextType} for ${app.name} already queued`);
      continue;
    }

    // Generate task description
    const taskDesc = getTaskDescription(nextType, app.name);
    if (!taskDesc) continue;

    // Add to COS-TASKS.md
    const newTask = await addTask({
      id: `sys-${app.id.slice(0, 8)}-${nextType}-${Date.now().toString(36)}`,
      description: taskDesc,
      priority: 'LOW',
      app: app.id,
      context: `Auto-generated improvement task for ${app.name}. Type: ${nextType}`,
      approvalRequired: false
    }, 'internal');

    await recordExecution(`task:${nextType}`, app.id);

    emitLog('info', `Queued improvement task: ${nextType} for ${app.name}`, { taskId: newTask.id, appId: app.id });
    existingTaskTypes.add(taskKey);
    queued++;

    // Only queue one task per app per evaluation to avoid flooding
  }

  if (queued > 0) {
    emitLog('info', `Queued ${queued} improvement task(s) to system tasks`);
  }
}

/**
 * Get task description for a self-improvement or app improvement type.
 * When appName is provided, returns app-scoped descriptions; otherwise returns PortOS self-improvement descriptions.
 */
function getTaskDescription(taskType, appName) {
  if (appName) {
    const descriptions = {
      'security': `Security audit for ${appName}: check for vulnerabilities`,
      'code-quality': `Code quality review for ${appName}: DRY violations, dead code`,
      'test-coverage': `Add missing tests for ${appName}`,
      'performance': `Performance optimization for ${appName}`,
      'accessibility': `Accessibility audit for ${appName}`,
      'console-errors': `Fix console errors in ${appName}`,
      'dependency-updates': `Update dependencies for ${appName}`,
      'documentation': `Update documentation for ${appName}`,
      'error-handling': `Improve error handling in ${appName}`,
      'typing': `Add/fix TypeScript types in ${appName}`,
      'ui-bugs': `Review UI for visual bugs in ${appName}`,
      'mobile-responsive': `Check mobile responsiveness of ${appName}`,
      'feature-ideas': `Implement a feature idea for ${appName} aligned with GOALS.md and PLAN.md (worktree+PR)`,
      'release-check': `Verify release readiness for ${appName}`,
      'jira-sprint-manager': `Triage and implement JIRA sprint tickets for ${appName} (worktree+PR)`,
      'jira-status-report': `Generate JIRA weekly status report for ${appName}`
    };
    return descriptions[taskType] ?? null;
  }
  const descriptions = {
    'ui-bugs': 'Review UI for visual bugs, layout issues, and UX improvements',
    'mobile-responsive': 'Check mobile responsiveness and fix layout issues on smaller screens',
    'security': 'Audit codebase for security vulnerabilities (XSS, injection, auth issues)',
    'code-quality': 'Review code for DRY violations, dead code, and refactoring opportunities',
    'console-errors': 'Check browser console and fix JavaScript errors and warnings',
    'performance': 'Profile and optimize slow components, queries, and renders',
    'test-coverage': 'Add missing tests for uncovered code paths',
    'documentation': 'Update documentation, comments, and README files',
    'feature-ideas': 'Implement a feature idea aligned with GOALS.md and PLAN.md (worktree+PR)',
    'accessibility': 'Audit and fix accessibility issues (ARIA, keyboard nav, contrast)',
    'dependency-updates': 'Check for and safely update outdated dependencies',
    'error-handling': 'Improve error handling patterns and recovery logic',
    'typing': 'Add or fix TypeScript/JSDoc type annotations',
    'release-check': 'Verify release readiness (changelog, version, tests)',
    'jira-sprint-manager': 'Triage and implement JIRA sprint tickets (worktree+PR)',
    'jira-status-report': 'Generate JIRA weekly status report'
  };
  return descriptions[taskType] ?? null;
}

// Unified improvement task types (rotates through these)
// Organized by goal priority from GOALS.md
const IMPROVEMENT_TYPES = [
  // Goal 1: Codebase Quality
  'ui-bugs',
  'mobile-responsive',
  'security',
  'code-quality',
  'console-errors',
  'performance',
  // Goal 2: Self-Improvement
  'test-coverage',
  'error-handling',
  'typing',
  // Goal 3: Documentation
  'documentation',
  // Goal 4: User Engagement
  'feature-ideas',
  // Goal 5: System Health
  'accessibility',
  'dependency-updates',
  'release-check'
];
// Backward compat alias
const SELF_IMPROVEMENT_TYPES = IMPROVEMENT_TYPES;

/**
 * Generate a self-improvement task for PortOS itself
 * Uses Playwright and Opus to analyze and fix issues
 *
 * Enhanced with adaptive learning and configurable intervals:
 * - Respects per-task-type interval settings (daily, weekly, once, etc.)
 * - Skips task types with consistently poor success rates
 * - Logs learning-based recommendations
 * - Falls back to next available task type if current is skipped
 * - Checks for on-demand task requests first
 */
async function generateSelfImprovementTask(state) {
  // Import task schedule service dynamically to avoid circular dependency
  const taskSchedule = await import('./taskSchedule.js');

  // First, check for any on-demand task requests (no category filter — unified)
  const onDemandRequests = await taskSchedule.getOnDemandRequests();
  const selfRequests = onDemandRequests.filter(r => !r.appId);

  if (selfRequests.length > 0) {
    const request = selfRequests[0];
    await taskSchedule.clearOnDemandRequest(request.id);
    emitLog('info', `Processing on-demand task request: ${request.taskType}`, { requestId: request.id });

    // Record execution and generate the requested task
    await taskSchedule.recordExecution(`task:${request.taskType}`);

    // Update state
    await withStateLock(async () => {
      const s = await loadState();
      s.stats.lastSelfImprovement = new Date().toISOString();
      s.stats.lastSelfImprovementType = request.taskType;
      await saveState(s);
    });

    return await generateSelfImprovementTaskForType(request.taskType, state);
  }

  // Use the schedule service to determine the next task type
  const lastType = state.stats.lastSelfImprovementType || '';
  const nextTypeResult = await taskSchedule.getNextTaskType(null, lastType);

  if (!nextTypeResult) {
    emitLog('debug', 'No improvement tasks are eligible to run based on schedule');
    await recordDecision(
      DECISION_TYPES.NOT_DUE,
      'No improvement tasks are eligible based on schedule',
      {}
    );
    return null;
  }

  let nextType = nextTypeResult.taskType;
  const selectionReason = nextTypeResult.reason;

  // Additional check: skip if learning data suggests poor performance
  const taskTypeKey = `task:${nextType}`;
  const cooldownInfo = await getAdaptiveCooldownMultiplier(taskTypeKey).catch(() => ({ skip: false }));

  if (cooldownInfo.skip) {
    emitLog('warn', `Skipping ${nextType} - poor success rate (${cooldownInfo.successRate}% after ${cooldownInfo.completed} attempts)`, {
      taskType: nextType,
      successRate: cooldownInfo.successRate,
      completed: cooldownInfo.completed,
      reason: cooldownInfo.reason
    });

    // Record the skip decision
    await recordDecision(
      DECISION_TYPES.TASK_SKIPPED,
      `Poor success rate (${cooldownInfo.successRate}% after ${cooldownInfo.completed} attempts)`,
      { taskType: nextType, successRate: cooldownInfo.successRate, attempts: cooldownInfo.completed }
    );

    // Try to find another eligible task type
    const dueTasks = await taskSchedule.getDueTasks();
    const alternativeTask = dueTasks.find(t => t.taskType !== nextType);

    if (alternativeTask) {
      const originalType = nextType;
      nextType = alternativeTask.taskType;
      emitLog('info', `Switched to alternative task type: ${nextType}`);

      // Record the switch decision
      await recordDecision(
        DECISION_TYPES.TASK_SWITCHED,
        `Switched from ${originalType} to ${nextType}`,
        { fromTask: originalType, toTask: nextType, reason: 'poor-success-rate' }
      );
    } else {
      // Fall back to the skipped types logic
      const skippedTypes = await getSkippedTaskTypes().catch(() => []);
      if (skippedTypes.length > 0) {
        skippedTypes.sort((a, b) => new Date(a.lastCompleted || 0) - new Date(b.lastCompleted || 0));
        const oldestType = skippedTypes[0].taskType.replace(/^(self-improve|app-improve|task):/, '');
        nextType = oldestType;
        emitLog('info', `Retrying ${oldestType} as it hasn't been attempted recently`);

        // Record rehabilitation decision
        await recordDecision(
          DECISION_TYPES.REHABILITATION,
          `Retrying ${oldestType} after period of inactivity`,
          { taskType: oldestType, reason: 'oldest-skipped-type' }
        );
      } else {
        nextType = IMPROVEMENT_TYPES[0];
      }
    }
  }

  // Log if there's a recommendation from learning system
  if (cooldownInfo.recommendation) {
    emitLog('debug', `Learning insight for ${nextType}: ${cooldownInfo.recommendation}`, {
      taskType: nextType,
      multiplier: cooldownInfo.multiplier
    });
  }

  // Record execution in the schedule service
  await taskSchedule.recordExecution(`task:${nextType}`);

  // Update state with new timestamp and type
  await withStateLock(async () => {
    const s = await loadState();
    s.stats.lastSelfImprovement = new Date().toISOString();
    s.stats.lastSelfImprovementType = nextType;
    await saveState(s);
  });

  emitLog('info', `Generating improvement task: ${nextType} (${selectionReason})`);

  // Record task selection decision
  await recordDecision(
    DECISION_TYPES.TASK_SELECTED,
    `Selected ${nextType} for improvement`,
    {
      taskType: nextType,
      reason: selectionReason,
      multiplier: cooldownInfo.multiplier,
      successRate: cooldownInfo.successRate
    }
  );

  // Get task descriptions from the centralized helper function
  const taskDescriptions = getSelfImprovementTaskDescriptions();

  return await generateSelfImprovementTaskForType(nextType, state, taskDescriptions);
}

/**
 * Resolve auto-approval for a task based on confidence scoring.
 * Returns { autoApproved, approvalRequired } ready to spread into task objects.
 */
async function resolveConfidenceApproval(state, taskTypeKey, logLabel) {
  const config = state?.config?.confidenceAutoApproval ?? {};
  if (config.enabled === false) return { autoApproved: true, approvalRequired: false };

  const confidence = await getTaskTypeConfidence(taskTypeKey, config);
  if (!confidence.autoApprove) {
    emitLog('info', `🔒 ${logLabel} requires approval (${confidence.reason})`, {}, '[Confidence]');
  }
  return { autoApproved: confidence.autoApprove, approvalRequired: !confidence.autoApprove };
}

/**
 * Helper function to generate a self-improvement task for a specific type
 * Used by both normal rotation and on-demand task requests
 */
async function generateSelfImprovementTaskForType(taskType, state, taskDescriptions = null) {
  const taskSchedule = await import('./taskSchedule.js');
  const interval = await taskSchedule.getTaskInterval(taskType);

  // Get the effective prompt (custom or default)
  const description = await taskSchedule.getTaskPrompt(taskType);

  const metadata = {
    analysisType: taskType,
    autoGenerated: true,
    selfImprovement: true
  };

  // Apply sanitized task-type-specific metadata from schedule config (e.g., useWorktree, simplify)
  const sanitizedMeta = sanitizeTaskMetadata(interval.taskMetadata);
  if (sanitizedMeta) {
    Object.assign(metadata, sanitizedMeta);
  }

  // Use configured model/provider if specified, otherwise use default
  if (interval.providerId) {
    metadata.provider = interval.providerId;
    metadata.providerId = interval.providerId;
  }
  if (interval.model) {
    metadata.model = interval.model;
  } else {
    metadata.model = 'claude-opus-4-5-20251101';
  }

  const approval = await resolveConfidenceApproval(state, `self-improve:${taskType}`, `Task self-improve:${taskType}`);

  const task = {
    id: `self-improve-${taskType}-${Date.now().toString(36)}`,
    status: 'pending',
    priority: 'MEDIUM',
    priorityValue: PRIORITY_VALUES['MEDIUM'],
    description,
    metadata,
    taskType: 'internal',
    ...approval
  };

  return task;
}

/**
 * Get task descriptions for all self-improvement types
 * Extracted for reuse by on-demand task generation
 */
function getSelfImprovementTaskDescriptions() {
  return {
    'ui-bugs': `[Self-Improvement] UI Bug Analysis

Use Playwright MCP (browser_navigate, browser_snapshot, browser_console_messages) to analyze PortOS UI:

1. Navigate to ${PORTOS_UI_URL}/
2. Check each main route: /, /apps, /cos, /cos/tasks, /cos/agents, /devtools, /devtools/history, /providers, /usage
3. For each route:
   - Take a browser_snapshot to see the page structure
   - Check browser_console_messages for JavaScript errors
   - Look for broken UI elements, missing data, failed requests
4. Fix any bugs found in the React components or API routes
5. Run tests and commit changes

Use model: claude-opus-4-5-20251101 for thorough analysis`,

    'mobile-responsive': `[Self-Improvement] Mobile Responsiveness Analysis

Use Playwright MCP to test PortOS at different viewport sizes:

1. browser_resize to mobile (375x812), then navigate to ${PORTOS_UI_URL}/
2. Take browser_snapshot and analyze for:
   - Text overflow or truncation
   - Buttons too small to tap (< 44px)
   - Horizontal scrolling issues
   - Elements overlapping
   - Navigation usability
3. Repeat at tablet (768x1024) and desktop (1440x900)
4. Fix Tailwind CSS responsive classes (sm:, md:, lg:) as needed
5. Test fixes and commit changes

Focus on these routes: /cos, /cos/tasks, /devtools, /providers

Use model: claude-opus-4-5-20251101 for comprehensive fixes`,

    'security': `[Self-Improvement] Security Audit

Analyze PortOS codebase for security vulnerabilities:

1. Review server/routes/*.js for:
   - Command injection in exec/spawn calls
   - Path traversal in file operations
   - Missing input validation
   - XSS in rendered content

2. Review server/services/*.js for:
   - Unsafe eval() or Function()
   - Hardcoded credentials
   - SQL/NoSQL injection

3. Review client/src/ for:
   - XSS vulnerabilities in React
   - Sensitive data in localStorage
   - CSRF protection

4. Check server/lib/commandAllowlist.js is comprehensive

Fix any vulnerabilities and commit with security advisory notes.

Use model: claude-opus-4-5-20251101 for thorough security analysis`,

    'code-quality': `[Self-Improvement] Code Quality Review

Analyze PortOS codebase for maintainability:

1. Find DRY violations - similar code in multiple places
2. Identify functions >50 lines that should be split
3. Look for missing error handling
4. Find dead code and unused imports
5. Check for console.log that should be removed
6. Look for TODO/FIXME that need addressing

Focus on:
- server/services/*.js
- client/src/pages/*.jsx
- client/src/components/*.jsx

Refactor issues found and commit improvements.

Use model: claude-opus-4-5-20251101 for quality refactoring`,

    'accessibility': `[Self-Improvement] Accessibility Audit

Use Playwright MCP to audit PortOS accessibility:

1. Navigate to ${PORTOS_UI_URL}/
2. Use browser_snapshot to get accessibility tree
3. Check each main route for:
   - Missing ARIA labels
   - Missing alt text on images
   - Insufficient color contrast
   - Keyboard navigation issues
   - Focus indicators

4. Fix accessibility issues in React components
5. Add appropriate aria-* attributes
6. Test and commit changes

Use model: claude-opus-4-5-20251101 for comprehensive a11y fixes`,

    'console-errors': `[Self-Improvement] Console Error Investigation

Use Playwright MCP to find and fix console errors:

1. Navigate to ${PORTOS_UI_URL}/
2. Call browser_console_messages with level: "error"
3. Visit each route and capture errors:
   - /, /apps, /cos, /cos/tasks, /cos/agents
   - /devtools, /devtools/history, /devtools/runner
   - /providers, /usage, /prompts

4. For each error:
   - Identify the source file and line
   - Understand the root cause
   - Implement a fix

5. Test fixes and commit changes

Use model: claude-opus-4-5-20251101 for thorough debugging`,

    'performance': `[Self-Improvement] Performance Analysis

Analyze PortOS for performance issues:

1. Review React components for:
   - Unnecessary re-renders
   - Missing useMemo/useCallback
   - Large component files that should be split

2. Review server code for:
   - N+1 query patterns
   - Missing caching opportunities
   - Inefficient file operations

3. Review client bundle for:
   - Missing code splitting
   - Large dependencies that could be tree-shaken

4. Check Socket.IO for:
   - Event handler memory leaks
   - Unnecessary broadcasts

Optimize and commit improvements.

Use model: claude-opus-4-5-20251101 for performance optimization`,

    'test-coverage': `[Self-Improvement] Improve Test Coverage

Analyze and improve test coverage for PortOS:

1. Check existing tests in server/tests/ and client/tests/
2. Identify untested critical paths:
   - API routes without tests
   - Services with complex logic
   - Error handling paths

3. Add tests for:
   - CoS task evaluation logic
   - Agent spawning and lifecycle
   - Socket.IO event handlers
   - API endpoints

4. Ensure tests:
   - Follow existing patterns
   - Use appropriate mocks
   - Test edge cases

5. Run npm test to verify all tests pass
6. Commit test additions with clear message describing what's covered

Use model: claude-opus-4-5-20251101 for comprehensive test design`,

    'documentation': `[Self-Improvement] Update Documentation

Review and improve PortOS documentation:

1. Update PLAN.md and DONE.md:
   - Move completed milestones from PLAN.md to DONE.md
   - Add any new features implemented to DONE.md
   - Keep PLAN.md focused on next actions and future work

2. Check docs/ folder:
   - Are all features documented?
   - Is the information current?
   - Add any missing guides

3. Review code comments:
   - Add JSDoc to exported functions
   - Document complex algorithms
   - Explain non-obvious code

4. Update README.md if needed:
   - Installation instructions
   - Quick start guide
   - Feature overview

5. Consider adding:
   - Architecture diagrams
   - API documentation
   - Troubleshooting guide

Commit documentation improvements.

Use model: claude-opus-4-5-20251101 for clear documentation`,

    'feature-ideas': `[Self-Improvement] Implement a Feature Idea

Your goal is to implement ONE feature.

## Research Phase

1. Read GOALS.md for context on user goals and priorities
2. Read PLAN.md for the current roadmap and planned work (next actions, audit findings, future ideas)
3. Read DONE.md to understand what has already been implemented (avoid re-implementing existing features)
4. Search for existing feature idea documents:
   - Check .planning/research/FEATURES.md for planned features
   - Check .planning/ directory for any feature specs or research docs
   - Check data/COS-GOALS.md for CoS-specific goals
5. Review recent completed tasks to understand what's already been done
6. Review recent git log to see what's been implemented recently

## Selection Phase

7. Choose ONE feature to implement that:
   - Aligns with GOALS.md priorities
   - Is NOT already completed in DONE.md (avoid re-implementing shipped features)
   - Is NOT already planned in PLAN.md (avoid duplicating roadmap work)
   - Is NOT already documented in existing feature idea files
   - Is a small, self-contained improvement (completable in one session)
   - Saves user time, improves developer experience, or makes CoS more helpful

## Implementation Phase

8. Implement the feature:
   - Write clean, tested code
   - Follow existing patterns in the codebase
   - Run tests to ensure nothing is broken

9. Run \`/simplify\` to review changed code for reuse, quality, and efficiency. Fix any issues found.

10. Commit with a clear description of the feature and rationale

Use model: claude-opus-4-5-20251101 for creative feature development`,

    'dependency-updates': `[Self-Improvement] Dependency Updates and Security Audit

Check PortOS dependencies for updates and security vulnerabilities:

1. Run npm audit in both server/ and client/ directories
2. Check for outdated packages with npm outdated
3. Review CRITICAL and HIGH severity vulnerabilities
4. For each vulnerability:
   - Assess the actual risk (is the vulnerable code path used?)
   - Check if an update is available
   - Test that updates don't break functionality

5. Update dependencies carefully:
   - Update patch versions first (safest)
   - Then minor versions
   - Major versions need more careful review

6. After updating:
   - Run npm test in server/
   - Run npm run build in client/
   - Verify the app starts correctly

7. Commit with clear changelog of what was updated and why

IMPORTANT: Only update one major version bump at a time. If multiple major updates are needed, create separate commits for each.

Use model: claude-opus-4-5-20251101 for thorough security analysis`
  };
}

/**
 * Generate a comprehensive self-improvement task for a managed app
 * Rotates through analysis types similar to PortOS self-improvement
 *
 * Enhanced with configurable intervals:
 * - Respects per-task-type interval settings (daily, weekly, once per app, etc.)
 * - Checks for on-demand task requests first
 * - Records execution history for interval tracking
 *
 * @param {Object} app - The managed app object
 * @param {Object} state - Current CoS state
 * @returns {Object} Generated task
 */
/**
 * Check if a pipeline stage's precondition is met.
 * Supports { fileExists: 'path' } and { fileNotExists: 'path' }.
 * Paths are relative to repoPath.
 */
export function checkStagePrecondition(stage, repoPath) {
  const pre = stage?.precondition;
  if (!pre || !repoPath) return { passed: true };
  if (pre.fileExists) {
    const fullPath = join(repoPath, pre.fileExists);
    if (!existsSync(fullPath)) return { passed: false, reason: `${pre.fileExists} does not exist` };
  }
  if (pre.fileNotExists) {
    const fullPath = join(repoPath, pre.fileNotExists);
    if (existsSync(fullPath)) return { passed: false, reason: `${pre.fileNotExists} already exists` };
  }
  return { passed: true };
}

/**
 * Check stage 0 precondition after pipeline initialization.
 * Returns true if the task should be skipped (precondition failed).
 */
function shouldSkipForPrecondition(metadata, app, analysisType) {
  const stage0 = metadata.pipeline?.stages?.[0];
  if (!stage0?.precondition) return false;
  const check = checkStagePrecondition(stage0, app.repoPath);
  if (!check.passed) {
    emitLog('info', `⏭️ Skipping ${analysisType} for ${app.name}: ${check.reason}`, { appId: app.id, analysisType });
    return true;
  }
  return false;
}

/**
 * Initialize pipeline runtime state on metadata if pipeline stages are configured.
 * Mutates the metadata object in place.
 */
function initializePipelineMetadata(metadata) {
  if (!metadata.pipeline?.stages?.length) return;
  metadata.pipeline = {
    ...metadata.pipeline,
    id: `pipeline-${Date.now().toString(36)}`,
    currentStage: 0,
    stageResults: [],
    previousStageAgentId: null,
    status: 'running'
  };
  const stage0 = metadata.pipeline.stages[0];
  if (stage0.readOnly !== undefined) {
    metadata.readOnly = stage0.readOnly;
  }
  // Propagate stage 0's provider/model so the first agent uses per-stage config
  if (stage0.model) metadata.model = stage0.model;
  if (stage0.providerId) {
    metadata.provider = stage0.providerId;
    metadata.providerId = stage0.providerId;
  }
  // Save task-level defaults and apply stage 0 overrides in one pass
  // Read-only stages default flags to false to prevent worktree/PR/simplify on review-only stages
  metadata.pipeline.taskDefaults = {};
  const stageReadOnly = stage0.readOnly ?? false;
  for (const flag of PIPELINE_BEHAVIOR_FLAGS) {
    if (metadata[flag] !== undefined) metadata.pipeline.taskDefaults[flag] = metadata[flag];
    if (flag in stage0) {
      metadata[flag] = stage0[flag];
    } else if (stageReadOnly) {
      metadata[flag] = false;
    }
  }
}

// Apply app-level worktree/PR defaults only when not already set by task-type metadata.
// openPR is applied first since it implies useWorktree — this prevents defaultUseWorktree: false
// from blocking defaultOpenPR: true when both are app-level defaults.
export function applyAppWorktreeDefault(metadata, app) {
  const taskTypeDisabledWorktree = metadata.useWorktree === false || metadata.useWorktree === 'false';

  // Apply defaultOpenPR first (since openPR implies useWorktree)
  if (metadata.openPR === undefined) {
    if (app.defaultOpenPR === true && !taskTypeDisabledWorktree) {
      metadata.openPR = true;
      metadata.useWorktree = true; // openPR implies useWorktree
    } else if (app.defaultOpenPR === false || taskTypeDisabledWorktree) {
      metadata.openPR = false;
    }
  }

  // Apply defaultUseWorktree (only if not already set by task-type or openPR above)
  if (metadata.useWorktree === undefined) {
    // openPR implies useWorktree — don't let app default override explicit openPR: true
    const explicitOpenPR = metadata.openPR === true || metadata.openPR === 'true';
    if (explicitOpenPR) {
      metadata.useWorktree = true;
    } else if (app.defaultUseWorktree === true) {
      metadata.useWorktree = true;
    } else if (app.defaultUseWorktree === false) {
      metadata.useWorktree = false;
    }
  }

  // Final invariant: openPR implies useWorktree (normalize in both directions)
  const finalOpenPR = metadata.openPR === true || metadata.openPR === 'true';
  const finalWorktreeOff = metadata.useWorktree === false || metadata.useWorktree === 'false';
  if (finalOpenPR && finalWorktreeOff) {
    // openPR wins — force useWorktree on
    metadata.useWorktree = true;
  } else if (finalWorktreeOff) {
    metadata.openPR = false;
  }
}

async function generateManagedAppImprovementTask(app, state) {
  const { getAppActivityById, updateAppActivity } = await import('./appActivity.js');
  const taskSchedule = await import('./taskSchedule.js');

  // First, check for any on-demand task requests for this app
  const onDemandRequests = await taskSchedule.getOnDemandRequests();
  const appRequests = onDemandRequests.filter(r => r.appId === app.id);

  let nextType;
  let selectionReason;

  if (appRequests.length > 0) {
    const request = appRequests[0];
    await taskSchedule.clearOnDemandRequest(request.id);
    nextType = request.taskType;
    selectionReason = 'on-demand';
    emitLog('info', `Processing on-demand app task request: ${nextType} for ${app.name}`, { requestId: request.id });
  } else {
    // Get last improvement type for this app
    const appActivity = await getAppActivityById(app.id);
    const lastType = appActivity?.lastImprovementType || '';

    // Use the schedule service to determine the next task type
    const nextTypeResult = await taskSchedule.getNextTaskType(app.id, lastType);

    if (!nextTypeResult) {
      emitLog('info', `No app improvement tasks are eligible for ${app.name} based on schedule`);
      return null;
    }

    nextType = nextTypeResult.taskType;
    selectionReason = nextTypeResult.reason;
  }

  // Record execution in the schedule service
  await taskSchedule.recordExecution(`task:${nextType}`, app.id);

  // Update app activity with new type
  await updateAppActivity(app.id, {
    lastImprovementType: nextType
  });

  emitLog('info', `Generating improvement task for ${app.name}: ${nextType} (${selectionReason})`, { appId: app.id, analysisType: nextType });

  // Get interval settings to determine provider/model and pipeline config
  const interval = await taskSchedule.getTaskInterval(nextType);

  const metadata = {
    app: app.id,
    appName: app.name,
    repoPath: app.repoPath,
    analysisType: nextType,
    autoGenerated: true,
    comprehensiveImprovement: true
  };

  // Apply sanitized task-type-specific metadata from schedule config (e.g., useWorktree, simplify, pipeline)
  const sanitizedGlobalMeta = sanitizeTaskMetadata(interval.taskMetadata);
  if (sanitizedGlobalMeta) {
    Object.assign(metadata, sanitizedGlobalMeta);
  }

  // Apply sanitized per-app taskMetadata overrides (merge on top of global)
  const appOverrides = await getAppTaskTypeOverrides(app.id);
  const sanitizedAppMeta = sanitizeTaskMetadata(appOverrides[nextType]?.taskMetadata);
  if (sanitizedAppMeta) {
    Object.assign(metadata, sanitizedAppMeta);
  }

  initializePipelineMetadata(metadata);
  if (shouldSkipForPrecondition(metadata, app, nextType)) return null;

  const promptTemplate = metadata.pipeline?.stages
    ? await taskSchedule.getStagePrompt(nextType, 0)
    : await taskSchedule.getTaskPrompt(nextType);
  const description = promptTemplate
    .replace(/\{appName\}/g, app.name)
    .replace(/\{repoPath\}/g, app.repoPath)
    .replace(/\{appId\}/g, app.id);

  applyAppWorktreeDefault(metadata, app);

  if (interval.providerId) {
    metadata.provider = interval.providerId;
    metadata.providerId = interval.providerId;
  }
  if (interval.model) {
    metadata.model = interval.model;
  } else if (!metadata.provider) {
    // Only default to Claude when no per-stage provider overrides the selection
    metadata.model = 'claude-opus-4-5-20251101';
  }

  const approval = await resolveConfidenceApproval(state, `app-improve:${nextType}`, `Task app-improve:${nextType} for ${app.name}`);

  const task = {
    id: `app-improve-${app.id}-${nextType}-${Date.now().toString(36)}`,
    status: 'pending',
    priority: state.config.idleReviewPriority || 'MEDIUM',
    priorityValue: PRIORITY_VALUES[state.config.idleReviewPriority] || 2,
    description,
    metadata,
    taskType: 'internal',
    ...approval
  };

  return task;
}

/**
 * Generate a managed app improvement task for a specific type
 * Used by on-demand task processing and can be called directly
 *
 * @param {string} taskType - The type of improvement task (e.g., 'security-audit', 'code-quality')
 * @param {Object} app - The managed app object
 * @param {Object} state - Current CoS state
 * @returns {Object} Generated task
 */
async function generateManagedAppImprovementTaskForType(taskType, app, state, { skipPreconditions = false } = {}) {
  const { updateAppActivity } = await import('./appActivity.js');
  const taskSchedule = await import('./taskSchedule.js');

  // Update app activity with new type
  await updateAppActivity(app.id, {
    lastImprovementType: taskType
  });

  emitLog('info', `Generating improvement task for ${app.name}: ${taskType} (on-demand)`, { appId: app.id, analysisType: taskType });

  // Get interval settings to determine provider/model and pipeline config
  const interval = await taskSchedule.getTaskInterval(taskType);

  const metadata = {
    app: app.id,
    appName: app.name,
    repoPath: app.repoPath,
    analysisType: taskType,
    autoGenerated: true,
    comprehensiveImprovement: true
  };

  // Apply sanitized task-type-specific metadata from schedule config (e.g., useWorktree, simplify, pipeline)
  const sanitizedGlobalMeta = sanitizeTaskMetadata(interval.taskMetadata);
  if (sanitizedGlobalMeta) {
    Object.assign(metadata, sanitizedGlobalMeta);
  }

  // Apply sanitized per-app taskMetadata overrides (merge on top of global)
  const appOverrides = await getAppTaskTypeOverrides(app.id);
  const sanitizedAppMeta = sanitizeTaskMetadata(appOverrides[taskType]?.taskMetadata);
  if (sanitizedAppMeta) {
    Object.assign(metadata, sanitizedAppMeta);
  }

  initializePipelineMetadata(metadata);
  if (!skipPreconditions && shouldSkipForPrecondition(metadata, app, taskType)) return null;

  const promptTemplate = metadata.pipeline?.stages
    ? await taskSchedule.getStagePrompt(taskType, 0)
    : await taskSchedule.getTaskPrompt(taskType);
  const description = promptTemplate
    .replace(/\{appName\}/g, app.name)
    .replace(/\{repoPath\}/g, app.repoPath)
    .replace(/\{appId\}/g, app.id);

  applyAppWorktreeDefault(metadata, app);

  // Use configured model/provider if specified, otherwise use default
  if (interval.providerId) {
    metadata.provider = interval.providerId;
    metadata.providerId = interval.providerId;
  }
  if (interval.model) {
    metadata.model = interval.model;
  } else if (!metadata.provider) {
    // Only default to Claude when no per-stage provider overrides the selection
    metadata.model = 'claude-opus-4-5-20251101';
  }

  const approval = await resolveConfidenceApproval(state, `app-improve:${taskType}`, `Task app-improve:${taskType} for ${app.name}`);

  const task = {
    id: `app-improve-${app.id}-${taskType}-${Date.now().toString(36)}`,
    status: 'pending',
    priority: state.config.idleReviewPriority || 'MEDIUM',
    priorityValue: PRIORITY_VALUES[state.config.idleReviewPriority] || 2,
    description,
    metadata,
    taskType: 'internal',
    ...approval
  };

  return task;
}

/**
 * Run system health check
 */
export async function runHealthCheck() {
  if (!isDaemonRunning()) return;

  const state = await loadState();
  const issues = [];
  const metrics = {
    timestamp: new Date().toISOString(),
    pm2: null,
    memory: null,
    ports: null
  };

  // Check PM2 processes
  const pm2Result = await execPm2(['jlist']).catch(() => ({ stdout: '[]' }));
  // pm2 jlist may output ANSI codes and warnings before JSON, extract the JSON array
  // Look for '[{' (array with objects) or '[]' (empty array) to avoid matching ANSI codes like [31m
  const pm2Output = pm2Result.stdout || '[]';
  let jsonStart = pm2Output.indexOf('[{');
  if (jsonStart < 0) {
    // Check for empty array - find '[]' that's not part of ANSI codes
    const emptyMatch = pm2Output.match(/\[\](?![0-9])/);
    jsonStart = emptyMatch ? pm2Output.indexOf(emptyMatch[0]) : -1;
  }
  const pm2Json = jsonStart >= 0 ? pm2Output.slice(jsonStart) : '[]';
  const pm2Processes = safeJSONParse(pm2Json, [], { logError: true, context: 'pm2 process list' });

  metrics.pm2 = {
    total: pm2Processes.length,
    online: pm2Processes.filter(p => p.pm2_env?.status === 'online').length,
    errored: pm2Processes.filter(p => p.pm2_env?.status === 'errored').length,
    stopped: pm2Processes.filter(p => p.pm2_env?.status === 'stopped').length
  };

  // Check for runaway processes (too many)
  if (pm2Processes.length > state.config.maxTotalProcesses) {
    issues.push({
      type: 'warning',
      category: 'processes',
      message: `High process count: ${pm2Processes.length} PM2 processes (limit: ${state.config.maxTotalProcesses})`
    });
  }

  // Check for errored processes and auto-restart them
  const erroredProcesses = pm2Processes.filter(p => p.pm2_env?.status === 'errored');
  if (erroredProcesses.length > 0) {
    const names = erroredProcesses.map(p => p.name);
    emitLog('warn', `🔄 ${names.length} errored PM2 process(es) detected: ${names.join(', ')} — attempting restart`);

    const restartResults = await Promise.all(names.map(async (name) => {
      const result = await execFileAsync('pm2', ['restart', name], { shell: process.platform === 'win32' }).catch(e => ({ stdout: '', stderr: e.message }));
      const failed = result.stderr && !result.stdout;
      if (failed) {
        emitLog('error', `❌ Failed to restart ${name}: ${result.stderr}`);
      } else {
        emitLog('success', `✅ Auto-restarted errored process: ${name}`);
      }
      return { name, success: !failed };
    }));

    const failedRestarts = restartResults.filter(r => !r.success);
    if (failedRestarts.length > 0) {
      issues.push({
        type: 'error',
        category: 'processes',
        message: `${failedRestarts.length} errored PM2 process(es) failed to auto-restart: ${failedRestarts.map(r => r.name).join(', ')}`
      });
    }

    const succeededRestarts = restartResults.filter(r => r.success);
    if (succeededRestarts.length > 0) {
      issues.push({
        type: 'warning',
        category: 'processes',
        message: `Auto-restarted ${succeededRestarts.length} errored PM2 process(es): ${succeededRestarts.map(r => r.name).join(', ')}`
      });
    }
  }

  // Check memory usage per process
  const highMemoryProcesses = pm2Processes.filter(p => {
    const memMb = (p.monit?.memory || 0) / (1024 * 1024);
    return memMb > state.config.maxProcessMemoryMb;
  });

  if (highMemoryProcesses.length > 0) {
    issues.push({
      type: 'warning',
      category: 'memory',
      message: `High memory usage in: ${highMemoryProcesses.map(p => `${p.name} (${Math.round((p.monit?.memory || 0) / (1024 * 1024))}MB)`).join(', ')}`
    });
  }

  // Get system memory
  const memCmd = process.platform === 'win32' ? 'wmic OS get FreePhysicalMemory,TotalVisibleMemorySize /VALUE' :
    process.platform === 'darwin' ? 'vm_stat' : 'free -m';
  const memResult = await execAsync(memCmd, { windowsHide: true }).catch(() => ({ stdout: '' }));
  metrics.memory = { raw: memResult.stdout.slice(0, 500) }; // Truncate for storage

  // Store health check result with lock to prevent race conditions
  await withStateLock(async () => {
    const freshState = await loadState();
    freshState.stats.lastHealthCheck = metrics.timestamp;
    freshState.stats.healthIssues = issues;
    await saveState(freshState);
  });

  cosEvents.emit('health:check', { metrics, issues });

  // If there are critical issues, emit for potential automated response
  if (issues.filter(i => i.type === 'error').length > 0) {
    cosEvents.emit('health:critical', issues.filter(i => i.type === 'error'));
  }

  return { metrics, issues };
}

/**
 * Get latest health status
 */
export async function getHealthStatus() {
  const state = await loadState();
  return {
    lastCheck: state.stats.lastHealthCheck,
    issues: state.stats.healthIssues || []
  };
}

/**
 * Save a generated script
 */
export async function saveScript(name, content, metadata = {}) {
  await ensureDirectories();
  const scriptPath = join(SCRIPTS_DIR, `${name}.sh`);
  await writeFile(scriptPath, content, { mode: 0o755 });

  // Save metadata
  const metaPath = join(SCRIPTS_DIR, `${name}.json`);
  await writeFile(metaPath, JSON.stringify({
    name,
    createdAt: new Date().toISOString(),
    ...metadata
  }, null, 2));

  return { path: scriptPath, name };
}

/**
 * List generated scripts
 */
export async function listScripts() {
  await ensureDirectories();
  const files = await readdir(SCRIPTS_DIR);
  return files.filter(f => f.endsWith('.sh')).map(f => f.replace('.sh', ''));
}

/**
 * Get script content
 */
export async function getScript(name) {
  const scriptPath = join(SCRIPTS_DIR, `${name}.sh`);
  const metaPath = join(SCRIPTS_DIR, `${name}.json`);

  if (!existsSync(scriptPath)) return null;

  const content = await readFile(scriptPath, 'utf-8');
  const metadata = existsSync(metaPath)
    ? safeJSONParse(await readFile(metaPath, 'utf-8'), {}, { logError: true, context: `script metadata ${name}` })
    : {};

  return { name, content, metadata };
}

// Agent and report functions are now in cosAgents.js and cosReports.js
// Re-exported above for backward compat with `import * as cos from './cos.js'`

/**
 * Check if daemon is running
 */
export function isRunning() {
  return isDaemonRunning();
}

/**
 * Add a new task to TASKS.md or COS-TASKS.md
 */
export async function addTask(taskData, taskType = 'user', { raw = false } = {}) {
  return withStateLock(async () => {
  const state = await loadState();
  const filePath = taskType === 'user'
    ? join(ROOT_DIR, state.config.userTasksFile)
    : join(ROOT_DIR, state.config.cosTasksFile);

  // Read existing tasks or start fresh
  let tasks = [];
  if (existsSync(filePath)) {
    const content = await readFile(filePath, 'utf-8');
    tasks = parseTasksMarkdown(content);
  }

  // Reject duplicate: same description already pending or in_progress
  const normalizedDesc = taskData.description.trim().toLowerCase();
  const duplicate = tasks.find(t =>
    (t.status === 'pending' || t.status === 'in_progress') &&
    t.description?.trim().toLowerCase() === normalizedDesc
  );
  if (duplicate) {
    console.log(`⚠️ Duplicate task rejected: "${taskData.description.substring(0, 60)}" matches ${duplicate.id}`);
    return { ...duplicate, duplicate: true };
  }

  // When raw=true, use the pre-built task object directly (for on-demand/generated tasks)
  let newTask;
  if (raw) {
    newTask = taskData;
  } else {
    // Generate a unique ID if not provided
    const id = taskData.id || `${taskType === 'user' ? 'task' : 'sys'}-${Date.now().toString(36)}`;

    // Build metadata object
    const metadata = {};
    if (taskData.context) metadata.context = taskData.context;
    if (taskData.model) metadata.model = taskData.model;
    if (taskData.provider) metadata.provider = taskData.provider;
    if (taskData.app) metadata.app = taskData.app;
    if (taskData.createJiraTicket) metadata.createJiraTicket = true;
    // Boolean flags: persist both true and false so users can explicitly override defaults.
    // The string round-trip ('false' from TASKS.md) is handled by isTruthyMeta/isFalsyMeta.
    // undefined means "use app defaults".
    if (taskData.useWorktree === true) metadata.useWorktree = true;
    else if (taskData.useWorktree === false) metadata.useWorktree = false;
    if (taskData.openPR === true) metadata.openPR = true;
    else if (taskData.openPR === false) metadata.openPR = false;
    if (taskData.simplify === true) metadata.simplify = true;
    else if (taskData.simplify === false) metadata.simplify = false;
    if (taskData.reviewLoop === true) metadata.reviewLoop = true;
    else if (taskData.reviewLoop === false) metadata.reviewLoop = false;
    if (taskData.jiraTicketId) metadata.jiraTicketId = taskData.jiraTicketId;
    if (taskData.jiraTicketUrl) metadata.jiraTicketUrl = taskData.jiraTicketUrl;
    if (taskData.screenshots?.length > 0) metadata.screenshots = taskData.screenshots;
    if (taskData.attachments?.length > 0) metadata.attachments = taskData.attachments;

    // Create the new task
    newTask = {
      id: hasKnownPrefix(id) ? id : `${taskType === 'user' ? 'task' : 'sys'}-${id}`,
      status: 'pending',
      priority: (taskData.priority || 'MEDIUM').toUpperCase(),
      priorityValue: PRIORITY_VALUES[taskData.priority?.toUpperCase()] || 2,
      description: taskData.description,
      metadata,
      approvalRequired: taskType === 'internal' && taskData.approvalRequired,
      autoApproved: taskType === 'internal' && !taskData.approvalRequired,
      section: 'pending'
    };
  }

  // Add task to top or bottom based on position parameter
  if (taskData.position === 'top') {
    tasks.unshift(newTask);
  } else {
    tasks.push(newTask);
  }

  // Write back to file
  const includeApprovalFlags = taskType === 'internal';
  const markdown = generateTasksMarkdown(tasks, includeApprovalFlags);
  await writeFile(filePath, markdown);

  cosEvents.emit('tasks:changed', { type: taskType, action: 'added', task: newTask });

  // Immediately attempt to spawn user tasks if slots are available
  // This avoids waiting for the next evaluation interval (which is meant for system task generation)
  if (taskType === 'user') {
    setImmediate(() => tryImmediateSpawn(newTask));
  }

  return newTask;
  });
}

/**
 * Attempt to immediately spawn a newly added user task if there are available agent slots.
 * This bypasses the evaluation interval for user-submitted tasks so they start instantly.
 */
async function tryImmediateSpawn(task) {
  if (!isDaemonRunning()) return;

  const paused = await isPaused();
  if (paused) return;

  const state = await loadState();
  const runningAgents = Object.values(state.agents).filter(a => a.status === 'running').length;
  const availableSlots = state.config.maxConcurrentAgents - runningAgents;

  if (availableSlots <= 0) {
    emitLog('debug', `⏳ Queued task ${task.id} - no available slots (${runningAgents}/${state.config.maxConcurrentAgents})`);
    return;
  }

  // Check per-project limit
  const perProjectLimit = state.config.maxConcurrentAgentsPerProject || state.config.maxConcurrentAgents;
  const agentsByProject = countRunningAgentsByProject(state.agents);
  if (!isWithinProjectLimit(task, agentsByProject, perProjectLimit)) {
    const project = task.metadata?.app || '_self';
    emitLog('debug', `⏳ Queued task ${task.id} - per-project limit reached for ${project} (${agentsByProject[project] || 0}/${perProjectLimit})`);
    return;
  }

  emitLog('info', `⚡ Immediate spawn: ${task.id} (${task.priority || 'MEDIUM'})`, {
    taskId: task.id,
    availableSlots
  });
  cosEvents.emit('task:ready', { ...task, taskType: 'user' });
}

/**
 * Event-driven task dequeue — the primary way tasks get spawned.
 *
 * Triggered by: agent:completed, tasks:user:added, tasks:cos:added, status:resumed
 * Fills all available slots using the same priority order as evaluateTasks:
 *   0. On-demand requests
 *   1. User tasks
 *   2. Auto-approved system tasks
 *   3. Mission-driven proactive tasks (if proactiveMode)
 *   4. Idle review task (if idleReviewEnabled)
 * Returns silently when idle — no log noise.
 */
async function dequeueNextTask() {
  if (!isDaemonRunning()) return;

  const paused = await isPaused();
  if (paused) return;

  const state = await loadState();
  const runningAgents = Object.values(state.agents).filter(a => a.status === 'running').length;
  const availableSlots = state.config.maxConcurrentAgents - runningAgents;

  if (availableSlots <= 0) return;

  const perProjectLimit = state.config.maxConcurrentAgentsPerProject || state.config.maxConcurrentAgents;
  const agentsByProject = countRunningAgentsByProject(state.agents);
  const spawnProjectCounts = { ...agentsByProject };
  let spawned = 0;

  const canSpawn = (task) => {
    if (spawned >= availableSlots) return false;
    const project = task.metadata?.app || '_self';
    return (spawnProjectCounts[project] || 0) < perProjectLimit;
  };

  const trackSpawn = (task) => {
    const project = task.metadata?.app || '_self';
    spawnProjectCounts[project] = (spawnProjectCounts[project] || 0) + 1;
    spawned++;
  };

  // Priority 0: On-demand task requests
  const taskScheduleMod = await import('./taskSchedule.js');
  const taskSchedule = await taskScheduleMod.loadSchedule();
  const onDemandRequests = await taskScheduleMod.getOnDemandRequests();

  for (const request of onDemandRequests) {
    if (spawned >= availableSlots) break;

    // Unified on-demand handling (no category split)
    const improvEnabled = state.config.improvementEnabled ??
      (state.config.selfImprovementEnabled || state.config.appImprovementEnabled);
    if (!improvEnabled) {
      await taskScheduleMod.clearOnDemandRequest(request.id);
      continue;
    }

    // Skip if the task type was disabled after queuing
    if (!taskSchedule.tasks[request.taskType]?.enabled) {
      emitLog('info', `On-demand request skipped — task type '${request.taskType}' is disabled`, { requestId: request.id });
      await taskScheduleMod.clearOnDemandRequest(request.id);
      continue;
    }

    let task = null;
    const apps = await getActiveApps().catch(() => []);
    let targetApp = null;

    if (request.appId) {
      targetApp = apps.find(a => a.id === request.appId);
      if (!targetApp) {
        emitLog('warn', `On-demand request for unknown app: ${request.appId}`, { requestId: request.id });
        await taskScheduleMod.clearOnDemandRequest(request.id);
        continue;
      }
    }

    await taskScheduleMod.clearOnDemandRequest(request.id);

    if (targetApp) {
      emitLog('info', `Processing on-demand improvement: ${request.taskType} for ${targetApp.name}`, { requestId: request.id, appId: targetApp.id });
      await markAppReviewStarted(targetApp.id, `on-demand-${Date.now()}`);
      await taskScheduleMod.recordExecution(`task:${request.taskType}`, targetApp.id);
      task = await generateManagedAppImprovementTaskForType(request.taskType, targetApp, state, { skipPreconditions: true });
    } else {
      emitLog('info', `Processing on-demand improvement: ${request.taskType}`, { requestId: request.id });
      await taskScheduleMod.recordExecution(`task:${request.taskType}`);
      await withStateLock(async () => {
        const s = await loadState();
        s.stats.lastSelfImprovement = new Date().toISOString();
        s.stats.lastSelfImprovementType = request.taskType;
        await saveState(s);
      });
      task = await generateSelfImprovementTaskForType(request.taskType, state);
    }

    if (task && canSpawn(task)) {
      const persisted = await addTask(task, 'internal', { raw: true });
      if (!persisted?.duplicate) {
        cosEvents.emit('task:ready', task);
        trackSpawn(task);
      }
    }
  }

  // Priority 1: User tasks
  const userTaskData = await getUserTasks();
  const pendingUserTasks = userTaskData.grouped?.pending || [];

  for (const task of pendingUserTasks) {
    if (spawned >= availableSlots) break;
    if (await blockIfExceedsMaxSpawns(task, 'user')) continue;
    const userTask = { ...task, taskType: 'user' };
    if (!canSpawn(userTask)) continue;
    cosEvents.emit('task:ready', userTask);
    trackSpawn(userTask);
  }

  // Priority 2: Auto-approved system tasks
  const cosTaskData = await getCosTasks();
  const autoApproved = cosTaskData.autoApproved || [];

  for (const task of autoApproved) {
    if (spawned >= availableSlots) break;
    if (await blockIfExceedsMaxSpawns(task, 'internal')) continue;
    // Skip improvement tasks whose type was disabled after queuing
    const analysisType = task.metadata?.analysisType || task.metadata?.selfImprovementType;
    if (analysisType && !taskSchedule.tasks[analysisType]?.enabled) {
      emitLog('info', `System task skipped — task type '${analysisType}' is disabled`, { taskId: task.id });
      continue;
    }
    const appId = task.metadata?.app;
    if (appId) {
      const onCooldown = await isAppOnCooldown(appId, state.config.appReviewCooldownMs);
      if (onCooldown) continue;
    }
    const sysTask = { ...task, taskType: 'internal' };
    if (!canSpawn(sysTask)) continue;
    cosEvents.emit('task:ready', sysTask);
    trackSpawn(sysTask);
  }

  const hasPendingUserTasks = pendingUserTasks.length > 0;

  // Priority 3: Mission-driven proactive tasks
  if (spawned < availableSlots && !hasPendingUserTasks && state.config.proactiveMode) {
    const missionTasks = await generateMissionTasks({ maxTasks: availableSlots - spawned }).catch(err => {
      emitLog('debug', `Mission task generation failed: ${err.message}`);
      return [];
    });

    for (const missionTask of missionTasks) {
      if (spawned >= availableSlots) break;
      const cosTask = {
        id: missionTask.id,
        description: missionTask.description,
        priority: missionTask.priority?.toUpperCase() || 'MEDIUM',
        status: 'pending',
        metadata: missionTask.metadata,
        taskType: 'internal',
        approvalRequired: !missionTask.autoApprove
      };
      if (!canSpawn(cosTask)) continue;
      cosEvents.emit('task:ready', cosTask);
      trackSpawn(cosTask);
      emitLog('info', `Generated mission task: ${missionTask.id}`, {
        missionId: missionTask.metadata?.missionId
      });
    }
  }

  // Priority 4: Idle review task (only when completely idle)
  if (spawned === 0 && state.config.idleReviewEnabled && !hasPendingUserTasks) {
    const freshCosTasks = await getCosTasks();
    const pendingSystemTasks = freshCosTasks.autoApproved?.length || 0;
    if (pendingSystemTasks === 0) {
      const idleTask = await generateIdleReviewTask(state);
      if (idleTask && canSpawn(idleTask)) {
        cosEvents.emit('task:ready', idleTask);
        trackSpawn(idleTask);
      }
    }
  }

  if (spawned > 0) {
    emitLog('info', `⚡ Dequeued ${spawned} task(s)`, { spawned, availableSlots });
  }
}

const PRIORITY_VALUES = {
  'CRITICAL': 4,
  'HIGH': 3,
  'MEDIUM': 2,
  'LOW': 1
};

/**
 * Update an existing task
 */
export async function updateTask(taskId, updates, taskType = 'user') {
  return withStateLock(async () => {
  const state = await loadState();
  const filePath = taskType === 'user'
    ? join(ROOT_DIR, state.config.userTasksFile)
    : join(ROOT_DIR, state.config.cosTasksFile);

  if (!existsSync(filePath)) {
    console.log(`⚠️ updateTask: file not found for ${taskId} (taskType=${taskType}, path=${filePath})`);
    return { error: 'Task file not found' };
  }

  const content = await readFile(filePath, 'utf-8');
  let tasks = parseTasksMarkdown(content);

  const taskIndex = tasks.findIndex(t => t.id === taskId);
  if (taskIndex === -1) {
    console.log(`⚠️ updateTask: task ${taskId} not found in ${filePath} (taskType=${taskType}, parsed ${tasks.length} tasks, status update: ${updates.status || 'none'})`);
    return { error: 'Task not found' };
  }

  // Build updated metadata - merge existing with any new metadata
  const updatedMetadata = {
    ...tasks[taskIndex].metadata,
    ...(updates.metadata || {})
  };
  // Handle legacy fields that may be passed directly in updates
  if (updates.context !== undefined) updatedMetadata.context = updates.context || undefined;
  if (updates.model !== undefined) updatedMetadata.model = updates.model || undefined;
  if (updates.provider !== undefined) updatedMetadata.provider = updates.provider || undefined;
  if (updates.app !== undefined) updatedMetadata.app = updates.app || undefined;

  // Clear blocked/failure metadata when transitioning out of blocked status
  if (updates.status && updates.status !== 'blocked' && tasks[taskIndex].status === 'blocked') {
    for (const key of ['blocker', 'blockedReason', 'blockedCategory', 'blockedAt', 'failureCount', 'lastErrorCategory', 'lastFailureAt']) {
      delete updatedMetadata[key];
    }
  }

  // Clean undefined values from metadata
  Object.keys(updatedMetadata).forEach(key => {
    if (updatedMetadata[key] === undefined) delete updatedMetadata[key];
  });

  // Update the task
  const updatedTask = {
    ...tasks[taskIndex],
    ...(updates.description && { description: updates.description }),
    ...(updates.priority && {
      priority: updates.priority.toUpperCase(),
      priorityValue: PRIORITY_VALUES[updates.priority.toUpperCase()] || 2
    }),
    ...(updates.status && { status: updates.status }),
    metadata: updatedMetadata
  };

  tasks[taskIndex] = updatedTask;

  // Write back to file
  const includeApprovalFlags = taskType === 'internal';
  const markdown = generateTasksMarkdown(tasks, includeApprovalFlags);
  await writeFile(filePath, markdown);

  cosEvents.emit('tasks:changed', { type: taskType, action: 'updated', task: updatedTask });
  return updatedTask;
  });
}

/**
 * Delete a task
 */
export async function deleteTask(taskId, taskType = 'user') {
  return withStateLock(async () => {
  const state = await loadState();
  const filePath = taskType === 'user'
    ? join(ROOT_DIR, state.config.userTasksFile)
    : join(ROOT_DIR, state.config.cosTasksFile);

  if (!existsSync(filePath)) {
    return { error: 'Task file not found' };
  }

  const content = await readFile(filePath, 'utf-8');
  let tasks = parseTasksMarkdown(content);

  const taskToDelete = tasks.find(t => t.id === taskId);
  if (!taskToDelete) {
    return { error: 'Task not found' };
  }

  tasks = tasks.filter(t => t.id !== taskId);

  // Write back to file
  const includeApprovalFlags = taskType === 'internal';
  const markdown = generateTasksMarkdown(tasks, includeApprovalFlags);
  await writeFile(filePath, markdown);

  cosEvents.emit('tasks:changed', { type: taskType, action: 'deleted', taskId });
  return { success: true, taskId };
  });
}

/**
 * Reorder user tasks based on an array of task IDs
 */
export async function reorderTasks(taskIds) {
  return withStateLock(async () => {
  const state = await loadState();
  const filePath = join(ROOT_DIR, state.config.userTasksFile);

  if (!existsSync(filePath)) {
    return { error: 'Task file not found' };
  }

  const content = await readFile(filePath, 'utf-8');
  const tasks = parseTasksMarkdown(content);

  // Create a map of tasks by ID for quick lookup
  const taskMap = new Map(tasks.map(t => [t.id, t]));

  // Reorder based on the provided order
  const reorderedTasks = [];
  for (const id of taskIds) {
    const task = taskMap.get(id);
    if (task) {
      reorderedTasks.push(task);
      taskMap.delete(id);
    }
  }

  // Append any tasks not in the provided order (shouldn't happen, but safe)
  for (const task of taskMap.values()) {
    reorderedTasks.push(task);
  }

  // Write back to file
  const markdown = generateTasksMarkdown(reorderedTasks, false);
  await writeFile(filePath, markdown);

  cosEvents.emit('tasks:changed', { type: 'user', action: 'reordered' });
  return { success: true, order: reorderedTasks.map(t => t.id) };
  });
}

/**
 * Approve a task that requires approval (marks it as auto-approved)
 */
export async function approveTask(taskId) {
  return withStateLock(async () => {
  const state = await loadState();
  const filePath = join(ROOT_DIR, state.config.cosTasksFile);

  if (!existsSync(filePath)) {
    return { error: 'CoS task file not found' };
  }

  const content = await readFile(filePath, 'utf-8');
  let tasks = parseTasksMarkdown(content);

  const taskIndex = tasks.findIndex(t => t.id === taskId);
  if (taskIndex === -1) {
    return { error: 'Task not found' };
  }

  if (!tasks[taskIndex].approvalRequired) {
    return { error: 'Task does not require approval' };
  }

  // Update approval flags
  tasks[taskIndex] = {
    ...tasks[taskIndex],
    approvalRequired: false,
    autoApproved: true
  };

  // Write back to file
  const markdown = generateTasksMarkdown(tasks, true);
  await writeFile(filePath, markdown);

  cosEvents.emit('tasks:changed', { type: 'internal', action: 'approved', task: tasks[taskIndex] });

  // Immediately attempt to spawn the newly approved task
  setImmediate(() => dequeueNextTask());

  return tasks[taskIndex];
  });
}

/**
 * Compute the next fire time for an autonomous job.
 * Supports two scheduling modes:
 * 1. Cron mode: job.cronExpression defines the full schedule
 * 2. Interval mode: job.intervalMs + optional job.scheduledTime (HH:MM in user timezone)
 *
 * @param {Object} job - The job object
 * @param {string} timezone - IANA timezone string for interpreting scheduledTime/cron
 * @returns {number} Timestamp (ms) of next fire time
 */
function computeNextJobFireTime(job, timezone) {
  // Convert scheduledTime (HH:MM) + interval to a cron expression so parseCronToNextRun
  // handles all "next occurrence after lastRun" logic without drift issues.
  // Only synthesize a daily/weekday cron for strictly daily or weekdaysOnly jobs.
  // Weekly/biweekly/sub-daily interval jobs fall through to the interval path below,
  // which correctly computes lastRun + intervalMs without scheduling them every day.
  // e.g. { interval: 'daily', scheduledTime: '04:30' } → '30 4 * * *'
  let cronExpr = job.cronExpression;
  const isDailyCronCandidate = job.interval === 'daily' || job.weekdaysOnly;
  if (!cronExpr && job.scheduledTime && isDailyCronCandidate) {
    const match = String(job.scheduledTime).match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (match) {
      const dayField = job.weekdaysOnly ? '1-5' : '*';
      cronExpr = `${Number(match[2])} ${Number(match[1])} * * ${dayField}`;
    }
  }

  if (cronExpr) {
    const from = job.lastRun ? new Date(job.lastRun) : new Date();
    const next = parseCronToNextRun(cronExpr, from, timezone);
    if (!next) {
      throw new Error(
        `Invalid cron expression for autonomous job` +
        (job.id ? ` "${job.id}"` : '') +
        `: ${cronExpr}`
      );
    }
    return next.getTime();
  }

  // Interval fallback: lastRun + intervalMs, then align to scheduledTime if set
  const lastRun = job.lastRun ? new Date(job.lastRun).getTime() : 0;
  let nextDue = lastRun + job.intervalMs;

  // Restore scheduledTime alignment for interval-mode jobs (e.g. weekly at 00:00).
  // nextLocalTime advances nextDue to the next occurrence of HH:MM in the user's timezone,
  // preventing drift when a run occurs slightly late.
  if (job.scheduledTime) {
    const match = String(job.scheduledTime).match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (match) {
      const candidate = nextLocalTime(nextDue, Number(match[1]), Number(match[2]), timezone);
      if (candidate > nextDue) nextDue = candidate;
    }
  }

  if (job.weekdaysOnly) {
    const { dayOfWeek } = getLocalParts(new Date(nextDue), timezone);
    if (dayOfWeek === 0) nextDue += 24 * 60 * 60 * 1000; // Sunday → Monday
    if (dayOfWeek === 6) nextDue += 2 * 24 * 60 * 60 * 1000; // Saturday → Monday
  }

  return nextDue;
}

/**
 * Register a single autonomous job as a one-shot scheduled event.
 * After execution, re-registers for the next fire time.
 */
async function registerSingleJobSchedule(jobId) {
  const { getJob } = await import('./autonomousJobs.js');
  const job = await getJob(jobId);
  if (!job || !job.enabled) {
    cancelEvent(`job:${jobId}`);
    return;
  }

  const timezone = await getUserTimezone();
  const nextFire = computeNextJobFireTime(job, timezone);
  const delayMs = Math.max(nextFire - Date.now(), 1000);

  scheduleEvent({
    id: `job:${jobId}`,
    type: 'once',
    delayMs,
    handler: () => executeScheduledJob(jobId),
    metadata: { description: `Autonomous job: ${job.name}`, jobId }
  });
}

// Track jobs currently being spawned (between task:ready emit and agent registration)
// to prevent duplicate spawns when timers overlap or fire during spawn
const spawningJobIds = new Set();
const spawningJobTimeouts = new Map();

function addSpawningJob(jobId) {
  spawningJobIds.add(jobId);
  // Auto-clear after 5 minutes if spawn never completes, and re-register the timer
  if (spawningJobTimeouts.has(jobId)) clearTimeout(spawningJobTimeouts.get(jobId));
  spawningJobTimeouts.set(jobId, setTimeout(() => {
    spawningJobIds.delete(jobId);
    spawningJobTimeouts.delete(jobId);
    emitLog('warn', `Job ${jobId} spawning timed out after 5m, re-registering schedule`, { jobId });
    registerSingleJobSchedule(jobId).catch(err =>
      console.error(`❌ Failed to re-register job schedule after spawn timeout for ${jobId}: ${err.message}`)
    );
  }, 5 * 60 * 1000));
}

function clearSpawningJob(jobId) {
  spawningJobIds.delete(jobId);
  const timeout = spawningJobTimeouts.get(jobId);
  if (timeout) {
    clearTimeout(timeout);
    spawningJobTimeouts.delete(jobId);
  }
}

/**
 * Execute a scheduled autonomous job and re-register its timer.
 */
async function executeScheduledJob(jobId) {
  if (!isDaemonRunning()) return;

  const paused = await isPaused();
  if (paused) {
    // Re-register for later
    await registerSingleJobSchedule(jobId);
    return;
  }

  const { getJob } = await import('./autonomousJobs.js');
  const job = await getJob(jobId);
  if (!job || !job.enabled) return;

  const state = await loadState();
  if (!state.config.autonomousJobsEnabled) {
    // Re-register so it fires when re-enabled
    await registerSingleJobSchedule(jobId);
    return;
  }

  // Script jobs and shell jobs execute directly without spawning an AI agent
  if (isScriptJob(job)) {
    const scriptOk = await executeScriptJob(job).then(() => true, err => {
      emitLog('error', `Script job failed: ${job.name} - ${err.message}`, { jobId: job.id });
      return false;
    });
    if (scriptOk) emitLog('info', `Script job executed: ${job.name}`, { jobId: job.id });
  } else if (isShellJob(job)) {
    const shellOk = await executeShellJob(job).then(() => true, err => {
      emitLog('error', `Shell job failed: ${job.name} - ${err.message}`, { jobId: job.id });
      return false;
    });
    if (shellOk) emitLog('info', `Shell job executed: ${job.name}`, { jobId: job.id });
  } else {
    // Check if this job is already being spawned or has a running agent.
    // Don't re-register the timer here — the job:spawned handler will do it
    // after recordJobExecution updates lastRun. Re-registering with stale
    // lastRun causes a 1-second re-fire loop.
    if (spawningJobIds.has(jobId)) {
      emitLog('debug', `Job ${job.name} skipped - already spawning`, { jobId });
      return;
    }
    const agentAlreadyRunning = Object.values(state.agents).some(
      a => a.status === 'running' && a.metadata?.jobId === jobId
    );
    if (agentAlreadyRunning) {
      emitLog('debug', `Job ${job.name} skipped - agent already running`, { jobId });
      return;
    }

    // Check capacity before spawning an agent
    const runningAgents = Object.values(state.agents).filter(a => a.status === 'running').length;
    if (runningAgents >= state.config.maxConcurrentAgents) {
      emitLog('debug', `Job ${job.name} deferred - no agent slots`, { jobId });
      // Retry in 60s
      scheduleEvent({
        id: `job:${jobId}`,
        type: 'once',
        delayMs: 60000,
        handler: () => executeScheduledJob(jobId),
        metadata: { description: `Autonomous job: ${job.name} (retry)`, jobId }
      });
      return;
    }

    // Run gate check — skip LLM if precondition not met
    // Gate errors fail-open (run the job) to avoid silently dropping scheduled work
    let gateResult;
    try {
      gateResult = await checkJobGate(jobId);
    } catch (gateErr) {
      emitLog('warn', `Job ${job.name} gate error, failing open: ${gateErr?.message || gateErr}`, { jobId });
      gateResult = { shouldRun: true, reason: 'Gate error — failing open' };
    }
    if (!gateResult.shouldRun) {
      emitLog('debug', `Job ${job.name} gate skipped: ${gateResult.reason}`, { jobId, gate: gateResult });
      // Update lastRun so the job reschedules at its normal interval, but don't increment runCount
      await recordJobGateSkip(jobId).catch(err =>
        console.error(`❌ Failed to record gate-skip for ${jobId}: ${err.message}`)
      );
      await registerSingleJobSchedule(jobId);
      return;
    }
    if (hasGate(jobId)) {
      emitLog('info', `Job ${job.name} gate passed: ${gateResult.reason}`, { jobId, gate: gateResult });
    }

    // Mark as spawning before emitting task:ready to prevent races
    addSpawningJob(jobId);
    try {
      const task = await generateTaskFromJob(job);
      emitLog('info', `Autonomous job firing: ${job.name}`, { jobId, category: job.category });
      cosEvents.emit('task:ready', task);
      // Don't re-register timer here — lastRun hasn't been updated yet, so
      // computeNextJobFireTime would return a past-due time and the timer would
      // fire in 1s, creating a rapid re-fire loop. The job:spawned handler
      // re-registers after recordJobExecution updates lastRun.
      return;
    } catch (err) {
      clearSpawningJob(jobId);
      emitLog('error', `Failed to fire autonomous job: ${job.name} - ${err?.message || err}`, { jobId, category: job.category });
    }
  }

  // Re-register for next fire time (script/shell jobs, early returns, and error paths)
  await registerSingleJobSchedule(jobId);
}

/**
 * Register all enabled autonomous jobs as individual one-shot scheduled events.
 */
async function registerJobSchedules() {
  const { getEnabledJobs } = await import('./autonomousJobs.js');
  const jobs = await getEnabledJobs();

  for (const job of jobs) {
    await registerSingleJobSchedule(job.id);
  }

  if (jobs.length > 0) {
    emitLog('info', `📅 Registered ${jobs.length} autonomous job schedule(s)`);
  }
}

/**
 * Cancel all autonomous job scheduled events.
 */
async function unregisterJobSchedules() {
  const { getAllJobs } = await import('./autonomousJobs.js');
  const jobs = await getAllJobs();

  for (const job of jobs) {
    cancelEvent(`job:${job.id}`);
  }
}

/**
 * Schedule a one-shot timer for the next due improvement task.
 * When it fires, queues eligible improvement tasks and re-schedules.
 */
async function scheduleNextImprovementCheck() {
  if (!isDaemonRunning()) return;

  const taskSchedule = await import('./taskSchedule.js');
  const upcoming = await taskSchedule.getUpcomingTasks(1);

  // Default: check again in 1 hour if nothing scheduled
  // Cap at 1 hour so per-app cron tasks (e.g. feature-ideas at 1am) are always checked
  // on time — getUpcomingTasks only sees global tasks, not per-app schedules
  const MAX_CHECK_INTERVAL = 60 * 60 * 1000;
  let delayMs = MAX_CHECK_INTERVAL;
  let description = 'Periodic improvement check (1h)';

  if (upcoming.length > 0 && upcoming[0].status === 'scheduled' && upcoming[0].eligibleIn > 0) {
    delayMs = Math.min(upcoming[0].eligibleIn, MAX_CHECK_INTERVAL);
    const effectiveFormatted = formatDuration(delayMs);
    const capNote = upcoming[0].eligibleIn > MAX_CHECK_INTERVAL
      ? ` (capped from ${upcoming[0].eligibleInFormatted})`
      : '';
    description = `Next improvement: ${upcoming[0].taskType} in ${effectiveFormatted}${capNote}`;
  }

  scheduleEvent({
    id: 'cos-improvement-check',
    type: 'once',
    delayMs: Math.max(delayMs, 1000),
    handler: async () => {
      if (!isDaemonRunning()) return;
      const paused = await isPaused();
      if (paused) {
        await scheduleNextImprovementCheck();
        return;
      }

      const state = await loadState();
      if (state.config.idleReviewEnabled) {
        const cosTaskData = await getCosTasks();
        await queueEligibleImprovementTasks(state, cosTaskData);
        setImmediate(() => dequeueNextTask());
      }

      await scheduleNextImprovementCheck();
    },
    metadata: { description }
  });
}

/**
 * Initialize on module load
 */
async function init() {
  await ensureDirectories();

  // When an agent completes, immediately try to dequeue the next pending task
  cosEvents.on('agent:completed', (agent) => {
    setImmediate(() => dequeueNextTask());

    // Create notification when a daily briefing completes
    if (agent?.metadata?.jobId === 'job-daily-briefing' && agent?.result?.success) {
      getUserTimezone()
        .then(tz => {
          const today = todayInTimezone(tz);
          return addNotification({
            type: NOTIFICATION_TYPES.BRIEFING_READY,
            title: 'Daily Briefing Ready',
            description: `Your daily briefing for ${today} is ready for review.`,
            priority: 'low',
            link: '/cos/briefing',
            metadata: { date: today, agentId: agent.id }
          });
        })
        .catch(err => console.error(`❌ Failed to create briefing notification: ${err.message}`));
    }
  });

  // Record autonomous job execution only after the agent actually spawns.
  // Update lastRun BEFORE clearing the spawning guard to prevent a race where
  // a pending timer fires between clearSpawningJob and recordJobExecution,
  // sees no guard and stale lastRun, and spawns a duplicate agent.
  cosEvents.on('job:spawned', async ({ jobId }) => {
    await recordJobExecution(jobId).catch(err =>
      console.error(`❌ Failed to record job execution for ${jobId}: ${err.message}`)
    );
    clearSpawningJob(jobId);
    // Re-register with updated lastRun so the next timer has the correct delay
    await registerSingleJobSchedule(jobId).catch(err =>
      console.error(`❌ Failed to re-register job schedule for ${jobId}: ${err.message}`)
    );
  });

  cosEvents.on('job:spawn-failed', async ({ jobId }) => {
    emitLog('warn', `Job spawn failed, re-registering schedule: ${jobId}`, { jobId });
    clearSpawningJob(jobId);
    await registerSingleJobSchedule(jobId).catch(err =>
      console.error(`❌ Failed to re-register job schedule after spawn failure for ${jobId}: ${err.message}`)
    );
  });

  // Event-driven triggers: task/file changes → dequeueNextTask
  cosEvents.on('tasks:changed', (data) => {
    if (isDaemonRunning() && data?.action === 'added') setImmediate(() => dequeueNextTask());
  });

  cosEvents.on('tasks:user:added', () => {
    if (isDaemonRunning()) setImmediate(() => dequeueNextTask());
  });

  cosEvents.on('tasks:cos:added', () => {
    if (isDaemonRunning()) setImmediate(() => dequeueNextTask());
  });

  cosEvents.on('task:on-demand-requested', () => {
    if (isDaemonRunning()) setImmediate(() => dequeueNextTask());
  });

  // Autonomous job lifecycle → re-register/cancel individual job timers
  cosEvents.on('jobs:toggled', async ({ id }) => {
    if (isDaemonRunning()) await registerSingleJobSchedule(id).catch(err =>
      console.error(`❌ Failed to register job schedule on toggle for ${id}: ${err?.message ?? String(err)}`)
    );
  });

  cosEvents.on('jobs:updated', async ({ id }) => {
    if (isDaemonRunning()) await registerSingleJobSchedule(id).catch(err =>
      console.error(`❌ Failed to register job schedule on update for ${id}: ${err?.message ?? String(err)}`)
    );
  });

  cosEvents.on('jobs:created', async ({ id }) => {
    if (isDaemonRunning()) await registerSingleJobSchedule(id).catch(err =>
      console.error(`❌ Failed to register job schedule on create for ${id}: ${err?.message ?? String(err)}`)
    );
  });

  cosEvents.on('jobs:deleted', async ({ id }) => {
    cancelEvent(`job:${id}`);
  });

  // Schedule changes → re-compute next improvement check
  cosEvents.on('schedule:changed', async () => {
    if (isDaemonRunning()) await scheduleNextImprovementCheck().catch(err =>
      console.error(`❌ Failed to schedule next improvement check: ${err?.message ?? String(err)}`)
    );
  });

  const state = await loadState();

  // Auto-start if alwaysOn mode is enabled (or legacy autoStart)
  if (state.config.alwaysOn || state.config.autoStart) {
    console.log('🚀 CoS auto-starting (alwaysOn mode)');
    await start();
  }
}

// Initialize asynchronously (skip during tests to avoid circular import issues and side effects)
if (process.env.NODE_ENV !== 'test') {
  init();
}
