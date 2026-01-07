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
 */
function emitLog(level, message, data = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level, // 'info', 'warn', 'error', 'success', 'debug'
    message,
    ...data
  };
  console.log(`${level === 'error' ? '❌' : level === 'warn' ? '⚠️' : level === 'success' ? '✅' : 'ℹ️'} ${message}`);
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
  evaluationIntervalMs: 60000,         // 1 minute (also used for idle check frequency)
  healthCheckIntervalMs: 900000,       // 15 minutes
  maxConcurrentAgents: 3,
  maxProcessMemoryMb: 2048,            // Alert if any process exceeds this
  maxTotalProcesses: 50,               // Alert if total PM2 processes exceed this
  mcpServers: [
    { name: 'filesystem', command: 'npx', args: ['-y', '@anthropic/mcp-server-filesystem'] },
    { name: 'puppeteer', command: 'npx', args: ['-y', '@anthropic/mcp-puppeteer', '--isolated'] }
  ],
  autoStart: false,                    // Legacy: use alwaysOn instead
  selfImprovementEnabled: true,        // Allow CoS to suggest improvements to its own prompts
  avatarStyle: 'svg',                  // UI preference: 'svg' or 'ascii'
  // Always-on mode settings
  alwaysOn: true,                      // CoS starts automatically and stays active
  appReviewCooldownMs: 3600000,        // 1 hour between working on same app
  idleReviewEnabled: true,             // Review apps for improvements when no user tasks
  idleReviewPriority: 'LOW',           // Priority for auto-generated review tasks
  immediateExecution: true,            // Execute new tasks immediately, don't wait for interval
  autoFixThresholds: {
    maxLinesChanged: 50,               // Auto-approve if <= this many lines changed
    allowedCategories: [               // Categories that can auto-execute
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
 * Load CoS state
 */
async function loadState() {
  await ensureDirectories();

  if (!existsSync(STATE_FILE)) {
    return { ...DEFAULT_STATE };
  }

  const content = await readFile(STATE_FILE, 'utf-8');
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
 * Generate an idle review task when no user/system tasks are pending
 *
 * @param {Object} state - Current CoS state
 * @returns {Object|null} Generated task or null if no apps eligible
 */
async function generateIdleReviewTask(state) {
  // Get all managed apps
  const apps = await getAllApps().catch(() => []);

  if (apps.length === 0) {
    emitLog('debug', 'No managed apps found for idle review');
    return null;
  }

  // Find next app eligible for review (not on cooldown, oldest review first)
  const nextApp = await getNextAppForReview(apps, state.config.appReviewCooldownMs);

  if (!nextApp) {
    emitLog('debug', 'All apps on cooldown - no idle review possible');
    return null;
  }

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
  const reviewTask = {
    id: `idle-review-${nextApp.id}-${Date.now().toString(36)}`,
    status: 'pending',
    priority: state.config.idleReviewPriority || 'LOW',
    priorityValue: PRIORITY_VALUES[state.config.idleReviewPriority] || 1,
    description: `[Idle Review] Review ${nextApp.name} codebase for improvements: formatting issues, dead code, DRY violations, typos, and other small fixes that can be auto-approved`,
    metadata: {
      app: nextApp.id,
      appName: nextApp.name,
      repoPath: nextApp.repoPath,
      reviewType: 'idle',
      autoGenerated: true
    },
    taskType: 'internal',
    autoApproved: true // Idle reviews are auto-approved to start, but individual fixes need classification
  };

  return reviewTask;
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

  // Build updated metadata
  const updatedMetadata = { ...tasks[taskIndex].metadata };
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
