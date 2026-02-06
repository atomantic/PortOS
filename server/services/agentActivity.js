/**
 * Agent Activity Service
 *
 * Logs and tracks all agent activities for monitoring, analytics,
 * and rate limit enforcement. Activity is stored per-agent per-day.
 */

import { readFile, writeFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import EventEmitter from 'events';
import { ensureDir, PATHS } from '../lib/fileUtils.js';

const AGENTS_DIR = PATHS.agentPersonalities;
const ACTIVITY_DIR = join(AGENTS_DIR, 'activity');

// Event emitter for activity events
export const activityEvents = new EventEmitter();

// Cache for today's activity (per account)
const todayCache = new Map();

async function ensureActivityDir(agentId = null) {
  await ensureDir(ACTIVITY_DIR);
  if (agentId) {
    await ensureDir(join(ACTIVITY_DIR, agentId));
  }
}

function getDateString(date = new Date()) {
  return date.toISOString().split('T')[0];
}

function getActivityFilePath(agentId, date = new Date()) {
  const dateStr = typeof date === 'string' ? date : getDateString(date);
  return join(ACTIVITY_DIR, agentId, `${dateStr}.json`);
}

/**
 * Load activity for a specific agent and date
 */
async function loadActivity(agentId, date = new Date()) {
  const filePath = getActivityFilePath(agentId, date);
  await ensureActivityDir(agentId);

  if (!existsSync(filePath)) {
    return { activities: [] };
  }

  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content);
}

/**
 * Save activity for a specific agent and date
 */
async function saveActivity(agentId, date, data) {
  await ensureActivityDir(agentId);
  const filePath = getActivityFilePath(agentId, date);
  await writeFile(filePath, JSON.stringify(data, null, 2));
}

/**
 * Log an activity
 */
export async function logActivity(activity) {
  const {
    agentId,
    accountId,
    scheduleId,
    action,
    params,
    status,
    result,
    error,
    timestamp
  } = activity;

  const date = new Date(timestamp || Date.now());
  const dateStr = getDateString(date);

  const data = await loadActivity(agentId, date);

  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    accountId,
    scheduleId,
    action,
    params,
    status,
    result,
    error,
    timestamp: timestamp || date.toISOString()
  };

  data.activities.push(entry);
  await saveActivity(agentId, dateStr, data);

  // Invalidate cache for this account
  todayCache.delete(`${accountId}-${action}`);

  // Emit event
  activityEvents.emit('activity', { agentId, ...entry });

  console.log(`📊 Activity logged: ${agentId}/${action} - ${status}`);
  return entry;
}

/**
 * Update activity status (e.g., from 'started' to 'completed')
 */
export async function updateActivityStatus(agentId, activityId, status, result = null, error = null) {
  const date = new Date();
  const dateStr = getDateString(date);
  const data = await loadActivity(agentId, date);

  const activity = data.activities.find(a => a.id === activityId);
  if (activity) {
    activity.status = status;
    if (result) activity.result = result;
    if (error) activity.error = error;
    activity.completedAt = new Date().toISOString();

    await saveActivity(agentId, dateStr, data);
    activityEvents.emit('activity:updated', { agentId, activityId, status });
  }

  return activity;
}

/**
 * Get activities for an agent
 */
export async function getActivities(agentId, options = {}) {
  const { date, limit = 100, offset = 0, action = null } = options;

  const targetDate = date || new Date();
  const data = await loadActivity(agentId, targetDate);

  let activities = data.activities || [];

  // Filter by action if specified
  if (action) {
    activities = activities.filter(a => a.action === action);
  }

  // Sort by timestamp descending (newest first)
  activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // Apply pagination
  return activities.slice(offset, offset + limit);
}

/**
 * Get recent activities across all agents
 */
export async function getRecentActivities(options = {}) {
  const { limit = 50, agentIds = null, action = null } = options;

  const today = getDateString();
  const activities = [];

  // Get list of agent directories
  await ensureActivityDir();
  let agentDirs = [];

  if (existsSync(ACTIVITY_DIR)) {
    const entries = await readdir(ACTIVITY_DIR, { withFileTypes: true });
    agentDirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  }

  // Filter to specific agents if provided
  if (agentIds) {
    agentDirs = agentDirs.filter(d => agentIds.includes(d));
  }

  // Load today's activities from each agent
  for (const agentId of agentDirs) {
    const data = await loadActivity(agentId, today);
    for (const activity of data.activities || []) {
      if (!action || activity.action === action) {
        activities.push({ agentId, ...activity });
      }
    }
  }

  // Sort and limit
  activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return activities.slice(0, limit);
}

/**
 * Get today's action count for an account (for rate limiting)
 */
export async function getTodayActionCount(accountId, action) {
  const cacheKey = `${accountId}-${action}`;

  // Check cache first
  if (todayCache.has(cacheKey)) {
    const cached = todayCache.get(cacheKey);
    if (Date.now() - cached.timestamp < 5000) { // 5 second cache
      return cached.count;
    }
  }

  // Count from all agents for this account
  const today = getDateString();
  let count = 0;

  await ensureActivityDir();

  if (existsSync(ACTIVITY_DIR)) {
    const entries = await readdir(ACTIVITY_DIR, { withFileTypes: true });
    const agentDirs = entries.filter(e => e.isDirectory()).map(e => e.name);

    for (const agentId of agentDirs) {
      const data = await loadActivity(agentId, today);
      for (const activity of data.activities || []) {
        if (activity.accountId === accountId && activity.action === action) {
          count++;
        }
      }
    }
  }

  // Update cache
  todayCache.set(cacheKey, { count, timestamp: Date.now() });

  return count;
}

/**
 * Get activity stats for an agent
 */
export async function getAgentStats(agentId, days = 7) {
  const stats = {
    totalActivities: 0,
    byAction: {},
    byStatus: {},
    byDay: {}
  };

  const today = new Date();

  for (let i = 0; i < days; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = getDateString(date);

    const data = await loadActivity(agentId, date);
    const dayActivities = data.activities || [];

    stats.byDay[dateStr] = dayActivities.length;
    stats.totalActivities += dayActivities.length;

    for (const activity of dayActivities) {
      stats.byAction[activity.action] = (stats.byAction[activity.action] || 0) + 1;
      stats.byStatus[activity.status] = (stats.byStatus[activity.status] || 0) + 1;
    }
  }

  return stats;
}

/**
 * Get activity timeline for display
 */
export async function getActivityTimeline(options = {}) {
  const { agentIds = null, limit = 100, beforeTimestamp = null } = options;

  const activities = await getRecentActivities({ limit: limit * 2, agentIds });

  // Filter by timestamp if provided
  let filtered = activities;
  if (beforeTimestamp) {
    filtered = activities.filter(a => new Date(a.timestamp) < new Date(beforeTimestamp));
  }

  return filtered.slice(0, limit);
}

/**
 * Clean up old activity files (older than N days)
 */
export async function cleanupOldActivity(daysToKeep = 30) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

  let deletedCount = 0;

  await ensureActivityDir();

  if (!existsSync(ACTIVITY_DIR)) return deletedCount;

  const entries = await readdir(ACTIVITY_DIR, { withFileTypes: true });
  const agentDirs = entries.filter(e => e.isDirectory()).map(e => e.name);

  for (const agentId of agentDirs) {
    const agentDir = join(ACTIVITY_DIR, agentId);
    const files = await readdir(agentDir);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const dateStr = file.replace('.json', '');
      const fileDate = new Date(dateStr);

      if (fileDate < cutoffDate) {
        const { unlink } = await import('fs/promises');
        await unlink(join(agentDir, file));
        deletedCount++;
      }
    }
  }

  if (deletedCount > 0) {
    console.log(`🧹 Cleaned up ${deletedCount} old activity files`);
  }

  return deletedCount;
}
