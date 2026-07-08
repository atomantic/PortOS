/**
 * Chief of Staff (CoS) Service
 *
 * Manages the autonomous agent manager that watches TASKS.md,
 * spawns sub-agents, and orchestrates task completion.
 *
 * Decomposed modules:
 * - cosState.js          — shared state management (loadState, saveState, config, mutex)
 * - cosAgents.js         — agent lifecycle (register, complete, archive, feedback)
 * - cosReports.js        — reports, briefings, and activity tracking
 * - cosEvents.js         — event emitter and logging
 * - cosHealthMonitor.js  — daemon health checks (PM2/memory, auto-restart)
 */

import { readFile, writeFile, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { getActiveProvider } from './providers.js';
import { isInternalTaskId } from '../lib/taskParser.js';
import { isAppOnCooldown, markAppReviewCooldown, bindAppReviewAgent, clearStaleActiveAgents } from './appActivity.js';
import { getActiveApps } from './apps.js';
import { getPerformanceSummary, checkAndRehabilitateSkippedTasks, getLearningInsights } from './taskLearning.js';
import { schedule as scheduleEvent, cancel as cancelEvent, getStats as getSchedulerStats } from './eventScheduler.js';
import { generateProactiveTasks as generateMissionTasks } from './missions.js';
import { recordJobExecution } from './autonomousJobs.js';
import { atomicWrite, safeJSONParse } from '../lib/fileUtils.js';
import { addNotification, NOTIFICATION_TYPES } from './notifications.js';
import { getUserTimezone, todayInTimezone } from '../lib/timezone.js';
import { normalizeDomainAutonomy, getDomainMode } from '../lib/domainAutonomy.js';
import { normalizeDomainBudgets, remainingActionBudget } from '../lib/domainBudgets.js';
import { getDomainBudgetStatus } from './domainUsage.js';

// Shared state management (extracted to avoid circular deps)
import { loadState, saveState, withStateLock, ensureDirectories, isImprovementEnabled, canQueueImprovementTasks, AGENTS_DIR, REPORTS_DIR, SCRIPTS_DIR, ROOT_DIR, isDaemonRunning, setDaemonRunning } from './cosState.js';

// Events and logging (canonical source: cosEvents.js)
import { cosEvents, emitLog } from './cosEvents.js';
export { cosEvents, emitLog };

// Agent lifecycle (re-export for backward compat with `import * as cos`)
export { registerAgent, updateAgent, completeAgent, appendAgentOutput, getAgents, getAgentDates, getAgentsByDate, getAgent, getAgentPrompt, terminateAgent, pauseAgent, killAgent, sendBtwToAgent, getAgentProcessStats, cleanupZombieAgents, deleteAgent, submitAgentFeedback, getFeedbackStats, extractTaskType, archiveStaleAgents, clearCompletedAgents, pruneOldAgentArchives } from './cosAgents.js';

// Reports and activity (re-export for backward compat with `import * as cos`)
export { generateReport, getReport, getTodayReport, listReports, listBriefings, getBriefing, getLatestBriefing, getTodayActivity, getWhileAwayActivity, getRecentTasks, formatRelativeTime } from './cosReports.js';

// Health monitoring (imported for internal use by start()/init() and re-exported
// for backward compat with `import * as cos` and the cos route handlers)
import { runHealthCheck, getHealthStatus } from './cosHealthMonitor.js';
export { runHealthCheck, getHealthStatus };

// Task store: CRUD + queue persistence (TASKS.md / COS-TASKS.md). Imported for
// internal use by evaluateTasks/dequeueNextTask/generators and re-exported for
// backward compat with `import * as cos` and the cos route handlers. The store
// emits `tasks:changed`; init() below turns that into tryImmediateSpawn /
// dequeueNextTask so the spawn-side logic stays here, not in the store.
import { firstLine, PRIORITY_VALUES, getUserTasks, getCosTasks, getAllTasks, getTasks, getTaskById, addTask, updateTask, deleteTask, reorderTasks, approveTask } from './cosTaskStore.js';
export { firstLine, getUserTasks, getCosTasks, getAllTasks, getTasks, getTaskById, addTask, updateTask, deleteTask, reorderTasks, approveTask };
import { ensureInstanceId } from './instances.js';
import { isHeldByOther, buildRenewal, buildClaim, getClaimOwner } from './cosTaskClaim.js';

const AGENT_ARCHIVE_RETENTION_DAYS = 90;
const RESUME_DEQUEUE_DELAY_MS = 500;
// CD recovery normally resolves in <100ms; hold start() at most this long so
// a stuck recovery doesn't block daemon boot indefinitely.
const CD_RECOVERY_BOOT_TIMEOUT_MS = 60_000;
// Initial idle-review queue kicks off after start() — far enough back that
// a fresh install isn't overwhelmed but close enough to not stall users.
const POST_STARTUP_QUEUE_DELAY_MS = 30_000;
// A task whose agent reported completed within this window is treated as
// "recently completed" and protected from resetOrphanedTasks's reaper.
const RECENT_COMPLETION_GRACE_MS = 60_000;

// Internal imports for functions used in this module
import { pruneOldAgentArchives, archiveStaleAgents as _archiveStaleAgents, loadAgentIndex } from './cosAgents.js';

// Task generation + evaluation engine (extracted to cosTaskGenerator.js).
// `evaluateTasks` and the generators emit `task:ready`; the spawn-side
// scheduler (dequeueNextTask / tryImmediateSpawn) below reacts to that. Most of
// these are imported for internal use by the scheduler; checkStagePrecondition
// and applyAppWorktreeDefault are re-exported for agentLifecycle.js and
// subAgentSpawner, and evaluateTasks for the cos route + `import * as cos`.
import {
  evaluateTasks,
  generateIdleReviewTask,
  queueEligibleImprovementTasks,
  generateSelfImprovementTaskForType,
  generateManagedAppImprovementTaskForType,
  blockIfExceedsMaxSpawns,
  selectDryRunAutoApproved,
  isCooldownExemptTask,
  countRunningAgentsByProject,
  isWithinProjectLimit,
  checkStagePrecondition,
  applyAppWorktreeDefault
} from './cosTaskGenerator.js';
export { evaluateTasks, checkStagePrecondition, applyAppWorktreeDefault };

// Autonomous-job + improvement-check timer machinery (extracted to
// cosJobScheduler.js). Imported for internal use by start()/stop()/init() and
// the job-lifecycle event handlers below. The improvement-check timer asks for
// a dequeue via the `cos:dequeue-requested` event (wired in init()), since
// dequeueNextTask stays here.
import {
  registerJobSchedules,
  unregisterJobSchedules,
  scheduleNextImprovementCheck,
  registerSingleJobSchedule,
  clearSpawningJob
} from './cosJobScheduler.js';

/**
 * Get current CoS status
 */
export async function getStatus() {
  const state = await loadState();
  const provider = await getActiveProvider();
  const idx = await loadAgentIndex();

  // Count active agents from state
  const activeAgents = Object.values(state.agents).filter(a => a.status === 'running').length;
  const pausedAgents = Object.values(state.agents).filter(a => a.status === 'paused').length;

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
    pausedAgents,
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
    // domainAutonomy is a partial-friendly map: a PATCH that names only one
    // domain must merge over the others rather than replace the whole object.
    // Capture the prior map BEFORE the spread clobbers it, then normalize the
    // merge so an unknown/invalid stored value resolves to the `execute` default.
    const priorDomainAutonomy = state.config.domainAutonomy;
    // Same for domainBudgets — a PATCH naming one domain (or one cap on one
    // domain) must merge field-by-field over the rest, not replace the map.
    const priorDomainBudgets = state.config.domainBudgets;
    state.config = { ...state.config, ...updates };
    if (updates.domainAutonomy !== undefined) {
      state.config.domainAutonomy = normalizeDomainAutonomy({
        ...priorDomainAutonomy,
        ...updates.domainAutonomy
      });
    }
    if (updates.domainBudgets !== undefined) {
      const mergedBudgets = { ...priorDomainBudgets };
      for (const [id, caps] of Object.entries(updates.domainBudgets)) {
        mergedBudgets[id] = { ...(priorDomainBudgets?.[id] || {}), ...caps };
      }
      state.config.domainBudgets = normalizeDomainBudgets(mergedBudgets);
    }
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

  // Wait for Creative Director boot recovery to finish retiring stale CD
  // tasks before we reset orphans. Without this gate, resetOrphanedTasks
  // would respawn stale CD treatment/evaluate tasks before recovery can
  // mark them `completed`, racing two agents on the same project. The
  // promise resolves whether recovery ran successfully, was a no-op (no
  // mid-flight projects), or wasn't called at all (markRecoveryDone is
  // exposed for that case). 60s ceiling — recovery on a healthy boot
  // resolves in <100ms, but we'd rather pay a slow-boot tax than reopen
  // the duplicate-agent race when initMediaJobQueue or earlier startup
  // steps stall.
  const { cdRecoveryDone } = await import('./creativeDirector/recovery.js');
  await Promise.race([
    cdRecoveryDone,
    new Promise((resolve) => setTimeout(resolve, CD_RECOVERY_BOOT_TIMEOUT_MS)),
  ]);

  // Then reset any orphaned in_progress tasks (no running agent)
  await resetOrphanedTasks();

  // Clear stale activeAgentId pointers in app-activity.json. Without this, an
  // idle-review agent that died across a restart (or a long-stale Feb-era state
  // file) leaves activeAgentId set forever — isAppOnCooldown treats that as
  // "agent still working" and queueEligibleImprovementTasks silently skips the
  // app every cycle. Re-load state since the orphan-cleanup steps above have
  // already mutated the on-disk agents map.
  const freshState = await loadState();
  const liveAgentIds = new Set(Object.keys(freshState.agents || {}));
  const { cleared: clearedActiveAgents } = await clearStaleActiveAgents(liveAgentIds).catch(() => ({ cleared: [] }));
  if (clearedActiveAgents.length > 0) {
    emitLog('info', `🧹 Cleared ${clearedActiveAgents.length} stale activeAgentId pointer(s) from app-activity`);
  }

  // Archive stale completed agents from state.json on startup
  const { archived } = await _archiveStaleAgents().catch(() => ({ archived: 0 }));
  if (archived > 0) {
    emitLog('info', `📦 Startup: archived ${archived} stale agent(s) from state`);
  }

  // Prune agent archives older than 90 days
  await pruneOldAgentArchives(AGENT_ARCHIVE_RETENTION_DAYS).catch(err =>
    console.warn(`⚠️ pruneOldAgentArchives failed: ${err?.message || err}`)
  );

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
  await evaluateTasks({ initialStartup: true });
  await runHealthCheck();

  cosEvents.emit('status', { running: true });
  emitLog('success', 'CoS daemon started');

  // Queue due improvement tasks shortly after startup (not during initial eval
  // to avoid overwhelming fresh installs, but soon enough to not stall)
  setTimeout(() => {
    if (!isDaemonRunning()) return;
    loadState().then(async (state) => {
      // Gate on the CoS auto-run domain (parity with evaluateTasks and the
      // cos-improvement-check timer) — see canQueueImprovementTasks.
      if (!canQueueImprovementTasks(state)) return;
      const cosTaskData = await getCosTasks();
      await queueEligibleImprovementTasks(state, cosTaskData);
      setImmediate(() => dequeueNextTask());
    }).catch(err => emitLog('warn', `Post-startup improvement queuing failed: ${err.message}`));
  }, POST_STARTUP_QUEUE_DELAY_MS);

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
    setTimeout(() => dequeueNextTask(), RESUME_DEQUEUE_DELAY_MS);
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

  // This machine's federation identity, for the cross-instance lease checks
  // below (issue #1563). `ensureInstanceId()` resolves the real id on the cold
  // path so a boot-time orphan-reset never compares against the `unknown`
  // sentinel.
  const instanceId = await ensureInstanceId();

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
        (Date.now() - new Date(a.completedAt).getTime()) < RECENT_COMPLETION_GRACE_MS)
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
      if (runningAgentTaskIds.includes(task.id)) {
        // A local agent is actively working this task — renew its federation
        // lease (the heartbeat, issue #1563) so a peer sharing this task list
        // keeps seeing it as live-claimed across a long run instead of treating
        // it as orphaned once the original lease window elapses. We can only
        // hold a lease we own (or freshly claim an unclaimed legacy task); never
        // steal a lease another instance owns.
        const owner = getClaimOwner(task.metadata);
        const renewal = owner === instanceId
          ? buildRenewal(task.metadata, instanceId)
          : (owner === null ? buildClaim(instanceId) : null);
        if (renewal) {
          const taskType = task.taskType || (isInternalTaskId(task.id) ? 'internal' : 'user');
          // Pass ONLY the renewal claim keys — updateTask merges them over the
          // CURRENT persisted metadata, so spreading {...task.metadata} (this
          // scan's possibly-stale copy) is redundant and would risk clobbering a
          // concurrent content edit. It also keeps the heartbeat a claim-only
          // patch so it never bumps the updatedAt LWW stamp (#1714).
          await updateTask(task.id, { metadata: renewal }, taskType).catch(() => {});
        }
        continue;
      }
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
      // Cross-instance lease guard (issue #1563, acceptance criterion 3): a
      // federated peer holds a live claim on this task, so it is being worked on
      // the other machine — not orphaned here. Resetting it to pending would
      // race a second agent onto work the peer is already doing. Leave it; the
      // lease expires on its own if the peer actually died.
      if (isHeldByOther(task.metadata, instanceId)) {
        emitLog('debug', `Skipping task ${task.id} — live lease held by instance ${getClaimOwner(task.metadata)}`, { taskId: task.id });
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
 * Save a generated script
 */
export async function saveScript(name, content, metadata = {}) {
  await ensureDirectories();
  const scriptPath = join(SCRIPTS_DIR, `${name}.sh`);
  await writeFile(scriptPath, content, { mode: 0o755 });

  // Save metadata
  const metaPath = join(SCRIPTS_DIR, `${name}.json`);
  await atomicWrite(metaPath, {
    name,
    createdAt: new Date().toISOString(),
    ...metadata
  });

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

  // A global pause stops scheduled/autonomous spawning, but NOT explicit user
  // triggers: on-demand requests (Priority 0) are processed even while paused so
  // a manual "Run" from an app's automation page still fires. The autonomous
  // tiers (Priority 1+) are skipped below when paused.
  const paused = await isPaused();

  const state = await loadState();
  const runningAgents = Object.values(state.agents).filter(a => a.status === 'running').length;
  const availableSlots = state.config.maxConcurrentAgents - runningAgents;

  if (availableSlots <= 0) return;

  // This instance's federation id, resolved once per cycle so the priority
  // tiers below can skip tasks a peer holds a live lease on (#1650). Warm path
  // is the cheap cached read; only the cold boot creates the identity.
  const instanceId = await ensureInstanceId();

  const perProjectLimit = state.config.maxConcurrentAgentsPerProject || state.config.maxConcurrentAgents;
  const agentsByProject = countRunningAgentsByProject(state.agents);
  const spawnProjectCounts = { ...agentsByProject };
  let spawned = 0;

  // `ceiling` defaults to the global slot count; autonomous sections pass the
  // lower `autonomousSpawnCeiling` so the CoS daily action budget (#711) caps them.
  const canSpawn = (task, ceiling = availableSlots) => {
    if (spawned >= ceiling) return false;
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

  // Track apps already marked review-started this cycle so multiple on-demand
  // requests for the same app don't each rewrite its activity record.
  const reviewStartedApps = new Set();
  for (const request of onDemandRequests) {
    if (spawned >= availableSlots) break;

    if (!isImprovementEnabled(state)) {
      emitLog('warn', `On-demand request dropped — improvement is disabled (Config → Improve)`, { requestId: request.id, taskType: request.taskType });
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
      // A user-initiated "Run" must re-check live state, never honor a stale
      // park or convergence signature — resetting both up front guarantees the
      // detector/reconcile below runs fresh and dispatches on live state (and,
      // if still idle, re-stamps a park reflecting THIS check).
      await taskScheduleMod.resetPerpetualForManualRun(request.taskType, targetApp.id);
      // Advance the cooldown eagerly (deduped per app per cycle), but defer
      // binding the active agent until a task is produced — a null result
      // here must not strand `activeAgentId` (issue #978).
      if (!reviewStartedApps.has(targetApp.id)) {
        await markAppReviewCooldown(targetApp.id);
        reviewStartedApps.add(targetApp.id);
      }
      await taskScheduleMod.recordExecution(`task:${request.taskType}`, targetApp.id);
      task = await generateManagedAppImprovementTaskForType(request.taskType, targetApp, state, { skipPreconditions: true });
      if (task) {
        await bindAppReviewAgent(targetApp.id, `on-demand-${Date.now()}`);
      }
    } else {
      emitLog('info', `Processing on-demand improvement: ${request.taskType}`, { requestId: request.id });
      // Same fresh-check guarantee as the app-scoped branch above.
      await taskScheduleMod.resetPerpetualForManualRun(request.taskType);
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
    } else if (!task) {
      // The explicit user "Run" produced no task. Surface WHY so the trigger
      // isn't a silent no-op the user only discovers in the pm2 logs. This event
      // fires ONLY on the on-demand (user-initiated) path, so the client can
      // toast it without background-park noise.
      //
      // Because we reset the park BEFORE the fresh detection above, a park
      // record here unambiguously means "this check parked" (definitive no
      // work). Its ABSENCE means the detector did NOT park — a transient probe
      // failure (gh/glab down) or a non-perpetual skip — which the client must
      // word as "couldn't re-check", never "nothing to do".
      const parkInfo = await taskScheduleMod
        .getPerpetualParkInfo(request.taskType, targetApp?.id || null)
        .catch(() => null);
      cosEvents.emit('schedule:on-demand-empty', {
        requestId: request.id,
        taskType: request.taskType,
        appId: targetApp?.id || null,
        appName: targetApp?.name || null,
        parked: !!parkInfo,
        parkReason: parkInfo?.parkReason || null,
        parkedUntil: parkInfo?.parkedUntil || null,
        actionableCount: parkInfo?.parkActionableCount ?? null,
        counts: parkInfo?.parkCounts || null
      });
    }
  }

  // Global pause stops every autonomous/scheduled/user tier below; only the
  // on-demand queue above (explicit user "Run") bypasses it.
  if (paused) return;

  // Priority 1: User tasks
  const userTaskData = await getUserTasks();
  const pendingUserTasks = userTaskData.grouped?.pending || [];

  for (const task of pendingUserTasks) {
    if (spawned >= availableSlots) break;
    // A federated peer holds a live lease on this task (#1650) — it's being
    // worked on the other machine. Skip it during candidate selection so it
    // doesn't consume this cycle's spawn slot (the spawn guard would return
    // null anyway) and starve later unclaimed tasks.
    if (isHeldByOther(task.metadata, instanceId)) {
      emitLog('debug', `Skipping user task ${task.id} — live lease held by peer instance ${getClaimOwner(task.metadata)}`, { taskId: task.id });
      continue;
    }
    if (await blockIfExceedsMaxSpawns(task, 'user')) continue;
    const userTask = { ...task, taskType: 'user' };
    if (!canSpawn(userTask)) continue;
    cosEvents.emit('task:ready', userTask);
    trackSpawn(userTask);
  }

  // Priority 2: Auto-approved system tasks — gated by the CoS auto-run domain.
  // `off`/`dry-run` both stop the unattended spawn; `dry-run` logs what would
  // have run so the user can see the plan without it executing.
  const cosTaskData = await getCosTasks();
  const autoApproved = cosTaskData.autoApproved || [];
  let cosAutonomyMode = getDomainMode(state.config, 'cos');

  // Daily CoS budget (#711) — same enforcement as the periodic evaluator
  // (cosTaskGenerator.evaluateTasks). This is the event-driven primary spawn
  // path, so the budget MUST be applied here too. Minutes is a binary off-gate
  // (a run's duration is unknown at spawn); actions cap THIS cycle's autonomous
  // admissions to the remaining daily allowance (completed + in-flight runs),
  // surfaced as `autonomousSpawnCeiling` below. On-demand (Priority 0) and user
  // (Priority 1) tasks are already spawned above and never count against it.
  const cosBudget = await getDomainBudgetStatus('cos');
  let autonomousActionsRemaining = Infinity;
  if (cosAutonomyMode !== 'off') {
    if (cosBudget.exceeded === 'minutes') {
      emitLog('info', `CoS auto-run paused — daily minutes budget reached`, { domainBudget: 'cos', exceeded: 'minutes' });
      cosAutonomyMode = 'off';
    } else if (cosBudget.budget?.maxActionsPerDay != null) {
      const runningAutonomous = Object.values(state.agents).filter(
        (a) => a.status === 'running' && a.metadata?.taskType && a.metadata.taskType !== 'user'
      ).length;
      autonomousActionsRemaining = remainingActionBudget(cosBudget.budget, cosBudget.usage, runningAutonomous);
      if (autonomousActionsRemaining === 0) {
        emitLog('info', `CoS auto-run paused — daily actions budget reached`, { domainBudget: 'cos', exceeded: 'actions' });
        cosAutonomyMode = 'off';
      }
    }
  }
  const autonomousSpawnCeiling = Math.min(availableSlots, spawned + autonomousActionsRemaining);

  // Engine-specific gate shared by execute and dry-run: improvement tasks whose
  // task type was disabled after queuing are skipped.
  const isDisabledAnalysisType = (task) => {
    const analysisType = task.metadata?.analysisType || task.metadata?.selfImprovementType;
    return Boolean(analysisType) && !taskSchedule.tasks[analysisType]?.enabled;
  };

  if (cosAutonomyMode !== 'execute') {
    // off/dry-run withhold the unattended spawn; dry-run logs only the tasks
    // execute mode would ACTUALLY spawn — applying the same max-spawns /
    // disabled-type / cooldown / per-project gates against virtual capacity —
    // rather than every auto-approved task regardless of eligibility.
    if (cosAutonomyMode === 'dry-run') {
      const wouldSpawn = await selectDryRunAutoApproved(autoApproved, {
        availableSlots: autonomousSpawnCeiling,
        alreadySpawned: spawned,
        perProjectLimit,
        spawnProjectCounts,
        isOnCooldown: (appId) => isAppOnCooldown(appId, state.config.appReviewCooldownMs),
        cooldownExempt: isCooldownExemptTask,
        extraSkip: isDisabledAnalysisType,
        heldByOther: (task) => isHeldByOther(task.metadata, instanceId)
      });
      for (const task of wouldSpawn) {
        emitLog('info', `[dry-run] CoS auto-run would spawn system task: ${task.id}`, { taskId: task.id, domainAutonomy: 'cos' });
      }
    }
  } else {
    for (const task of autoApproved) {
      if (spawned >= autonomousSpawnCeiling) break;
      // A federated peer holds a live lease on this task (#1650) — skip it
      // during candidate selection so it doesn't consume an autonomous slot
      // the spawn guard would just reject.
      if (isHeldByOther(task.metadata, instanceId)) {
        emitLog('debug', `Skipping system task ${task.id} — live lease held by peer instance ${getClaimOwner(task.metadata)}`, { taskId: task.id });
        continue;
      }
      if (await blockIfExceedsMaxSpawns(task, 'internal')) continue;
      // Skip improvement tasks whose type was disabled after queuing
      if (isDisabledAnalysisType(task)) {
        const analysisType = task.metadata?.analysisType || task.metadata?.selfImprovementType;
        emitLog('info', `System task skipped — task type '${analysisType}' is disabled`, { taskId: task.id });
        continue;
      }
      // Pipeline continuations AND perpetual drains bypass the per-app cooldown
      // (see isCooldownExemptTask) — otherwise a perpetual task the refill just
      // queued is skipped here until the 30-min window expires, stalling the
      // manually-triggered back-to-back drain one item in.
      const appId = task.metadata?.app;
      if (appId && !isCooldownExemptTask(task)) {
        const onCooldown = await isAppOnCooldown(appId, state.config.appReviewCooldownMs);
        if (onCooldown) continue;
      }
      const sysTask = { ...task, taskType: 'internal' };
      if (!canSpawn(sysTask, autonomousSpawnCeiling)) continue;
      cosEvents.emit('task:ready', sysTask);
      trackSpawn(sysTask);
    }
  }

  const hasPendingUserTasks = pendingUserTasks.length > 0;

  // Priority 3: Mission-driven proactive tasks. These are speculative autonomous
  // spawns — when CoS auto-run isn't `execute`, skip generating them entirely
  // (off and dry-run both withhold autonomous spawns; only the concrete already-
  // queued auto-approved tasks above are surfaced for dry-run).
  if (spawned < autonomousSpawnCeiling && !hasPendingUserTasks && state.config.proactiveMode && cosAutonomyMode === 'execute') {
    const missionTasks = await generateMissionTasks({ maxTasks: autonomousSpawnCeiling - spawned }).catch(err => {
      emitLog('debug', `Mission task generation failed: ${err.message}`);
      return [];
    });

    for (const missionTask of missionTasks) {
      if (spawned >= autonomousSpawnCeiling) break;
      const cosTask = {
        id: missionTask.id,
        description: missionTask.description,
        priority: missionTask.priority?.toUpperCase() || 'MEDIUM',
        status: 'pending',
        metadata: missionTask.metadata,
        taskType: 'internal',
        approvalRequired: !missionTask.autoApprove
      };
      if (!canSpawn(cosTask, autonomousSpawnCeiling)) continue;
      cosEvents.emit('task:ready', cosTask);
      trackSpawn(cosTask);
      emitLog('info', `Generated mission task: ${missionTask.id}`, {
        missionId: missionTask.metadata?.missionId
      });
    }
  }

  // Priority 4: Idle review task (only when completely idle) — also an autonomous
  // spawn, so gated by the CoS auto-run domain.
  if (spawned === 0 && state.config.idleReviewEnabled && !hasPendingUserTasks && cosAutonomyMode === 'execute') {
    const freshCosTasks = await getCosTasks();
    const pendingSystemTasks = freshCosTasks.autoApproved?.length || 0;
    if (pendingSystemTasks === 0) {
      const idleTask = await generateIdleReviewTask(state);
      if (idleTask && canSpawn(idleTask, autonomousSpawnCeiling)) {
        cosEvents.emit('task:ready', idleTask);
        trackSpawn(idleTask);
      }
    }
  }

  if (spawned > 0) {
    emitLog('info', `⚡ Dequeued ${spawned} task(s)`, { spawned, availableSlots });
  }
}

/**
 * Pure gate: did the just-completed agent belong to an *enabled perpetual*
 * schedule (e.g. claim-issue)? Perpetual tasks are documented as "drain
 * actionable work back-to-back (re-queue on completion)" (taskSchedule.js), but
 * `dequeueNextTask` above only drains already-queued tasks — it never
 * regenerates perpetual work. Without an explicit refill on completion the next
 * run waits for the ~hourly `cos-improvement-check` timer (a "ready" perpetual
 * task doesn't even shorten that timer — cosJobScheduler gates the delay on
 * `status:'scheduled'` tasks only). This gate lets the completion handler decide
 * whether to refill the perpetual queue immediately instead of idling. Reads
 * the analysis type the same way `queueEligibleImprovementTasks` /
 * `isDisabledAnalysisType` do, and never throws on partial inputs.
 */
export function isPerpetualRefillCandidate(agent, schedule) {
  const analysisType = agent?.metadata?.taskAnalysisType
    || agent?.metadata?.analysisType
    || agent?.metadata?.selfImprovementType;
  if (!analysisType) return false;
  const taskDef = schedule?.tasks?.[analysisType];
  return Boolean(taskDef?.enabled) && taskDef.type === 'perpetual';
}

/**
 * When a perpetual-schedule agent finishes, re-queue the next eligible
 * improvement task right away so the backlog drains back-to-back rather than
 * stalling until the next improvement-check tick. Mirrors the gates the
 * improvement-check timer applies (daemon running, not paused, idle-review on,
 * CoS auto-run = execute) and reuses the same `queueEligibleImprovementTasks`
 * path — which already enforces per-app cooldown, the one-pending-per-app cap,
 * and the perpetual work-detector park, so this converges (when no actionable
 * work remains the task parks and nothing is re-queued) and can't fan out past
 * the concurrency limits in `dequeueNextTask`.
 */
async function refillPerpetualForCompletedAgent(agent) {
  if (!isDaemonRunning()) return;
  // Only a SUCCESSFUL perpetual run drains to the next item immediately. A failed
  // run (provider/setup/test failure) must NOT refill back-to-back: perpetual
  // completions skip the per-app cooldown, and the work-detector will usually
  // still see the same issue as actionable — so an immediate refill would spin
  // the daemon through repeated failures. On failure, fall back to the task
  // retry/backoff and the improvement-check recheck cadence (the park IS the
  // throttle only once work genuinely runs out, not when a run errors).
  if (!agent?.result?.success) return;
  if (await isPaused()) return;

  const taskScheduleMod = await import('./taskSchedule.js');
  const schedule = await taskScheduleMod.loadSchedule();
  if (!isPerpetualRefillCandidate(agent, schedule)) return;

  const state = await loadState();
  if (!canQueueImprovementTasks(state)) return;

  // `agent:completed` fires from `completeAgent` BEFORE the completion flow's
  // `updateTask` marks this agent's task done (agentLifecycle.js: completeAgent
  // emits, THEN updateTask persists). So the just-finished task can still read as
  // `in_progress` both in this snapshot AND on disk when queueEligible's addTask
  // re-reads COS-TASKS.md. Pass its id as `ignoreTaskId` so the per-app busy cap,
  // the per-type dedup set, and addTask's disk-level duplicate scan all treat it
  // as already done — otherwise a perpetual schedule (claim-issue/claim-work
  // regenerates an identical first-line per app) is rejected as a duplicate of
  // the completing task and the drain stalls until the next scheduler tick.
  const cosTaskData = await getCosTasks();
  await queueEligibleImprovementTasks(state, cosTaskData, { ignoreTaskId: agent?.taskId });
  // NOTE: the caller (the agent:completed handler) runs dequeueNextTask AFTER
  // this resolves, so the freshly-queued perpetual task is on the queue before
  // slots are filled. Do not dequeue here — that would re-introduce the ordering
  // race where generic dequeue claims the freed slot with idle/mission work.
}

/**
 * Wire event listeners, load state, and auto-start the daemon when configured.
 * Called once from `server/index.js` during boot.
 */
export async function init() {
  await ensureDirectories();

  // When an agent completes, refill perpetual work then dequeue the next task
  cosEvents.on('agent:completed', (agent) => {
    // Refill the perpetual backlog FIRST, THEN dequeue — in one async task so the
    // generic dequeue can't fill the just-freed slot with idle/mission work ahead
    // of the perpetual re-queue. Perpetual schedules (e.g. claim-issue) drain
    // back-to-back: regenerate the next eligible task now instead of waiting for
    // the ~hourly improvement check (dequeueNextTask only spawns ALREADY-queued
    // work, so on its own a perpetual backlog stalls between ticks). The refill
    // early-returns fast for non-perpetual or failed completions, so for those
    // this stays a thin wrapper around the dequeue. Both steps are .catch-guarded
    // because this runs outside the request lifecycle.
    setImmediate(() => {
      refillPerpetualForCompletedAgent(agent)
        .catch(err => console.error(`❌ Perpetual refill after ${agent?.id} failed: ${err.message}`))
        .then(() => dequeueNextTask())
        .catch(err => console.error(`❌ Dequeue after ${agent?.id} completion failed: ${err.message}`));
    });

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

  // Event-driven triggers: task/file changes → dequeueNextTask.
  // The task store (cosTaskStore.js) persists tasks and emits this event; the
  // spawn-side reaction lives here so the store stays free of scheduler logic.
  // - 'added': fill open slots via dequeueNextTask, and (for user tasks) also
  //   fire tryImmediateSpawn so the just-added task starts instantly, bypassing
  //   the evaluation interval that's meant for system task generation.
  // - 'approved': a newly approved internal task can now spawn — re-run dequeue.
  cosEvents.on('tasks:changed', (data) => {
    if (!isDaemonRunning() || !data?.action) return;
    if (data.action === 'added') {
      // Order matters: dequeueNextTask is scheduled before the user-task
      // tryImmediateSpawn, matching the pre-extraction sequence (addTask emitted
      // tasks:changed — registering dequeue via this listener — before it called
      // setImmediate(tryImmediateSpawn)). dequeue fills slots in priority order
      // first; tryImmediateSpawn then handles the just-added task.
      setImmediate(() => dequeueNextTask());
      if (data.type === 'user' && data.task) setImmediate(() => tryImmediateSpawn(data.task));
    } else if (data.action === 'approved') {
      setImmediate(() => dequeueNextTask());
    }
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

  // The improvement-check timer (cosJobScheduler.scheduleNextImprovementCheck)
  // queues eligible improvement tasks then asks for a dequeue via this event,
  // since dequeueNextTask lives here. Mirrors the pre-extraction direct call.
  cosEvents.on('cos:dequeue-requested', () => {
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
