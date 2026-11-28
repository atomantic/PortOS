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
import { cosEvents, emitLog } from '../cos/cosEvents.js';
import { ensureDir, readJSONFile, PATHS, atomicWrite, tryReadFile } from '../../lib/fileUtils.js';
import { createMutex } from '../../lib/asyncMutex.js';
import { EXTERNAL_UNTYPED_TASK_TYPE, isSandboxedTaskType, classifyUntypedTask, extractTaskType } from '../../lib/taskTypeBucket.js';

export { EXTERNAL_UNTYPED_TASK_TYPE, isSandboxedTaskType, classifyUntypedTask, extractTaskType };

export const withLock = createMutex();

const DATA_DIR = PATHS.cos;
const LEARNING_FILE = join(DATA_DIR, 'learning.json');
export const AGENTS_DIR = join(DATA_DIR, 'agents'); // consumed by metrics.js
const DISMISSED_RECS_FILE = join(DATA_DIR, 'dismissed-recommendations.json');

// Re-export the infra that sibling modules consume so they import from one
// place. (ensureDir / readJSONFile / atomicWrite stay internal to this file.)
export { cosEvents, emitLog, tryReadFile };
export { executionKeyPrefix, executionKeyPrefixOf, executionDurationKey } from '../../lib/executionDurationKey.js';

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

// Execution-scoped duration buckets (#8001): `byTaskType` blends slow local and fast
// cloud runs and skews ETAs, so `byTaskTypeExecution` keys a duration-only aggregate
// by provider/model/effort. FLAT map under one composed key (cheaper to prune, iterate
// and cap than a nest). The LI success-rate signal keeps reading `byTaskType`.

// Ceiling on retained execution buckets. This dimension multiplies task types by
// every provider/model/effort the install has ever run, so the <2-completions/30-day
// prune `byTaskType` gets is not enough on its own — see `saveLearningData`.
export const EXECUTION_BUCKET_CAP = 200;

// Recent-outcomes ring (#2460): lifetime `byTaskType` counters never decay, so
// since-resolved failures would depress the success rate LI reads indefinitely. Each
// bucket also keeps a bounded ring `{ t: ISO, s: success }`; `computeWindowedStats`
// derives a rate bounded by BOTH count and age, leaving dashboard lifetime stats intact.

// Cap on retained recent-outcome samples per task type (oldest pruned first).
export const RECENT_OUTCOMES_CAP = 50;

// Default recency window applied when reading the ring: at most this many
// most-recent runs AND no older than this age. Either bound alone can shrink the
// window; both are overridable per call.
export const DEFAULT_WINDOW_MAX_COUNT = 30;
export const DEFAULT_WINDOW_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Append `{ t, s }` (plus `d` duration ms when finite; omitted when unknown so absent
 * != 0) to a bucket's bounded ring. Mutates and returns `metrics`; initializes the
 * ring on pre-migration-188 buckets and drops the oldest past `RECENT_OUTCOMES_CAP`.
 */
export function appendRecentOutcome(metrics, { success, at, durationMs } = {}) {
  if (!metrics || typeof metrics !== 'object') return metrics;
  if (!Array.isArray(metrics.recentOutcomes)) metrics.recentOutcomes = [];
  const sample = { t: at || new Date().toISOString(), s: !!success };
  // Only a finite, non-negative duration is a measurement. `|| 0` would collapse
  // "not recorded" into "instant", which is exactly the sentinel the churn
  // detector must not trip on for pre-instrumentation history.
  if (Number.isFinite(durationMs) && durationMs >= 0) sample.d = durationMs;
  metrics.recentOutcomes.push(sample);
  if (metrics.recentOutcomes.length > RECENT_OUTCOMES_CAP) {
    metrics.recentOutcomes = metrics.recentOutcomes.slice(-RECENT_OUTCOMES_CAP);
  }
  return metrics;
}

/**
 * Recency-windowed success stats from a recent-outcomes ring (#2460), windowed by max
 * count AND max age. Pure. `windowedSuccessRate` is `null` (never 0) for an empty
 * window so LI falls back to the lifetime rate instead of a fabricated 0%.
 *
 * @param {Array<{t:string,s:boolean}>} recentOutcomes - the bucket's ring
 * @param {{ maxCount?:number, maxAgeMs?:number, now?:number }} [opts]
 * @returns {{ windowedCompleted:number, windowedSucceeded:number,
 *   windowedFailed:number, windowedSuccessRate:number|null }}
 */
export function computeWindowedStats(recentOutcomes, {
  maxCount = DEFAULT_WINDOW_MAX_COUNT,
  maxAgeMs = DEFAULT_WINDOW_MAX_AGE_MS,
  now = Date.now()
} = {}) {
  const ring = Array.isArray(recentOutcomes) ? recentOutcomes : [];
  const ageCutoff = Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? now - maxAgeMs : null;

  // Age-filter first (drop stale outcomes), then keep only the most-recent
  // `maxCount`. An undated sample (unparseable `t`) is kept — the count bound
  // still applies, so a hand-edited ring can't grow the window unbounded.
  const withinAge = ageCutoff === null
    ? ring
    : ring.filter((o) => {
        const t = Date.parse(o?.t);
        return Number.isFinite(t) ? t >= ageCutoff : true;
      });
  const windowed = Number.isFinite(maxCount) && maxCount > 0
    ? withinAge.slice(-maxCount)
    : withinAge;

  const windowedCompleted = windowed.length;
  const windowedSucceeded = windowed.reduce((n, o) => n + (o?.s ? 1 : 0), 0);
  const windowedFailed = windowedCompleted - windowedSucceeded;
  const windowedSuccessRate = windowedCompleted > 0
    ? Math.round((windowedSucceeded / windowedCompleted) * 100)
    : null;

  return { windowedCompleted, windowedSucceeded, windowedFailed, windowedSuccessRate };
}

// Minimum windowed outcomes before the windowed rate is trusted over the
// lifetime rate (issue #2617). Below this bar the window is too thin to read a
// trend from, so decisions keep today's lifetime behavior (cold-start parity).
export const EFFECTIVE_RATE_MIN_WINDOW_SAMPLES = 5;

/**
 * Effective success rate for DECISION paths (#2617). Pure. The never-decaying
 * lifetime rate keeps punishing recovered types, so this returns the windowed rate
 * once the window holds `minWindowSamples` outcomes, else the lifetime rate.
 * `successRate` is `null` when the fallback is absent; `source` names the one used.
 *
 * @param {Object|null|undefined} metrics - a `byTaskType` bucket
 * @param {{ minWindowSamples?:number, maxCount?:number, maxAgeMs?:number, now?:number }} [opts]
 *   - extra keys are forwarded to `computeWindowedStats` (window bounds/clock seam)
 * @returns {{ successRate:number|null, source:'windowed'|'lifetime', windowedCompleted:number }}
 */
export function computeEffectiveSuccessRate(metrics, opts = {}) {
  const { minWindowSamples = EFFECTIVE_RATE_MIN_WINDOW_SAMPLES } = opts;
  const { windowedCompleted, windowedSuccessRate } = computeWindowedStats(metrics?.recentOutcomes, opts);
  if (windowedSuccessRate !== null && windowedCompleted >= minWindowSamples) {
    return { successRate: windowedSuccessRate, source: 'windowed', windowedCompleted };
  }
  return { successRate: metrics?.successRate ?? null, source: 'lifetime', windowedCompleted };
}

/**
 * Shared skip predicate (#2617): >=5 lifetime completions AND EFFECTIVE success rate
 * <30%. Pure. The single definition of "skipped" for scheduling, skip list and health
 * views, so no surface disagrees with the decision path.
 */
export function isSkipCandidate(metrics) {
  if (!metrics || (metrics.completed ?? 0) < 5) return false;
  const { successRate } = computeEffectiveSuccessRate(metrics);
  return successRate !== null && successRate < 30;
}

// Environmental/infrastructure failure categories (#2618): outage, exhausted quota,
// revoked key, dead network, agent never started. They say nothing about the task or
// model, so they are EXCLUDED from every success-rate aggregate (byTaskType,
// byModelTier, routingAccuracy, totals, recentOutcomes, correlation window) and counted
// in `data.environmentalFailures`; they still feed errorPatterns / failureSignatures.
//
// Covers both classifier vocabularies that stamp `errorAnalysis.category`
// (agentErrorAnalysis ERROR_PATTERNS, agentRunTracking extractErrorFromOutput);
// `model-not-available` is the legacy name kept for stored data.
//
// Deliberately EXCLUDES `timeout`, `unknown`, `process-killed`, `api-error` (can be real
// task/model signal) and `server-error` / `spawn-error` (their regexes match ordinary
// task output, e.g. a failing test printing "Internal Server Error").
// A superset of agentErrorAnalysis's `API_ACCESS_ERROR_CATEGORIES` (cross-checked in
// agentErrorAnalysis.test.js), defined as a local leaf: importing it would drag the
// cos.js task-store graph into every taskLearning consumer.
export const ENVIRONMENTAL_ERROR_CATEGORIES = new Set([
  'rate-limit',
  'usage-limit',
  'auth-error',
  'auth',
  'forbidden',
  'billing-error',
  'connection',
  'network-error',
  // #3358: a PR-shaped run finalized while `gh` could not reach the forge. The
  // run itself may have been perfect — we simply could not confirm its PR — so
  // it must not dent the type's success rate the way `pr-missing` (the agent's
  // own miss, deliberately NOT listed here) should.
  'forge-unreachable',
  'claude-error',
  'startup-failure',
  'model-not-available',
  'model-not-found',
  'model-not-supported',
  // The provider CLI never started — its config file was invalid. Nothing about
  // the task itself failed, so it must not dent the task type's success rate.
  'cli-config-invalid'
]);

const DEFAULT_LEARNING_DATA = {
  // v2 (issue #2460): each byTaskType bucket carries a bounded `recentOutcomes`
  // ring so the signal LI reads can be recency-windowed (see appendRecentOutcome
  // / computeWindowedStats below). Migration 188 initializes the ring on existing
  // installs; fresh installs seed at v2.
  version: 2,
  lastUpdated: null,

  // Metrics by self-improvement task type
  byTaskType: {},

  // Duration-only metrics by task type × the concrete execution identity the run
  // used (issue #8001) — a flat map keyed by `executionDurationKey`. Additive:
  // older learning.json files predate this key and load fine; the recording path
  // initializes it on first use, exactly as `failureSignatures` /
  // `environmentalFailures` / `correlationWindow` did. Bounded by the prune +
  // EXECUTION_BUCKET_CAP sweep in `saveLearningData`.
  byTaskTypeExecution: {},

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

  // Environmental/infrastructure failures (issue #2618): category →
  // { count, lastOccurred, taskTypes } for rate-limit/auth/billing/startup-class
  // failures, which are kept OUT of every success-rate aggregate above so an
  // outage can't poison routing/skip decisions (see ENVIRONMENTAL_ERROR_CATEGORIES
  // in metrics.js). Additive: older learning.json files predate this key and load
  // fine — the recording path initializes it on first use.
  environmentalFailures: {},

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
let _learningCacheGeneration = 0;
const LEARNING_CACHE_TTL_MS = 5000;

/**
 * Clear the learning data cache. Exposed for testing.
 */
export function clearLearningCache() {
  _learningCacheGeneration += 1;
  _learningCache = null;
  _learningCacheTime = 0;
}

/** Hold learning mutations through live backup transfer and cache reconciliation. */
export const withLiveRestore = (restore) => withLock(() => restore(clearLearningCache));

/**
 * Load learning data from file (cached for 5s)
 */
export async function loadLearningData() {
  if (_learningCache && (Date.now() - _learningCacheTime) < LEARNING_CACHE_TTL_MS) {
    return structuredClone(_learningCache);
  }

  const generation = _learningCacheGeneration;
  await ensureDir(DATA_DIR);

  // Strict (#4115): every mutation is `loadLearningData → mutate →
  // saveLearningData`, so a swallowed unreadable file hands the caller a fresh
  // DEFAULT_LEARNING_DATA and the next save atomicWrites it over the whole
  // routing/outcome history. It also feeds the CoS learning counts. Throwing
  // skips the cycle and leaves the file intact.
  const data = await readJSONFile(LEARNING_FILE, structuredClone(DEFAULT_LEARNING_DATA), { strict: true });
  if (generation !== _learningCacheGeneration) return loadLearningData();
  _learningCache = structuredClone(data);
  _learningCacheTime = Date.now();
  return data;
}

// Ledger of agent ids already folded into the aggregates (#13095). Both the live
// `agent:completed` listener and `backfillFromHistory` feed `recordTaskCompletion`,
// so the ledger lives beside the metrics it protects and is checked under the same
// lock. Bounded FIFO: ids are short, and the newest runs are the ones a repeated
// backfill or a replayed completion can plausibly re-present.
export const COUNTED_AGENT_IDS_CAP = 10000;

export function hasCountedAgent(data, agentId) {
  return !!agentId && Array.isArray(data.countedAgentIds) && data.countedAgentIds.includes(agentId);
}

export function markAgentCounted(data, agentId) {
  if (!agentId) return;
  if (!Array.isArray(data.countedAgentIds)) data.countedAgentIds = [];
  data.countedAgentIds.push(agentId);
  if (data.countedAgentIds.length > COUNTED_AGENT_IDS_CAP) {
    data.countedAgentIds = data.countedAgentIds.slice(-COUNTED_AGENT_IDS_CAP);
  }
}

/**
 * Save learning data to file
 */
export async function saveLearningData(data) {
  data.lastUpdated = new Date().toISOString();

  // Prune task types with fewer than 2 completions and last seen > 30 days ago
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const isStaleThinBucket = (stats) =>
    (stats?.completed || 0) < 2 && stats?.lastCompleted && new Date(stats.lastCompleted).getTime() < cutoff;
  if (data.byTaskType) {
    for (const [type, stats] of Object.entries(data.byTaskType)) {
      if (isStaleThinBucket(stats)) delete data.byTaskType[type];
    }
  }

  // Same prune for the execution dimension (issue #8001), plus a hard cap: this
  // map is task types MULTIPLIED by every provider/model/effort the install has
  // run, so the thin/stale sweep alone can't bound it — a long-lived install that
  // keeps switching models would accumulate a bucket per combination forever.
  // Over the cap, the least-recently-completed buckets go first: they are the ones
  // whose estimate is least likely to describe how the install runs today.
  if (data.byTaskTypeExecution) {
    for (const [key, stats] of Object.entries(data.byTaskTypeExecution)) {
      if (isStaleThinBucket(stats)) delete data.byTaskTypeExecution[key];
    }
    const keys = Object.keys(data.byTaskTypeExecution);
    if (keys.length > EXECUTION_BUCKET_CAP) {
      // An undated bucket sorts oldest (0) — it carries no evidence of recency,
      // so it is the first thing to give up when the map is over budget.
      const byRecency = keys.sort((a, b) => (
        (Date.parse(data.byTaskTypeExecution[a]?.lastCompleted) || 0)
        - (Date.parse(data.byTaskTypeExecution[b]?.lastCompleted) || 0)
      ));
      for (const key of byRecency.slice(0, keys.length - EXECUTION_BUCKET_CAP)) {
        delete data.byTaskTypeExecution[key];
      }
    }
  }

  await atomicWrite(LEARNING_FILE, data);
  _learningCacheGeneration += 1;
  _learningCache = structuredClone(data);
  _learningCacheTime = Date.now();
  cosEvents.emit('goals:changed', {});
  cosEvents.emit('learning:changed');
}

/**
 * Summarize `failureSignatures` (#2329/#2333) into a ranked, display-ready list with
 * provider/model attribution and validation-miss counts the coarser `errorPatterns`
 * can't express. Pure. With `taskType`, only that type's samples count (categories
 * with none are dropped), so a recommendation never inherits another type's failures.
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

// Human-readable insights (#2443): the ONE prose channel in the learning store, runtime
// data in `data/cos/learning.json` (never committed or federated). Auto-recorded text
// must come only from controlled labels (category, counts, task type, provider/model
// ids, agent id), never the raw error message, which can embed paths/PII.

// Cap on retained insights (oldest pruned first). Matches the pre-existing cap
// that `recordLearningInsight` enforced before it was factored out here.
export const INSIGHT_CAP = 50;

// Recurrence counts (of a single error category) at which the failure path
// auto-records a standing insight. Exact-equality matching over these ascending
// milestones makes recording idempotent — the per-category count only increments
// by one per categorized failure, so each milestone fires exactly once and then
// escalates, rather than spamming an insight on every subsequent failure.
export const RECURRENCE_INSIGHT_MILESTONES = [3, 10, 25, 50, 100];

/** True when a category's post-increment recurrence count lands on a milestone. */
export function recurrenceMilestoneReached(count) {
  return RECURRENCE_INSIGHT_MILESTONES.includes(count);
}

/**
 * Append an insight to `data.insights`, stamping `recordedAt` and defaulting `origin`
 * to `'user'` (`'auto-incident'` for the failure-path recorder). Mutates and returns
 * `data`; enforces `INSIGHT_CAP` (oldest pruned).
 */
export function appendInsight(data, insight) {
  if (!Array.isArray(data.insights)) data.insights = [];
  data.insights.push({ origin: 'user', ...insight, recordedAt: new Date().toISOString() });
  if (data.insights.length > INSIGHT_CAP) {
    data.insights = data.insights.slice(-INSIGHT_CAP);
  }
  return data;
}

/**
 * Build a privacy-safe insight for a recurring failure category (#2443). Pure. Uses
 * only controlled fields and never echoes the raw error message (can embed paths/PII);
 * `origin: 'auto-incident'` distinguishes it from user-authored notes.
 */
export function buildRecurrenceInsight({ category, count, taskType, agentId = null, failureSignatures = {} } = {}) {
  const summary = summarizeFailureSignatures(failureSignatures, { taskType })
    .find((s) => s.category === category);
  const topProvider = summary?.providers?.[0]?.key || null;
  const via = topProvider ? `, most recently via ${topProvider}` : '';
  const message = `Recurring failure: "${category}" errors have occurred ${count} times for ${taskType} tasks${via}. Auto-flagged at ${count} occurrences — investigate the root cause or route this task type away from the failing path.`;

  return {
    type: 'recurring-failure',
    origin: 'auto-incident',
    category,
    taskType,
    recurrenceCount: count,
    provider: topProvider,
    originatingAgentId: agentId,
    message
  };
}

/**
 * Load dismissed recommendations map: { [id]: { dismissedAt, snapshot } }
 */
export async function loadDismissedRecommendations() {
  await ensureDir(DATA_DIR);
  // Strict (#4115): `dismissRecommendation` / `restoreRecommendation` load this
  // map, mutate one key, and write the whole thing back — an unreadable file
  // would silently un-dismiss every recommendation on the next dismissal.
  return await readJSONFile(DISMISSED_RECS_FILE, {}, { strict: true });
}

export async function saveDismissedRecommendations(map) {
  await atomicWrite(DISMISSED_RECS_FILE, map);
}
