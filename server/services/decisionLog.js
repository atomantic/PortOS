/**
 * Decision Log Service
 *
 * Tracks CoS decision-making for transparency.
 * Records why tasks were skipped, intervals were adjusted, or alternatives were chosen.
 * This helps users understand CoS behavior and identify patterns.
 */

import { join } from 'path';
import { dashboardEvents, scheduleDashboardExpiry } from './dashboardEvents.js';
import { atomicWrite, ensureDir, readJSONFile, PATHS } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';

const DATA_DIR = PATHS.cos;
const DECISION_FILE = join(DATA_DIR, 'decisions.json');
const queueDecisionWrite = createFileWriteQueue();

// In-memory cache for recent decisions (avoid excessive file I/O)
let decisionCache = null;

// Decision types
export const DECISION_TYPES = {
  TASK_SKIPPED: 'task_skipped',           // Task skipped due to poor success rate
  TASK_SWITCHED: 'task_switched',          // Switched to alternative task
  INTERVAL_ADJUSTED: 'interval_adjusted',  // Interval changed by learning system
  COOLDOWN_ACTIVE: 'cooldown_active',      // Task/app still in cooldown period
  NOT_DUE: 'not_due',                       // Task not due based on schedule
  QUEUE_FULL: 'queue_full',                 // Too many tasks in queue
  CAPACITY_FULL: 'capacity_full',           // Max concurrent agents reached (global or per-project)
  TASK_SELECTED: 'task_selected',           // Task was selected to run
  IDLE: 'idle'                              // No work available after full evaluation
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
  if (decisionCache) {
    return decisionCache;
  }

  await ensureDir(DATA_DIR);

  // STRICT (#4115): `getDecisionSummary()` divides by `recentDecisions.length`
  // for the transparency score and reduces `count` into `totalOccurrences` — a
  // swallowed unreadable read publishes those as real numbers over an empty set.
  // `data.stats.totalDecisions` is also a LIFETIME counter that `saveDecisions`
  // writes back, so the same read resets it to zero on the next recordDecision.
  const loaded = await readJSONFile(DECISION_FILE, structuredClone(DEFAULT_DATA), { strict: true });
  // A dashboard read that started on a cold cache can finish after a write.
  decisionCache ??= loaded;
  return decisionCache;
}

/**
 * Save decision data to file
 */
async function saveDecisions(data) {
  await atomicWrite(DECISION_FILE, data);
  decisionCache = data;
  dashboardEvents.emit('cos:decisions:changed');
}

/**
 * Record a decision
 * Consecutive identical decisions (same type + reason) are collapsed into a
 * single entry with an incrementing `count` field. This keeps the 200-entry
 * buffer focused on meaningful decisions instead of flooding it with
 * repetitive idle/not_due entries every evaluation cycle.
 *
 * @param {string} type - Decision type from DECISION_TYPES
 * @param {string} reason - Human-readable reason
 * @param {Object} context - Additional context (taskType, successRate, etc.)
 */
export async function recordDecision(type, reason, context = {}) {
  return queueDecisionWrite(async () => {
    const data = await loadDecisions();
    const prev = data.decisions[0];
    const timestamp = new Date().toISOString();
    const collapse = prev && prev.type === type && prev.reason === reason;
    const decision = collapse
      ? { ...prev, count: (prev.count || 1) + 1, lastTimestamp: timestamp, context }
      : {
          id: `dec-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 4)}`,
          type,
          reason,
          context,
          count: 1,
          timestamp
        };

    await saveDecisions({
      ...data,
      decisions: collapse
        ? [decision, ...data.decisions.slice(1)]
        : [decision, ...data.decisions.slice(0, MAX_DECISIONS - 1)],
      stats: {
        ...data.stats,
        totalDecisions: data.stats.totalDecisions + 1,
        byType: { ...data.stats.byType, [type]: (data.stats.byType[type] || 0) + 1 }
      }
    });
    return decision;
  });
}

/**
 * Get decision summary for dashboard
 * Returns counts and recent impactful decisions
 */
export async function getDecisionSummary() {
  const data = await loadDecisions();

  // Get decisions from last 24 hours (use lastTimestamp for collapsed entries)
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recentDecisions = data.decisions.filter(d => {
    const ts = new Date(d.lastTimestamp || d.timestamp).getTime();
    return ts > oneDayAgo;
  });

  scheduleDashboardExpiry('cos:decisions:changed', Math.min(...recentDecisions.map(d =>
    new Date(d.lastTimestamp || d.timestamp).getTime() + 24 * 60 * 60 * 1000)));

  // Group by type, using collapsed count
  const byType = {};
  for (const d of recentDecisions) {
    byType[d.type] = (byType[d.type] || 0) + (d.count || 1);
  }

  // Get impactful decisions (skips, switches, capacity issues, cooldowns)
  const impactfulTypes = [
    DECISION_TYPES.TASK_SKIPPED,
    DECISION_TYPES.TASK_SWITCHED,
    DECISION_TYPES.INTERVAL_ADJUSTED,
    DECISION_TYPES.CAPACITY_FULL,
    DECISION_TYPES.COOLDOWN_ACTIVE
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

  // Total is the sum of collapsed counts, not just entry count
  const totalOccurrences = recentDecisions.reduce((sum, d) => sum + (d.count || 1), 0);

  return {
    last24Hours: {
      total: totalOccurrences,
      byType,
      skipped: byType[DECISION_TYPES.TASK_SKIPPED] || 0,
      switched: byType[DECISION_TYPES.TASK_SWITCHED] || 0,
      adjusted: byType[DECISION_TYPES.INTERVAL_ADJUSTED] || 0,
      selected: byType[DECISION_TYPES.TASK_SELECTED] || 0,
      capacityFull: byType[DECISION_TYPES.CAPACITY_FULL] || 0,
      cooldownActive: byType[DECISION_TYPES.COOLDOWN_ACTIVE] || 0,
      idle: byType[DECISION_TYPES.IDLE] || 0
    },
    impactfulDecisions,
    transparencyScore,
    hasImpactfulDecisions: impactfulDecisions.length > 0
  };
}
