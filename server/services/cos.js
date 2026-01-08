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
import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import { getActiveProvider } from './providers.js';
import { parseTasksMarkdown, groupTasksByStatus, getNextTask, getAutoApprovedTasks, getAwaitingApprovalTasks, updateTaskStatus, generateTasksMarkdown } from '../lib/taskParser.js';
import { isAppOnCooldown, getNextAppForReview, markAppReviewStarted, markIdleReviewStarted } from './appActivity.js';
import { getAllApps } from './apps.js';
import { shouldSkipTaskType, getAdaptiveCooldownMultiplier, getSkippedTaskTypes, getPerformanceSummary, recordLearningInsight } from './taskLearning.js';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '../../data');
const COS_DIR = join(DATA_DIR, 'cos');
const STATE_FILE = join(COS_DIR, 'state.json');
const AGENTS_DIR = join(COS_DIR, 'agents');
const REPORTS_DIR = join(COS_DIR, 'reports');
const SCRIPTS_DIR = join(COS_DIR, 'scripts');
const ROOT_DIR = join(__dirname, '../../');

// Event emitter for CoS events
export const cosEvents = new EventEmitter();

/**
 * Emit a log event for UI display
 * Exported for use by other CoS-related services
 * @param {string} level - Log level: 'info', 'warn', 'error', 'success', 'debug'
 * @param {string} message - Log message
 * @param {Object} data - Additional data to include in log entry
 * @param {string} prefix - Optional prefix for console output (e.g., '[SelfImprovement]')
 */
export function emitLog(level, message, data = {}, prefix = '') {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data
  };
  const emoji = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : level === 'success' ? '✅' : 'ℹ️';
  const prefixStr = prefix ? ` ${prefix}` : '';
  console.log(`${emoji}${prefixStr} ${message}`);
  cosEvents.emit('log', logEntry);
}

// In-memory daemon state
let daemonRunning = false;
let evaluationInterval = null;
let healthCheckInterval = null;

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
  maxProcessMemoryMb: 2048,                // Alert if any process exceeds this
  maxTotalProcesses: 50,                   // Alert if total PM2 processes exceed this
  mcpServers: [
    { name: 'filesystem', command: 'npx', args: ['-y', '@anthropic/mcp-server-filesystem'] },
    { name: 'puppeteer', command: 'npx', args: ['-y', '@anthropic/mcp-puppeteer', '--isolated'] }
  ],
  autoStart: false,                        // Legacy: use alwaysOn instead
  selfImprovementEnabled: true,            // Allow CoS to suggest improvements to its own prompts
  avatarStyle: 'svg',                      // UI preference: 'svg' or 'ascii'
  // Always-on mode settings
  alwaysOn: true,                          // CoS starts automatically and stays active
  appReviewCooldownMs: 1800000,            // 30 min between working on same app (was 1 hour)
  idleReviewEnabled: true,                 // Review apps for improvements when no user tasks
  idleReviewPriority: 'MEDIUM',            // Priority for auto-generated tasks (was LOW)
  immediateExecution: true,                // Execute new tasks immediately, don't wait for interval
  proactiveMode: true,                     // Be proactive about finding work
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

  // Start evaluation loop
  evaluationInterval = setInterval(async () => {
    await evaluateTasks();
  }, state.config.evaluationIntervalMs);

  // Start health check loop
  healthCheckInterval = setInterval(async () => {
    await runHealthCheck();
  }, state.config.healthCheckIntervalMs);

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

  // Clear intervals
  if (evaluationInterval) {
    clearInterval(evaluationInterval);
    evaluationInterval = null;
  }
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }

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

  // Count running agents and available slots
  const runningAgents = Object.values(state.agents).filter(a => a.status === 'running').length;
  const availableSlots = state.config.maxConcurrentAgents - runningAgents;

  if (availableSlots <= 0) {
    emitLog('warn', `Max concurrent agents reached (${runningAgents}/${state.config.maxConcurrentAgents})`);
    cosEvents.emit('evaluation', { message: 'Max concurrent agents reached', running: runningAgents });
    return;
  }

  const tasksToSpawn = [];

  // Priority 1: User tasks (not on cooldown)
  const pendingUserTasks = userTaskData.grouped?.pending || [];
  for (const task of pendingUserTasks) {
    if (tasksToSpawn.length >= availableSlots) break;

    // Check if task's app is on cooldown
    const appId = task.metadata?.app;
    if (appId) {
      const onCooldown = await isAppOnCooldown(appId, state.config.appReviewCooldownMs);
      if (onCooldown) {
        emitLog('debug', `Skipping task ${task.id} - app ${appId} on cooldown`);
        continue;
      }
    }

    tasksToSpawn.push({ ...task, taskType: 'user' });
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
          continue;
        }
      }

      tasksToSpawn.push({ ...task, taskType: 'internal' });
    }
  }

  // Priority 3: Generate idle review task if no other work and idle review enabled
  if (tasksToSpawn.length === 0 && state.config.idleReviewEnabled) {
    const idleTask = await generateIdleReviewTask(state);
    if (idleTask) {
      tasksToSpawn.push(idleTask);
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

  // Periodically log performance summary (every 10 evaluations)
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
    emitLog('info', 'No tasks to process - idle');
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

  // Try app reviews
  // Get all managed apps
  const apps = await getAllApps().catch(() => []);

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

      emitLog('info', `Generating idle review task for ${nextApp.name}`, { appId: nextApp.id });

      // Create an idle review task
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

  // All apps on cooldown or no apps - fall back to self-improvement
  // This ensures CoS is ALWAYS working on something
  if (state.config.selfImprovementEnabled) {
    emitLog('info', 'No apps available for review - running self-improvement instead');
    return await generateSelfImprovementTask(state);
  }

  emitLog('debug', 'No idle tasks available');
  return null;
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
 * Enhanced with adaptive learning:
 * - Skips task types with consistently poor success rates
 * - Logs learning-based recommendations
 * - Falls back to next available task type if current is skipped
 */
async function generateSelfImprovementTask(state) {
  // Get the next analysis type in rotation, but skip failing task types
  const lastType = state.stats.lastSelfImprovementType || '';
  let currentIndex = SELF_IMPROVEMENT_TYPES.indexOf(lastType);
  let nextType = null;
  let attempts = 0;
  const maxAttempts = SELF_IMPROVEMENT_TYPES.length;

  // Find next task type that isn't being skipped due to poor performance
  while (attempts < maxAttempts) {
    currentIndex = (currentIndex + 1) % SELF_IMPROVEMENT_TYPES.length;
    const candidateType = SELF_IMPROVEMENT_TYPES[currentIndex];
    const taskTypeKey = `self-improve:${candidateType}`;

    // Check if this task type should be skipped based on learning data
    const cooldownInfo = await getAdaptiveCooldownMultiplier(taskTypeKey).catch(() => ({ skip: false }));

    if (cooldownInfo.skip) {
      emitLog('warn', `Skipping ${candidateType} - poor success rate (${cooldownInfo.successRate}% after ${cooldownInfo.completed} attempts)`, {
        taskType: candidateType,
        successRate: cooldownInfo.successRate,
        completed: cooldownInfo.completed,
        reason: cooldownInfo.reason
      });
      attempts++;
      continue;
    }

    // Log if there's a recommendation from learning system
    if (cooldownInfo.recommendation) {
      emitLog('info', `Learning insight for ${candidateType}: ${cooldownInfo.recommendation}`, {
        taskType: candidateType,
        multiplier: cooldownInfo.multiplier
      });
    }

    nextType = candidateType;
    break;
  }

  // If all task types are failing, log warning and pick the one that's been failing longest
  if (!nextType) {
    const skippedTypes = await getSkippedTaskTypes().catch(() => []);
    emitLog('warn', `All self-improvement task types are underperforming - selecting oldest failed type for retry`, {
      skippedCount: skippedTypes.length
    });

    // Sort by lastCompleted ascending (oldest first) and pick that one
    if (skippedTypes.length > 0) {
      skippedTypes.sort((a, b) => new Date(a.lastCompleted || 0) - new Date(b.lastCompleted || 0));
      const oldestType = skippedTypes[0].taskType.replace('self-improve:', '');
      nextType = oldestType;
      emitLog('info', `Retrying ${oldestType} as it hasn't been attempted recently`);
    } else {
      // Fallback to first type in rotation
      nextType = SELF_IMPROVEMENT_TYPES[0];
    }
  }

  // Update state with new timestamp and type
  await withStateLock(async () => {
    const s = await loadState();
    s.stats.lastSelfImprovement = new Date().toISOString();
    s.stats.lastSelfImprovementType = nextType;
    await saveState(s);
  });

  emitLog('info', `Generating self-improvement task: ${nextType}`);

  const taskDescriptions = {
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

  const description = taskDescriptions[nextType];

  const task = {
    id: `self-improve-${nextType}-${Date.now().toString(36)}`,
    status: 'pending',
    priority: 'MEDIUM',
    priorityValue: PRIORITY_VALUES['MEDIUM'],
    description,
    metadata: {
      analysisType: nextType,
      autoGenerated: true,
      selfImprovement: true,
      model: 'claude-opus-4-5-20251101'
    },
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
  const pm2Processes = JSON.parse(pm2Result.stdout || '[]');

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

  // Check for errored processes
  const erroredProcesses = pm2Processes.filter(p => p.pm2_env?.status === 'errored');
  if (erroredProcesses.length > 0) {
    issues.push({
      type: 'error',
      category: 'processes',
      message: `${erroredProcesses.length} errored PM2 processes: ${erroredProcesses.map(p => p.name).join(', ')}`
    });
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
 * Get all agents
 */
export async function getAgents() {
  const state = await loadState();
  return Object.values(state.agents);
}

/**
 * Get agent by ID with full output from file
 */
export async function getAgent(agentId) {
  const state = await loadState();
  const agent = state.agents[agentId];
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
  // Also check against activeAgents map from spawner
  const { getActiveAgentIds } = await import('./subAgentSpawner.js');
  const activeIds = getActiveAgentIds();

  return withStateLock(async () => {
    const state = await loadState();
    const runningAgents = Object.values(state.agents).filter(a => a.status === 'running');
    const cleaned = [];

    for (const agent of runningAgents) {
      let isZombie = false;

      // If agent has a PID, check if it's still alive
      if (agent.pid) {
        const alive = await isPidAlive(agent.pid);
        if (!alive) {
          isZombie = true;
        }
      } else {
        // No PID stored - check if it's in activeAgents map
        // If not in map, it's a zombie from before PID tracking
        if (!activeIds.includes(agent.id)) {
          isZombie = true;
        }
      }

      if (isZombie) {
        console.log(`🧟 Zombie agent detected: ${agent.id} (PID ${agent.pid || 'unknown'} is dead)`);
        state.agents[agent.id] = {
          ...agent,
          status: 'completed',
          completedAt: new Date().toISOString(),
          result: { success: false, error: 'Agent process was orphaned (server restart)' }
        };
        cleaned.push(agent.id);
      }
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
 * Delete a single agent from state
 */
export async function deleteAgent(agentId) {
  return withStateLock(async () => {
    const state = await loadState();

    if (!state.agents[agentId]) {
      return { error: 'Agent not found' };
    }

    delete state.agents[agentId];
    await saveState(state);

    cosEvents.emit('agents:changed', { action: 'deleted', agentId });
    return { success: true, agentId };
  });
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

  // Format duration as human-readable
  const formatDuration = (ms) => {
    const mins = Math.floor(ms / 60000);
    const hours = Math.floor(mins / 60);
    const remainingMins = mins % 60;
    if (hours > 0) {
      return `${hours}h ${remainingMins}m`;
    }
    return `${mins}m`;
  };

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
 * Clear completed agents from state (keep in files)
 */
export async function clearCompletedAgents() {
  return withStateLock(async () => {
    const state = await loadState();

    const toRemove = Object.keys(state.agents).filter(
      id => state.agents[id].status === 'completed'
    );

    for (const id of toRemove) {
      delete state.agents[id];
    }

    await saveState(state);
    return { cleared: toRemove.length };
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
  if (taskData.screenshots?.length > 0) metadata.screenshots = taskData.screenshots;

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

  tasks.push(newTask);

  // Write back to file
  const includeApprovalFlags = taskType === 'internal';
  const markdown = generateTasksMarkdown(tasks, includeApprovalFlags);
  await writeFile(filePath, markdown);

  cosEvents.emit('tasks:changed', { type: taskType, action: 'added', task: newTask });
  return newTask;
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
  return tasks[taskIndex];
}

/**
 * Initialize on module load
 */
async function init() {
  await ensureDirectories();

  const state = await loadState();

  // Auto-start if alwaysOn mode is enabled (or legacy autoStart)
  if (state.config.alwaysOn || state.config.autoStart) {
    console.log('🚀 CoS auto-starting (alwaysOn mode)');
    await start();
  }
}

// Initialize asynchronously
init();
