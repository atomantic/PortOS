/**
 * Task Learning — metrics aggregation
 *
 * Records completed tasks into the learning store and rebuilds derived
 * aggregates (per-tier metrics, success-only duration stats) from the
 * authoritative sources. This is the "write" side of the learning data:
 * everything here mutates and persists `learning.json`.
 */

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  withLock,
  AGENTS_DIR,
  emitLog,
  tryReadFile,
  calculateDurationETA,
  extractTaskType,
  loadLearningData,
  saveLearningData,
  appendInsight,
  buildRecurrenceInsight,
  recurrenceMilestoneReached,
  appendRecentOutcome,
  computeWindowedStats,
  DEFAULT_WINDOW_MAX_COUNT,
  DEFAULT_WINDOW_MAX_AGE_MS,
  ENVIRONMENTAL_ERROR_CATEGORIES
} from './store.js';
import { deriveFailureSignalAvoidance, isNonRoutableLearnedTier } from './routing.js';
import { recordCorrelationSample } from './correlationQuality.js';

// Cap on retained per-category signature samples — bounds file growth the same
// way `recentUnknownErrors` does, while keeping enough recent context to spot
// trends (provider/model/tier correlation) without a full agent-archive scan.
const MAX_SIGNATURE_SAMPLES = 10;

// ENVIRONMENTAL_ERROR_CATEGORIES lives in store.js (the leaf module) so both
// this recorder and routing.js can consume it without deepening the existing
// metrics⇄routing import cycle; re-exported here for back-compat.
export { ENVIRONMENTAL_ERROR_CATEGORIES };


/**
 * Record an environmental failure into `data.environmentalFailures` (issue
 * #2618). Pure — mutates and returns `data`. Mirrors the `errorPatterns` bucket
 * shape (count + lastOccurred + per-task-type counts) so the UI can render both
 * the same way. Additive + back-compat: tolerates a learning.json that predates
 * the `environmentalFailures` key. No-op when the failure carries no category.
 */
export function recordEnvironmentalFailure(data, { category, taskType } = {}) {
  if (!category) return data;
  if (!data.environmentalFailures) data.environmentalFailures = {};
  if (!data.environmentalFailures[category]) {
    data.environmentalFailures[category] = { count: 0, lastOccurred: null, taskTypes: {} };
  }
  const bucket = data.environmentalFailures[category];
  bucket.count++;
  bucket.lastOccurred = new Date().toISOString();
  bucket.taskTypes[taskType] = (bucket.taskTypes[taskType] || 0) + 1;
  return data;
}

/**
 * Decide whether a failed run should be diverted to `environmentalFailures`
 * instead of counting against the learning aggregates (issues #2618, #2642).
 * Pure. Two gates, both required:
 *
 *   1. Category gate (#2618) — `category` is in ENVIRONMENTAL_ERROR_CATEGORIES.
 *   2. Provenance gate (#2642) — only an allowlisted provenance authorizes the
 *      diversion. Structured provider/runner signals (`origin: 'provider'|
 *      'runner'`) and records with NO origin marker (older runs / federated
 *      peers — back-compat, category-only as before) divert. Everything else —
 *      `'output-scan'` (a false positive: ordinary task output tripping a loose
 *      pattern, e.g. a failing test whose tail prints "rate limit") OR an
 *      unrecognized/future/malformed marker — is NOT diverted and counts as a
 *      genuine failure. Allowlist (not `!== 'output-scan'`) so an unknown origin
 *      can never silently exclude a real failure from the aggregates.
 *
 * @param {boolean} outcomeSuccess validation-authoritative outcome (#2344)
 * @param {string|null} category failure category
 * @param {string|null|undefined} origin provenance marker ('provider'|'runner'|'output-scan'|null)
 */
const DIVERTIBLE_ORIGINS = new Set(['provider', 'runner']);
export function shouldDivertToEnvironmental(outcomeSuccess, category, origin) {
  if (outcomeSuccess) return false;
  if (!ENVIRONMENTAL_ERROR_CATEGORIES.has(category)) return false;
  return origin == null || DIVERTIBLE_ORIGINS.has(origin);
}

/**
 * Remove a task type's contribution from every environmental bucket (issue
 * #2618 reset parity): decrement each bucket's count by the type's share,
 * delete the per-type entry, and drop a bucket left with nothing — so a reset
 * type's old outages stop appearing in insights and error-share denominators.
 * Pure — mutates `data`. Returns the number of events removed.
 */
export function purgeEnvironmentalFailuresForType(data, taskType) {
  let removed = 0;
  for (const [category, bucket] of Object.entries(data.environmentalFailures || {})) {
    const typeCount = bucket.taskTypes?.[taskType] || 0;
    if (typeCount === 0) continue;
    removed += typeCount;
    bucket.count = Math.max(0, (Number(bucket.count) || 0) - typeCount);
    delete bucket.taskTypes[taskType];
    if (bucket.count <= 0 && Object.keys(bucket.taskTypes || {}).length === 0) {
      delete data.environmentalFailures[category];
    }
  }
  return removed;
}

/**
 * Milliseconds between two ISO timestamps. Pure. Returns null (not 0) when
 * either bound is missing/unparseable so an absent timestamp never masquerades
 * as a zero-latency measurement (repo "sentinel, don't conflate absent" rule).
 */
function msBetween(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

/**
 * Compute the queue/compute latency split for a completed run (issue #2329).
 * Pure. Prefers measured values from source timestamps; where a source timestamp
 * is missing, derives the missing leg from the wall/execution difference so a
 * run without a `createdAt` (queue) or a runner `duration` (compute) still yields
 * a usable split instead of a null.
 *
 * Sentinel discipline: every leg carries a `source` marker so a *derived* value
 * is never confused with a *measured* one, and a legitimately-measured `0` is
 * never confused with an *absent* leg (`null`). Derivation only fires when the
 * other two legs are genuinely measured — an absent leg is never fabricated from
 * two other absent/derived legs.
 *
 * @returns {{ wallMs:number|null, queueMs:number|null, executionMs:number|null,
 *   source:{ wall:'measured'|null, queue:'measured'|'derived'|null,
 *            execution:'measured'|'derived'|null } }}
 */
export function computeLatencySplit({ startedAt, completedAt, createdAt, durationMs }) {
  const wallMs = msBetween(startedAt, completedAt);
  let queueMs = msBetween(createdAt, startedAt);
  let executionMs = Number.isFinite(durationMs) ? durationMs : null;

  const source = {
    wall: wallMs === null ? null : 'measured',
    queue: queueMs === null ? null : 'measured',
    execution: executionMs === null ? null : 'measured'
  };

  // Fallback: no createdAt but wall+compute measured → queue = wall − compute.
  if (queueMs === null && wallMs !== null && executionMs !== null && executionMs <= wallMs) {
    queueMs = wallMs - executionMs;
    source.queue = 'derived';
  } else if (executionMs === null && wallMs !== null && queueMs !== null && queueMs <= wallMs) {
    // Fallback: no runner duration but wall+queue measured → compute = wall − queue.
    executionMs = wallMs - queueMs;
    source.execution = 'derived';
  }

  return { wallMs, queueMs, executionMs, source };
}

/**
 * Build a structured TaskTelemetryContext for a completed agent run (issue
 * #2329). Pure — no I/O. Derives what is cheaply available from the agent/task
 * and their timestamps/metadata; uses explicit null sentinels for anything not
 * derivable rather than fabricating a value.
 *
 *   failureSignature  — { category, messageSnippet, failurePosition } (null when the
 *     run met its validation-authoritative outcome; see outcomeSuccess below)
 *   executionContext  — { provider, model, modelTier, taskType, component, inputChars, routingReason }
 *   latency           — { wallMs, queueMs, executionMs } (null members when not derivable)
 *   validationPassed  — success-criteria validation boolean (issue #2344):
 *     did the run meet its DECLARED success criteria, distinct from the runner's
 *     exit-code `success`? null sentinel = no machine-checkable criterion was
 *     declared for this task; true/false = declared criterion met / not met.
 *     Stamped authoritatively at the completion chokepoint (finalizeAgent) onto
 *     `result.validationPassed`; surfaced here with an explicit null default so
 *     "absent" never masquerades as `false`.
 */
export function buildTaskTelemetryContext(agent, task) {
  const meta = agent?.metadata || {};
  const result = agent?.result || {};
  const success = result.success || false;
  // Sentinel discipline: only an explicit boolean counts as a validation verdict;
  // anything else (undefined/null/non-bool) is "no criterion declared" → null.
  const validationPassed = typeof result.validationPassed === 'boolean' ? result.validationPassed : null;
  // Validation-authoritative outcome (issue #2344): a declared verdict overrides
  // the runner's exit code. Failure telemetry keys off THIS, not raw `success`,
  // so a commit-found run (success:false, validationPassed:true) is NOT harvested
  // as a failure (which would poison the #2329 failure-signal window that routing
  // consumes), and a criterion-missed clean exit is treated as the failure it is.
  const outcomeSuccess = validationPassed === null ? success : validationPassed;
  const taskType = extractTaskType(task);

  const errorAnalysis = result.errorAnalysis || null;
  const rawMessage = errorAnalysis?.message || errorAnalysis?.details || '';
  const failureSignature = outcomeSuccess ? null : {
    category: errorAnalysis?.category || null,
    // Classification provenance (#2642): 'provider'|'runner'|'output-scan', or
    // null on records that predate the marker (older runs / federated peers).
    // Gates the environmental exclusion below so an output-scan false positive
    // isn't diverted out of the learning aggregates. `?? null` (not `|| null`) so
    // only a genuinely-absent marker becomes the back-compat null — a malformed
    // falsy value (e.g. '') is preserved and rejected by the gate's allowlist.
    origin: errorAnalysis?.origin ?? null,
    messageSnippet: rawMessage ? String(rawMessage).substring(0, 200) : null,
    // Best-available proxy for "where in a multi-step workflow it failed": the
    // phase the agent had reached at completion. null when no phase was stamped.
    failurePosition: meta.phase ?? null
  };

  const taskDescription = task?.description ?? meta.taskDescription ?? null;
  const executionContext = {
    provider: meta.providerId ?? null,
    model: meta.model ?? null,
    modelTier: meta.modelTier ?? null,
    taskType,
    // Component/runner that executed the agent (tui | runner | direct).
    component: meta.executionMode ?? null,
    // Input dimension: prompt/description size in chars (null, not 0, when absent).
    inputChars: typeof taskDescription === 'string' ? taskDescription.length : null,
    // Routing decision rationale captured at spawn time (modelSelection.reason).
    routingReason: meta.modelReason ?? null
  };

  // Queue/compute latency split with a wall-difference fallback when a source
  // timestamp (task.createdAt or runner duration) is missing (issue #2329).
  const latency = computeLatencySplit({
    startedAt: agent?.startedAt,
    completedAt: agent?.completedAt,
    createdAt: task?.createdAt,
    durationMs: result.duration
  });

  return {
    taskType,
    success,
    validationPassed,
    // Validation-authoritative learning outcome (#2344): the single source of
    // truth every aggregate/window/telemetry gate keys off, so they can't drift.
    outcomeSuccess,
    failureSignature,
    executionContext,
    latency
  };
}

/**
 * Persist a failure signature aggregate onto the learning data (issue #2329).
 * Pure — mutates and returns `data`. Additive + back-compat: tolerates an old
 * learning.json that predates the `failureSignatures` key. No-op on success or
 * when the failure carries no category.
 */
export function recordFailureSignature(data, context) {
  const sig = context?.failureSignature;
  if (!sig || !sig.category) return data;

  if (!data.failureSignatures) data.failureSignatures = {};
  if (!data.failureSignatures[sig.category]) {
    data.failureSignatures[sig.category] = { count: 0, lastOccurred: null, recent: [] };
  }

  const bucket = data.failureSignatures[sig.category];
  const recordedAt = new Date().toISOString();
  bucket.count++;
  bucket.lastOccurred = recordedAt;
  bucket.recent.push({
    messageSnippet: sig.messageSnippet,
    failurePosition: sig.failurePosition,
    provider: context.executionContext.provider,
    model: context.executionContext.model,
    modelTier: context.executionContext.modelTier,
    taskType: context.executionContext.taskType,
    wallMs: context.latency.wallMs,
    executionMs: context.latency.executionMs,
    // Success-criteria validation verdict at failure time (issue #2344): null
    // when no machine-checkable criterion was declared, false when declared and
    // missed. Explicit null default keeps "absent" distinct from "failed".
    validationPassed: context.validationPassed ?? null,
    recordedAt
  });
  if (bucket.recent.length > MAX_SIGNATURE_SAMPLES) {
    bucket.recent = bucket.recent.slice(-MAX_SIGNATURE_SAMPLES);
  }
  return data;
}

/**
 * Build the per-proposal-domain execution payload (#2765) from a completed task that
 * took the Layered-Intelligence hand-off path, or null when the task carries no LI
 * marker. The marker (`metadata.taskLiProposal`) is projected onto the agent by
 * agentLifecycle and reconstructed onto the task by the completion listener; it names
 * the proposal's app, slug, and domain (scope). `success` is the validation-authoritative
 * learning outcome, so it agrees with the byTaskType aggregate for the same run.
 */
function deriveLiExecutionPayload(task, success, { errorCategory = null, validationPassed = null } = {}) {
  const li = task?.metadata?.taskLiProposal;
  if (!li || typeof li !== 'object' || Array.isArray(li)) return null;
  if (!li.appId || !li.slug) return null;
  // On failure, carry the run's failure signal so the outcome store can classify
  // the execution-failure taxonomy (#2764 §1). Harmless on success (the store
  // ignores it and nulls both diagnosis fields). `errorCategory` is the raw
  // agentErrorAnalysis category; `validationPassed` distinguishes a clean-exit
  // criterion miss (→ testing) when no error pattern matched.
  return {
    appId: li.appId,
    slug: li.slug,
    scope: li.scope ?? null,
    success: !!success,
    errorCategory: success ? null : errorCategory,
    validationPassed: success ? null : validationPassed
  };
}

/**
 * Record a completed task for learning
 */
export async function recordTaskCompletion(agent, task) {
  // Per-proposal-domain execution attribution (#2765) — captured inside the lock (it
  // needs this run's validation-authoritative outcome) but WRITTEN after it, so the LI
  // outcome store's I/O never runs under the learning lock and the generic learning
  // store stays statically decoupled from LI (lazy import below).
  let liExecPayload = null;
  const result = await withLock(async () => {
  const data = await loadLearningData();

  // Structured telemetry context (failure signature + execution context +
  // latency breakdown) derived once and reused for aggregate + log (issue #2329).
  const telemetry = buildTaskTelemetryContext(agent, task);
  const taskType = telemetry.taskType;
  const modelTier = agent.metadata?.modelTier || 'unknown';
  const success = telemetry.success;
  // Validation-authoritative learning outcome (issue #2344) — computed once in
  // buildTaskTelemetryContext so aggregates, the correlation window, and failure
  // telemetry all key off the same value. A clean exit that produced no committed
  // work is NOT a tier success; a commit-found run is a success even on a non-zero
  // exit; with no criterion declared it falls back to the runner's exit-code
  // `success` (so legacy completions/tests are unchanged).
  const outcomeSuccess = telemetry.outcomeSuccess;
  const duration = agent.result?.duration || 0;
  const errorCategory = telemetry.failureSignature?.category || null;
  // `?? null` preserves a malformed falsy origin ('') so the gate's allowlist
  // rejects it, rather than `|| null` collapsing it into the back-compat null (#2642).
  const errorOrigin = telemetry.failureSignature?.origin ?? null;

  // Environmental failure gate (issue #2618): a rate-limit/auth/billing/startup
  // failure says nothing about the task type or the model tier, so it must not
  // dent any success-rate aggregate or routing matrix — an outage would otherwise
  // get a healthy task type skipped (<30% gate) or a healthy tier avoided. Such
  // runs are diverted to `environmentalFailures` below; errorPatterns and
  // failureSignatures still record them for diagnostics/prompt hints.
  // Provenance gate (#2642): a category derived only from the output-text regex
  // sweep (`origin: 'output-scan'`) is NOT diverted — it may be a false positive
  // (ordinary task output tripping a loose pattern). Structured provider/runner
  // signals and pre-marker records (null origin) keep the category-only behavior.
  const isEnvironmentalFailure = shouldDivertToEnvironmental(outcomeSuccess, errorCategory, errorOrigin);

  // Attribute an LI hand-off's outcome to the proposal's DOMAIN (#2765). Only a
  // non-environmental completion counts: a rate-limit/outage says nothing about the
  // domain, exactly as it is barred from denting the byTaskType aggregate below.
  liExecPayload = isEnvironmentalFailure ? null : deriveLiExecutionPayload(task, outcomeSuccess, { errorCategory, validationPassed: telemetry.validationPassed });

  // Correlation-quality prediction snapshot (issue #2344) — captured HERE, before
  // ANY of this run's aggregates (byModelTier, routingAccuracy, failureSignatures)
  // are folded in below, so the prediction reflects history strictly BEFORE this
  // completion. `deriveFailureSignalAvoidance` reads routingAccuracy for its
  // proven cross-check, so computing it after those mutations would leak this
  // run's own outcome into its own prediction and inflate the gauge. Uses the
  // signal's BASE sensitivity (default aggressive bar) as a fixed predictor —
  // measuring the gate against its own correlation-gated output would be circular.
  // Skipped for the unknown tier AND non-routable learned tiers (minimal/low):
  // routing can never flag those, so recording them as "predicted safe" would
  // encode "no routable prediction" as a true-negative and skew the gauge.
  const correlationPredictedRisk = (modelTier && modelTier !== 'unknown' && !isNonRoutableLearnedTier(modelTier))
    ? deriveFailureSignalAvoidance(data, taskType).avoidTiers.includes(modelTier)
    : null;

  if (isEnvironmentalFailure) {
    // Divert to the separate environmental record (issue #2618): the event stays
    // visible (count + lastOccurred + affected task types) without touching any
    // bucket the routing/skip/approval decisions read. Deliberately skips even
    // bucket *initialization* so a task type whose only history is an outage
    // never grows an empty aggregate entry.
    recordEnvironmentalFailure(data, { category: errorCategory, taskType });
  } else {
    // Initialize task type bucket if needed
    if (!data.byTaskType[taskType]) {
      data.byTaskType[taskType] = {
        completed: 0,
        succeeded: 0,
        failed: 0,
        totalDurationMs: 0,
        avgDurationMs: 0,
        maxDurationMs: 0,
        p80DurationMs: 0,
        lastCompleted: null,
        successRate: 0,
        // Bounded recency ring (issue #2460) — feeds the windowed rate LI reads.
        recentOutcomes: []
      };
    }

    // Initialize model tier bucket if needed
    if (!data.byModelTier[modelTier]) {
      data.byModelTier[modelTier] = {
        completed: 0,
        succeeded: 0,
        failed: 0,
        totalDurationMs: 0,
        successDurationMs: 0,
        avgDurationMs: 0
      };
    }

    // Update task type metrics
    const typeMetrics = data.byTaskType[taskType];
    typeMetrics.completed++;
    if (outcomeSuccess) {
      typeMetrics.succeeded++;
      // Only include successful durations in ETA calculations — failed agents often
      // run long in error loops and skew estimates
      typeMetrics.successDurationMs = (typeMetrics.successDurationMs || 0) + duration;
      typeMetrics.successMaxDurationMs = Math.max(typeMetrics.successMaxDurationMs || 0, duration);
    } else {
      typeMetrics.failed++;
    }
    typeMetrics.totalDurationMs += duration;
    Object.assign(typeMetrics, calculateDurationETA(typeMetrics));
    typeMetrics.lastCompleted = new Date().toISOString();
    typeMetrics.successRate = Math.round((typeMetrics.succeeded / typeMetrics.completed) * 100);
    // Append this run to the bounded recency ring (issue #2460). The lifetime
    // counters above never decay; the ring lets LI read a recency-windowed rate so
    // a since-resolved failure burst ages out of the "is work needed" signal
    // instead of depressing it forever. Stamped with the same `lastCompleted` time.
    appendRecentOutcome(typeMetrics, { success: outcomeSuccess, at: typeMetrics.lastCompleted });

    // Update model tier metrics
    const tierMetrics = data.byModelTier[modelTier];
    tierMetrics.completed++;
    if (outcomeSuccess) {
      tierMetrics.succeeded++;
      tierMetrics.successDurationMs = (tierMetrics.successDurationMs || 0) + duration;
    } else {
      tierMetrics.failed++;
    }
    tierMetrics.totalDurationMs += duration;
    tierMetrics.avgDurationMs = calculateDurationETA(tierMetrics).avgDurationMs;

    // Track routing accuracy: taskType × modelTier cross-reference
    if (!data.routingAccuracy) data.routingAccuracy = {};
    if (!data.routingAccuracy[taskType]) data.routingAccuracy[taskType] = {};
    if (!data.routingAccuracy[taskType][modelTier]) {
      data.routingAccuracy[taskType][modelTier] = { succeeded: 0, failed: 0, lastAttempt: null };
    }
    const routing = data.routingAccuracy[taskType][modelTier];
    if (outcomeSuccess) {
      routing.succeeded++;
    } else {
      routing.failed++;
    }
    routing.lastAttempt = new Date().toISOString();
  }

  // Track error patterns — gated on the validation-authoritative outcome so a
  // commit-found run isn't logged as an error and a criterion-miss is (#2344).
  if (!outcomeSuccess && errorCategory) {
    if (!data.errorPatterns[errorCategory]) {
      data.errorPatterns[errorCategory] = {
        count: 0,
        taskTypes: {},
        lastOccurred: null
      };
    }
    data.errorPatterns[errorCategory].count++;
    data.errorPatterns[errorCategory].lastOccurred = new Date().toISOString();

    // Track which task types produce this error
    if (!data.errorPatterns[errorCategory].taskTypes[taskType]) {
      data.errorPatterns[errorCategory].taskTypes[taskType] = 0;
    }
    data.errorPatterns[errorCategory].taskTypes[taskType]++;

    // Store recent unknown error samples for diagnosability
    // This helps identify missing patterns that should be added to ERROR_PATTERNS
    if (errorCategory === 'unknown') {
      const errorAnalysis = agent.result?.errorAnalysis || {};
      if (!data.recentUnknownErrors) data.recentUnknownErrors = [];
      data.recentUnknownErrors.push({
        taskType,
        message: (errorAnalysis.message || '').substring(0, 200),
        details: (errorAnalysis.details || '').substring(0, 500),
        agentId: agent.agentId || agent.id,
        recordedAt: new Date().toISOString()
      });
      // Keep only last 20 samples to avoid unbounded growth
      if (data.recentUnknownErrors.length > 20) {
        data.recentUnknownErrors = data.recentUnknownErrors.slice(-20);
      }
    }
  }

  // Correlation-quality window (issue #2344): pair the pre-mutation prediction
  // snapshot (captured above, before any of this run's aggregates were folded in)
  // with the actual outcome. Reuses the same validation-authoritative
  // `outcomeSuccess` the aggregates above learn from, so the correlation `bad`
  // label and the routing counts can never disagree about a single run.
  // Environmental failures are excluded (issue #2618): the window measures how
  // well the routing signal predicts task/model outcomes, and an outage-shaped
  // `bad` sample would grade the predictor on something it can't predict.
  if (correlationPredictedRisk !== null && !isEnvironmentalFailure) {
    recordCorrelationSample(data, { taskType, tier: modelTier, predictedRisk: correlationPredictedRisk, bad: !outcomeSuccess });
  }

  // Aggregate the enriched failure signature (category + snippet + position +
  // execution context + latency) — a no-op on success (issue #2329).
  recordFailureSignature(data, telemetry);

  // Fold a recurring failure category into a standing, provenance-stamped
  // human-readable insight (issue #2443) — turns a machine aggregate into an
  // operating note the user can read in the CoS UI, without a manual API call.
  // Fires only when the per-category recurrence count lands on a milestone so it
  // escalates instead of spamming. Appended inline (not via recordLearningInsight)
  // because we already hold the non-reentrant store lock and `data` is about to
  // be persisted below. Privacy: buildRecurrenceInsight uses only controlled
  // fields — no raw error message (which could embed a path/PII).
  if (!outcomeSuccess && errorCategory) {
    const recurrenceCount = data.errorPatterns[errorCategory]?.count || 0;
    if (recurrenceMilestoneReached(recurrenceCount)) {
      appendInsight(data, buildRecurrenceInsight({
        category: errorCategory,
        count: recurrenceCount,
        taskType,
        agentId: agent.agentId || agent.id || null,
        failureSignatures: data.failureSignatures
      }));
      emitLog('info', `📚 Auto-recorded recurring-failure insight: "${errorCategory}" ×${recurrenceCount} (${taskType})`, {
        category: errorCategory,
        recurrenceCount,
        taskType
      }, '[TaskLearning]');
    }
  }

  // Update totals — environmental failures stay out (issue #2618): the overall
  // success rate is a rate aggregate too, and an outage must not dent it.
  if (!isEnvironmentalFailure) {
    data.totals.completed++;
    if (outcomeSuccess) {
      data.totals.succeeded++;
      data.totals.successDurationMs = (data.totals.successDurationMs || 0) + duration;
      data.totals.successMaxDurationMs = Math.max(data.totals.successMaxDurationMs || 0, duration);
    } else {
      data.totals.failed++;
    }
    data.totals.totalDurationMs += duration;
    Object.assign(data.totals, calculateDurationETA(data.totals));
  }

  await saveLearningData(data);

  const { provider, model, component, routingReason } = telemetry.executionContext;
  const { wallMs, queueMs } = telemetry.latency;
  const wallSecs = Math.round((wallMs ?? duration) / 1000);
  // Label reflects the learning OUTCOME (validation-authoritative). A run that
  // exited clean but missed its declared criterion reads as `failed:validation-miss`
  // rather than the misleading `success` the raw exit code would show (#2344).
  const outcomeLabel = outcomeSuccess
    ? 'success'
    : `failed:${errorCategory || (success ? 'validation-miss' : 'uncategorized')}${isEnvironmentalFailure ? ' environmental' : ''}`;
  emitLog('debug', `Recorded task completion: ${taskType} (${outcomeLabel}) via ${provider || '?'}/${model || '?'}@${modelTier} [${component || '?'}] wall=${wallSecs}s`, {
    taskType,
    modelTier,
    provider,
    model,
    component,
    routingReason,
    success,
    validationPassed: telemetry.validationPassed,
    outcomeSuccess,
    errorCategory,
    environmental: isEnvironmentalFailure,
    failurePosition: telemetry.failureSignature?.failurePosition ?? null,
    wallMs,
    queueMs,
    executionMs: telemetry.latency.executionMs,
    duration: Math.round(duration / 1000) + 's'
  }, '[TaskLearning]');

  return data;
  });

  // Post-lock, best-effort: record the LI hand-off execution outcome keyed to the
  // proposal's domain (#2765). Lazy import keeps the learning store's static module
  // graph free of LI; a failure here never disturbs the learning write above.
  if (liExecPayload) {
    await import('../layeredIntelligenceOutcomes.js')
      .then(m => m.recordProposalExecution(liExecPayload))
      .catch(err => console.error(`❌ 📚 TaskLearning: failed to record LI proposal execution: ${err.message}`));
  }

  return result;
}

/**
 * Recency-windowed success stats for a task type (issue #2460). Loads the
 * learning store, reads the task type's `recentOutcomes` ring, and windows it by
 * count and/or age via the pure `computeWindowedStats`. Read-only. Returns the
 * `null`-successRate sentinel when the task type is absent or has no in-window
 * samples, so callers (Layered Intelligence) can fall back to the lifetime rate
 * rather than treat "no recent runs" as a fabricated 0%.
 *
 * @param {string} taskType
 * @param {{ maxCount?:number, maxAgeMs?:number }} [opts]
 */
export async function getWindowedStats(taskType, {
  maxCount = DEFAULT_WINDOW_MAX_COUNT,
  maxAgeMs = DEFAULT_WINDOW_MAX_AGE_MS
} = {}) {
  const data = await loadLearningData();
  const metrics = data.byTaskType?.[taskType];
  return computeWindowedStats(metrics?.recentOutcomes, { maxCount, maxAgeMs });
}

/**
 * Reset learning data for a specific task type
 * Used when a previously-failing task type has been fixed and should be retried
 * Subtracts the task type's metrics from totals and removes the task type entry
 * @param {string} taskType - The task type to reset (e.g., 'self-improve:ui')
 * @returns {Object} Summary of what was reset
 */
export async function resetTaskTypeLearning(taskType) {
  return withLock(async () => {
  const data = await loadLearningData();

  // Purge this type from the environmental buckets FIRST (#2618): an
  // outage-only type has no byTaskType bucket, so the purge must not sit
  // behind the task-type-not-found early return below.
  //
  // Deliberately part of the RESET path, not of removeTaskTypeFromLearningData:
  // this function is "the user says this type is fixed — forget all of it", so
  // dropping its outage history is intended. A caller repairing mis-recorded
  // BUCKET data (e.g. migration 197) must not purge outages, which are recorded
  // from real errors and are true regardless of any bucket-level bug.
  const environmentalRemoved = purgeEnvironmentalFailuresForType(data, taskType);

  const metrics = data.byTaskType[taskType];
  if (!metrics) {
    if (environmentalRemoved > 0) {
      await saveLearningData(data);
      emitLog('info', `Reset environmental-only learning data for ${taskType} (${environmentalRemoved} outage events purged)`, { taskType, environmentalRemoved }, '📚 TaskLearning');
      return { reset: true, reason: 'environmental-only', taskType, environmentalRemoved };
    }
    return { reset: false, reason: 'task-type-not-found', taskType };
  }

  const previousMetrics = removeTaskTypeFromLearningData(data, taskType);

  await saveLearningData(data);

  emitLog('info', `Reset learning data for ${taskType} (was ${metrics.successRate}% success after ${metrics.completed} attempts)`, {
    taskType,
    previousSuccessRate: metrics.successRate,
    previousAttempts: metrics.completed
  }, '📚 TaskLearning');

  return { reset: true, taskType, previousMetrics };
  });
}

/**
 * Remove one task type's contribution from every learning aggregate, in place.
 * Pure (mutates `data`, no I/O) so both the runtime reset and offline repairs
 * (migrations) can share ONE definition of "what a task type contributes to" —
 * a second, hand-rolled version would silently drift as aggregates are added.
 *
 * Unwinds: `totals` (+ recomputed max/ETA), `errorPatterns`, `byModelTier` (via
 * `routingAccuracy`, which must be read BEFORE it is deleted), `routingAccuracy`,
 * `byTaskType`, `failureSignatures` (#2619), and `correlationWindow` (#2619).
 *
 * Does NOT touch `environmentalFailures` — that is a separate ledger fed only by
 * real outages, so removing it is a policy decision belonging to the caller (see
 * `resetTaskTypeLearning`, which purges it; migration 197, which must not).
 *
 * @param {Object} data - the loaded learning store, mutated in place
 * @param {string} taskType - e.g. 'self-improve:layered-intelligence'
 * @returns {{ completed:number, succeeded:number, failed:number, successRate:number }|null}
 *   the removed bucket's headline metrics, or null when the type had no bucket.
 */
export function removeTaskTypeFromLearningData(data, taskType) {
  const metrics = data?.byTaskType?.[taskType];
  if (!metrics) return null;

  // Subtract this task type's contribution from totals. Guarded because this helper
  // also runs OFFLINE against a raw on-disk store (migrations), where the defaults
  // loadLearningData applies at runtime haven't been layered on — and an aggregate
  // this function throws on would block boot rather than repair anything.
  if (data.totals && typeof data.totals === 'object') {
    data.totals.completed -= metrics.completed;
    data.totals.succeeded -= metrics.succeeded;
    data.totals.failed -= metrics.failed;
    data.totals.totalDurationMs -= metrics.totalDurationMs;
    if (data.totals.successDurationMs) {
      data.totals.successDurationMs = Math.max(0, data.totals.successDurationMs - (metrics.successDurationMs || 0));
    }
    // Recalculate max from remaining task types (we can't subtract a max)
    const remainingTypes = Object.entries(data.byTaskType).filter(([t]) => t !== taskType);
    data.totals.successMaxDurationMs = remainingTypes.reduce((max, [, m]) => Math.max(max, m.successMaxDurationMs || 0), 0);
    Object.assign(data.totals, calculateDurationETA(data.totals));
  }

  // Clean up error patterns referencing this task type
  for (const [category, pattern] of Object.entries(data.errorPatterns || {})) {
    const taskTypeCount = pattern?.taskTypes?.[taskType] || 0;
    if (taskTypeCount > 0) {
      pattern.count -= taskTypeCount;
      delete pattern.taskTypes[taskType];
    }
    // Remove empty error categories
    if (pattern.count <= 0) {
      delete data.errorPatterns[category];
    }
  }

  // Subtract model tier contributions using routing accuracy data (before deleting it)
  data.byModelTier ??= {};
  const routingData = data.routingAccuracy?.[taskType];
  if (routingData) {
    for (const [tier, counts] of Object.entries(routingData)) {
      const tierMetrics = data.byModelTier[tier];
      if (tierMetrics) {
        const tierTotal = counts.succeeded + counts.failed;
        tierMetrics.completed = Math.max(0, tierMetrics.completed - tierTotal);
        tierMetrics.succeeded = Math.max(0, tierMetrics.succeeded - counts.succeeded);
        tierMetrics.failed = Math.max(0, tierMetrics.failed - counts.failed);
        // Estimate duration contribution using task type's avg duration per agent
        if (tierTotal > 0 && metrics.avgDurationMs > 0) {
          tierMetrics.totalDurationMs = Math.max(0, tierMetrics.totalDurationMs - (metrics.avgDurationMs * tierTotal));
        }
        tierMetrics.avgDurationMs = tierMetrics.completed > 0
          ? Math.round(tierMetrics.totalDurationMs / tierMetrics.completed)
          : 0;
        // Clean up empty tiers
        if (tierMetrics.completed <= 0) {
          delete data.byModelTier[tier];
        }
      }
    }
    delete data.routingAccuracy[taskType];
  }

  // Remove the task type entry
  delete data.byTaskType[taskType];

  // Purge the task type's samples from the enriched failure signatures (#2619).
  // Each `recent[]` sample carries its `taskType` and drives
  // deriveFailureSignalAvoidance, so a leftover sample would keep steering a
  // just-reset type off a tier. Decrement each bucket's rolling count by the
  // samples removed and drop a bucket left with nothing.
  if (data.failureSignatures && typeof data.failureSignatures === 'object') {
    for (const [category, bucket] of Object.entries(data.failureSignatures)) {
      if (!Array.isArray(bucket?.recent)) continue;
      const kept = bucket.recent.filter((s) => s?.taskType !== taskType);
      const removed = bucket.recent.length - kept.length;
      if (removed === 0) continue;
      bucket.recent = kept;
      bucket.count = Math.max(0, (Number(bucket.count) || 0) - removed);
      if (bucket.recent.length === 0 && bucket.count <= 0) {
        delete data.failureSignatures[category];
      }
    }
  }

  // Drop the task type's rows from the cross-type correlation window (#2619) so a
  // rehabilitated type contributes no stale prediction/outcome pairs to the gauge.
  if (Array.isArray(data.correlationWindow)) {
    data.correlationWindow = data.correlationWindow.filter((row) => row?.taskType !== taskType);
  }

  return {
    completed: metrics.completed,
    succeeded: metrics.succeeded,
    failed: metrics.failed,
    successRate: metrics.successRate
  };
}

/**
 * Recalculate byModelTier from routingAccuracy data.
 *
 * The byModelTier aggregate accumulates raw counts over time, including
 * historical failures from before routingAccuracy tracking existed.
 * This creates drift — e.g., the "heavy" tier can show 0% success from
 * old misconfigured runs even though recent routing data is clean.
 *
 * This function rebuilds byModelTier entirely from routingAccuracy
 * (the authoritative per-task-type per-tier source of truth) and uses
 * byTaskType average durations to estimate timing.
 *
 * Called on init to self-heal and exposed for manual triggering.
 *
 * @returns {Object} Summary of changes made
 */
export async function recalculateModelTierMetrics() {
  return withLock(async () => {
  const data = await loadLearningData();
  const routingData = data.routingAccuracy || {};
  const oldTiers = data.byModelTier || {};

  const newTiers = {};

  for (const [taskType, tiers] of Object.entries(routingData)) {
    const taskMetrics = data.byTaskType?.[taskType];
    const avgDurationPerAgent = taskMetrics?.avgDurationMs || 0;

    for (const [tier, counts] of Object.entries(tiers)) {
      const total = (counts.succeeded || 0) + (counts.failed || 0);
      if (total === 0) continue;

      if (!newTiers[tier]) {
        newTiers[tier] = {
          completed: 0,
          succeeded: 0,
          failed: 0,
          totalDurationMs: 0,
          avgDurationMs: 0
        };
      }

      newTiers[tier].completed += total;
      newTiers[tier].succeeded += counts.succeeded || 0;
      newTiers[tier].failed += counts.failed || 0;
      newTiers[tier].totalDurationMs += avgDurationPerAgent * total;
    }
  }

  // Calculate averages
  for (const metrics of Object.values(newTiers)) {
    metrics.avgDurationMs = metrics.completed > 0
      ? Math.round(metrics.totalDurationMs / metrics.completed)
      : 0;
  }

  // Build change summary
  const changes = [];
  const allTierKeys = new Set([...Object.keys(oldTiers), ...Object.keys(newTiers)]);
  for (const tier of allTierKeys) {
    const oldSuccessRate = oldTiers[tier]?.completed > 0
      ? Math.round((oldTiers[tier].succeeded / oldTiers[tier].completed) * 100)
      : null;
    const newSuccessRate = newTiers[tier]?.completed > 0
      ? Math.round((newTiers[tier].succeeded / newTiers[tier].completed) * 100)
      : null;

    if (oldSuccessRate !== newSuccessRate || oldTiers[tier]?.completed !== newTiers[tier]?.completed) {
      changes.push({
        tier,
        old: { completed: oldTiers[tier]?.completed || 0, successRate: oldSuccessRate },
        new: { completed: newTiers[tier]?.completed || 0, successRate: newSuccessRate }
      });
    }
  }

  if (changes.length > 0) {
    data.byModelTier = newTiers;
    await saveLearningData(data);

    const summary = changes.map(c =>
      `${c.tier}: ${c.old.completed}@${c.old.successRate ?? 0}% → ${c.new.completed}@${c.new.successRate ?? 0}%`
    ).join(', ');
    emitLog('info', `Recalculated model tier metrics from routing accuracy: ${summary}`, {
      changes: changes.length
    }, '📚 TaskLearning');
  }

  return { recalculated: changes.length > 0, changes };
  });
}

/**
 * Rebuild success-only duration stats from the agent archive.
 * Scans all completed agent metadata to recalculate avgDurationMs, maxDurationMs, and p80DurationMs
 * using only successful agent durations (failed agents often run long in error loops and skew ETAs).
 */
export async function recalculateDurationStats() {
  return withLock(async () => {
  const data = await loadLearningData();

  // Reset success-only duration fields
  for (const metrics of Object.values(data.byTaskType)) {
    metrics.successDurationMs = 0;
    metrics.successMaxDurationMs = 0;
  }
  data.totals.successDurationMs = 0;
  data.totals.successMaxDurationMs = 0;

  let agentCount = 0;
  let successCount = 0;

  if (existsSync(AGENTS_DIR)) {
    const dateDirs = readdirSync(AGENTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name));

    // Collect all metadata paths then read in parallel
    const metaPaths = [];
    for (const dateDir of dateDirs) {
      const datePath = join(AGENTS_DIR, dateDir.name);
      const agentDirs = readdirSync(datePath, { withFileTypes: true })
        .filter(d => d.isDirectory());
      for (const agentDir of agentDirs) {
        metaPaths.push(join(datePath, agentDir.name, 'metadata.json'));
      }
    }

    const results = await Promise.all(
      metaPaths.map(p => tryReadFile(p))
    );

    for (const raw of results) {
      if (!raw) continue;
      const meta = JSON.parse(raw);
      agentCount++;

      const duration = meta.result?.duration || 0;
      // Validation-authoritative outcome (issue #2344), consistent with the live
      // recordTaskCompletion path: an archived clean-exit run that missed its
      // declared criterion is NOT a success (excluded from success-only ETAs),
      // and a commit-found run is a success even on a non-zero exit. Falls back to
      // the raw exit-code success for records that predate validationPassed.
      // NOTE (#2696): the coordinator commit-criterion exemption is deliberately NOT
      // applied here. This rebuild re-derives success-only DURATIONS from archives but
      // does not rebuild the `succeeded` COUNTS, and totals.successDurationMs (below) is
      // summed unconditionally. Overriding a coordinator's fossil validationPassed:false
      // to an exit-code success here would add its duration to totals while migration 198
      // had already removed its count — inflating the totals ETA. A post-fix coordinator
      // run carries validationPassed:null (finalize returns null) and is already counted
      // correctly; a pre-fix fossil is left excluded so durations stay consistent with the
      // purged counts. The residual archives-vs-counts skew of this manual rebuild predates
      // #2696 and is ETA-cosmetic.
      const vp = meta.result?.validationPassed;
      const outcomeSuccess = typeof vp === 'boolean' ? vp : !!meta.result?.success;
      if (!outcomeSuccess || duration <= 0) continue;

      successCount++;
      const taskType = extractTaskType({
        description: meta.metadata?.taskDescription,
        metadata: meta.metadata,
        taskType: meta.metadata?.taskType
      });

      if (data.byTaskType[taskType]) {
        data.byTaskType[taskType].successDurationMs += duration;
        data.byTaskType[taskType].successMaxDurationMs = Math.max(
          data.byTaskType[taskType].successMaxDurationMs, duration
        );
      }

      data.totals.successDurationMs += duration;
      data.totals.successMaxDurationMs = Math.max(data.totals.successMaxDurationMs, duration);
    }
  }

  // Recalculate avgDurationMs, maxDurationMs, and p80DurationMs using the helper
  for (const metrics of Object.values(data.byTaskType)) {
    if ((metrics.succeeded || 0) > 0 && metrics.successDurationMs > 0) {
      Object.assign(metrics, calculateDurationETA(metrics));
    }
  }

  if ((data.totals.succeeded || 0) > 0 && data.totals.successDurationMs > 0) {
    Object.assign(data.totals, calculateDurationETA(data.totals));
  }

  await saveLearningData(data);

  emitLog('info', `📚 Recalculated duration stats from ${agentCount} agents (${successCount} successful)`, {
    agentCount, successCount,
    newAvgMs: data.totals.avgDurationMs,
    newP80Ms: data.totals.p80DurationMs
  }, '[TaskLearning]');

  return {
    recalculated: true,
    agentsScanned: agentCount,
    successfulAgents: successCount,
    newTotals: {
      avgDurationMs: data.totals.avgDurationMs,
      p80DurationMs: data.totals.p80DurationMs,
      maxDurationMs: data.totals.maxDurationMs
    }
  };
  });
}
