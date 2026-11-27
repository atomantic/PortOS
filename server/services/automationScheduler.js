/**
 * Automation Scheduler Service
 *
 * Manages scheduled automation tasks for agent platform accounts.
 * Uses the eventScheduler pattern for reliable cron/interval/random scheduling.
 */

import { join } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { PATHS, createCachedStore } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import * as eventScheduler from './eventScheduler.js';
import * as agentActivity from './agent/agentActivity.js';
import { validateScheduleOwner } from './agent/automationScheduleOwner.js';
import { getUserTimezone } from './userTimezone.js';
import { createSingleFlight } from '../lib/singleFlight.js';
import { ServerError } from '../lib/errorHandler.js';

const SCHEDULES_FILE = join(PATHS.agentPersonalities, 'schedules.json');
const store = createCachedStore(SCHEDULES_FILE, { schedules: {} }, { context: 'automation schedules' });
const loadSchedules = store.load;

// Serialize the durable mutation and its timer change together. Restore owns this
// queue, leaving the store queue available for persisting a restored random roll.
const queueSchedules = createFileWriteQueue();
const activeSchedules = new Map();
// A schedule edit can replace its event while the old handler is still running.
const scheduleRuns = createSingleFlight();
let actionExecutor = null;

export function registerActionExecutor(executor) {
  actionExecutor = executor;
}

export const invalidateCache = store.invalidateCache;
export function withLiveRestore(restore) {
  return queueSchedules(() => restore(async () => {
    invalidateCache();
    await reconcileSchedules();
  }));
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
export function createSchedule(scheduleData) {
  return queueSchedules(() => createScheduleLocked(scheduleData));
}

async function createScheduleLocked(scheduleData) {
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
    rolledIntervalMs: null,
    createdAt: now,
    updatedAt: now
  };

  await store.mutate((data) => { data.schedules[id] = schedule; });

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
export function updateSchedule(id, updates) {
  return queueSchedules(() => updateScheduleLocked(id, updates));
}

async function updateScheduleLocked(id, updates) {
  let schedule = null;
  await store.mutate(async (data) => {
    if (!data.schedules[id]) return data;

    const { id: _id, createdAt: _createdAt, ...cleanUpdates } = updates;

    schedule = {
      ...data.schedules[id],
      ...cleanUpdates,
      createdAt: data.schedules[id].createdAt,
      updatedAt: new Date().toISOString()
    };

    // Validate against the same serialized snapshot used for the write.
    if (cleanUpdates.agentId !== undefined || cleanUpdates.accountId !== undefined) {
      await validateScheduleOwner(schedule);
    }

    if (cleanUpdates.schedule) {
      schedule.rolledIntervalMs = null;
      if (schedule.schedule) {
        schedule.schedule.rolledIntervalMs = null;
      }
    }

    data.schedules[id] = schedule;
    return data;
  });

  if (!schedule) return null;

  deactivateSchedule(id);
  if (schedule.enabled) await activateSchedule(id, schedule);

  console.log(`📝 Updated schedule: ${schedule.action.type} (${id})`);
  return { id, ...schedule, isActive: activeSchedules.has(id) };
}

/**
 * Delete a schedule
 */
export function deleteSchedule(id) {
  return queueSchedules(() => deleteScheduleLocked(id));
}

async function deleteScheduleLocked(id) {
  let existed = false;
  await store.mutate((data) => {
    if (!data.schedules[id]) return data;
    existed = true;
    delete data.schedules[id];
    return data;
  });

  if (!existed) return false;

  // Deactivate if running
  deactivateSchedule(id);

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
  const eventId = `agent-schedule-${id}`;
  const registration = { eventId };
  const handler = () => scheduleRuns.run(id, () => executeScheduledAction(id, registration));

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
    if (schedule.lastRun) {
      eventConfig.lastRunAt = schedule.lastRun;
    }
  } else if (schedule.schedule.type === 'random') {
    // For random, use interval with randomized timing
    eventConfig.type = 'interval';
    const { minMs, maxMs } = schedule.schedule.randomWindow;
    let intervalMs = schedule.rolledIntervalMs ?? schedule.schedule?.rolledIntervalMs;
    if (!intervalMs || intervalMs < minMs || intervalMs > maxMs) {
      intervalMs = minMs + Math.random() * (maxMs - minMs);
      await store.mutate((data) => {
        if (data.schedules[id]) {
          data.schedules[id].rolledIntervalMs = intervalMs;
          if (data.schedules[id].schedule) {
            data.schedules[id].schedule.rolledIntervalMs = intervalMs;
          }
        }
      });
    }
    eventConfig.intervalMs = intervalMs;
    if (schedule.lastRun) {
      eventConfig.lastRunAt = schedule.lastRun;
    }
  }

  // Match the inputs that determine the event and its next run. Unchanged timers
  // retain their countdown even when a snapshot contains a never-run interval.
  registration.inputs = JSON.stringify([eventConfig.type, eventConfig.cron, eventConfig.timezone,
    eventConfig.intervalMs, eventConfig.metadata, schedule.schedule.type,
    schedule.schedule.randomWindow?.minMs, schedule.schedule.randomWindow?.maxMs]);
  registration.lastRun = schedule.lastRun ?? null;
  const current = activeSchedules.get(id);
  if (current?.inputs === registration.inputs && current.lastRun === registration.lastRun && eventScheduler.getEvent(eventId)) return;

  if (current) deactivateSchedule(id);
  eventScheduler.schedule(eventConfig);
  activeSchedules.set(id, registration);

  console.log(`▶️ Activated schedule: ${schedule.action.type} (${id})`);
}

/**
 * Deactivate a schedule (stop the timer)
 */
function deactivateSchedule(id) {
  const eventId = activeSchedules.get(id)?.eventId;
  if (eventId) {
    eventScheduler.cancel(eventId);
    activeSchedules.delete(id);
    console.log(`⏸️ Deactivated schedule (${id})`);
  }
}

/**
 * Execute a scheduled action
 */
async function executeScheduledAction(scheduleId, registration) {
  const execution = await queueSchedules(() => {
    if (activeSchedules.get(scheduleId) === registration) return admitScheduledAction(scheduleId, registration);
  });
  if (!execution) return;
  try {
    await execution.executor(execution.input);
  } finally {
    if (execution.input.schedule.schedule.type === 'random') {
      await queueSchedules(async () => {
        if (activeSchedules.get(scheduleId) !== registration) return;
        deactivateSchedule(scheduleId);
        const fresh = await getScheduleById(scheduleId);
        if (fresh?.enabled) await activateSchedule(scheduleId, fresh);
      });
    }
  }
}

async function admitScheduledAction(scheduleId, registration) {
  const schedule = await getScheduleById(scheduleId);
  if (!schedule || !schedule.enabled) {
    return;
  }

  const executor = actionExecutor;
  if (!executor) throw new Error('Agent action executor is not initialized');
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
  await store.mutate((data) => {
    if (data.schedules[scheduleId]) {
      data.schedules[scheduleId].lastRun = now;
      data.schedules[scheduleId].runCount = (data.schedules[scheduleId].runCount || 0) + 1;
      data.schedules[scheduleId].rolledIntervalMs = null;
      if (data.schedules[scheduleId].schedule) {
        data.schedules[scheduleId].schedule.rolledIntervalMs = null;
      }
    }
  });

  registration.lastRun = now;
  return { executor, input: { scheduleId, schedule, timestamp: now } };
}

/**
 * Manually trigger a schedule to run now
 */
export async function runNow(scheduleId) {
  const enabled = await queueSchedules(async () => {
    const schedule = await getScheduleById(scheduleId);
    if (schedule?.enabled && !eventScheduler.getEvent(`agent-schedule-${scheduleId}`)) {
      await activateSchedule(scheduleId, schedule);
    }
    return schedule?.enabled;
  });

  if (enabled) {
    const result = await eventScheduler.triggerNow(`agent-schedule-${scheduleId}`);
    if (result === false) {
      throw new ServerError('Scheduler is shutting down', { status: 503 });
    }
  }
  return await getScheduleById(scheduleId);
}

/**
 * Initialize: Load and activate all enabled schedules
 */
export function init() {
  return queueSchedules(reconcileSchedules);
}

async function reconcileSchedules() {
  const { schedules } = await loadSchedules();
  for (const id of activeSchedules.keys()) {
    if (!schedules[id]?.enabled) deactivateSchedule(id);
  }
  let activatedCount = 0;

  for (const [id, schedule] of Object.entries(schedules)) {
    if (schedule.enabled) {
      await activateSchedule(id, schedule);
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
