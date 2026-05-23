import { join } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { appendJSONLine, ensureDir, PATHS, readJSONLines, writeJSONLines } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';

const DATA_DIR = PATHS.data;
const HISTORY_FILE = join(DATA_DIR, 'history.jsonl');
const MAX_ENTRIES = 500;

// In-memory cache with TTL
let historyCache = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 2000; // 2 second cache TTL
const queueHistoryWrite = createFileWriteQueue();

async function loadHistory() {
  // Return cached data if still valid
  const now = Date.now();
  if (historyCache && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return historyCache;
  }

  await ensureDir(DATA_DIR);

  historyCache = { entries: await readJSONLines(HISTORY_FILE, { logErrors: true }) };
  cacheTimestamp = now;
  return historyCache;
}

async function saveHistory(data) {
  await ensureDir(DATA_DIR);
  // Trim to max entries
  const nextData = {
    entries: data.entries.length > MAX_ENTRIES
      ? data.entries.slice(-MAX_ENTRIES)
      : data.entries,
  };
  await writeJSONLines(HISTORY_FILE, nextData.entries);
  // Update cache only after the disk write succeeds.
  historyCache = nextData;
  cacheTimestamp = Date.now();
}

/**
 * Log an action to history
 */
export async function logAction(action, target, targetName, details = {}, success = true, error = null) {
  return queueHistoryWrite(async () => {
    const data = await loadHistory();

    const entry = {
      id: uuidv4(),
      action,
      target,
      targetName,
      details,
      success,
      error,
      timestamp: new Date().toISOString()
    };

    const entries = [...data.entries, entry];

    if (entries.length > MAX_ENTRIES) {
      await saveHistory({ entries });
    } else {
      await appendJSONLine(HISTORY_FILE, entry);
      historyCache = { entries };
      cacheTimestamp = Date.now();
    }

    return entry;
  });
}

/**
 * Get history entries with optional filtering
 */
export async function getHistory(options = {}) {
  const { limit = 100, offset = 0, action, target, success } = options;

  const data = await loadHistory();
  let entries = [...data.entries].reverse(); // Most recent first

  // Apply filters
  if (action) {
    entries = entries.filter(e => e.action === action);
  }
  if (target) {
    entries = entries.filter(e => e.target === target);
  }
  if (success !== undefined) {
    entries = entries.filter(e => e.success === success);
  }

  return {
    total: entries.length,
    entries: entries.slice(offset, offset + limit)
  };
}

/**
 * Get unique action types in history
 */
export async function getActionTypes() {
  const data = await loadHistory();
  const types = new Set(data.entries.map(e => e.action));
  return Array.from(types).sort();
}

/**
 * Delete a single history entry by ID
 */
export async function deleteEntry(id) {
  return queueHistoryWrite(async () => {
    const data = await loadHistory();
    const index = data.entries.findIndex(e => e.id === id);

    if (index === -1) {
      return { deleted: false, error: 'Entry not found' };
    }

    await saveHistory({
      entries: data.entries.filter((entry) => entry.id !== id),
    });
    return { deleted: true };
  });
}

/**
 * Clear history (optionally older than days)
 */
export async function clearHistory(olderThanDays = null) {
  return queueHistoryWrite(async () => {
    const data = await loadHistory();

    let entries = [];
    if (olderThanDays !== null) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - olderThanDays);
      entries = data.entries.filter(e => new Date(e.timestamp) >= cutoff);
    }

    await saveHistory({ entries });
    return { cleared: true };
  });
}

/**
 * Get history stats
 */
export async function getHistoryStats() {
  const data = await loadHistory();
  const entries = data.entries;

  const stats = {
    total: entries.length,
    byAction: {},
    successRate: 0,
    recentActivity: []
  };

  let successCount = 0;
  for (const entry of entries) {
    stats.byAction[entry.action] = (stats.byAction[entry.action] || 0) + 1;
    if (entry.success) successCount++;
  }

  stats.successRate = entries.length > 0 ? (successCount / entries.length * 100).toFixed(1) : 0;

  // Last 24 hours activity by hour
  const now = new Date();
  const last24h = entries.filter(e => {
    const diff = now - new Date(e.timestamp);
    return diff < 24 * 60 * 60 * 1000;
  });

  stats.last24h = last24h.length;

  return stats;
}
