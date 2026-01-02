import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '../../data');
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
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }

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
 * Get usage summary
 */
export function getUsageSummary() {
  if (!usageData) return getEmptyUsage();

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

  // Calculate totals
  const totalCost = estimateCost(usageData.totalTokens.input, usageData.totalTokens.output);

  return {
    totalSessions: usageData.totalSessions,
    totalMessages: usageData.totalMessages,
    totalToolCalls: usageData.totalToolCalls,
    totalTokens: usageData.totalTokens,
    estimatedCost: totalCost,
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
