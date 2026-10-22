/**
 * CoS agent-run churn detector.
 *
 * A scheduled / perpetual task that finishes the SAME work over and over in
 * short-lived agent runs (last night's branch-reconcile loop: dozens of
 * identical findings, each a couple of minutes) is a local diagnostic signal.
 * This module watches every agent completion, decides from the task-type
 * recency ring whether the type is churning, and parks a looping coordinator
 * so it stops burning quota. The learning ring stays local; Layered
 * Intelligence can later decide whether the signal supports a concrete,
 * planned fix worth filing.
 *
 * Detection is deterministic (counts + durations + inter-arrival gaps). No
 * LLM call — safe under the cold-bootstrap AI policy.
 */

import { extractTaskType, loadLearningData } from './taskLearning/store.js';
import { NON_COMMITTING_COORDINATOR_TASK_TYPES } from './taskTypeHooks.js';

// Tight window: the failure mode is a burst overnight, not a busy week of
// legitimate drain. Eight completions is already more than a healthy
// coordinator should need to re-state the same finding.
export const CHURN_WINDOW_MS = 6 * 60 * 60 * 1000;
export const SHORT_LIVED_MS = 5 * 60 * 1000;
export const CHURN_MIN_RUNS = 8;
export const CHURN_SHORT_LIVED_RATIO = 0.7;
export const RAPID_GAP_MS = 15 * 60 * 1000;

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Window a recent-outcomes ring and summarize duration + spacing. Pure.
 * Samples without a parseable timestamp are dropped (they cannot contribute
 * to a recency burst). Duration stats are null when no sample carried `d`,
 * so pre-instrumentation history is distinguishable from "every run was instant".
 */
export function summarizeRecentRuns(recentOutcomes, {
  now = Date.now(),
  windowMs = CHURN_WINDOW_MS
} = {}) {
  const ring = Array.isArray(recentOutcomes) ? recentOutcomes : [];
  const cutoff = now - windowMs;
  const windowed = ring.filter((o) => {
    const t = Date.parse(o?.t);
    return Number.isFinite(t) && t >= cutoff;
  });
  const durations = windowed
    .map((o) => o?.d)
    .filter((d) => Number.isFinite(d) && d >= 0);
  const shortLivedCount = durations.filter((d) => d < SHORT_LIVED_MS).length;
  const times = windowed
    .map((o) => Date.parse(o?.t))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  return {
    windowCompleted: windowed.length,
    windowMs,
    shortLivedCount,
    shortLivedSampleSize: durations.length,
    shortLivedRatio: durations.length > 0 ? shortLivedCount / durations.length : null,
    averageDurationMs: durations.length
      ? Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length)
      : null,
    medianDurationMs: median(durations),
    medianGapMs: median(gaps)
  };
}

/**
 * Classify a task-type recency ring as churning or not. Pure.
 *
 * Two independent signals, either of which is enough once the run-count floor
 * is met:
 *   - short-lived-burst — enough of the measured runs finished under
 *     SHORT_LIVED_MS (the last-night shape: coordinator reports the same
 *     finding and exits in a couple of minutes).
 *   - rapid-succession — no duration data (pre-instrumentation ring) but the
 *     completions are packed tighter than RAPID_GAP_MS. The timestamp cadence
 *     is the only honest proxy when `d` was never recorded.
 *
 * A healthy drain of real work (a handful of long runs, or many long runs
 * spaced out) does not flag.
 */
export function computeChurn(recentOutcomes, opts = {}) {
  const stats = summarizeRecentRuns(recentOutcomes, opts);
  let reason = null;
  if (stats.windowCompleted >= CHURN_MIN_RUNS) {
    if (stats.shortLivedRatio !== null && stats.shortLivedRatio >= CHURN_SHORT_LIVED_RATIO) {
      reason = 'short-lived-burst';
    } else if (stats.shortLivedRatio === null && stats.medianGapMs !== null && stats.medianGapMs < RAPID_GAP_MS) {
      reason = 'rapid-succession';
    }
  }
  return { ...stats, flagged: reason !== null, reason };
}

function formatWindow(ms) {
  const hours = Math.round((Number(ms) || 0) / 3600000);
  return hours <= 1 ? '1h' : `${hours}h`;
}

function scheduledTypeOf(task) {
  return task?.metadata?.analysisType || task?.metadata?.taskAnalysisType || null;
}

function appIdOf(task) {
  return task?.metadata?.app || task?.metadata?.taskApp || null;
}


/**
 * Watch one completed agent run. Call AFTER `recordTaskCompletion` so this
 * run is already on the recency ring. Never throws — callers at the
 * agent-completed boundary must stay up if parking fails.
 */
export async function observeAgentChurn(agent, task, {
  loadLearning = loadLearningData,
  now = Date.now,
  park = null
} = {}) {
  const taskType = extractTaskType(task);
  if (!taskType) return { flagged: false };
  const clock = typeof now === 'function' ? now() : now;
  const nowMs = typeof clock === 'number' ? clock : Date.parse(clock);
  const effectiveNow = Number.isFinite(nowMs) ? nowMs : Date.now();

  const data = await loadLearning();
  const churn = computeChurn(data?.byTaskType?.[taskType]?.recentOutcomes, { now: effectiveNow });
  if (!churn.flagged) return { flagged: false, taskType, churn };

  const analysisType = scheduledTypeOf(task);
  const appId = appIdOf(task);
  // A coordinator looping fast enough to be parked is a workflow fault; a burst
  // of quick user tasks is just a busy hour and nothing acts on it.
  const looping = NON_COMMITTING_COORDINATOR_TASK_TYPES.has(analysisType);
  const summary = `CoS churn: ${taskType} ${churn.reason} (${churn.windowCompleted} runs in ${formatWindow(churn.windowMs)})`;
  if (looping) console.warn(`⚠️ ${summary}`);
  else console.log(`🔁 ${summary}`);

  let parked = false;
  if (looping) {
    const parkFn = park || (async (...args) => {
      const { parkPerpetual } = await import('./taskSchedule.js');
      return parkPerpetual(...args);
    });
    await parkFn(analysisType, appId, { reason: 'churn-detected', actionableCount: churn.windowCompleted });
    parked = true;
    console.warn(`⚠️ CoS churn: parked ${analysisType} so the loop stops burning quota`);
  }

  return { flagged: true, filed: false, parked, taskType, churn, reason: 'local-metric' };
}
