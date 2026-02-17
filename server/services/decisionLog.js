/**
 * Decision Log Service
 *
 * Tracks CoS decision-making for transparency.
 * Records why tasks were skipped, intervals were adjusted, or alternatives were chosen.
 * This helps users understand CoS behavior and identify patterns.
 */

import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readJSONFile } from '../lib/fileUtils.js';
import { cosEvents } from './cosEvents.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '../../data/cos');
const DECISION_FILE = join(DATA_DIR, 'decisions.json');

// In-memory cache for recent decisions (avoid excessive file I/O)
let decisionCache = null;
let cacheLoaded = false;

// Decision types
export const DECISION_TYPES = {
  TASK_SKIPPED: 'task_skipped',           // Task skipped due to poor success rate
  TASK_SWITCHED: 'task_switched',          // Switched to alternative task
  INTERVAL_ADJUSTED: 'interval_adjusted',  // Interval changed by learning system
  COOLDOWN_ACTIVE: 'cooldown_active',      // Task still in cooldown
  NOT_DUE: 'not_due',                       // Task not due based on schedule
  QUEUE_FULL: 'queue_full',                 // Too many tasks in queue
  TASK_SELECTED: 'task_selected',           // Task was selected to run
  REHABILITATION: 'rehabilitation'          // Skipped task type retried
};

// Default data structure
const DEFAULT_DATA = {
  version: 1,
  decisions: [],
  stats: {
    totalDecisions: 0,
    byType: {}
  }
};

// Maximum decisions to keep
const MAX_DECISIONS = 200;

/**
 * Load decision data from file
 */
async function loadDecisions() {
  if (cacheLoaded && decisionCache) {
    return decisionCache;
  }

  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }

  decisionCache = await readJSONFile(DECISION_FILE, { ...DEFAULT_DATA });
  cacheLoaded = true;
  return decisionCache;
}

/**
 * Save decision data to file
 */
async function saveDecisions(data) {
  decisionCache = data;
  await writeFile(DECISION_FILE, JSON.stringify(data, null, 2));
}

/**
 * Record a decision
 * @param {string} type - Decision type from DECISION_TYPES
 * @param {string} reason - Human-readable reason
 * @param {Object} context - Additional context (taskType, successRate, etc.)
 */
export async function recordDecision(type, reason, context = {}) {
  const data = await loadDecisions();

  const decision = {
    id: `dec-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 4)}`,
    type,
    reason,
    context,
    timestamp: new Date().toISOString()
  };

  // Add to beginning (most recent first)
  data.decisions.unshift(decision);

  // Trim to max size
  if (data.decisions.length > MAX_DECISIONS) {
    data.decisions = data.decisions.slice(0, MAX_DECISIONS);
  }

  // Update stats
  data.stats.totalDecisions++;
  data.stats.byType[type] = (data.stats.byType[type] || 0) + 1;

  await saveDecisions(data);

  // Emit event for real-time updates
  cosEvents.emit('decision', decision);

  return decision;
}

/**
 * Get recent decisions
 * @param {number} limit - Max decisions to return (default 20)
 * @param {string} type - Optional filter by type
 */
export async function getRecentDecisions(limit = 20, type = null) {
  const data = await loadDecisions();

  let decisions = data.decisions;

  if (type) {
    decisions = decisions.filter(d => d.type === type);
  }

  return decisions.slice(0, limit);
}

/**
 * Get decision summary for dashboard
 * Returns counts and recent impactful decisions
 */
export async function getDecisionSummary() {
  const data = await loadDecisions();

  // Get decisions from last 24 hours
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recentDecisions = data.decisions.filter(
    d => new Date(d.timestamp).getTime() > oneDayAgo
  );

  // Group by type
  const byType = {};
  for (const d of recentDecisions) {
    byType[d.type] = (byType[d.type] || 0) + 1;
  }

  // Get impactful decisions (skips, switches, adjustments)
  const impactfulTypes = [
    DECISION_TYPES.TASK_SKIPPED,
    DECISION_TYPES.TASK_SWITCHED,
    DECISION_TYPES.INTERVAL_ADJUSTED,
    DECISION_TYPES.REHABILITATION
  ];

  const impactfulDecisions = recentDecisions
    .filter(d => impactfulTypes.includes(d.type))
    .slice(0, 5);

  // Calculate transparency score (how many decisions we can explain)
  const totalRecent = recentDecisions.length;
  const explainedCount = recentDecisions.filter(d => d.reason).length;
  const transparencyScore = totalRecent > 0
    ? Math.round((explainedCount / totalRecent) * 100)
    : 100;

  return {
    last24Hours: {
      total: recentDecisions.length,
      byType,
      skipped: byType[DECISION_TYPES.TASK_SKIPPED] || 0,
      switched: byType[DECISION_TYPES.TASK_SWITCHED] || 0,
      adjusted: byType[DECISION_TYPES.INTERVAL_ADJUSTED] || 0,
      selected: byType[DECISION_TYPES.TASK_SELECTED] || 0
    },
    impactfulDecisions,
    transparencyScore,
    hasImpactfulDecisions: impactfulDecisions.length > 0
  };
}

/**
 * Get patterns in decisions (for insights)
 */
export async function getDecisionPatterns() {
  const data = await loadDecisions();

  // Analyze task types that are frequently skipped
  const skippedTasks = {};
  const switchedFrom = {};

  for (const d of data.decisions) {
    if (d.type === DECISION_TYPES.TASK_SKIPPED && d.context?.taskType) {
      skippedTasks[d.context.taskType] = (skippedTasks[d.context.taskType] || 0) + 1;
    }
    if (d.type === DECISION_TYPES.TASK_SWITCHED && d.context?.fromTask) {
      switchedFrom[d.context.fromTask] = (switchedFrom[d.context.fromTask] || 0) + 1;
    }
  }

  // Find most skipped tasks
  const frequentlySkipped = Object.entries(skippedTasks)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([taskType, count]) => ({ taskType, count }));

  return {
    frequentlySkipped,
    totalSkips: Object.values(skippedTasks).reduce((a, b) => a + b, 0),
    totalSwitches: Object.values(switchedFrom).reduce((a, b) => a + b, 0),
    stats: data.stats
  };
}

/**
 * Clear old decisions (keep last N days)
 */
export async function cleanupOldDecisions(daysToKeep = 7) {
  const data = await loadDecisions();
  const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;

  const before = data.decisions.length;
  data.decisions = data.decisions.filter(
    d => new Date(d.timestamp).getTime() > cutoff
  );
  const removed = before - data.decisions.length;

  if (removed > 0) {
    await saveDecisions(data);
  }

  return { removed, remaining: data.decisions.length };
}

// Export types for easy importing
export default {
  recordDecision,
  getRecentDecisions,
  getDecisionSummary,
  getDecisionPatterns,
  cleanupOldDecisions,
  DECISION_TYPES
};
