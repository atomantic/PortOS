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

  // Rolling correlation-quality window (issue #2344): prediction/outcome pairs
  // measuring how well the enriched failure signals predict actual outcomes.
  // Gates auto-adjustment aggressiveness (see correlationQuality.js). Additive:
  // older learning.json files predate this key and load fine.
  correlationWindow: [],

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
 * Sandboxed fallback type for executions the classifier can't map to a known
 * domain (issue #2333). Replaces the old blind `'unknown'` sink so untyped work
 * still flows through outcome learning + failure-signature harvesting, while
 * being explicitly walled off from routing influence (see `isSandboxedTaskType`
 * consumers in routing.js) — a heterogeneous grab-bag must never drive a tier
 * suggestion or globally skip all untyped work (which would create a routing
 * blind spot / loop).
 */
export const EXTERNAL_UNTYPED_TASK_TYPE = 'external/untyped';

// The new sandboxed fallback plus the legacy `'unknown'` sink it replaces. Older
// installs still hold `'unknown'` buckets from before the classifier (and the
// spawn-time key in agentModelSelection.js) migrated onto the sandboxed bucket, so
// it keeps the same wall: stale/heterogeneous uncategorized data must never drive a
// tier suggestion or globally skip work.
const SANDBOXED_TASK_TYPES = new Set([EXTERNAL_UNTYPED_TASK_TYPE, 'unknown']);

/**
 * True when a task type is a sandboxed fallback bucket (not a real learned
 * domain). Callers in routing.js gate on this to keep the fallback from
 * influencing model-tier suggestions or skip/rehabilitation gating.
 */
export const isSandboxedTaskType = (taskType) => SANDBOXED_TASK_TYPES.has(taskType);

/**
 * Summarize the enriched `failureSignatures` map (issues #2329/#2333) into a
 * ranked, display-ready list. Reads each category's `recent[]` samples to add
 * provider/model attribution and success-criteria (validation) miss counts that
 * the coarser `errorPatterns` aggregate can't express — so the self-improvement
 * loop (insights + prompt recommendations) can say WHICH provider/model recently
 * failed for a task type, not just how often a category occurred.
 *
 * Pure / read-only. When `taskType` is given, only samples recorded for that
 * task type count (and categories with no matching sample are dropped) so a
 * per-type recommendation never inherits another type's failures.
 *
 * @param {Object} failureSignatures - `data.failureSignatures`: `{ [category]: { count, lastOccurred, recent: [] } }`
 * @param {Object} [opts]
 * @param {string|null} [opts.taskType] - restrict samples to this task type
 * @param {number} [opts.limit] - max categories returned (ranked by count desc)
 * @returns {Array<{category, count, samples, lastOccurred, providers, validationMissed, sampleSnippet}>}
 */
export function summarizeFailureSignatures(failureSignatures, { taskType = null, limit = 5 } = {}) {
  const map = failureSignatures && typeof failureSignatures === 'object' ? failureSignatures : {};
  const summaries = [];

  for (const [category, bucket] of Object.entries(map)) {
    const recent = Array.isArray(bucket?.recent) ? bucket.recent : [];
    const matched = taskType ? recent.filter((s) => s?.taskType === taskType) : recent;
    // Task-type-scoped view drops categories with no sample for that type.
    if (taskType && matched.length === 0) continue;

    const attribution = new Map();
    let validationMissed = 0;
    for (const s of matched) {
      const key = s?.provider
        ? `${s.provider}${s.model ? `/${s.model}` : ''}`
        : (s?.modelTier || 'unknown');
      attribution.set(key, (attribution.get(key) || 0) + 1);
      // Explicit === false so an absent/undefined criterion (null) isn't a miss.
      if (s?.validationPassed === false) validationMissed++;
    }

    const providers = [...attribution.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count);
    const latest = matched.length ? matched[matched.length - 1] : null;

    summaries.push({
      category,
      // Per-type count reflects the matched samples; the global view prefers the
      // lifetime `count` (recent[] is capped) and falls back to the sample size.
      count: taskType ? matched.length : (Number(bucket?.count) || matched.length),
      samples: matched.length,
      lastOccurred: bucket?.lastOccurred || latest?.recordedAt || null,
      providers,
      validationMissed,
      sampleSnippet: latest?.messageSnippet || null
    });
  }

  return summaries.sort((a, b) => b.count - a.count).slice(0, Math.max(0, limit));
}

/**
 * Ordered description-keyword → concrete-type rules, tried only as a last resort
 * before the sandboxed fallback. First match wins. Patterns are whole-word/stem
 * tests (`\b…`) so a substring can't false-positive (e.g. "testing" ⊄ trigger of
 * an unrelated word). Kept deliberately conservative — a wrong concrete label is
 * worse than an honest `external/untyped`.
 */
const DESCRIPTION_CLASSIFIERS = [
  { type: 'auto-fix', re: /\b(fix|bug|crash|broken|failing|regression|investigate|stack ?trace)\b/ },
  { type: 'self-improve:general', re: /\b(refactor|clean ?up|simplif\w*|optimi[sz]\w*|improve|enhance)\b/ },
  { type: 'idle-review', re: /\b(review|audit|inspect)\b/ },
  { type: 'test-task', re: /\b(unit test|coverage|test suite|write tests?)\b/ }
];

/**
 * Concrete `task.taskType` values (beyond user/internal, resolved upstream) that
 * map to a real learned domain. Allow-listed rather than accepting any string so
 * an unexpected/high-cardinality taskType can't spawn a swarm of non-sandboxed
 * singleton buckets that skew routing — anything not here falls through to the
 * description heuristics and, failing that, the sandboxed fallback.
 */
const KNOWN_UNSPECIALIZED_TASK_TYPES = new Set([
  'scheduled', 'test', 'architect', 'layered-intelligence', 'all'
]);

/** Normalize a raw task-type token to a stable, low-cardinality slug. */
function slugTaskType(raw) {
  return String(raw).trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Classify a task that the primary `extractTaskType` heuristics left untyped
 * (issue #2333). Pure, deterministic (idempotent — same input → same output),
 * and side-effect free / O(1) over a few short regexes, so it stays well under
 * the <50ms execution-entry budget. Inspects additional signals in priority
 * order — a self-improvement metadata hint, an explicit `task.taskType` the
 * primary extractor didn't special-case, then broader description keyword
 * signatures — and only falls back to the sandboxed `external/untyped` type
 * (never the old `'unknown'`) when nothing matches.
 */
export function classifyUntypedTask(task) {
  if (!task || typeof task !== 'object') return EXTERNAL_UNTYPED_TASK_TYPE;

  // Round-trip safety: re-classifying an already-classified task by its own
  // recorded type must be stable and preserve the sandboxed bucket (the fallback
  // string's `/` would otherwise be slugged to a non-sandboxed `-task` below).
  if (isSandboxedTaskType(task?.taskType)) return task.taskType;

  // 1) A self-improvement hint not paired with a taskApp (that pairing is
  //    handled by the primary extractor upstream).
  const selfImprovementType = task?.metadata?.selfImprovementType;
  if (typeof selfImprovementType === 'string' && selfImprovementType.trim()) {
    return `self-improve:${slugTaskType(selfImprovementType)}`;
  }

  // 2) An explicit task.taskType the primary extractor didn't special-case
  //    (user/internal are resolved upstream). Map an already-namespaced type
  //    (`a:b`) or an allow-listed known domain to a concrete bucket; anything
  //    else falls through so an unexpected value can't skew routing.
  const explicit = task?.taskType;
  if (typeof explicit === 'string' && explicit.trim() && explicit !== 'unknown') {
    const slug = slugTaskType(explicit);
    if (slug.includes(':')) return slug;
    if (KNOWN_UNSPECIALIZED_TASK_TYPES.has(slug)) return `${slug}-task`;
  }

  // 3) Broader description keyword signatures (bracket-tag patterns already ran
  //    upstream; this catches free-form descriptions).
  const desc = (task?.description || task?.metadata?.taskDescription || '').toLowerCase();
  if (desc) {
    for (const { type, re } of DESCRIPTION_CLASSIFIERS) {
      if (re.test(desc)) return type;
    }
  }

  // 4) Nothing matched — sandboxed fallback (never 'unknown').
  return EXTERNAL_UNTYPED_TASK_TYPE;
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

  // Execution-entry classification hook (issue #2333): before giving up to the
  // old blind 'unknown' sink, inspect additional signals to infer a concrete
  // domain, else return the sandboxed `external/untyped` fallback.
  return classifyUntypedTask(task);
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
