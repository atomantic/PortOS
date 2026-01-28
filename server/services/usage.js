import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { ensureDir, PATHS } from '../lib/fileUtils.js';

const DATA_DIR = PATHS.data;
const USAGE_FILE = join(DATA_DIR, 'usage.json');

let usageData = null;

/**
 * Initialize usage data structure
 */
function getEmptyUsage() {
  return {
    totalSessions: 0,
    totalMessages: 0,
    totalToolCalls: 0,
    totalTokens: {
      input: 0,
      output: 0
    },
    byProvider: {},
    byModel: {},
    dailyActivity: {},
    hourlyActivity: Array(24).fill(0),
    lastUpdated: null
  };
}

/**
 * Load usage data from disk
 */
export async function loadUsage() {
  await ensureDir(DATA_DIR);

  if (existsSync(USAGE_FILE)) {
    usageData = JSON.parse(await readFile(USAGE_FILE, 'utf-8'));
  } else {
    usageData = getEmptyUsage();
    await saveUsage();
  }

  console.log(`📊 Loaded usage: ${usageData.totalSessions} sessions, ${usageData.totalMessages} messages`);
  return usageData;
}

/**
 * Save usage data to disk
 */
async function saveUsage() {
  usageData.lastUpdated = new Date().toISOString();
  await writeFile(USAGE_FILE, JSON.stringify(usageData, null, 2));
}

/**
 * Get current usage stats
 */
export function getUsage() {
  return usageData || getEmptyUsage();
}

/**
 * Record a new session
 */
export async function recordSession(providerId, providerName, model) {
  if (!usageData) await loadUsage();

  usageData.totalSessions++;

  // Track by provider
  if (!usageData.byProvider[providerId]) {
    usageData.byProvider[providerId] = { name: providerName, sessions: 0, messages: 0, tokens: 0 };
  }
  usageData.byProvider[providerId].sessions++;

  // Track by model
  if (model) {
    if (!usageData.byModel[model]) {
      usageData.byModel[model] = { sessions: 0, messages: 0, tokens: 0 };
    }
    usageData.byModel[model].sessions++;
  }

  // Track daily activity
  const today = new Date().toISOString().split('T')[0];
  if (!usageData.dailyActivity[today]) {
    usageData.dailyActivity[today] = { sessions: 0, messages: 0, tokens: 0 };
  }
  usageData.dailyActivity[today].sessions++;

  // Track hourly activity
  const hour = new Date().getHours();
  usageData.hourlyActivity[hour]++;

  await saveUsage();
  return usageData.totalSessions;
}

/**
 * Record messages in a session
 */
export async function recordMessages(providerId, model, messageCount, tokenCount = 0) {
  if (!usageData) await loadUsage();

  usageData.totalMessages += messageCount;

  if (tokenCount > 0) {
    usageData.totalTokens.output += tokenCount;
  }

  // Track by provider
  if (usageData.byProvider[providerId]) {
    usageData.byProvider[providerId].messages += messageCount;
    usageData.byProvider[providerId].tokens += tokenCount;
  }

  // Track by model
  if (model && usageData.byModel[model]) {
    usageData.byModel[model].messages += messageCount;
    usageData.byModel[model].tokens += tokenCount;
  }

  // Track daily
  const today = new Date().toISOString().split('T')[0];
  if (usageData.dailyActivity[today]) {
    usageData.dailyActivity[today].messages += messageCount;
    usageData.dailyActivity[today].tokens += tokenCount;
  }

  await saveUsage();
}

/**
 * Record tool calls
 */
export async function recordToolCalls(count) {
  if (!usageData) await loadUsage();
  usageData.totalToolCalls += count;
  await saveUsage();
}

/**
 * Record token usage
 */
export async function recordTokens(inputTokens, outputTokens) {
  if (!usageData) await loadUsage();
  usageData.totalTokens.input += inputTokens;
  usageData.totalTokens.output += outputTokens;
  await saveUsage();
}

/**
 * Calculate current activity streak (consecutive days with sessions)
 */
function calculateStreak(dailyActivity) {
  const today = new Date();
  let streak = 0;
  let checkDate = new Date(today);

  // Start from today and work backwards
  while (true) {
    const dateStr = checkDate.toISOString().split('T')[0];
    const dayData = dailyActivity[dateStr];

    if (dayData && dayData.sessions > 0) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else if (streak === 0) {
      // If today has no activity, check if yesterday started a streak
      checkDate.setDate(checkDate.getDate() - 1);
      const yesterdayStr = checkDate.toISOString().split('T')[0];
      const yesterdayData = dailyActivity[yesterdayStr];
      if (!yesterdayData || yesterdayData.sessions === 0) {
        break; // No streak
      }
      // Continue checking from yesterday
    } else {
      break; // Streak broken
    }
  }

  return streak;
}

/**
 * Find the longest streak in history
 */
function findLongestStreak(dailyActivity) {
  const dates = Object.keys(dailyActivity).sort();
  if (dates.length === 0) return 0;

  let maxStreak = 0;
  let currentStreak = 0;
  let prevDate = null;

  for (const dateStr of dates) {
    const dayData = dailyActivity[dateStr];
    if (!dayData || dayData.sessions === 0) continue;

    if (prevDate) {
      const prev = new Date(prevDate);
      const curr = new Date(dateStr);
      const diffDays = Math.round((curr - prev) / (1000 * 60 * 60 * 24));

      if (diffDays === 1) {
        currentStreak++;
      } else {
        currentStreak = 1;
      }
    } else {
      currentStreak = 1;
    }

    maxStreak = Math.max(maxStreak, currentStreak);
    prevDate = dateStr;
  }

  return maxStreak;
}

/**
 * Get usage summary
 */
export function getUsageSummary() {
  if (!usageData) {
    const empty = getEmptyUsage();
    // Generate empty last7Days
    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      last7Days.push({
        date: date.toISOString().split('T')[0],
        label: date.toLocaleDateString('en-US', { weekday: 'short' }),
        sessions: 0,
        messages: 0,
        tokens: 0
      });
    }
    return {
      ...empty,
      currentStreak: 0,
      longestStreak: 0,
      last7Days,
      estimatedCost: 0,
      topProviders: [],
      topModels: []
    };
  }

  // Get last 7 days activity
  const last7Days = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    last7Days.push({
      date: dateStr,
      label: date.toLocaleDateString('en-US', { weekday: 'short' }),
      ...(usageData.dailyActivity[dateStr] || { sessions: 0, messages: 0, tokens: 0 })
    });
  }

  // Calculate streaks
  const currentStreak = calculateStreak(usageData.dailyActivity);
  const longestStreak = findLongestStreak(usageData.dailyActivity);

  // Calculate totals
  const totalCost = estimateCost(usageData.totalTokens.input, usageData.totalTokens.output);

  return {
    totalSessions: usageData.totalSessions,
    totalMessages: usageData.totalMessages,
    totalToolCalls: usageData.totalToolCalls,
    totalTokens: usageData.totalTokens,
    estimatedCost: totalCost,
    currentStreak,
    longestStreak,
    last7Days,
    hourlyActivity: usageData.hourlyActivity,
    topProviders: Object.entries(usageData.byProvider)
      .map(([id, data]) => ({ id, ...data }))
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, 5),
    topModels: Object.entries(usageData.byModel)
      .map(([model, data]) => ({ model, ...data }))
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, 5),
    lastUpdated: usageData.lastUpdated
  };
}

/**
 * Estimate cost based on token usage
 */
function estimateCost(inputTokens, outputTokens) {
  // Average costs per 1M tokens (rough estimates)
  const inputCostPer1M = 3.00;
  const outputCostPer1M = 15.00;

  const inputCost = (inputTokens / 1_000_000) * inputCostPer1M;
  const outputCost = (outputTokens / 1_000_000) * outputCostPer1M;

  return Math.round((inputCost + outputCost) * 100) / 100;
}

/**
 * Reset usage data
 */
export async function resetUsage() {
  usageData = getEmptyUsage();
  await saveUsage();
  return true;
}

// Load on startup
loadUsage().catch(err => console.error(`❌ Failed to load usage: ${err.message}`));
