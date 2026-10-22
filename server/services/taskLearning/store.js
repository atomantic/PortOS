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
export { EXECUTION_EFFORT_NONE, executionKeyPrefix, executionKeyPrefixOf, executionDurationKey } from '../../lib/executionDurationKey.js';

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

// ---------------------------------------------------------------------------
// Execution-scoped duration buckets (issue #8001)
//
// `byTaskType` averages every run of a task type together, so the same
// `self-improve:release-check` on a slow local Ollama model and on a fast cloud
// model land in one bucket and the card's "N min remaining" is wrong for both.
// The provider/model/effort a run actually executed on is the largest single
// driver of its wall-clock time, so `byTaskTypeExecution` keys a second,
// duration-only aggregate by that concrete identity. It is a FLAT map under one
// composed key rather than a 4-level nest: cheaper to prune, iterate and cap.
//
// Duration only — no `recentOutcomes` ring. The LI success-rate signal keeps
// reading `byTaskType`; this dimension exists solely to sharpen the ETA.
// ---------------------------------------------------------------------------

// Ceiling on retained execution buckets. This dimension multiplies task types by
// every provider/model/effort the install has ever run, so the <2-completions/30-day
// prune `byTaskType` gets is not enough on its own — see `saveLearningData`.
export const EXECUTION_BUCKET_CAP = 200;

// ---------------------------------------------------------------------------
// Recent-outcomes ring (issue #2460)
//
// Lifetime `byTaskType` counters (completed/succeeded/failed/successRate) are
// cumulative and never decay, so a burst of since-resolved failures (a provider
// misconfig, PTY-capture artifacts on a now-retired task type) permanently
// depresses the success rate the Layered Intelligence reasoner reads via its
// `cosMetrics` source and keeps signaling "work needed" long after the root cause
// is fixed. To let that signal self-heal WITHOUT destroying the lifetime stats the
// dashboards display, each task-type bucket also carries a bounded ring of recent
// outcomes (`{ t: ISO timestamp, s: success bool }`). `computeWindowedStats`
// derives a recency-windowed success rate from it (bounded by BOTH count and age)
// that LI consumes instead of the lifetime rate. Mirrors the existing
// `failureSignatures.recent` / `recentUnknownErrors` rolling-buffer precedent.
// ---------------------------------------------------------------------------

// Cap on retained recent-outcome samples per task type (oldest pruned first).
export const RECENT_OUTCOMES_CAP = 50;

// Default recency window applied when reading the ring: at most this many
// most-recent runs AND no older than this age. Either bound alone can shrink the
// window; both are overridable per call.
export const DEFAULT_WINDOW_MAX_COUNT = 30;
export const DEFAULT_WINDOW_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Append a recent outcome to a task-type metrics bucket's bounded ring (issue
 * #2460). Mutates `metrics` in place and returns it for chaining. Stores the compact `{ t, s }`
 * shape (ISO timestamp + success bool), plus `d` (duration ms) when a finite
 * duration was measured — omitted when unknown so a pre-duration sample and a
 * duration-less new sample stay the same shape (absent ≠ 0). Tolerates a bucket
 * that predates the ring (older learning.json before migration 188) by
 * initializing it. Enforces `RECENT_OUTCOMES_CAP`, dropping the oldest sample first.
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
 * Compute recency-windowed success stats from a task-type recent-outcomes ring
 * (issue #2460). Pure / no I/O. Windows the ring by BOTH a max sample count and a
 * max age, then computes the success rate over just that window.
 *
 * Sentinel discipline (repo "absent vs empty" rule): `windowedSuccessRate` is
 * `null` when the window contains NO samples — never 0 — so a task type with no
 * recent runs is distinguishable from one that recently failed everything. LI
 * falls back to the lifetime rate on null rather than reading a fabricated 0%.
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
 * Effective success rate for DECISION paths (issue #2617). Pure / no I/O.
 *
 * Lifetime `successRate` never decays, so a burst of since-fixed failures
 * permanently depresses it — cooldown/skip/approval decisions built on it keep
 * punishing a task type long after it recovered. This returns the recency-
 * windowed rate (`computeWindowedStats` over the bucket's `recentOutcomes`
 * ring) whenever the window holds at least `minWindowSamples` outcomes, and
 * falls back to the lifetime rate otherwise — so a type with a thin/empty
 * window behaves exactly as before, while a type with a healthy recent record
 * recovers as soon as it starts succeeding again.
 *
 * Sentinel discipline: `successRate` is `null` (never a fabricated 0) when the
 * fallback lifetime rate is itself absent. `source` names which rate was used
 * (`'windowed'` | `'lifetime'`) so decisions can surface it in reasons/logs.
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
 * Shared skip predicate (issue #2617): a task type is a skip candidate when it
 * has ≥5 lifetime completions AND its EFFECTIVE success rate is <30%. Pure.
 *
 * This is THE definition of "skipped" — used by the scheduling decision
 * (`getAdaptiveCooldownMultiplier`'s skip branch mirrors it), the skip list
 * (`getSkippedTaskTypes`), the rehabilitation/status views, AND the health
 * summaries (`getPerformanceSummary`, `getLearningSummary`). Keeping every
 * consumer on one predicate is what stops a dashboard/alert surface from
 * claiming a type is skipped after the actual decision path stopped skipping
 * it (or vice versa).
 */
export function isSkipCandidate(metrics) {
  if (!metrics || (metrics.completed ?? 0) < 5) return false;
  const { successRate } = computeEffectiveSuccessRate(metrics);
  return successRate !== null && successRate < 30;
}

/**
 * Default learning data structure
 */
// Environmental/infrastructure error categories (issue #2618): failures that say
// nothing about the task or the model — a provider outage, an exhausted quota, a
// revoked key, a dead network, an agent that never started. These are EXCLUDED
// from the success-rate aggregates (`byTaskType` / `byModelTier` /
// `routingAccuracy` / `totals` / the `recentOutcomes` windowed ring / the
// correlation window) so an hour of provider 529s can't crater a task type's
// rate, steer routing off a healthy tier, or trip the <30% skip gate. They are
// instead counted in `data.environmentalFailures[category]` (count +
// lastOccurred + affected task types) so the events stay visible, and they STILL
// feed `errorPatterns` / `failureSignatures` — prompt recommendations and
// diagnostics appropriately consume those.
//
// Covers BOTH classifier vocabularies that can stamp `errorAnalysis.category`:
// agentErrorAnalysis's ERROR_PATTERNS (`rate-limit`, `usage-limit`, `auth-error`,
// `forbidden`, `billing-error`, `network-error`, `claude-error` —
// `overloaded_error`, `startup-failure`, `model-not-found`,
// `model-not-supported`) and agentRunTracking's extractErrorFromOutput (`auth`,
// `connection`, `rate-limit`). `model-not-available` is the legacy naming for
// the model-unavailability class (still present in stored learning data /
// prompt insights).
//
// Deliberately EXCLUDES `timeout`, `unknown`, `process-killed`, and the generic
// `api-error`: each can be genuine task/model signal (a task too big for its
// tier times out or blows resource limits; an uncategorized or generic API
// failure may be anything, including a task-induced bad request). Also EXCLUDES
// the mixed-provenance categories `server-error` and `spawn-error`: their
// classifier regexes (`/server error|internal error/`, `command not found`)
// match ordinary task output too — a genuinely failing app test printing
// "Internal Server Error" must keep denting the rate, not vanish as an
// "outage". Superset of agentErrorAnalysis's `API_ACCESS_ERROR_CATEGORIES`
// (auth-error / forbidden / usage-limit — asserted by a cross-check test in
// agentErrorAnalysis.test.js) but defined here as its own leaf constant:
// importing agentErrorAnalysis.js would drag the cos.js task-store graph into
// every taskLearning consumer and suite.
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

  // Strict (#4115): every mutation is `loadLearningData → mutate →
  // saveLearningData`, so a swallowed unreadable file hands the caller a fresh
  // DEFAULT_LEARNING_DATA and the next save atomicWrites it over the whole
  // routing/outcome history. It also feeds the CoS learning counts. Throwing
  // skips the cycle and leaves the file intact.
  const data = await readJSONFile(LEARNING_FILE, structuredClone(DEFAULT_LEARNING_DATA), { strict: true });
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
  _learningCache = structuredClone(data);
  _learningCacheTime = Date.now();
  cosEvents.emit('goals:changed', {});
  cosEvents.emit('learning:changed');
}


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

// ---------------------------------------------------------------------------
// Human-readable insights (issue #2443)
//
// The insights array is the ONE prose channel in the learning store: standing
// "operating notes" the user reads in the CoS UI. It is runtime data in
// `data/cos/learning.json` — never committed to git and never federated — so
// auto-recorded insight text must stay free of hostnames/paths/PII (build it
// only from controlled labels: error category, counts, task type, provider/model
// ids, agent id — never the raw error message, which can embed a path).
// ---------------------------------------------------------------------------

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
 * Append an insight to `data.insights`, stamping `recordedAt` and defaulting
 * `origin` to `'user'` (a manual API insight) unless the caller marks it
 * `'auto-incident'`. Pure over `data` (mutates + returns it); enforces the
 * `INSIGHT_CAP` (oldest pruned). Shared by the manual route (`recordLearningInsight`)
 * and the failure-path auto-recorder so both stay in one shape.
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
 * Build a provenance-stamped, privacy-safe insight for a recurring failure
 * category (issue #2443). Pure — no I/O. Uses only controlled fields (category
 * label, recurrence count, task type, provider/model ids, agent id); it reads
 * the enriched `failureSignatures` map for provider/model attribution but never
 * echoes the raw error message (which can embed a path/PII). `origin` is
 * `'auto-incident'` so the UI can distinguish it from user-authored notes.
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
