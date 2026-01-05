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
  evaluationIntervalMs: 60000,         // 1 minute
  healthCheckIntervalMs: 900000,       // 15 minutes
  maxConcurrentAgents: 3,
  maxProcessMemoryMb: 2048,            // Alert if any process exceeds this
  maxTotalProcesses: 50,               // Alert if total PM2 processes exceed this
  mcpServers: [
    { name: 'filesystem', command: 'npx', args: ['-y', '@anthropic/mcp-server-filesystem'] },
    { name: 'puppeteer', command: 'npx', args: ['-y', '@anthropic/mcp-puppeteer', '--isolated'] }
  ],
  autoStart: false,
  selfImprovementEnabled: true         // Allow CoS to suggest improvements to its own prompts
};

/**
 * Default state
 */
const DEFAULT_STATE = {
  running: false,
  config: DEFAULT_CONFIG,
  stats: {
    tasksCompleted: 0,
    totalRuntime: 0,
    agentsSpawned: 0,
    lastEvaluation: null
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
 */
export async function evaluateTasks() {
  if (!daemonRunning) return;

  // Update evaluation timestamp with lock to prevent race conditions
  const state = await withStateLock(async () => {
    const s = await loadState();
    s.stats.lastEvaluation = new Date().toISOString();
    await saveState(s);
    return s;
  });

  // Get both user and CoS tasks
  const { user: userTaskData, cos: cosTaskData } = await getAllTasks();

  const pendingUserTasks = userTaskData.grouped?.pending?.length || 0;
  const inProgressUserTasks = userTaskData.grouped?.in_progress?.length || 0;
  const pendingCosTasks = cosTaskData.grouped?.pending?.length || 0;

  emitLog('info', `Evaluating tasks: ${pendingUserTasks} pending, ${inProgressUserTasks} in_progress, ${pendingCosTasks} system`, {
    pendingUser: pendingUserTasks,
    inProgressUser: inProgressUserTasks,
    pendingSystem: pendingCosTasks
  });

  // Count running agents
  const runningAgents = Object.values(state.agents).filter(a => a.status === 'running').length;
  const availableSlots = state.config.maxConcurrentAgents - runningAgents;

  if (availableSlots <= 0) {
    emitLog('warn', `Max concurrent agents reached (${runningAgents}/${state.config.maxConcurrentAgents})`);
    cosEvents.emit('evaluation', { message: 'Max concurrent agents reached', running: runningAgents });
    return;
  }

  // Priority 1: Check for auto-approved CoS tasks (system maintenance)
  if (cosTaskData.exists && cosTaskData.autoApproved?.length > 0) {
    const nextAutoTask = cosTaskData.autoApproved[0];
    emitLog('info', `Found auto-approved system task: ${nextAutoTask.id}`, { taskId: nextAutoTask.id });
    cosEvents.emit('evaluation', {
      message: 'Found auto-approved system task',
      task: nextAutoTask,
      type: 'internal'
    });
    cosEvents.emit('task:ready', { ...nextAutoTask, taskType: 'internal' });
    return;
  }

  // Priority 2: Check for user tasks
  if (userTaskData.exists) {
    const nextUserTask = getNextTask(userTaskData.tasks);
    if (nextUserTask) {
      emitLog('success', `Found user task: ${nextUserTask.id} (${nextUserTask.priority})`, {
        taskId: nextUserTask.id,
        priority: nextUserTask.priority,
        description: nextUserTask.description?.substring(0, 80)
      });
      cosEvents.emit('evaluation', {
        message: 'Found user task to process',
        task: nextUserTask,
        pendingCount: userTaskData.grouped.pending.length,
        type: 'user'
      });
      cosEvents.emit('task:ready', { ...nextUserTask, taskType: 'user' });
      return;
    }
  }

  // Emit tasks awaiting approval if any
  if (cosTaskData.exists && cosTaskData.awaitingApproval?.length > 0) {
    emitLog('info', `${cosTaskData.awaitingApproval.length} tasks awaiting approval`);
    cosEvents.emit('evaluation', {
      message: 'Tasks awaiting approval',
      awaitingApproval: cosTaskData.awaitingApproval.length
    });
  }

  emitLog('info', 'No pending tasks to process - idle');
  cosEvents.emit('evaluation', { message: 'No pending tasks to process' });
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

    state.agents[agentId] = { ...state.agents[agentId], ...updates };
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
 * Get agent by ID
 */
export async function getAgent(agentId) {
  const state = await loadState();
  return state.agents[agentId] || null;
}

/**
 * Terminate an agent (will be handled by spawner)
 */
export async function terminateAgent(agentId) {
  cosEvents.emit('agent:terminate', agentId);
  return { success: true, agentId };
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

  // Auto-start if configured
  if (state.config.autoStart) {
    await start();
  }
}

// Initialize asynchronously
init();
