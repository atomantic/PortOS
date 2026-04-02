/**
 * Automation Scheduler Service
 *
 * Manages scheduled automation tasks for agent platform accounts.
 * Uses the eventScheduler pattern for reliable cron/interval/random scheduling.
 */

import { join } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import EventEmitter from 'events';
import { PATHS, createCachedStore } from '../lib/fileUtils.js';
import * as eventScheduler from './eventScheduler.js';
import * as agentActivity from './agentActivity.js';
import { getUserTimezone } from '../lib/timezone.js';

const SCHEDULES_FILE = join(PATHS.agentPersonalities, 'schedules.json');
const store = createCachedStore(SCHEDULES_FILE, { schedules: {} }, { context: 'automation schedules' });
const loadSchedules = store.load;
const saveSchedules = store.save;

// Event emitter for schedule changes
export const scheduleEvents = new EventEmitter();

// Track active scheduled events
const activeSchedules = new Map();

export const invalidateCache = store.invalidateCache;

export function notifyChanged(action = 'update', scheduleId = null) {
  scheduleEvents.emit('changed', { action, scheduleId, timestamp: Date.now() });
}

/**
 * Get all schedules
 */
export async function getAllSchedules() {
  const data = await loadSchedules();
  return Object.entries(data.schedules).map(([id, schedule]) => ({
    id,
    ...schedule,
    isActive: activeSchedules.has(id)
  }));
}

/**
 * Get schedules for a specific agent
 */
export async function getSchedulesByAgent(agentId) {
  const schedules = await getAllSchedules();
  return schedules.filter(schedule => schedule.agentId === agentId);
}

/**
 * Get schedules for a specific account
 */
export async function getSchedulesByAccount(accountId) {
  const schedules = await getAllSchedules();
  return schedules.filter(schedule => schedule.accountId === accountId);
}

/**
 * Get schedule by ID
 */
export async function getScheduleById(id) {
  const data = await loadSchedules();
  const schedule = data.schedules[id];
  return schedule ? {
    id,
    ...schedule,
    isActive: activeSchedules.has(id)
  } : null;
}

/**
 * Create a new schedule
 */
export async function createSchedule(scheduleData) {
  const data = await loadSchedules();
  const id = uuidv4();
  const now = new Date().toISOString();

  const schedule = {
    agentId: scheduleData.agentId,
    accountId: scheduleData.accountId,
    action: {
      type: scheduleData.action.type,
      params: scheduleData.action.params || {}
    },
    schedule: {
      type: scheduleData.schedule.type,
      cron: scheduleData.schedule.cron,
      intervalMs: scheduleData.schedule.intervalMs,
      randomWindow: scheduleData.schedule.randomWindow
    },
    rateLimit: scheduleData.rateLimit || {},
    enabled: scheduleData.enabled === true,
    lastRun: null,
    runCount: 0,
    createdAt: now,
    updatedAt: now
  };

  data.schedules[id] = schedule;
  await saveSchedules(data);
  notifyChanged('create', id);

  // If enabled, activate the schedule
  if (schedule.enabled) {
    await activateSchedule(id, schedule);
  }

  console.log(`📅 Created schedule: ${schedule.action.type} (${id})`);
  return { id, ...schedule, isActive: schedule.enabled };
}

/**
 * Update an existing schedule
 */
export async function updateSchedule(id, updates) {
  const data = await loadSchedules();

  if (!data.schedules[id]) {
    return null;
  }

  const { id: _id, createdAt: _createdAt, ...cleanUpdates } = updates;
  const wasEnabled = data.schedules[id].enabled;

  const schedule = {
    ...data.schedules[id],
    ...cleanUpdates,
    createdAt: data.schedules[id].createdAt,
    updatedAt: new Date().toISOString()
  };

  data.schedules[id] = schedule;
  await saveSchedules(data);
  notifyChanged('update', id);

  // Handle enable/disable
  if (wasEnabled && !schedule.enabled) {
    await deactivateSchedule(id);
  } else if (!wasEnabled && schedule.enabled) {
    await activateSchedule(id, schedule);
  } else if (schedule.enabled) {
    // Schedule config changed, restart it
    await deactivateSchedule(id);
    await activateSchedule(id, schedule);
  }

  console.log(`📝 Updated schedule: ${schedule.action.type} (${id})`);
  return { id, ...schedule, isActive: activeSchedules.has(id) };
}

/**
 * Delete a schedule
 */
export async function deleteSchedule(id) {
  const data = await loadSchedules();

  if (!data.schedules[id]) {
    return false;
  }

  // Deactivate if running
  await deactivateSchedule(id);

  delete data.schedules[id];
  await saveSchedules(data);
  notifyChanged('delete', id);

  console.log(`🗑️ Deleted schedule (${id})`);
  return true;
}

/**
 * Toggle schedule enabled status
 */
export async function toggleSchedule(id, enabled) {
  return updateSchedule(id, { enabled });
}

/**
 * Activate a schedule (start the timer)
 */
async function activateSchedule(id, schedule) {
  // Don't double-activate
  if (activeSchedules.has(id)) {
    return;
  }

  const eventId = `agent-schedule-${id}`;

  const handler = async () => {
    await executeScheduledAction(id);
  };

  // Build schedule config based on type
  const eventConfig = {
    id: eventId,
    handler,
    metadata: {
      scheduleId: id,
      agentId: schedule.agentId,
      accountId: schedule.accountId,
      actionType: schedule.action.type
    }
  };

  if (schedule.schedule.type === 'cron') {
    eventConfig.type = 'cron';
    eventConfig.cron = schedule.schedule.cron;
    eventConfig.timezone = await getUserTimezone();
  } else if (schedule.schedule.type === 'interval') {
    eventConfig.type = 'interval';
    eventConfig.intervalMs = schedule.schedule.intervalMs;
  } else if (schedule.schedule.type === 'random') {
    // For random, use interval with randomized timing
    eventConfig.type = 'interval';
    const { minMs, maxMs } = schedule.schedule.randomWindow;
    eventConfig.intervalMs = minMs + Math.random() * (maxMs - minMs);
  }

  eventScheduler.schedule(eventConfig);
  activeSchedules.set(id, eventId);

  console.log(`▶️ Activated schedule: ${schedule.action.type} (${id})`);
}

/**
 * Deactivate a schedule (stop the timer)
 */
async function deactivateSchedule(id) {
  const eventId = activeSchedules.get(id);
  if (eventId) {
    eventScheduler.cancel(eventId);
    activeSchedules.delete(id);
    console.log(`⏸️ Deactivated schedule (${id})`);
  }
}

/**
 * Execute a scheduled action
 */
async function executeScheduledAction(scheduleId) {
  const schedule = await getScheduleById(scheduleId);
  if (!schedule || !schedule.enabled) {
    return;
  }

  const now = new Date().toISOString();

  // Check rate limits
  if (schedule.rateLimit) {
    const { maxPerDay, cooldownMs } = schedule.rateLimit;

    // Check cooldown
    if (cooldownMs && schedule.lastRun) {
      const lastRunTime = new Date(schedule.lastRun).getTime();
      const elapsed = Date.now() - lastRunTime;
      if (elapsed < cooldownMs) {
        console.log(`⏳ Rate limited: ${scheduleId} - cooldown not met`);
        return;
      }
    }

    // Check daily limit (simplified - would need activity tracking for accurate count)
    if (maxPerDay) {
      const todayCount = await agentActivity.getTodayActionCount(
        schedule.accountId,
        schedule.action.type
      );
      if (todayCount >= maxPerDay) {
        console.log(`⏳ Rate limited: ${scheduleId} - daily limit reached`);
        return;
      }
    }
  }

  // Execute the action
  console.log(`🚀 Executing scheduled action: ${schedule.action.type} (${scheduleId})`);

  // Log activity
  await agentActivity.logActivity({
    agentId: schedule.agentId,
    accountId: schedule.accountId,
    scheduleId,
    action: schedule.action.type,
    params: schedule.action.params,
    status: 'started',
    timestamp: now
  });

  // Update last run
  const data = await loadSchedules();
  if (data.schedules[scheduleId]) {
    data.schedules[scheduleId].lastRun = now;
    data.schedules[scheduleId].runCount = (data.schedules[scheduleId].runCount || 0) + 1;
    await saveSchedules(data);
  }

  // Emit event for platform integration to pick up
  scheduleEvents.emit('execute', {
    scheduleId,
    schedule,
    timestamp: now
  });

  // For random schedules, reschedule with new random interval
  if (schedule.schedule.type === 'random') {
    await deactivateSchedule(scheduleId);
    const freshSchedule = await getScheduleById(scheduleId);
    if (freshSchedule && freshSchedule.enabled) {
      await activateSchedule(scheduleId, freshSchedule);
    }
  }
}

/**
 * Manually trigger a schedule to run now
 */
export async function runNow(scheduleId) {
  const schedule = await getScheduleById(scheduleId);
  if (!schedule) {
    return null;
  }

  await executeScheduledAction(scheduleId);
  return await getScheduleById(scheduleId);
}

/**
 * Initialize: Load and activate all enabled schedules
 */
export async function init() {
  const schedules = await getAllSchedules();
  let activatedCount = 0;

  for (const schedule of schedules) {
    if (schedule.enabled) {
      await activateSchedule(schedule.id, schedule);
      activatedCount++;
    }
  }

  if (activatedCount > 0) {
    console.log(`📅 Initialized ${activatedCount} agent schedules`);
  }
}

/**
 * Get schedule stats
 */
export async function getStats() {
  const schedules = await getAllSchedules();
  const byAction = {};
  let enabledCount = 0;
  let totalRuns = 0;

  for (const schedule of schedules) {
    if (schedule.enabled) enabledCount++;
    totalRuns += schedule.runCount || 0;
    byAction[schedule.action.type] = (byAction[schedule.action.type] || 0) + 1;
  }

  return {
    total: schedules.length,
    enabled: enabledCount,
    active: activeSchedules.size,
    totalRuns,
    byAction
  };
}
