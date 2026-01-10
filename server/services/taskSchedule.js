/**
 * Task Schedule Service
 *
 * Manages configurable intervals for self-improvement and managed app tasks.
 * Allows setting per-task-type intervals like:
 * - Run accessibility audits once per week
 * - Run feature-ideas brainstorm daily
 * - Run security audits once per app
 *
 * Interval types:
 * - 'rotation': Run as part of normal rotation (default)
 * - 'daily': Run once per day
 * - 'weekly': Run once per week
 * - 'once': Run once per app/globally then stop
 * - 'on-demand': Only run when manually triggered
 * - 'custom': Custom interval in milliseconds
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { cosEvents, emitLog } from './cos.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '../../data/cos');
const SCHEDULE_FILE = join(DATA_DIR, 'task-schedule.json');

// Interval type constants
export const INTERVAL_TYPES = {
  ROTATION: 'rotation',      // Default: runs in normal task rotation
  DAILY: 'daily',            // Runs once per day
  WEEKLY: 'weekly',          // Runs once per week
  ONCE: 'once',              // Runs once per app or globally
  ON_DEMAND: 'on-demand',    // Only runs when manually triggered
  CUSTOM: 'custom'           // Custom interval in milliseconds
};

// Time constants in milliseconds
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

// Default interval settings for self-improvement task types
const DEFAULT_SELF_IMPROVEMENT_INTERVALS = {
  'ui-bugs': { type: INTERVAL_TYPES.ROTATION, enabled: true },
  'mobile-responsive': { type: INTERVAL_TYPES.WEEKLY, enabled: true },
  'security': { type: INTERVAL_TYPES.WEEKLY, enabled: true },
  'code-quality': { type: INTERVAL_TYPES.ROTATION, enabled: true },
  'console-errors': { type: INTERVAL_TYPES.ROTATION, enabled: true },
  'performance': { type: INTERVAL_TYPES.WEEKLY, enabled: true },
  'cos-enhancement': { type: INTERVAL_TYPES.ROTATION, enabled: true },
  'test-coverage': { type: INTERVAL_TYPES.WEEKLY, enabled: true },
  'documentation': { type: INTERVAL_TYPES.WEEKLY, enabled: true },
  'feature-ideas': { type: INTERVAL_TYPES.DAILY, enabled: true },
  'accessibility': { type: INTERVAL_TYPES.WEEKLY, enabled: true },
  'dependency-updates': { type: INTERVAL_TYPES.WEEKLY, enabled: true }
};

// Default interval settings for managed app improvement task types
const DEFAULT_APP_IMPROVEMENT_INTERVALS = {
  'security-audit': { type: INTERVAL_TYPES.WEEKLY, enabled: true },
  'code-quality': { type: INTERVAL_TYPES.ROTATION, enabled: true },
  'test-coverage': { type: INTERVAL_TYPES.WEEKLY, enabled: true },
  'performance': { type: INTERVAL_TYPES.WEEKLY, enabled: true },
  'accessibility': { type: INTERVAL_TYPES.ONCE, enabled: true },
  'console-errors': { type: INTERVAL_TYPES.ROTATION, enabled: true },
  'dependency-updates': { type: INTERVAL_TYPES.WEEKLY, enabled: true },
  'documentation': { type: INTERVAL_TYPES.ONCE, enabled: true },
  'error-handling': { type: INTERVAL_TYPES.ROTATION, enabled: true },
  'typing': { type: INTERVAL_TYPES.ONCE, enabled: true }
};

/**
 * Default schedule data structure
 */
const DEFAULT_SCHEDULE = {
  version: 1,
  lastUpdated: null,

  // Self-improvement task intervals (for PortOS)
  selfImprovement: {
    ...DEFAULT_SELF_IMPROVEMENT_INTERVALS
  },

  // Managed app task intervals
  appImprovement: {
    ...DEFAULT_APP_IMPROVEMENT_INTERVALS
  },

  // Track last execution times
  executions: {
    // Format: 'self-improve:ui-bugs': { lastRun: timestamp, count: number, perApp: {} }
  },

  // On-demand task templates that can be triggered manually
  templates: []
};

/**
 * Ensure data directory exists
 */
async function ensureDir() {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
}

/**
 * Load schedule data
 */
export async function loadSchedule() {
  await ensureDir();

  if (!existsSync(SCHEDULE_FILE)) {
    return { ...DEFAULT_SCHEDULE };
  }

  const content = await readFile(SCHEDULE_FILE, 'utf-8');
  const loaded = JSON.parse(content);

  // Merge with defaults to ensure all task types have settings
  return {
    ...DEFAULT_SCHEDULE,
    ...loaded,
    selfImprovement: {
      ...DEFAULT_SELF_IMPROVEMENT_INTERVALS,
      ...loaded.selfImprovement
    },
    appImprovement: {
      ...DEFAULT_APP_IMPROVEMENT_INTERVALS,
      ...loaded.appImprovement
    },
    executions: loaded.executions || {},
    templates: loaded.templates || []
  };
}

/**
 * Save schedule data
 */
async function saveSchedule(schedule) {
  await ensureDir();
  schedule.lastUpdated = new Date().toISOString();
  await writeFile(SCHEDULE_FILE, JSON.stringify(schedule, null, 2));
}

/**
 * Get interval for a self-improvement task type
 */
export async function getSelfImprovementInterval(taskType) {
  const schedule = await loadSchedule();
  return schedule.selfImprovement[taskType] || { type: INTERVAL_TYPES.ROTATION, enabled: true };
}

/**
 * Get interval for an app improvement task type
 */
export async function getAppImprovementInterval(taskType) {
  const schedule = await loadSchedule();
  return schedule.appImprovement[taskType] || { type: INTERVAL_TYPES.ROTATION, enabled: true };
}

/**
 * Update self-improvement interval for a task type
 */
export async function updateSelfImprovementInterval(taskType, settings) {
  const schedule = await loadSchedule();

  if (!schedule.selfImprovement[taskType]) {
    schedule.selfImprovement[taskType] = { type: INTERVAL_TYPES.ROTATION, enabled: true };
  }

  schedule.selfImprovement[taskType] = {
    ...schedule.selfImprovement[taskType],
    ...settings
  };

  await saveSchedule(schedule);
  emitLog('info', `Updated self-improvement interval for ${taskType}`, { taskType, settings }, '[TaskSchedule]');
  cosEvents.emit('schedule:changed', { category: 'selfImprovement', taskType, settings });

  return schedule.selfImprovement[taskType];
}

/**
 * Update app improvement interval for a task type
 */
export async function updateAppImprovementInterval(taskType, settings) {
  const schedule = await loadSchedule();

  if (!schedule.appImprovement[taskType]) {
    schedule.appImprovement[taskType] = { type: INTERVAL_TYPES.ROTATION, enabled: true };
  }

  schedule.appImprovement[taskType] = {
    ...schedule.appImprovement[taskType],
    ...settings
  };

  await saveSchedule(schedule);
  emitLog('info', `Updated app improvement interval for ${taskType}`, { taskType, settings }, '[TaskSchedule]');
  cosEvents.emit('schedule:changed', { category: 'appImprovement', taskType, settings });

  return schedule.appImprovement[taskType];
}

/**
 * Record a task execution
 */
export async function recordExecution(taskType, appId = null) {
  const schedule = await loadSchedule();
  const key = taskType;

  if (!schedule.executions[key]) {
    schedule.executions[key] = {
      lastRun: null,
      count: 0,
      perApp: {}
    };
  }

  schedule.executions[key].lastRun = new Date().toISOString();
  schedule.executions[key].count = (schedule.executions[key].count || 0) + 1;

  if (appId) {
    if (!schedule.executions[key].perApp[appId]) {
      schedule.executions[key].perApp[appId] = {
        lastRun: null,
        count: 0
      };
    }
    schedule.executions[key].perApp[appId].lastRun = new Date().toISOString();
    schedule.executions[key].perApp[appId].count++;
  }

  await saveSchedule(schedule);
  return schedule.executions[key];
}

/**
 * Get execution history for a task type
 */
export async function getExecutionHistory(taskType) {
  const schedule = await loadSchedule();
  return schedule.executions[taskType] || { lastRun: null, count: 0, perApp: {} };
}

/**
 * Check if a self-improvement task type should run based on its interval
 */
export async function shouldRunSelfImprovementTask(taskType) {
  const schedule = await loadSchedule();
  const interval = schedule.selfImprovement[taskType];

  if (!interval || !interval.enabled) {
    return { shouldRun: false, reason: 'disabled' };
  }

  const execution = schedule.executions[`self-improve:${taskType}`] || { lastRun: null, count: 0 };
  const now = Date.now();
  const lastRun = execution.lastRun ? new Date(execution.lastRun).getTime() : 0;
  const timeSinceLastRun = now - lastRun;

  switch (interval.type) {
    case INTERVAL_TYPES.ROTATION:
      // Always eligible in rotation
      return { shouldRun: true, reason: 'rotation' };

    case INTERVAL_TYPES.DAILY:
      if (timeSinceLastRun >= DAY) {
        return { shouldRun: true, reason: 'daily-due' };
      }
      return {
        shouldRun: false,
        reason: 'daily-cooldown',
        nextRunIn: DAY - timeSinceLastRun,
        nextRunAt: new Date(lastRun + DAY).toISOString()
      };

    case INTERVAL_TYPES.WEEKLY:
      if (timeSinceLastRun >= WEEK) {
        return { shouldRun: true, reason: 'weekly-due' };
      }
      return {
        shouldRun: false,
        reason: 'weekly-cooldown',
        nextRunIn: WEEK - timeSinceLastRun,
        nextRunAt: new Date(lastRun + WEEK).toISOString()
      };

    case INTERVAL_TYPES.ONCE:
      if (execution.count === 0) {
        return { shouldRun: true, reason: 'once-first-run' };
      }
      return { shouldRun: false, reason: 'once-completed', completedAt: execution.lastRun };

    case INTERVAL_TYPES.ON_DEMAND:
      return { shouldRun: false, reason: 'on-demand-only' };

    case INTERVAL_TYPES.CUSTOM:
      const customInterval = interval.intervalMs || DAY;
      if (timeSinceLastRun >= customInterval) {
        return { shouldRun: true, reason: 'custom-due' };
      }
      return {
        shouldRun: false,
        reason: 'custom-cooldown',
        nextRunIn: customInterval - timeSinceLastRun,
        nextRunAt: new Date(lastRun + customInterval).toISOString()
      };

    default:
      return { shouldRun: true, reason: 'unknown-default-rotation' };
  }
}

/**
 * Check if an app improvement task type should run for a specific app
 */
export async function shouldRunAppImprovementTask(taskType, appId) {
  const schedule = await loadSchedule();
  const interval = schedule.appImprovement[taskType];

  if (!interval || !interval.enabled) {
    return { shouldRun: false, reason: 'disabled' };
  }

  const key = `app-improve:${taskType}`;
  const execution = schedule.executions[key] || { lastRun: null, count: 0, perApp: {} };
  const appExecution = execution.perApp[appId] || { lastRun: null, count: 0 };
  const now = Date.now();
  const lastRun = appExecution.lastRun ? new Date(appExecution.lastRun).getTime() : 0;
  const timeSinceLastRun = now - lastRun;

  switch (interval.type) {
    case INTERVAL_TYPES.ROTATION:
      return { shouldRun: true, reason: 'rotation' };

    case INTERVAL_TYPES.DAILY:
      if (timeSinceLastRun >= DAY) {
        return { shouldRun: true, reason: 'daily-due' };
      }
      return {
        shouldRun: false,
        reason: 'daily-cooldown',
        nextRunIn: DAY - timeSinceLastRun,
        nextRunAt: new Date(lastRun + DAY).toISOString()
      };

    case INTERVAL_TYPES.WEEKLY:
      if (timeSinceLastRun >= WEEK) {
        return { shouldRun: true, reason: 'weekly-due' };
      }
      return {
        shouldRun: false,
        reason: 'weekly-cooldown',
        nextRunIn: WEEK - timeSinceLastRun,
        nextRunAt: new Date(lastRun + WEEK).toISOString()
      };

    case INTERVAL_TYPES.ONCE:
      if (appExecution.count === 0) {
        return { shouldRun: true, reason: 'once-first-run' };
      }
      return { shouldRun: false, reason: 'once-completed', completedAt: appExecution.lastRun };

    case INTERVAL_TYPES.ON_DEMAND:
      return { shouldRun: false, reason: 'on-demand-only' };

    case INTERVAL_TYPES.CUSTOM:
      const customInterval = interval.intervalMs || DAY;
      if (timeSinceLastRun >= customInterval) {
        return { shouldRun: true, reason: 'custom-due' };
      }
      return {
        shouldRun: false,
        reason: 'custom-cooldown',
        nextRunIn: customInterval - timeSinceLastRun,
        nextRunAt: new Date(lastRun + customInterval).toISOString()
      };

    default:
      return { shouldRun: true, reason: 'unknown-default-rotation' };
  }
}

/**
 * Get all enabled self-improvement task types that are due to run
 */
export async function getDueSelfImprovementTasks() {
  const schedule = await loadSchedule();
  const due = [];

  for (const [taskType, interval] of Object.entries(schedule.selfImprovement)) {
    if (!interval.enabled) continue;

    const check = await shouldRunSelfImprovementTask(taskType);
    if (check.shouldRun) {
      due.push({ taskType, reason: check.reason, interval });
    }
  }

  return due;
}

/**
 * Get all enabled app improvement task types that are due to run for a specific app
 */
export async function getDueAppImprovementTasks(appId) {
  const schedule = await loadSchedule();
  const due = [];

  for (const [taskType, interval] of Object.entries(schedule.appImprovement)) {
    if (!interval.enabled) continue;

    const check = await shouldRunAppImprovementTask(taskType, appId);
    if (check.shouldRun) {
      due.push({ taskType, reason: check.reason, interval });
    }
  }

  return due;
}

/**
 * Get the next task type to run based on schedule priority
 * Prioritizes: daily tasks due > weekly tasks due > rotation tasks
 */
export async function getNextSelfImprovementTaskType(lastType) {
  const schedule = await loadSchedule();
  const taskTypes = Object.keys(schedule.selfImprovement);

  // First, check for daily/weekly tasks that are due
  const dueTasks = await getDueSelfImprovementTasks();

  // Prioritize daily tasks first, then weekly
  const dailyDue = dueTasks.filter(t => t.interval.type === INTERVAL_TYPES.DAILY);
  if (dailyDue.length > 0) {
    return { taskType: dailyDue[0].taskType, reason: 'daily-priority' };
  }

  const weeklyDue = dueTasks.filter(t => t.interval.type === INTERVAL_TYPES.WEEKLY);
  if (weeklyDue.length > 0) {
    return { taskType: weeklyDue[0].taskType, reason: 'weekly-priority' };
  }

  // Fall back to rotation among enabled rotation tasks
  const rotationTasks = taskTypes.filter(t =>
    schedule.selfImprovement[t].enabled &&
    schedule.selfImprovement[t].type === INTERVAL_TYPES.ROTATION
  );

  if (rotationTasks.length === 0) {
    return null;
  }

  // Get next in rotation
  const currentIndex = rotationTasks.indexOf(lastType);
  const nextIndex = (currentIndex + 1) % rotationTasks.length;

  return { taskType: rotationTasks[nextIndex], reason: 'rotation' };
}

/**
 * Get the next app improvement task type to run for a specific app
 */
export async function getNextAppImprovementTaskType(appId, lastType) {
  const schedule = await loadSchedule();
  const taskTypes = Object.keys(schedule.appImprovement);

  // First, check for daily/weekly tasks that are due
  const dueTasks = await getDueAppImprovementTasks(appId);

  // Prioritize daily tasks first, then weekly, then once
  const dailyDue = dueTasks.filter(t => t.interval.type === INTERVAL_TYPES.DAILY);
  if (dailyDue.length > 0) {
    return { taskType: dailyDue[0].taskType, reason: 'daily-priority' };
  }

  const weeklyDue = dueTasks.filter(t => t.interval.type === INTERVAL_TYPES.WEEKLY);
  if (weeklyDue.length > 0) {
    return { taskType: weeklyDue[0].taskType, reason: 'weekly-priority' };
  }

  const onceDue = dueTasks.filter(t => t.interval.type === INTERVAL_TYPES.ONCE);
  if (onceDue.length > 0) {
    return { taskType: onceDue[0].taskType, reason: 'once-first-run' };
  }

  // Fall back to rotation
  const rotationTasks = taskTypes.filter(t =>
    schedule.appImprovement[t].enabled &&
    schedule.appImprovement[t].type === INTERVAL_TYPES.ROTATION
  );

  if (rotationTasks.length === 0) {
    return null;
  }

  const currentIndex = rotationTasks.indexOf(lastType);
  const nextIndex = (currentIndex + 1) % rotationTasks.length;

  return { taskType: rotationTasks[nextIndex], reason: 'rotation' };
}

/**
 * Add a template task that can be triggered on-demand
 */
export async function addTemplateTask(template) {
  const schedule = await loadSchedule();

  const newTemplate = {
    id: `template-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    name: template.name,
    description: template.description,
    category: template.category || 'custom', // 'selfImprovement', 'appImprovement', 'custom'
    taskType: template.taskType,
    priority: template.priority || 'MEDIUM',
    metadata: template.metadata || {}
  };

  schedule.templates.push(newTemplate);
  await saveSchedule(schedule);

  emitLog('info', `Added template task: ${newTemplate.name}`, { templateId: newTemplate.id }, '[TaskSchedule]');
  return newTemplate;
}

/**
 * Get all template tasks
 */
export async function getTemplateTasks() {
  const schedule = await loadSchedule();
  return schedule.templates;
}

/**
 * Delete a template task
 */
export async function deleteTemplateTask(templateId) {
  const schedule = await loadSchedule();
  const index = schedule.templates.findIndex(t => t.id === templateId);

  if (index === -1) {
    return { error: 'Template not found' };
  }

  const deleted = schedule.templates.splice(index, 1)[0];
  await saveSchedule(schedule);

  emitLog('info', `Deleted template task: ${deleted.name}`, { templateId }, '[TaskSchedule]');
  return { success: true, deleted };
}

/**
 * Trigger an on-demand task by task type
 * Creates an immediate task entry for the specified type
 */
export async function triggerOnDemandTask(taskType, category = 'selfImprovement', appId = null) {
  // This marks the task as requested for immediate execution
  // The task generation will pick it up on the next evaluation
  const schedule = await loadSchedule();

  if (!schedule.onDemandRequests) {
    schedule.onDemandRequests = [];
  }

  const request = {
    id: `demand-${Date.now().toString(36)}`,
    taskType,
    category,
    appId,
    requestedAt: new Date().toISOString()
  };

  schedule.onDemandRequests.push(request);
  await saveSchedule(schedule);

  emitLog('info', `On-demand task requested: ${taskType}`, { category, appId }, '[TaskSchedule]');
  cosEvents.emit('task:on-demand-requested', request);

  return request;
}

/**
 * Get pending on-demand task requests
 */
export async function getOnDemandRequests() {
  const schedule = await loadSchedule();
  return schedule.onDemandRequests || [];
}

/**
 * Clear an on-demand request (after it's been processed)
 */
export async function clearOnDemandRequest(requestId) {
  const schedule = await loadSchedule();

  if (!schedule.onDemandRequests) return null;

  const index = schedule.onDemandRequests.findIndex(r => r.id === requestId);
  if (index === -1) return null;

  const cleared = schedule.onDemandRequests.splice(index, 1)[0];
  await saveSchedule(schedule);

  return cleared;
}

/**
 * Get full schedule status for UI display
 */
export async function getScheduleStatus() {
  const schedule = await loadSchedule();
  const status = {
    lastUpdated: schedule.lastUpdated,
    selfImprovement: {},
    appImprovement: {},
    templates: schedule.templates,
    onDemandRequests: schedule.onDemandRequests || []
  };

  // Add execution status to each self-improvement task type
  for (const [taskType, interval] of Object.entries(schedule.selfImprovement)) {
    const check = await shouldRunSelfImprovementTask(taskType);
    const execution = schedule.executions[`self-improve:${taskType}`] || { lastRun: null, count: 0 };

    status.selfImprovement[taskType] = {
      ...interval,
      lastRun: execution.lastRun,
      runCount: execution.count,
      status: check
    };
  }

  // Add execution status to each app improvement task type
  for (const [taskType, interval] of Object.entries(schedule.appImprovement)) {
    const execution = schedule.executions[`app-improve:${taskType}`] || { lastRun: null, count: 0, perApp: {} };

    status.appImprovement[taskType] = {
      ...interval,
      globalLastRun: execution.lastRun,
      globalRunCount: execution.count,
      perAppCount: Object.keys(execution.perApp).length
    };
  }

  return status;
}

/**
 * Reset execution history for a task type (useful for re-running 'once' tasks)
 */
export async function resetExecutionHistory(taskType, category = 'selfImprovement', appId = null) {
  const schedule = await loadSchedule();
  const key = category === 'selfImprovement' ? `self-improve:${taskType}` : `app-improve:${taskType}`;

  if (!schedule.executions[key]) {
    return { error: 'No execution history found' };
  }

  if (appId) {
    // Reset only for specific app
    if (schedule.executions[key].perApp && schedule.executions[key].perApp[appId]) {
      delete schedule.executions[key].perApp[appId];
    }
  } else {
    // Reset entire history for this task type
    delete schedule.executions[key];
  }

  await saveSchedule(schedule);
  emitLog('info', `Reset execution history for ${taskType}`, { category, appId }, '[TaskSchedule]');

  return { success: true, taskType, appId };
}
