/**
 * Agent Activity Service
 *
 * Logs and tracks all agent activities for monitoring, analytics,
 * and rate limit enforcement. Activity is stored per-agent per-day.
 */

import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { ensureDir, getDateString, atomicWrite, PATHS } from '../../lib/fileUtils.js';
import { createKeyedFileWriteQueue } from '../../lib/fileWriteQueue.js';
import { mapWithConcurrency } from '../../lib/mapWithConcurrency.js';

const ACTIVITY_READ_CONCURRENCY = 4;
const AGENTS_DIR = PATHS.agentPersonalities;
const ACTIVITY_DIR = join(AGENTS_DIR, 'activity');

// A day file is `<YYYY-MM-DD>.json`. Anything else in an agent directory is not
// activity and is never read as a day.
const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.json$/;

// Each day file is a whole-file JSON read-modify-write. Keyed per agent/day so
// concurrent logActivity calls for one file serialize (no lost entries) while
// different agents or days still write in parallel.
const queueActivityWrite = createKeyedFileWriteQueue();

// Cache for today's activity (per account)
const todayCache = new Map();

function getActivityFilePath(agentId, date = new Date()) {
  const dateStr = typeof date === 'string' ? date : getDateString(date);
  return join(ACTIVITY_DIR, agentId, `${dateStr}.json`);
}

/**
 * Load activity for a specific agent and date
 */
async function loadActivity(agentId, date = new Date()) {
  const filePath = getActivityFilePath(agentId, date);
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') return { activities: [] };
    throw error;
  }
}

async function listActivityDir(directory, options) {
  try {
    return await readdir(directory, options);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Save activity for a specific agent and date
 */
async function saveActivity(agentId, date, data) {
  await ensureDir(join(ACTIVITY_DIR, agentId));
  const filePath = getActivityFilePath(agentId, date);
  await atomicWrite(filePath, data);
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
    code,
    timestamp
  } = activity;

  const date = new Date(timestamp || Date.now());
  const dateStr = getDateString(date);

  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    accountId,
    scheduleId,
    action,
    params,
    status,
    result,
    error,
    ...(typeof code === 'string' && code ? { code } : {}),
    timestamp: timestamp || date.toISOString()
  };

  await queueActivityWrite(`${agentId}/${dateStr}`, async () => {
    const data = await loadActivity(agentId, date);
    data.activities.push(entry);
    await saveActivity(agentId, dateStr, data);
  });

  // Invalidate cache for this account
  todayCache.delete(`${accountId}-${action}`);

  console.log(`📊 Activity logged: ${agentId}/${action} - ${status}`);
  return entry;
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
  const entries = await listActivityDir(ACTIVITY_DIR, { withFileTypes: true });
  const agentDirs = entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
  const counts = await mapWithConcurrency(agentDirs, ACTIVITY_READ_CONCURRENCY, async agentId => {
    const data = await loadActivity(agentId, today);
    return (data.activities || []).filter(activity => activity.accountId === accountId && activity.action === action).length;
  });
  const count = counts.reduce((total, agentCount) => total + agentCount, 0);

  // Update cache
  todayCache.set(cacheKey, { count, timestamp: Date.now() });

  return count;
}

const arrayLength = (value) => (Array.isArray(value) ? value.length : 0);

/**
 * Posts/comments/votes one activity record produced. Only `completed` records
 * count: the scheduler also logs a `started` record for the same action, and
 * engage/monitor runs bundle several votes and replies into one record.
 */
function countOutcomes(activity) {
  const counts = { posts: 0, comments: 0, votes: 0 };
  if (activity.status !== 'completed') return counts;
  const result = activity.result || {};
  const performed = result.action !== 'none' ? 1 : 0;
  switch (activity.action) {
    case 'post':
      counts.posts = 1;
      break;
    case 'comment':
      counts.comments = performed;
      break;
    case 'vote':
      counts.votes = performed;
      break;
    case 'engage':
      counts.votes = arrayLength(result.votes);
      counts.comments = arrayLength(result.comments);
      break;
    case 'monitor':
      counts.votes = arrayLength(result.upvoted);
      counts.comments = arrayLength(result.replied);
      break;
  }
  return counts;
}

/**
 * Get activity stats for an agent
 */
export async function getAgentStats(agentId, days = 7) {
  const stats = {
    totalActivities: 0,
    byAction: {},
    byStatus: {},
    byDay: {},
    totalPosts: 0,
    totalComments: 0,
    totalVotes: 0
  };

  const today = new Date();
  const dates = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    dates.push(getDateString(date));
  }

  const dayData = await mapWithConcurrency(dates, ACTIVITY_READ_CONCURRENCY, date => loadActivity(agentId, date));
  for (const [index, data] of dayData.entries()) {
    const dateStr = dates[index];
    const dayActivities = data.activities || [];

    stats.byDay[dateStr] = dayActivities.length;
    stats.totalActivities += dayActivities.length;

    for (const activity of dayActivities) {
      stats.byAction[activity.action] = (stats.byAction[activity.action] || 0) + 1;
      stats.byStatus[activity.status] = (stats.byStatus[activity.status] || 0) + 1;
      const counts = countOutcomes(activity);
      stats.totalPosts += counts.posts;
      stats.totalComments += counts.comments;
      stats.totalVotes += counts.votes;
    }
  }

  return stats;
}

/**
 * Get activity timeline for display
 */
export async function getActivityTimeline(options = {}) {
  const { agentIds = null, actions = null, limit = 100, beforeTimestamp = null } = options;
  const before = beforeTimestamp ? new Date(beforeTimestamp).getTime() : null;

  const entries = await listActivityDir(ACTIVITY_DIR, { withFileTypes: true });
  const agentDirs = entries
    .filter(entry => entry.isDirectory() && (!agentIds || agentIds.includes(entry.name)))
    .map(entry => entry.name);
  const filesByAgent = await mapWithConcurrency(agentDirs, ACTIVITY_READ_CONCURRENCY,
    agentId => listActivityDir(join(ACTIVITY_DIR, agentId)));
  const agentsByDate = new Map();

  for (const [index, files] of filesByAgent.entries()) {
    for (const file of files) {
      if (!DAY_FILE_RE.test(file)) continue;
      const date = file.slice(0, -5);
      if (!agentsByDate.has(date)) agentsByDate.set(date, []);
      agentsByDate.get(date).push(agentDirs[index]);
    }
  }

  const activities = [];
  for (const date of [...agentsByDate.keys()].sort().reverse()) {
    const dayActivities = [];
    const dayAgents = agentsByDate.get(date);
    const dayData = await mapWithConcurrency(dayAgents, ACTIVITY_READ_CONCURRENCY, agentId => loadActivity(agentId, date));
    for (const [index, data] of dayData.entries()) {
      for (const activity of data.activities || []) {
        const timestamp = new Date(activity.timestamp).getTime();
        // Filter before the limit cut so a filtered page stays full.
        if ((before === null || timestamp < before) && (!actions || actions.includes(activity.action))) {
          dayActivities.push({ timestamp, entry: { agentId: dayAgents[index], ...activity } });
        }
      }
    }

    dayActivities.sort((a, b) => {
      const timestampOrder = b.timestamp - a.timestamp;
      if (timestampOrder !== 0) return timestampOrder;
      const agentOrder = a.entry.agentId.localeCompare(b.entry.agentId);
      return agentOrder || String(a.entry.id).localeCompare(String(b.entry.id));
    });
    activities.push(...dayActivities.map(({ entry }) => entry));

    // Files are visited newest-day first. Once a complete day fills the page,
    // older files cannot contribute an entry ahead of the current window.
    if (activities.length >= limit) break;
  }

  return activities.slice(0, limit);
}
