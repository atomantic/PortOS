/**
 * Chief of Staff (CoS) Service
 *
 * Manages the autonomous agent manager that watches TASKS.md,
 * spawns sub-agents, and orchestrates task completion.
 */

import { readFile, writeFile, mkdir, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import { getActiveProvider } from './providers.js';
import { parseTasksMarkdown, groupTasksByStatus, getNextTask, getAutoApprovedTasks, getAwaitingApprovalTasks, updateTaskStatus, generateTasksMarkdown } from '../lib/taskParser.js';
import { isAppOnCooldown, getNextAppForReview, markAppReviewStarted, markIdleReviewStarted } from './appActivity.js';
import { getActiveApps } from './apps.js';
import { getAdaptiveCooldownMultiplier, getSkippedTaskTypes, getPerformanceSummary, checkAndRehabilitateSkippedTasks, getLearningInsights } from './taskLearning.js';
import { schedule as scheduleEvent, cancel as cancelEvent, getStats as getSchedulerStats } from './eventScheduler.js';
import { generateProactiveTasks as generateMissionTasks, getStats as getMissionStats } from './missions.js';
import { getDueJobs, generateTaskFromJob, recordJobExecution } from './autonomousJobs.js';
import { formatDuration } from '../lib/fileUtils.js';
import { addNotification, NOTIFICATION_TYPES } from './notifications.js';
import { recordDecision, DECISION_TYPES } from './decisionLog.js';
// Import and re-export cosEvents from separate module to avoid circular dependencies
import { cosEvents as _cosEvents } from './cosEvents.js';
export const cosEvents = _cosEvents;

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '../../data');
const COS_DIR = join(DATA_DIR, 'cos');
const STATE_FILE = join(COS_DIR, 'state.json');
const AGENTS_DIR = join(COS_DIR, 'agents');
const REPORTS_DIR = join(COS_DIR, 'reports');
const SCRIPTS_DIR = join(COS_DIR, 'scripts');
const ROOT_DIR = join(__dirname, '../../');

/**
 * Emit a log event for UI display
 * Exported for use by other CoS-related services
 * @param {string} level - Log level: 'info', 'warn', 'error', 'success', 'debug'
 * @param {string} message - Log message
 * @param {Object} data - Additional data to include in log entry
 * @param {string} prefix - Optional prefix for console output (e.g., 'SelfImprovement')
 */
export function emitLog(level, message, data = {}, prefix = '') {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data
  };
  const emoji = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : level === 'success' ? '✅' : level === 'debug' ? '🔍' : 'ℹ️';
  const prefixStr = prefix ? ` ${prefix}` : '';
  console.log(`${emoji}${prefixStr} ${message}`);
  cosEvents.emit('log', logEntry);
}

// In-memory daemon state
let daemonRunning = false;

// In-memory cache of completed agents loaded from disk metadata files
// Keyed by agentId, lazy-loaded on first getAgents() call
let completedAgentCache = null;

// Load completed agent metadata from disk into the cache.
// Reads all data/cos/agents/{id}/metadata.json files.
// Only called once (lazy init), then kept in sync via completeAgent/deleteAgent.
async function loadCompletedAgentCache() {
  if (completedAgentCache) return completedAgentCache;

  completedAgentCache = new Map();
  if (!existsSync(AGENTS_DIR)) return completedAgentCache;

  const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
  const metadataReads = entries
    .filter(e => e.isDirectory() && e.name.startsWith('agent-'))
    .map(async (entry) => {
      const metaPath = join(AGENTS_DIR, entry.name, 'metadata.json');
      if (!existsSync(metaPath)) return;
      const content = await readFile(metaPath, 'utf-8').catch(() => null);
      if (!content) return;
      const agent = JSON.parse(content);
      if (agent?.id && agent.status === 'completed') {
        // Strip output array from cache to save memory — full output read on demand
        const { output, ...agentWithoutOutput } = agent;
        completedAgentCache.set(agent.id, agentWithoutOutput);
      }
    });

  await Promise.all(metadataReads);
  console.log(`📂 Loaded ${completedAgentCache.size} completed agents from disk`);
  return completedAgentCache;
}

// Mutex lock for state operations to prevent race conditions
let stateLock = Promise.resolve();
async function withStateLock(fn) {
  const release = stateLock;
  let resolve;
  stateLock = new Promise(r => { resolve = r; });
  await release;
  try {
    return await fn();
  } finally {
    resolve();
  }
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG = {
  userTasksFile: 'data/TASKS.md',          // User-defined tasks
  cosTasksFile: 'data/COS-TASKS.md',       // CoS internal/system tasks
  goalsFile: 'data/COS-GOALS.md',          // Mission and goals file
  evaluationIntervalMs: 60000,             // 1 minute - stay active, check frequently
  healthCheckIntervalMs: 900000,           // 15 minutes
  maxConcurrentAgents: 3,
  maxConcurrentAgentsPerProject: 2,        // Per-project limit (prevents one project hogging all slots)
  maxProcessMemoryMb: 2048,                // Alert if any process exceeds this
  maxTotalProcesses: 50,                   // Alert if total PM2 processes exceed this
  mcpServers: [
    { name: 'filesystem', command: 'npx', args: ['-y', '@anthropic/mcp-server-filesystem'] },
    { name: 'puppeteer', command: 'npx', args: ['-y', '@anthropic/mcp-puppeteer', '--isolated'] }
  ],
  autoStart: false,                        // Legacy: use alwaysOn instead
  selfImprovementEnabled: true,            // Allow CoS to improve itself (PortOS codebase)
  appImprovementEnabled: true,             // Allow CoS to improve managed apps
  avatarStyle: 'svg',                      // UI preference: 'svg' | 'ascii' | 'cyber' | 'sigil'
  // Always-on mode settings
  alwaysOn: true,                          // CoS starts automatically and stays active
  appReviewCooldownMs: 1800000,            // 30 min between working on same app (was 1 hour)
  idleReviewEnabled: true,                 // Review apps for improvements when no user tasks
  idleReviewPriority: 'MEDIUM',            // Priority for auto-generated tasks (was LOW)
  comprehensiveAppImprovement: true,       // Use comprehensive analysis for managed apps (same as PortOS self-improvement)
  immediateExecution: true,                // Execute new tasks immediately, don't wait for interval
  proactiveMode: true,                     // Be proactive about finding work
  autonomousJobsEnabled: true,             // Enable recurring autonomous jobs (git maintenance, brain processing, etc.)
  autonomyLevel: 'manager',                // Default autonomy level preset (standby/assistant/manager/yolo)
  rehabilitationGracePeriodDays: 7,        // Days before auto-retrying skipped task types (learning-based)
  autoFixThresholds: {
    maxLinesChanged: 50,                   // Auto-approve if <= this many lines changed
    allowedCategories: [                   // Categories that can auto-execute
      'formatting',
      'dry-violations',
      'dead-code',
      'typo-fix',
      'import-cleanup'
    ]
  }
};

/**
 * Default state
 */
const DEFAULT_STATE = {
  running: false,
  paused: false,                       // Pause state for always-on mode
  pausedAt: null,                      // Timestamp when paused
  pauseReason: null,                   // Optional reason for pause
  config: DEFAULT_CONFIG,
  stats: {
    tasksCompleted: 0,
    totalRuntime: 0,
    agentsSpawned: 0,
    errors: 0,
    lastEvaluation: null,
    lastIdleReview: null               // Track last idle review time
  },
  agents: {}
};

/**
 * Ensure data directories exist
 */
async function ensureDirectories() {
  const dirs = [DATA_DIR, COS_DIR, AGENTS_DIR, REPORTS_DIR, SCRIPTS_DIR];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
  }
}

/**
 * Validate JSON string before parsing
 */
function isValidJSON(str) {
  if (!str || !str.trim()) return false;
  const trimmed = str.trim();
  // Check for basic JSON structure
  if (!(trimmed.startsWith('{') && trimmed.endsWith('}'))) return false;
  // Check for common corruption patterns
  if (trimmed.endsWith('}}') || trimmed.includes('}{')) return false;
  return true;
}

/**
 * Load CoS state
 */
async function loadState() {
  await ensureDirectories();

  if (!existsSync(STATE_FILE)) {
    return { ...DEFAULT_STATE };
  }

  const content = await readFile(STATE_FILE, 'utf-8');

  if (!isValidJSON(content)) {
    console.log(`⚠️ Corrupted or empty state file at ${STATE_FILE}, returning default state`);
    // Backup the corrupted file for debugging
    const backupPath = `${STATE_FILE}.corrupted.${Date.now()}`;
    await writeFile(backupPath, content).catch(() => {});
    console.log(`📝 Backed up corrupted state to ${backupPath}`);
    return { ...DEFAULT_STATE };
  }

  const state = JSON.parse(content);

  // Merge with defaults to ensure all fields exist
  return {
    ...DEFAULT_STATE,
    ...state,
    config: { ...DEFAULT_CONFIG, ...state.config },
    stats: { ...DEFAULT_STATE.stats, ...state.stats }
  };
}

/**
 * Save CoS state
 */
async function saveState(state) {
  await ensureDirectories();
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Get current CoS status
 */
export async function getStatus() {
  const state = await loadState();
  const provider = await getActiveProvider();

  // Count active agents
  const activeAgents = Object.values(state.agents).filter(a => a.status === 'running').length;

  return {
    running: daemonRunning,
    paused: state.paused || false,
    pausedAt: state.pausedAt,
    pauseReason: state.pauseReason,
    config: state.config,
    stats: state.stats,
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
  if (daemonRunning) {
    emitLog('warn', 'CoS already running');
    return { success: false, error: 'Already running' };
  }

  emitLog('info', 'Starting Chief of Staff daemon...');

  const state = await loadState();
  state.running = true;
  await saveState(state);

  daemonRunning = true;

  // First clean up orphaned agents (agents marked running but no live process)
  const { cleanupOrphanedAgents } = await import('./subAgentSpawner.js');
  const cleanedAgents = await cleanupOrphanedAgents();
  if (cleanedAgents > 0) {
    emitLog('info', `Cleaned up ${cleanedAgents} orphaned agent(s)`);
  }

  // Then reset any orphaned in_progress tasks (no running agent)
  await resetOrphanedTasks();

  // Start evaluation loop using event scheduler
  scheduleEvent({
    id: 'cos-evaluation',
    type: 'interval',
    intervalMs: state.config.evaluationIntervalMs,
    handler: async () => {
      await evaluateTasks();
    },
    metadata: { description: 'CoS task evaluation loop' }
  });

  // Start health check loop using event scheduler
  scheduleEvent({
    id: 'cos-health-check',
    type: 'interval',
    intervalMs: state.config.healthCheckIntervalMs,
    handler: async () => {
      await runHealthCheck();
      // Periodic zombie detection — catches agents whose process died mid-run
      const cleaned = await cleanupOrphanedAgents();
      if (cleaned > 0) {
        emitLog('info', `🧹 Periodic cleanup: ${cleaned} orphaned agent(s)`);
      }
    },
    metadata: { description: 'CoS health check + orphan cleanup loop' }
  });

  // Run initial evaluation and health check
  emitLog('info', 'Running initial task evaluation...');
  await evaluateTasks();
  await runHealthCheck();

  cosEvents.emit('status', { running: true });
  emitLog('success', 'CoS daemon started successfully');
  return { success: true };
}

/**
 * Stop the CoS daemon
 */
export async function stop() {
  if (!daemonRunning) {
    return { success: false, error: 'Not running' };
  }

  // Cancel scheduled events
  cancelEvent('cos-evaluation');
  cancelEvent('cos-health-check');

  const state = await loadState();
  state.running = false;
  await saveState(state);

  daemonRunning = false;
  cosEvents.emit('status', { running: false });
  return { success: true };
}

/**
 * Pause the CoS daemon (for always-on mode)
 * Daemon stays running but skips evaluations
 */
export async function pause(reason = null) {
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
}

/**
 * Resume the CoS daemon from pause
 */
export async function resume() {
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

  // Trigger immediate evaluation on resume
  if (daemonRunning) {
    setTimeout(() => evaluateTasks(), 500);
  }

  return { success: true };
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
 * Reset orphaned in_progress tasks back to pending
 * (tasks marked in_progress but no running agent)
 */
async function resetOrphanedTasks() {
  const state = await loadState();
  const { user: userTaskData } = await getAllTasks();

  if (!userTaskData.exists) {
    emitLog('debug', 'No user tasks file found');
    return;
  }

  const inProgressTasks = userTaskData.grouped.in_progress || [];
  emitLog('debug', `Checking for orphaned tasks: ${inProgressTasks.length} in_progress`);

  const runningAgentTaskIds = Object.values(state.agents)
    .filter(a => a.status === 'running')
    .map(a => a.taskId);

  emitLog('debug', `Running agents: ${runningAgentTaskIds.length}`, { taskIds: runningAgentTaskIds });

  for (const task of inProgressTasks) {
    if (!runningAgentTaskIds.includes(task.id)) {
      emitLog('info', `Resetting orphaned task ${task.id} to pending`, { taskId: task.id });
      await updateTask(task.id, { status: 'pending' }, 'user');
    }
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
  if (!daemonRunning) return;

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

  // Count running agents and available slots (global + per-project)
  const runningAgents = Object.values(state.agents).filter(a => a.status === 'running').length;
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

      let task = null;
      if (request.category === 'selfImprovement' && state.config.selfImprovementEnabled) {
        // Generate self-improvement task for the requested type
        await taskSchedule.clearOnDemandRequest(request.id);
        emitLog('info', `Processing on-demand self-improvement: ${request.taskType}`, { requestId: request.id });

        await taskSchedule.recordExecution(`self-improve:${request.taskType}`);
        await withStateLock(async () => {
          const s = await loadState();
          s.stats.lastSelfImprovement = new Date().toISOString();
          s.stats.lastSelfImprovementType = request.taskType;
          await saveState(s);
        });

        task = await generateSelfImprovementTaskForType(request.taskType, state);
      } else if (request.category === 'appImprovement' && state.config.appImprovementEnabled) {
        // Generate app improvement task for the specific app requested (or next eligible if no appId)
        // Only consider active (non-archived) apps for COS tasks
        const apps = await getActiveApps().catch(() => []);
        let targetApp = null;

        if (request.appId) {
          // Specific app requested
          targetApp = apps.find(a => a.id === request.appId);
          if (!targetApp) {
            emitLog('warn', `On-demand request for unknown app: ${request.appId}`, { requestId: request.id });
            await taskSchedule.clearOnDemandRequest(request.id);
            continue;
          }
        } else {
          // No specific app - use next eligible app (bypass cooldown for on-demand)
          targetApp = await getNextAppForReview(apps, 0); // 0 cooldown = no cooldown check
          if (!targetApp && apps.length > 0) {
            // All apps might be on cooldown - pick the first app anyway for on-demand
            targetApp = apps[0];
          }
          if (!targetApp) {
            emitLog('warn', 'On-demand app improvement requested but no apps available', { requestId: request.id });
            await taskSchedule.clearOnDemandRequest(request.id);
            continue;
          }
        }

        await taskSchedule.clearOnDemandRequest(request.id);
        emitLog('info', `Processing on-demand app improvement: ${request.taskType} for ${targetApp.name}`, { requestId: request.id, appId: targetApp.id });

        // Mark app review started and record execution
        await markAppReviewStarted(targetApp.id, `on-demand-${Date.now()}`);
        await taskSchedule.recordExecution(`app-improve:${request.taskType}`, targetApp.id);

        task = await generateManagedAppImprovementTaskForType(request.taskType, targetApp, state);
      }

      if (task && canSpawnTask(task)) {
        tasksToSpawn.push(task);
        trackSpawn(task);
      }
    }
  }

  // Priority 1: User tasks (always run - cooldown only applies to system tasks)
  const pendingUserTasks = userTaskData.grouped?.pending || [];
  for (const task of pendingUserTasks) {
    if (tasksToSpawn.length >= availableSlots) break;
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

      // Check if task's app is on cooldown
      const appId = task.metadata?.app;
      if (appId) {
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
  if (state.config.idleReviewEnabled && !hasPendingUserTasks) {
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

  // Priority 3.5: Autonomous jobs (recurring scheduled jobs)
  if (tasksToSpawn.length < availableSlots && !hasPendingUserTasks && state.config.autonomousJobsEnabled) {
    const dueJobs = await getDueJobs().catch(err => {
      emitLog('debug', `Autonomous jobs check failed: ${err.message}`);
      return [];
    });

    for (const job of dueJobs) {
      if (tasksToSpawn.length >= availableSlots) break;
      const task = await generateTaskFromJob(job);
      if (!canSpawnTask(task)) continue;
      tasksToSpawn.push(task);
      trackSpawn(task);
      emitLog('info', `Autonomous job due: ${job.name} (${job.reason})`, {
        jobId: job.id,
        category: job.category
      });
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

  emitLog('info', `Evaluation: ${pendingUserCount} user pending, ${inProgressCount} in_progress, ${pendingSystemCount} system, spawning ${tasksToSpawn.length}`, {
    pendingUser: pendingUserCount,
    inProgress: inProgressCount,
    pendingSystem: pendingSystemCount,
    toSpawn: tasksToSpawn.length,
    availableSlots
  });

  // Periodically log performance summary with learning insights (every 10 evaluations)
  const evalCount = state.stats.evaluationCount || 0;
  if (evalCount % 10 === 0 && evalCount > 0) {
    const perfSummary = await getPerformanceSummary().catch(() => null);
    if (perfSummary && perfSummary.totalCompleted > 0) {
      emitLog('info', `Performance: ${perfSummary.overallSuccessRate}% success rate over ${perfSummary.totalCompleted} tasks`, {
        successRate: perfSummary.overallSuccessRate,
        totalCompleted: perfSummary.totalCompleted,
        topPerformers: perfSummary.topPerformers.length,
        needsAttention: perfSummary.needsAttention.length
      });

      // Surface learning recommendations every 20 evaluations (less frequent to avoid noise)
      if (evalCount % 20 === 0) {
        const learningInsights = await getLearningInsights().catch(() => null);
        if (learningInsights?.recommendations?.length > 0) {
          const recommendations = learningInsights.recommendations.slice(0, 3);
          for (const rec of recommendations) {
            const level = rec.type === 'warning' ? 'warn' : rec.type === 'action' ? 'info' : 'debug';
            emitLog(level, `🧠 Learning: ${rec.message}`, { recommendationType: rec.type });
          }
          // Emit event for UI consumption
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
      }
    }
  }

  // Periodically check for task types eligible for auto-rehabilitation (every 100 evaluations, ~2 hours)
  // This gives previously-failing task types a fresh chance after their grace period expires
  if (evalCount % 100 === 0 && evalCount > 0) {
    const gracePeriodMs = (state.config.rehabilitationGracePeriodDays || 7) * 24 * 60 * 60 * 1000;
    const rehabilitationResult = await checkAndRehabilitateSkippedTasks(gracePeriodMs).catch(() => ({ count: 0 }));
    if (rehabilitationResult.count > 0) {
      emitLog('success', `Auto-rehabilitated ${rehabilitationResult.count} skipped task type(s) for retry`, {
        rehabilitated: rehabilitationResult.rehabilitated?.map(r => r.taskType) || []
      });
    }
  }

  // Update evaluation count
  await withStateLock(async () => {
    const s = await loadState();
    s.stats.evaluationCount = (s.stats.evaluationCount || 0) + 1;
    await saveState(s);
  });

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
    emitLog('info', `No tasks to process - idle: ${idleReason}`);
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
  // Check if we should run self-improvement (alternates with app reviews)
  const lastSelfImprovementTime = state.stats.lastSelfImprovement
    ? new Date(state.stats.lastSelfImprovement).getTime()
    : 0;
  const lastIdleReviewTime = state.stats.lastIdleReview
    ? new Date(state.stats.lastIdleReview).getTime()
    : 0;

  // Prioritize self-improvement if it hasn't run recently (or ever)
  const shouldRunSelfImprovement = lastSelfImprovementTime <= lastIdleReviewTime;

  if (shouldRunSelfImprovement && state.config.selfImprovementEnabled) {
    const selfImprovementTask = await generateSelfImprovementTask(state);
    if (selfImprovementTask) {
      return selfImprovementTask;
    }
  }

  // Try app reviews (if enabled)
  if (state.config.appImprovementEnabled) {
    // Get all active (non-archived) managed apps
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

      // Use comprehensive improvement if enabled, otherwise use simple idle review
      if (state.config.comprehensiveAppImprovement) {
        emitLog('info', `Generating comprehensive improvement task for ${nextApp.name}`, { appId: nextApp.id });
        return await generateManagedAppImprovementTask(nextApp, state);
      } else {
        emitLog('info', `Generating idle review task for ${nextApp.name}`, { appId: nextApp.id });

        // Create a simple idle review task (legacy behavior)
        return {
          id: `idle-review-${nextApp.id}-${Date.now().toString(36)}`,
          status: 'pending',
          priority: state.config.idleReviewPriority || 'MEDIUM',
          priorityValue: PRIORITY_VALUES[state.config.idleReviewPriority] || 2,
          description: `[Idle Review] Review ${nextApp.name} codebase for improvements: formatting issues, dead code, DRY violations, typos, and other small fixes that can be auto-approved. Commit each fix with a clear description.`,
          metadata: {
            app: nextApp.id,
            appName: nextApp.name,
            repoPath: nextApp.repoPath,
            reviewType: 'idle',
            autoGenerated: true
          },
          taskType: 'internal',
          autoApproved: true
        };
      }
    }
  }
  }

  // All apps on cooldown or no apps - fall back to self-improvement
  // This ensures CoS is ALWAYS working on something
  if (state.config.selfImprovementEnabled) {
    emitLog('info', 'No apps available for review - running self-improvement instead');
    return await generateSelfImprovementTask(state);
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
  const { getDueSelfImprovementTasks, shouldRunSelfImprovementTask, getNextAppImprovementTaskType } = await import('./taskSchedule.js');

  // Get existing pending/in_progress system tasks to avoid duplicates
  const existingTasks = cosTaskData.tasks || [];
  const existingTaskTypes = new Set();

  for (const task of existingTasks) {
    if (task.status === 'pending' || task.status === 'in_progress') {
      // Check for self-improvement type in metadata or description
      const selfImpType = task.metadata?.selfImprovementType ||
        task.description?.match(/\[self-improvement\]\s*(\w[\w-]*)/i)?.[1];
      if (selfImpType) {
        existingTaskTypes.add(selfImpType);
      }
      // Check for app improvement type
      const appImpType = task.metadata?.analysisType;
      const appId = task.metadata?.app;
      if (appImpType && appId) {
        existingTaskTypes.add(`app:${appId}:${appImpType}`);
      }
    }
  }

  let queued = 0;

  // Queue eligible self-improvement tasks for PortOS
  if (state.config.selfImprovementEnabled) {
    const dueTasks = await getDueSelfImprovementTasks().catch(() => []);

    for (const taskType of dueTasks) {
      // Skip if already queued
      if (existingTaskTypes.has(taskType)) {
        emitLog('debug', `Self-improvement task ${taskType} already queued`);
        continue;
      }

      // Double-check eligibility
      const eligible = await shouldRunSelfImprovementTask(taskType).catch(() => false);
      if (!eligible) continue;

      // Generate task description
      const taskDesc = getSelfImprovementTaskDescription(taskType);
      if (!taskDesc) continue;

      // Add to COS-TASKS.md
      const newTask = await addTask({
        id: `sys-${taskType}-${Date.now().toString(36)}`,
        description: `[self-improvement] ${taskType}: ${taskDesc}`,
        priority: 'LOW',
        app: null,
        context: `Auto-generated self-improvement task. Type: ${taskType}`,
        approvalRequired: false
      }, 'internal');

      emitLog('info', `Queued self-improvement task: ${taskType}`, { taskId: newTask.id });
      existingTaskTypes.add(taskType);
      queued++;
    }
  }

  // Queue eligible app improvement tasks for managed apps (if enabled)
  if (state.config.appImprovementEnabled) {
    // Only queue tasks for active (non-archived) apps
    const apps = await getActiveApps().catch(() => []);
    for (const app of apps) {
    // Check if app is on cooldown
    const onCooldown = await isAppOnCooldown(app.id, state.config.appReviewCooldownMs);
    if (onCooldown) continue;

    // Get next eligible improvement type for this app
    const nextType = await getNextAppImprovementTaskType(app.id).catch(() => null);
    if (!nextType) continue;

    const taskKey = `app:${app.id}:${nextType}`;
    if (existingTaskTypes.has(taskKey)) {
      emitLog('debug', `App improvement task ${nextType} for ${app.name} already queued`);
      continue;
    }

    // Generate task description
    const taskDesc = getAppImprovementTaskDescription(nextType, app);
    if (!taskDesc) continue;

    // Add to COS-TASKS.md
    const newTask = await addTask({
      id: `sys-app-${app.id.slice(0, 8)}-${nextType}-${Date.now().toString(36)}`,
      description: taskDesc,
      priority: 'LOW',
      app: app.id,
      context: `Auto-generated app improvement task for ${app.name}. Type: ${nextType}`,
      approvalRequired: false
    }, 'internal');

    emitLog('info', `Queued app improvement task: ${nextType} for ${app.name}`, { taskId: newTask.id, appId: app.id });
    existingTaskTypes.add(taskKey);
    queued++;

    // Only queue one task per app per evaluation to avoid flooding
    break;
  }
  }

  if (queued > 0) {
    emitLog('info', `Queued ${queued} improvement task(s) to system tasks`);
  }
}

/**
 * Get task description for a self-improvement type
 */
function getSelfImprovementTaskDescription(taskType) {
  const descriptions = {
    'ui-bugs': 'Review PortOS UI for visual bugs, layout issues, and UX improvements',
    'mobile-responsive': 'Check mobile responsiveness and fix layout issues on smaller screens',
    'security': 'Audit PortOS for security vulnerabilities (XSS, injection, auth issues)',
    'code-quality': 'Review code for DRY violations, dead code, and refactoring opportunities',
    'console-errors': 'Check browser console and fix JavaScript errors and warnings',
    'performance': 'Profile and optimize slow components, queries, and renders',
    'cos-enhancement': 'Improve CoS capabilities, prompts, and task handling logic',
    'test-coverage': 'Add missing tests for uncovered code paths',
    'documentation': 'Update documentation, comments, and README files',
    'feature-ideas': 'Brainstorm and document potential new features for PortOS',
    'accessibility': 'Audit and fix accessibility issues (ARIA, keyboard nav, contrast)',
    'dependency-updates': 'Check for and safely update outdated dependencies'
  };
  return descriptions[taskType] || null;
}

/**
 * Get task description for an app improvement type
 */
function getAppImprovementTaskDescription(taskType, app) {
  const descriptions = {
    'security-audit': `Security audit for ${app.name}: check for vulnerabilities`,
    'code-quality': `Code quality review for ${app.name}: DRY violations, dead code`,
    'test-coverage': `Add missing tests for ${app.name}`,
    'performance': `Performance optimization for ${app.name}`,
    'accessibility': `Accessibility audit for ${app.name}`,
    'console-errors': `Fix console errors in ${app.name}`,
    'dependency-updates': `Update dependencies for ${app.name}`,
    'documentation': `Update documentation for ${app.name}`,
    'error-handling': `Improve error handling in ${app.name}`,
    'typing': `Add/fix TypeScript types in ${app.name}`
  };
  return descriptions[taskType] || null;
}

// Self-improvement task types (rotates through these)
// Organized by goal priority from COS-GOALS.md
const SELF_IMPROVEMENT_TYPES = [
  // Goal 1: Codebase Quality
  'ui-bugs',
  'mobile-responsive',
  'security',
  'code-quality',
  'console-errors',
  'performance',
  // Goal 2: Self-Improvement (CoS enhancing itself)
  'cos-enhancement',
  'test-coverage',
  // Goal 3: Documentation
  'documentation',
  // Goal 4: User Engagement
  'feature-ideas',
  // Goal 5: System Health
  'accessibility',
  'dependency-updates'
];

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

  // First, check for any on-demand task requests
  const onDemandRequests = await taskSchedule.getOnDemandRequests();
  const selfImprovementRequests = onDemandRequests.filter(r => r.category === 'selfImprovement');

  if (selfImprovementRequests.length > 0) {
    const request = selfImprovementRequests[0];
    await taskSchedule.clearOnDemandRequest(request.id);
    emitLog('info', `Processing on-demand task request: ${request.taskType}`, { requestId: request.id });

    // Record execution and generate the requested task
    await taskSchedule.recordExecution(`self-improve:${request.taskType}`);

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
  const nextTypeResult = await taskSchedule.getNextSelfImprovementTaskType(lastType);

  if (!nextTypeResult) {
    emitLog('info', 'No self-improvement tasks are eligible to run based on schedule');
    await recordDecision(
      DECISION_TYPES.NOT_DUE,
      'No self-improvement tasks are eligible based on schedule',
      { category: 'selfImprovement' }
    );
    return null;
  }

  let nextType = nextTypeResult.taskType;
  const selectionReason = nextTypeResult.reason;

  // Additional check: skip if learning data suggests poor performance
  const taskTypeKey = `self-improve:${nextType}`;
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
    const dueTasks = await taskSchedule.getDueSelfImprovementTasks();
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
        const oldestType = skippedTypes[0].taskType.replace('self-improve:', '');
        nextType = oldestType;
        emitLog('info', `Retrying ${oldestType} as it hasn't been attempted recently`);

        // Record rehabilitation decision
        await recordDecision(
          DECISION_TYPES.REHABILITATION,
          `Retrying ${oldestType} after period of inactivity`,
          { taskType: oldestType, reason: 'oldest-skipped-type' }
        );
      } else {
        nextType = SELF_IMPROVEMENT_TYPES[0];
      }
    }
  }

  // Log if there's a recommendation from learning system
  if (cooldownInfo.recommendation) {
    emitLog('info', `Learning insight for ${nextType}: ${cooldownInfo.recommendation}`, {
      taskType: nextType,
      multiplier: cooldownInfo.multiplier
    });
  }

  // Record execution in the schedule service
  await taskSchedule.recordExecution(`self-improve:${nextType}`);

  // Update state with new timestamp and type
  await withStateLock(async () => {
    const s = await loadState();
    s.stats.lastSelfImprovement = new Date().toISOString();
    s.stats.lastSelfImprovementType = nextType;
    await saveState(s);
  });

  emitLog('info', `Generating self-improvement task: ${nextType} (${selectionReason})`);

  // Record task selection decision
  await recordDecision(
    DECISION_TYPES.TASK_SELECTED,
    `Selected ${nextType} for self-improvement`,
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
 * Helper function to generate a self-improvement task for a specific type
 * Used by both normal rotation and on-demand task requests
 */
async function generateSelfImprovementTaskForType(taskType, state, taskDescriptions = null) {
  const taskSchedule = await import('./taskSchedule.js');
  const interval = await taskSchedule.getSelfImprovementInterval(taskType);

  // Get the effective prompt (custom or default)
  const description = await taskSchedule.getSelfImprovementPrompt(taskType);

  const metadata = {
    analysisType: taskType,
    autoGenerated: true,
    selfImprovement: true
  };

  // Use configured model/provider if specified, otherwise use default
  if (interval.providerId) {
    metadata.providerId = interval.providerId;
  }
  if (interval.model) {
    metadata.model = interval.model;
  } else {
    metadata.model = 'claude-opus-4-5-20251101';
  }

  const task = {
    id: `self-improve-${taskType}-${Date.now().toString(36)}`,
    status: 'pending',
    priority: 'MEDIUM',
    priorityValue: PRIORITY_VALUES['MEDIUM'],
    description,
    metadata,
    taskType: 'internal',
    autoApproved: true
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

1. Navigate to http://localhost:5555/
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

1. browser_resize to mobile (375x812), then navigate to http://localhost:5555/
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

1. Navigate to http://localhost:5555/
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

1. Navigate to http://localhost:5555/
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

    'cos-enhancement': `[Self-Improvement] Enhance CoS Capabilities

Review the CoS system and add new capabilities:

1. Read data/COS-GOALS.md to understand the mission and goals
2. Review server/services/cos.js for improvement opportunities:
   - Better task prioritization logic
   - Smarter model selection
   - More informative status messages
   - Better error recovery

3. Review the self-improvement task prompts:
   - Are they comprehensive enough?
   - Do they lead to quality fixes?
   - What new analysis types could be added?

4. Consider adding:
   - New MCP server integrations
   - Better metrics tracking
   - Learning from completed tasks
   - Smarter cooldown logic

5. Implement ONE meaningful enhancement and commit it

Focus on making CoS more autonomous and effective.

Use model: claude-opus-4-5-20251101 for thoughtful enhancement`,

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

1. Update PLAN.md:
   - Mark completed milestones
   - Add any new features implemented
   - Document architectural decisions

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

    'feature-ideas': `[Self-Improvement] Brainstorm and Implement Feature

Think about ways to make PortOS more useful:

1. Read data/COS-GOALS.md for context on user goals
2. Review recent completed tasks to understand patterns
3. Consider these areas:
   - User task management improvements
   - Better progress visualization
   - New automation capabilities
   - Enhanced monitoring features

4. Choose ONE small, high-impact feature to implement:
   - Something that saves user time
   - Improves the developer experience
   - Makes CoS more helpful

5. Implement it:
   - Write clean, tested code
   - Follow existing patterns
   - Update relevant documentation

6. Commit with a clear description of the new feature

Think creatively but implement practically.

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
async function generateManagedAppImprovementTask(app, state) {
  const { getAppActivityById, updateAppActivity } = await import('./appActivity.js');
  const taskSchedule = await import('./taskSchedule.js');

  // First, check for any on-demand task requests for this app
  const onDemandRequests = await taskSchedule.getOnDemandRequests();
  const appRequests = onDemandRequests.filter(r =>
    r.category === 'appImprovement' && r.appId === app.id
  );

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
    const nextTypeResult = await taskSchedule.getNextAppImprovementTaskType(app.id, lastType);

    if (!nextTypeResult) {
      emitLog('info', `No app improvement tasks are eligible for ${app.name} based on schedule`);
      return null;
    }

    nextType = nextTypeResult.taskType;
    selectionReason = nextTypeResult.reason;
  }

  // Record execution in the schedule service
  await taskSchedule.recordExecution(`app-improve:${nextType}`, app.id);

  // Update app activity with new type
  await updateAppActivity(app.id, {
    lastImprovementType: nextType
  });

  emitLog('info', `Generating comprehensive improvement task for ${app.name}: ${nextType} (${selectionReason})`, { appId: app.id, analysisType: nextType });

  // Get the effective prompt (custom or default template)
  const promptTemplate = await taskSchedule.getAppImprovementPrompt(nextType);

  // Replace template variables in the prompt
  const description = promptTemplate
    .replace(/\{appName\}/g, app.name)
    .replace(/\{repoPath\}/g, app.repoPath);

  // Legacy task descriptions - keeping for fallback but they won't be used
  const taskDescriptions = {
    'security-audit': `[App Improvement: ${app.name}] Security Audit

Analyze the ${app.name} codebase for security vulnerabilities:

Repository: ${app.repoPath}

1. Review routes/controllers for:
   - Command injection in exec/spawn calls
   - Path traversal in file operations
   - Missing input validation
   - XSS vulnerabilities
   - SQL/NoSQL injection

2. Review services for:
   - Unsafe eval() or Function()
   - Hardcoded credentials
   - Insecure dependencies

3. Review client code for:
   - XSS vulnerabilities
   - Sensitive data in localStorage
   - CSRF protection

4. Check authentication and authorization:
   - Secure password handling
   - Token management
   - Access control

Fix any vulnerabilities found and commit with security advisory notes.

Use model: claude-opus-4-5-20251101 for thorough security analysis`,

    'code-quality': `[App Improvement: ${app.name}] Code Quality Review

Analyze ${app.name} for maintainability improvements:

Repository: ${app.repoPath}

1. Find DRY violations - similar code in multiple places
2. Identify functions >50 lines that should be split
3. Look for missing error handling
4. Find dead code and unused imports
5. Check for console.log that should be removed
6. Look for TODO/FIXME that need addressing
7. Identify magic numbers that should be constants

Focus on the main source directories. Refactor issues found and commit improvements.

Use model: claude-opus-4-5-20251101 for quality refactoring`,

    'test-coverage': `[App Improvement: ${app.name}] Improve Test Coverage

Analyze and improve test coverage for ${app.name}:

Repository: ${app.repoPath}

1. Check existing tests and identify untested critical paths
2. Look for:
   - API routes without tests
   - Services with complex logic
   - Error handling paths
   - Edge cases

3. Add tests following existing patterns in the project
4. Ensure tests:
   - Use appropriate mocks
   - Test edge cases
   - Follow naming conventions

5. Run tests to verify all pass
6. Commit test additions with clear message describing coverage

Use model: claude-opus-4-5-20251101 for comprehensive test design`,

    'performance': `[App Improvement: ${app.name}] Performance Analysis

Analyze ${app.name} for performance issues:

Repository: ${app.repoPath}

1. Review components/views for:
   - Unnecessary re-renders
   - Missing memoization
   - Large files that should be split

2. Review backend for:
   - N+1 query patterns
   - Missing caching opportunities
   - Inefficient file operations
   - Slow API endpoints

3. Review build/bundle for:
   - Missing code splitting
   - Large dependencies that could be optimized

4. Check for:
   - Memory leaks
   - Unnecessary broadcasts/events

Optimize and commit improvements.

Use model: claude-opus-4-5-20251101 for performance optimization`,

    'accessibility': `[App Improvement: ${app.name}] Accessibility Audit

Audit ${app.name} for accessibility issues:

Repository: ${app.repoPath}

If the app has a web UI:
1. Navigate to the app's UI
2. Check for:
   - Missing ARIA labels
   - Missing alt text on images
   - Insufficient color contrast
   - Keyboard navigation issues
   - Focus indicators
   - Semantic HTML usage

3. Fix accessibility issues in components
4. Add appropriate aria-* attributes
5. Test and commit changes

Use model: claude-opus-4-5-20251101 for comprehensive a11y fixes`,

    'console-errors': `[App Improvement: ${app.name}] Console Error Investigation

Find and fix console errors in ${app.name}:

Repository: ${app.repoPath}

1. If the app has a UI, check browser console for errors
2. Check server logs for errors
3. For each error:
   - Identify the source file and line
   - Understand the root cause
   - Implement a fix

4. Test fixes and commit changes

Use model: claude-opus-4-5-20251101 for thorough debugging`,

    'dependency-updates': `[App Improvement: ${app.name}] Dependency Updates

Check ${app.name} dependencies for updates and security vulnerabilities:

Repository: ${app.repoPath}

1. Run npm audit (or equivalent package manager)
2. Check for outdated packages
3. Review CRITICAL and HIGH severity vulnerabilities
4. For each vulnerability:
   - Assess actual risk
   - Check if update available
   - Test updates don't break functionality

5. Update dependencies carefully:
   - Patch versions first (safest)
   - Then minor versions
   - Major versions need careful review

6. After updating:
   - Run tests
   - Verify the app starts correctly

7. Commit with clear changelog

IMPORTANT: Only update one major version bump at a time.

Use model: claude-opus-4-5-20251101 for thorough security analysis`,

    'documentation': `[App Improvement: ${app.name}] Update Documentation

Review and improve ${app.name} documentation:

Repository: ${app.repoPath}

1. Check README.md:
   - Installation instructions current?
   - Quick start guide clear?
   - Feature overview complete?

2. Review inline documentation:
   - Add JSDoc to exported functions
   - Document complex algorithms
   - Explain non-obvious code

3. Check for docs/ folder:
   - Are all features documented?
   - Is information current?
   - Add missing guides if needed

4. Update PLAN.md or similar if present:
   - Mark completed milestones
   - Document architectural decisions

Commit documentation improvements.

Use model: claude-opus-4-5-20251101 for clear documentation`,

    'error-handling': `[App Improvement: ${app.name}] Improve Error Handling

Enhance error handling in ${app.name}:

Repository: ${app.repoPath}

1. Review code for:
   - Missing try-catch blocks where needed
   - Silent failures (empty catch blocks)
   - Errors that should be logged
   - User-facing error messages

2. Add error handling for:
   - Network requests
   - File operations
   - Database queries
   - External API calls

3. Ensure errors are:
   - Logged appropriately
   - Have clear messages
   - Include relevant context
   - Don't expose sensitive data

4. Test error paths and commit improvements

Use model: claude-opus-4-5-20251101 for comprehensive error handling`,

    'typing': `[App Improvement: ${app.name}] TypeScript Type Improvements

Improve TypeScript types in ${app.name}:

Repository: ${app.repoPath}

1. Review TypeScript files for:
   - 'any' types that should be specific
   - Missing type annotations
   - Type assertions that could be avoided
   - Missing interfaces/types for objects

2. Add types for:
   - Function parameters and returns
   - Component props
   - API responses
   - Configuration objects

3. Ensure:
   - Types are properly exported
   - No implicit any
   - Types are reusable

4. Run type checking and commit improvements

Use model: claude-opus-4-5-20251101 for thorough typing`
  };

  // Get interval settings to determine provider/model
  const interval = await taskSchedule.getAppImprovementInterval(nextType);

  const metadata = {
    app: app.id,
    appName: app.name,
    repoPath: app.repoPath,
    analysisType: nextType,
    autoGenerated: true,
    comprehensiveImprovement: true
  };

  // Use configured model/provider if specified, otherwise use default
  if (interval.providerId) {
    metadata.providerId = interval.providerId;
  }
  if (interval.model) {
    metadata.model = interval.model;
  } else {
    metadata.model = 'claude-opus-4-5-20251101';
  }

  const task = {
    id: `app-improve-${app.id}-${nextType}-${Date.now().toString(36)}`,
    status: 'pending',
    priority: state.config.idleReviewPriority || 'MEDIUM',
    priorityValue: PRIORITY_VALUES[state.config.idleReviewPriority] || 2,
    description,
    metadata,
    taskType: 'internal',
    autoApproved: true
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
async function generateManagedAppImprovementTaskForType(taskType, app, state) {
  const { updateAppActivity } = await import('./appActivity.js');
  const taskSchedule = await import('./taskSchedule.js');

  // Update app activity with new type
  await updateAppActivity(app.id, {
    lastImprovementType: taskType
  });

  emitLog('info', `Generating app improvement task for ${app.name}: ${taskType} (on-demand)`, { appId: app.id, analysisType: taskType });

  // Get the effective prompt (custom or default template)
  const promptTemplate = await taskSchedule.getAppImprovementPrompt(taskType);

  // Replace template variables in the prompt
  const description = promptTemplate
    .replace(/\{appName\}/g, app.name)
    .replace(/\{repoPath\}/g, app.repoPath);

  // Get interval settings to determine provider/model
  const interval = await taskSchedule.getAppImprovementInterval(taskType);

  const metadata = {
    app: app.id,
    appName: app.name,
    repoPath: app.repoPath,
    analysisType: taskType,
    autoGenerated: true,
    comprehensiveImprovement: true
  };

  // Use configured model/provider if specified, otherwise use default
  if (interval.providerId) {
    metadata.providerId = interval.providerId;
  }
  if (interval.model) {
    metadata.model = interval.model;
  } else {
    metadata.model = 'claude-opus-4-5-20251101';
  }

  const task = {
    id: `app-improve-${app.id}-${taskType}-${Date.now().toString(36)}`,
    status: 'pending',
    priority: state.config.idleReviewPriority || 'MEDIUM',
    priorityValue: PRIORITY_VALUES[state.config.idleReviewPriority] || 2,
    description,
    metadata,
    taskType: 'internal',
    autoApproved: true
  };

  return task;
}

/**
 * Run system health check
 */
export async function runHealthCheck() {
  if (!daemonRunning) return;

  const state = await loadState();
  const issues = [];
  const metrics = {
    timestamp: new Date().toISOString(),
    pm2: null,
    memory: null,
    ports: null
  };

  // Check PM2 processes
  const pm2Result = await execAsync('pm2 jlist 2>/dev/null || echo "[]"').catch(() => ({ stdout: '[]' }));
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
  const pm2Processes = JSON.parse(pm2Json);

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
      const result = await execFileAsync('pm2', ['restart', name]).catch(e => ({ stdout: '', stderr: e.message }));
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
  const memResult = await execAsync('vm_stat 2>/dev/null || free -m 2>/dev/null').catch(() => ({ stdout: '' }));
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
    ? JSON.parse(await readFile(metaPath, 'utf-8'))
    : {};

  return { name, content, metadata };
}

/**
 * Register a spawned agent
 */
export async function registerAgent(agentId, taskId, metadata = {}) {
  return withStateLock(async () => {
    const state = await loadState();

    state.agents[agentId] = {
      id: agentId,
      taskId,
      status: 'running',
      startedAt: new Date().toISOString(),
      metadata,
      output: []
    };

    state.stats.agentsSpawned++;
    await saveState(state);

    cosEvents.emit('agent:spawned', state.agents[agentId]);
    return state.agents[agentId];
  });
}

/**
 * Update agent status
 */
export async function updateAgent(agentId, updates) {
  return withStateLock(async () => {
    const state = await loadState();

    if (!state.agents[agentId]) {
      return null;
    }

    // Merge metadata if present in updates
    if (updates.metadata) {
      state.agents[agentId] = {
        ...state.agents[agentId],
        ...updates,
        metadata: { ...state.agents[agentId].metadata, ...updates.metadata }
      };
    } else {
      state.agents[agentId] = { ...state.agents[agentId], ...updates };
    }
    await saveState(state);

    cosEvents.emit('agent:updated', state.agents[agentId]);
    return state.agents[agentId];
  });
}

/**
 * Mark agent as completed
 */
export async function completeAgent(agentId, result = {}) {
  return withStateLock(async () => {
    const state = await loadState();

    if (!state.agents[agentId]) {
      return null;
    }

    state.agents[agentId] = {
      ...state.agents[agentId],
      status: 'completed',
      completedAt: new Date().toISOString(),
      result
    };

    if (result.success) {
      state.stats.tasksCompleted++;
    } else {
      state.stats.errors = (state.stats.errors || 0) + 1;
    }

    await saveState(state);
    cosEvents.emit('agent:completed', state.agents[agentId]);
    cosEvents.emit('agent:updated', state.agents[agentId]);

    // Save agent data to file for history
    const agentDir = join(AGENTS_DIR, agentId);
    if (!existsSync(agentDir)) {
      await mkdir(agentDir, { recursive: true });
    }
    await writeFile(
      join(agentDir, 'metadata.json'),
      JSON.stringify(state.agents[agentId], null, 2)
    );

    // Update in-memory cache so completed agents survive state resets
    if (completedAgentCache) {
      const { output, ...agentWithoutOutput } = state.agents[agentId];
      completedAgentCache.set(agentId, agentWithoutOutput);
    }

    return state.agents[agentId];
  });
}

/**
 * Append output to agent
 */
export async function appendAgentOutput(agentId, line) {
  const result = await withStateLock(async () => {
    const state = await loadState();

    if (!state.agents[agentId]) {
      return null;
    }

    state.agents[agentId].output.push({
      timestamp: new Date().toISOString(),
      line
    });

    // Trim to last 1000 lines in state
    if (state.agents[agentId].output.length > 1000) {
      state.agents[agentId].output = state.agents[agentId].output.slice(-1000);
    }

    await saveState(state);
    return state.agents[agentId];
  });

  if (result) {
    cosEvents.emit('agent:output', { agentId, line });
  }

  return result;
}

/**
 * Get all agents — merges in-memory state (running agents) with
 * persisted completed agents from disk metadata files.
 */
export async function getAgents() {
  const state = await loadState();
  const cache = await loadCompletedAgentCache();

  // Start with all agents from state (running + any completed still in state)
  const merged = { ...Object.fromEntries([...cache.entries()]) };

  // State agents override cache (they have fresher data for running agents)
  for (const [id, agent] of Object.entries(state.agents)) {
    merged[id] = agent;
  }

  return Object.values(merged);
}

/**
 * Get agent by ID with full output from file
 */
export async function getAgent(agentId) {
  const state = await loadState();
  let agent = state.agents[agentId];

  // Fall back to disk metadata if not in state
  if (!agent) {
    const cache = await loadCompletedAgentCache();
    agent = cache.get(agentId) ?? null;
  }
  if (!agent) return null;

  // For completed agents, read full output from file
  if (agent.status === 'completed') {
    const outputFile = join(AGENTS_DIR, agentId, 'output.txt');
    if (existsSync(outputFile)) {
      const fullOutput = await readFile(outputFile, 'utf-8');
      // Convert string to output array format
      const lines = fullOutput.split('\n').filter(line => line.trim());
      return {
        ...agent,
        output: lines.map(line => ({ line, timestamp: agent.completedAt }))
      };
    }
  }

  return agent;
}

/**
 * Terminate an agent (will be handled by spawner)
 */
export async function terminateAgent(agentId) {
  // Emit event to kill the process FIRST
  cosEvents.emit('agent:terminate', agentId);
  // The spawner will handle marking the agent as completed after termination
  return { success: true, agentId };
}

/**
 * Force kill an agent with SIGKILL (immediate, no graceful shutdown)
 */
export async function killAgent(agentId) {
  const { killAgent: killAgentFromSpawner } = await import('./subAgentSpawner.js');
  return killAgentFromSpawner(agentId);
}

/**
 * Get process stats for an agent (CPU, memory)
 */
export async function getAgentProcessStats(agentId) {
  const { getAgentProcessStats: getStatsFromSpawner } = await import('./subAgentSpawner.js');
  return getStatsFromSpawner(agentId);
}

/**
 * Check if a PID is still running
 */
async function isPidAlive(pid) {
  if (!pid) return false;
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);
  const result = await execAsync(`ps -p ${pid} -o pid= 2>/dev/null`).catch(() => ({ stdout: '' }));
  return result.stdout.trim() !== '';
}

/**
 * Cleanup zombie agents - agents marked as running but whose process is dead
 */
export async function cleanupZombieAgents() {
  // Check local tracking maps
  const { getActiveAgentIds } = await import('./subAgentSpawner.js');
  const activeIds = getActiveAgentIds();

  // Also check with the CoS runner for agents it's actively tracking
  const { getActiveAgentsFromRunner } = await import('./cosRunnerClient.js');
  const runnerAgents = await getActiveAgentsFromRunner().catch(() => []);
  const runnerAgentIds = new Set(runnerAgents.map(a => a.id));

  return withStateLock(async () => {
    const state = await loadState();
    const runningAgents = Object.values(state.agents).filter(a => a.status === 'running');
    const cleaned = [];

    for (const agent of runningAgents) {
      // Skip if tracked in local maps or runner
      if (activeIds.includes(agent.id) || runnerAgentIds.has(agent.id)) {
        continue;
      }

      // If agent has a PID, verify the process is actually dead
      if (agent.pid) {
        const alive = await isPidAlive(agent.pid);
        if (alive) {
          // Process is still running, don't mark as zombie
          continue;
        }
      } else {
        // No PID yet - agent might still be initializing
        // Give it a 30 second grace period before marking as zombie
        const startedAt = agent.startedAt ? new Date(agent.startedAt).getTime() : 0;
        const ageMs = Date.now() - startedAt;
        if (ageMs < 30000) {
          // Agent is less than 30 seconds old and has no PID - still initializing
          continue;
        }
      }

      // Agent is not tracked anywhere and process is dead (or no PID after grace period) - it's a zombie
      console.log(`🧟 Zombie agent detected: ${agent.id} (PID ${agent.pid || 'unknown'} not running)`);
      state.agents[agent.id] = {
        ...agent,
        status: 'completed',
        completedAt: new Date().toISOString(),
        result: { success: false, error: 'Agent process terminated unexpectedly' }
      };
      cleaned.push(agent.id);
    }

    if (cleaned.length > 0) {
      await saveState(state);
      console.log(`🧹 Cleaned up ${cleaned.length} zombie agents: ${cleaned.join(', ')}`);
      cosEvents.emit('agents:changed', { action: 'zombie-cleanup', cleaned });
    }

    return { cleaned, count: cleaned.length };
  });
}

/**
 * Delete a single agent from state and disk
 */
export async function deleteAgent(agentId) {
  return withStateLock(async () => {
    const state = await loadState();

    // Check both state and cache
    const inState = !!state.agents[agentId];
    const inCache = completedAgentCache?.has(agentId);
    if (!inState && !inCache) {
      return { error: 'Agent not found' };
    }

    delete state.agents[agentId];
    await saveState(state);

    // Remove from cache
    completedAgentCache?.delete(agentId);

    // Remove metadata files from disk
    const agentDir = join(AGENTS_DIR, agentId);
    if (existsSync(agentDir)) {
      await rm(agentDir, { recursive: true }).catch(() => {});
    }

    cosEvents.emit('agents:changed', { action: 'deleted', agentId });
    return { success: true, agentId };
  });
}

/**
 * Submit feedback for a completed agent
 * @param {string} agentId - Agent ID
 * @param {object} feedback - { rating: 'positive'|'negative'|'neutral', comment?: string }
 */
export async function submitAgentFeedback(agentId, feedback) {
  return withStateLock(async () => {
    const state = await loadState();

    if (!state.agents[agentId]) {
      return { error: 'Agent not found' };
    }

    const agent = state.agents[agentId];
    if (agent.status !== 'completed') {
      return { error: 'Can only submit feedback for completed agents' };
    }

    // Store feedback on the agent
    state.agents[agentId].feedback = {
      rating: feedback.rating,
      comment: feedback.comment || null,
      submittedAt: new Date().toISOString()
    };

    await saveState(state);

    emitLog('info', `Feedback received for agent ${agentId}: ${feedback.rating}`, { agentId, rating: feedback.rating });
    cosEvents.emit('agent:feedback', { agentId, feedback: state.agents[agentId].feedback });

    return { success: true, agent: state.agents[agentId] };
  });
}

/**
 * Get aggregated feedback statistics
 */
export async function getFeedbackStats() {
  const state = await loadState();
  const agents = Object.values(state.agents);

  const withFeedback = agents.filter(a => a.feedback);
  const positive = withFeedback.filter(a => a.feedback.rating === 'positive').length;
  const negative = withFeedback.filter(a => a.feedback.rating === 'negative').length;
  const neutral = withFeedback.filter(a => a.feedback.rating === 'neutral').length;

  // Group by task type
  const byTaskType = {};
  withFeedback.forEach(a => {
    const taskType = extractTaskType(a.metadata?.taskDescription);
    if (!byTaskType[taskType]) {
      byTaskType[taskType] = { positive: 0, negative: 0, neutral: 0, total: 0 };
    }
    byTaskType[taskType][a.feedback.rating]++;
    byTaskType[taskType].total++;
  });

  // Recent feedback (last 10 with comments)
  const recentWithComments = withFeedback
    .filter(a => a.feedback.comment)
    .sort((a, b) => new Date(b.feedback.submittedAt) - new Date(a.feedback.submittedAt))
    .slice(0, 10)
    .map(a => ({
      agentId: a.id,
      taskDescription: a.metadata?.taskDescription,
      rating: a.feedback.rating,
      comment: a.feedback.comment,
      submittedAt: a.feedback.submittedAt
    }));

  const satisfactionRate = withFeedback.length > 0
    ? Math.round((positive / withFeedback.length) * 100)
    : null;

  return {
    total: withFeedback.length,
    positive,
    negative,
    neutral,
    satisfactionRate,
    byTaskType,
    recentWithComments
  };
}

// Helper to extract task type from description (mirrors client-side logic)
function extractTaskType(description) {
  if (!description) return 'general';
  const d = description.toLowerCase();
  if (d.includes('fix') || d.includes('bug') || d.includes('error') || d.includes('issue')) return 'bug-fix';
  if (d.includes('refactor') || d.includes('clean up') || d.includes('improve') || d.includes('optimize')) return 'refactor';
  if (d.includes('test')) return 'testing';
  if (d.includes('document') || d.includes('readme') || d.includes('docs')) return 'documentation';
  if (d.includes('review') || d.includes('audit')) return 'code-review';
  if (d.includes('mobile') || d.includes('responsive')) return 'mobile-responsive';
  if (d.includes('security') || d.includes('vulnerability')) return 'security';
  if (d.includes('performance') || d.includes('speed')) return 'performance';
  if (d.includes('ui') || d.includes('ux') || d.includes('design') || d.includes('style')) return 'ui-ux';
  if (d.includes('api') || d.includes('endpoint') || d.includes('route')) return 'api';
  if (d.includes('database') || d.includes('migration')) return 'database';
  if (d.includes('deploy') || d.includes('ci') || d.includes('cd')) return 'devops';
  if (d.includes('investigate') || d.includes('debug')) return 'investigation';
  if (d.includes('self-improvement') || d.includes('feature idea')) return 'self-improvement';
  return 'feature';
}

/**
 * Generate daily report
 */
export async function generateReport(date = null) {
  const reportDate = date || new Date().toISOString().split('T')[0];
  const state = await loadState();

  // Filter agents completed on this date
  const completedAgents = Object.values(state.agents).filter(a => {
    if (!a.completedAt) return false;
    return a.completedAt.startsWith(reportDate);
  });

  const report = {
    date: reportDate,
    generated: new Date().toISOString(),
    summary: {
      tasksCompleted: completedAgents.filter(a => a.result?.success).length,
      tasksFailed: completedAgents.filter(a => !a.result?.success).length,
      totalAgents: completedAgents.length
    },
    agents: completedAgents.map(a => ({
      id: a.id,
      taskId: a.taskId,
      success: a.result?.success || false,
      duration: a.completedAt && a.startedAt
        ? new Date(a.completedAt) - new Date(a.startedAt)
        : 0
    }))
  };

  // Save report
  const reportFile = join(REPORTS_DIR, `${reportDate}.json`);
  await writeFile(reportFile, JSON.stringify(report, null, 2));

  return report;
}

/**
 * Get report for a date
 */
export async function getReport(date) {
  const reportFile = join(REPORTS_DIR, `${date}.json`);

  if (!existsSync(reportFile)) {
    return null;
  }

  const content = await readFile(reportFile, 'utf-8');
  return JSON.parse(content);
}

/**
 * Get today's report
 */
export async function getTodayReport() {
  const today = new Date().toISOString().split('T')[0];
  return getReport(today) || generateReport(today);
}

/**
 * List all reports
 */
export async function listReports() {
  await ensureDirectories();

  const files = await readdir(REPORTS_DIR);
  return files
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''))
    .sort()
    .reverse();
}

/**
 * List all briefings (markdown files in reports dir)
 */
export async function listBriefings() {
  await ensureDirectories();

  const files = await readdir(REPORTS_DIR);
  return files
    .filter(f => f.endsWith('-briefing.md'))
    .map(f => {
      const date = f.replace('-briefing.md', '');
      return { date, filename: f };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Get a briefing by date
 */
export async function getBriefing(date) {
  const briefingFile = join(REPORTS_DIR, `${date}-briefing.md`);

  if (!existsSync(briefingFile)) {
    return null;
  }

  const content = await readFile(briefingFile, 'utf-8');
  return { date, content };
}

/**
 * Get the latest briefing
 */
export async function getLatestBriefing() {
  const briefings = await listBriefings();
  if (briefings.length === 0) return null;
  return getBriefing(briefings[0].date);
}

/**
 * Get today's activity summary
 * Returns completed tasks, success rate, time worked, and top accomplishments
 */
export async function getTodayActivity() {
  const state = await loadState();
  const today = new Date().toISOString().split('T')[0];

  // Filter agents completed today
  const todayAgents = Object.values(state.agents).filter(a => {
    if (!a.completedAt) return false;
    return a.completedAt.startsWith(today);
  });

  const succeeded = todayAgents.filter(a => a.result?.success);
  const failed = todayAgents.filter(a => !a.result?.success);

  // Calculate total time worked (sum of agent durations)
  const totalDurationMs = todayAgents.reduce((sum, a) => {
    const duration = a.result?.duration || 0;
    return sum + duration;
  }, 0);

  // Get currently running agents
  const runningAgents = Object.values(state.agents).filter(a => a.status === 'running');
  const activeTimeMs = runningAgents.reduce((sum, a) => {
    if (!a.startedAt) return sum;
    return sum + (Date.now() - new Date(a.startedAt).getTime());
  }, 0);

  // Get top accomplishments (successful tasks with description snippets)
  const accomplishments = succeeded
    .map(a => ({
      id: a.id,
      taskId: a.taskId,
      description: a.metadata?.taskDescription?.substring(0, 100) || a.taskId,
      taskType: a.metadata?.analysisType || a.metadata?.taskType || 'task',
      duration: a.result?.duration || 0,
      completedAt: a.completedAt
    }))
    .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))
    .slice(0, 5);

  // Calculate success rate
  const successRate = todayAgents.length > 0
    ? Math.round((succeeded.length / todayAgents.length) * 100)
    : 0;

  return {
    date: today,
    stats: {
      completed: todayAgents.length,
      succeeded: succeeded.length,
      failed: failed.length,
      successRate,
      running: runningAgents.length
    },
    time: {
      totalDurationMs,
      totalDuration: formatDuration(totalDurationMs),
      activeDurationMs: activeTimeMs,
      activeDuration: formatDuration(activeTimeMs),
      combinedMs: totalDurationMs + activeTimeMs,
      combined: formatDuration(totalDurationMs + activeTimeMs)
    },
    accomplishments,
    lastEvaluation: state.stats.lastEvaluation,
    isRunning: daemonRunning,
    isPaused: state.paused
  };
}

/**
 * Get recent completed tasks across all days
 * @param {number} limit - Maximum number of tasks to return (default: 10)
 * @returns {Object} Recent tasks with metadata
 */
export async function getRecentTasks(limit = 10) {
  const state = await loadState();

  // Get all completed agents, sorted by completion time (newest first)
  const completedAgents = Object.values(state.agents)
    .filter(a => a.status === 'completed' && a.completedAt)
    .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))
    .slice(0, limit);

  // Transform to compact task summaries
  const tasks = completedAgents.map(a => ({
    id: a.id,
    taskId: a.taskId,
    description: a.metadata?.taskDescription?.substring(0, 120) || a.taskId,
    taskType: a.metadata?.analysisType || a.metadata?.taskType || 'task',
    app: a.metadata?.app || null,
    success: a.result?.success || false,
    duration: a.result?.duration || 0,
    durationFormatted: formatDuration(a.result?.duration || 0),
    completedAt: a.completedAt,
    // Add relative time (e.g., "2h ago", "yesterday")
    completedRelative: formatRelativeTime(a.completedAt)
  }));

  // Calculate summary stats
  const successCount = tasks.filter(t => t.success).length;
  const failCount = tasks.filter(t => !t.success).length;

  return {
    tasks,
    summary: {
      total: tasks.length,
      succeeded: successCount,
      failed: failCount,
      successRate: tasks.length > 0 ? Math.round((successCount / tasks.length) * 100) : 0
    }
  };
}

/**
 * Format a timestamp as relative time (e.g., "2h ago", "yesterday")
 * @param {string} timestamp - ISO timestamp
 * @returns {string} Relative time string
 */
function formatRelativeTime(timestamp) {
  const now = new Date();
  const then = new Date(timestamp);
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Clear completed agents from state, cache, and disk
 */
export async function clearCompletedAgents() {
  return withStateLock(async () => {
    const state = await loadState();
    const cache = await loadCompletedAgentCache();

    // Collect IDs from both state and cache
    const stateCompleted = Object.keys(state.agents).filter(
      id => state.agents[id].status === 'completed'
    );
    const cacheCompleted = [...cache.keys()];
    const allCompleted = [...new Set([...stateCompleted, ...cacheCompleted])];

    // Remove from state
    for (const id of stateCompleted) {
      delete state.agents[id];
    }
    await saveState(state);

    // Clear cache
    cache.clear();

    // Remove metadata files from disk
    const removals = allCompleted.map(id => {
      const agentDir = join(AGENTS_DIR, id);
      return existsSync(agentDir)
        ? rm(agentDir, { recursive: true }).catch(() => {})
        : Promise.resolve();
    });
    await Promise.all(removals);

    return { cleared: allCompleted.length };
  });
}

/**
 * Check if daemon is running
 */
export function isRunning() {
  return daemonRunning;
}

/**
 * Add a new task to TASKS.md or COS-TASKS.md
 */
export async function addTask(taskData, taskType = 'user') {
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

  // Generate a unique ID if not provided
  const id = taskData.id || `${taskType === 'user' ? 'task' : 'sys'}-${Date.now().toString(36)}`;

  // Build metadata object
  const metadata = {};
  if (taskData.context) metadata.context = taskData.context;
  if (taskData.model) metadata.model = taskData.model;
  if (taskData.provider) metadata.provider = taskData.provider;
  if (taskData.app) metadata.app = taskData.app;
  if (taskData.createJiraTicket) metadata.createJiraTicket = true;
  if (taskData.jiraTicketId) metadata.jiraTicketId = taskData.jiraTicketId;
  if (taskData.jiraTicketUrl) metadata.jiraTicketUrl = taskData.jiraTicketUrl;
  if (taskData.screenshots?.length > 0) metadata.screenshots = taskData.screenshots;
  if (taskData.attachments?.length > 0) metadata.attachments = taskData.attachments;

  // Create the new task
  const newTask = {
    id: id.startsWith('task-') || id.startsWith('sys-') ? id : `${taskType === 'user' ? 'task' : 'sys'}-${id}`,
    status: 'pending',
    priority: (taskData.priority || 'MEDIUM').toUpperCase(),
    priorityValue: PRIORITY_VALUES[taskData.priority?.toUpperCase()] || 2,
    description: taskData.description,
    metadata,
    approvalRequired: taskType === 'internal' && taskData.approvalRequired,
    autoApproved: taskType === 'internal' && !taskData.approvalRequired,
    section: 'pending'
  };

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
}

/**
 * Attempt to immediately spawn a newly added user task if there are available agent slots.
 * This bypasses the evaluation interval for user-submitted tasks so they start instantly.
 */
async function tryImmediateSpawn(task) {
  if (!daemonRunning) return;

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
 * When an agent completes (freeing a slot), immediately try to dequeue and spawn the next pending task.
 * Checks user tasks first, then auto-approved system tasks.
 */
async function dequeueNextTask() {
  if (!daemonRunning) return;

  const paused = await isPaused();
  if (paused) return;

  const state = await loadState();
  const runningAgents = Object.values(state.agents).filter(a => a.status === 'running').length;
  const availableSlots = state.config.maxConcurrentAgents - runningAgents;

  if (availableSlots <= 0) return;

  const perProjectLimit = state.config.maxConcurrentAgentsPerProject || state.config.maxConcurrentAgents;
  const agentsByProject = countRunningAgentsByProject(state.agents);

  // Check user tasks first (highest priority)
  const userTaskData = await getUserTasks();
  const pendingUserTasks = userTaskData.grouped?.pending || [];

  for (const task of pendingUserTasks) {
    if (!isWithinProjectLimit(task, agentsByProject, perProjectLimit)) continue;
    emitLog('info', `⚡ Dequeue on slot free: ${task.id} (${task.priority || 'MEDIUM'})`, {
      taskId: task.id,
      availableSlots
    });
    cosEvents.emit('task:ready', { ...task, taskType: 'user' });
    return; // One at a time — let the next completion trigger more
  }

  // No user tasks — check auto-approved system tasks
  const cosTaskData = await getCosTasks();
  const autoApproved = cosTaskData.autoApproved || [];

  for (const task of autoApproved) {
    const appId = task.metadata?.app;
    if (appId) {
      const onCooldown = await isAppOnCooldown(appId, state.config.appReviewCooldownMs);
      if (onCooldown) continue;
    }
    if (!isWithinProjectLimit(task, agentsByProject, perProjectLimit)) continue;
    emitLog('info', `⚡ Dequeue system task on slot free: ${task.id}`, { taskId: task.id, availableSlots });
    cosEvents.emit('task:ready', { ...task, taskType: 'internal' });
    return;
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
  const state = await loadState();
  const filePath = taskType === 'user'
    ? join(ROOT_DIR, state.config.userTasksFile)
    : join(ROOT_DIR, state.config.cosTasksFile);

  if (!existsSync(filePath)) {
    return { error: 'Task file not found' };
  }

  const content = await readFile(filePath, 'utf-8');
  let tasks = parseTasksMarkdown(content);

  const taskIndex = tasks.findIndex(t => t.id === taskId);
  if (taskIndex === -1) {
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
}

/**
 * Delete a task
 */
export async function deleteTask(taskId, taskType = 'user') {
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
}

/**
 * Reorder user tasks based on an array of task IDs
 */
export async function reorderTasks(taskIds) {
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
}

/**
 * Approve a task that requires approval (marks it as auto-approved)
 */
export async function approveTask(taskId) {
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
      const today = new Date().toISOString().split('T')[0];
      addNotification({
        type: NOTIFICATION_TYPES.BRIEFING_READY,
        title: 'Daily Briefing Ready',
        description: `Your daily briefing for ${today} is ready for review.`,
        priority: 'low',
        link: '/cos/briefing',
        metadata: { date: today, agentId: agent.id }
      }).catch(err => console.error(`❌ Failed to create briefing notification: ${err.message}`));
    }
  });

  // Record autonomous job execution only after the agent actually spawns
  cosEvents.on('job:spawned', async ({ jobId }) => {
    await recordJobExecution(jobId).catch(err =>
      console.error(`❌ Failed to record job execution for ${jobId}: ${err.message}`)
    );
  });

  const state = await loadState();

  // Auto-start if alwaysOn mode is enabled (or legacy autoStart)
  if (state.config.alwaysOn || state.config.autoStart) {
    console.log('🚀 CoS auto-starting (alwaysOn mode)');
    await start();
  }
}

// Initialize asynchronously
init();
