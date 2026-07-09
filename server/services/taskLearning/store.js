/**
 * Task Learning — shared persistence layer
 *
 * Owns the on-disk learning data file (load/save with a short-lived in-memory
 * cache), the dismissed-recommendations file, the write mutex, and the small
 * pure helpers (`calculateDurationETA`, `extractTaskType`) that every other
 * taskLearning submodule depends on. Keeping these here avoids circular
 * imports between the metrics / routing / insights modules.
 */

import { join } from 'path';
import { cosEvents, emitLog } from '../cosEvents.js';
import { ensureDir, readJSONFile, PATHS, atomicWrite, tryReadFile } from '../../lib/fileUtils.js';
import { createMutex } from '../../lib/asyncMutex.js';

export const withLock = createMutex();

const DATA_DIR = PATHS.cos;
const LEARNING_FILE = join(DATA_DIR, 'learning.json');
export const AGENTS_DIR = join(DATA_DIR, 'agents'); // consumed by metrics.js
const DISMISSED_RECS_FILE = join(DATA_DIR, 'dismissed-recommendations.json');

// Re-export the infra that sibling modules consume so they import from one
// place. (ensureDir / readJSONFile / atomicWrite stay internal to this file.)
export { cosEvents, emitLog, tryReadFile };

/**
 * Calculate ETA-oriented duration stats from success-only metrics with fallback.
 * Returns { avgDurationMs, maxDurationMs, p80DurationMs }.
 */
export function calculateDurationETA(metrics) {
  const hasSuccessData = (metrics.successDurationMs || 0) > 0;
  const avgBase = hasSuccessData ? metrics.successDurationMs : metrics.totalDurationMs;
  const countBase = hasSuccessData ? metrics.succeeded : metrics.completed;
  if (!countBase || countBase <= 0) return { avgDurationMs: 0, maxDurationMs: 0, p80DurationMs: 0 };
  const avg = Math.round(avgBase / countBase);
  const max = hasSuccessData ? (metrics.successMaxDurationMs || avg) : avg;
  const p80 = Math.round(Math.min(avg * 3, avg + 0.6 * (max - avg)));
  return { avgDurationMs: avg, maxDurationMs: max, p80DurationMs: p80 };
}

/**
 * Default learning data structure
 */
const DEFAULT_LEARNING_DATA = {
  version: 1,
  lastUpdated: null,

  // Metrics by self-improvement task type
  byTaskType: {},

  // Metrics by model tier
  byModelTier: {},

  // Metrics by error category
  errorPatterns: {},

  // Structured failure signatures by error category (issue #2329): each entry
  // aggregates enriched telemetry — recent messageSnippet/failurePosition plus
  // the execution context (provider/model/tier) and latency of failures in that
  // category. Additive: older learning.json files predate this key and load fine.
  failureSignatures: {},

  // Routing accuracy: taskType → modelTier → { succeeded, failed }
  // Records which model tiers work/fail for each task type
  routingAccuracy: {},

  // Overall stats
  totals: {
    completed: 0,
    succeeded: 0,
    failed: 0,
    totalDurationMs: 0,
    avgDurationMs: 0
  }
};

// In-memory cache for learning data — avoids redundant disk reads during
// evaluation cycles where multiple functions read the same file.
let _learningCache = null;
let _learningCacheTime = 0;
const LEARNING_CACHE_TTL_MS = 5000;

/**
 * Clear the learning data cache. Exposed for testing.
 */
export function clearLearningCache() {
  _learningCache = null;
  _learningCacheTime = 0;
}

/**
 * Load learning data from file (cached for 5s)
 */
export async function loadLearningData() {
  if (_learningCache && (Date.now() - _learningCacheTime) < LEARNING_CACHE_TTL_MS) {
    return structuredClone(_learningCache);
  }

  await ensureDir(DATA_DIR);

  const data = await readJSONFile(LEARNING_FILE, structuredClone(DEFAULT_LEARNING_DATA));
  _learningCache = structuredClone(data);
  _learningCacheTime = Date.now();
  return data;
}

/**
 * Save learning data to file
 */
export async function saveLearningData(data) {
  data.lastUpdated = new Date().toISOString();

  // Prune task types with fewer than 2 completions and last seen > 30 days ago
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  if (data.byTaskType) {
    for (const [type, stats] of Object.entries(data.byTaskType)) {
      if ((stats.completed || 0) < 2 && stats.lastCompleted && new Date(stats.lastCompleted).getTime() < cutoff) {
        delete data.byTaskType[type];
      }
    }
  }

  await atomicWrite(LEARNING_FILE, data);
  _learningCache = structuredClone(data);
  _learningCacheTime = Date.now();
}

/**
 * Extract task type from task description or metadata
 */
export function extractTaskType(task) {
  // Check for self-improvement type in metadata (direct or forwarded from task)
  const analysisType = task?.metadata?.analysisType || task?.metadata?.taskAnalysisType;
  if (analysisType) {
    return `self-improve:${analysisType}`;
  }

  // Check for idle review
  const reviewType = task?.metadata?.reviewType || task?.metadata?.taskReviewType;
  if (reviewType === 'idle') {
    return 'idle-review';
  }

  // Check for mission tasks
  if (task?.metadata?.missionName) {
    return `mission:${task.metadata.missionName}`;
  }

  // Check for app improvement tasks
  if (task?.metadata?.taskApp && task?.metadata?.selfImprovementType) {
    return `app-improve:${task.metadata.selfImprovementType}`;
  }

  // Check description patterns
  const desc = (task?.description || '').toLowerCase();

  if (desc.includes('[self-improvement]')) {
    const typeMatch = desc.match(/\[self-improvement\]\s*([\w-]+)/i);
    if (typeMatch) return `self-improve:${typeMatch[1]}`;
    return 'self-improve:general';
  }

  if (desc.includes('[idle review]')) {
    return 'idle-review';
  }

  if (desc.includes('[auto-fix]') || desc.includes('[auto] investigate')) {
    return 'auto-fix';
  }

  if (desc.includes('[app-improvement]') || desc.includes('[app improvement]')) {
    return 'app-improvement';
  }

  // User task classification
  if (task?.taskType === 'user') {
    return 'user-task';
  }

  // Internal/system tasks that don't match a specific pattern
  if (task?.taskType === 'internal') {
    return 'internal-task';
  }

  return 'unknown';
}

/**
 * Load dismissed recommendations map: { [id]: { dismissedAt, snapshot } }
 */
export async function loadDismissedRecommendations() {
  await ensureDir(DATA_DIR);
  return await readJSONFile(DISMISSED_RECS_FILE, {});
}

export async function saveDismissedRecommendations(map) {
  await atomicWrite(DISMISSED_RECS_FILE, map);
}
