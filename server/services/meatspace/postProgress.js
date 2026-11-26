/** Aggregates POST progress, skill evidence, and progression ladder history. */

import { APPLIED_NUMERACY_DRILL_TYPE, APPLIED_NUMERACY_DIFFICULTIES } from '../../lib/postAppliedNumeracy.js';
import { resolveMultiplicationLevel, MASTERY_DEFAULTS } from '../../lib/postMultiplicationLadder.js';
import { POWERS_MASTERY_DEFAULTS, powersTechniqueForPair, resolvePowersLevel } from '../../lib/postPowersLadder.js';
import {
  cognitiveLadder,
  cognitiveLevelConfig,
  resolveCognitiveProgression,
  COGNITIVE_LADDER_TYPES,
  COGNITIVE_MASTERY_DEFAULTS,
} from '../../lib/postProgression.js';
import {
  getMemoryItems,
  getDueMemoryItems,
  MASTERY_TARGET_ACCURACY,
} from './meatspacePostMemory.js';
import { applySessionToReviewSchedule, getRetentionReport } from './meatspacePostReview.js';
import { getAllTrainingEntries } from '../postTrainingLogStore.js';
import {
  computeUnifiedStreak,
  recordDayKey,
  ymdToUTC,
  ymdShift,
} from '../../lib/postStreak.js';
import { todayInTimezone } from '../../lib/timezone.js';
import { getUserTimezone } from '../userTimezone.js';
import { POST_BENCHMARK_PROTOCOL, benchmarkCompatibility } from './postBenchmark.js';
import { getPostSessions } from './postSessionHistory.js';
import {
  deriveTaskAccuracy,
  deriveTaskCompletion,
  deriveTaskAvgResponseMs,
  trainingEntryTask,
  skillEvidenceSessions,
} from './postSkillEvidence.js';

// A maintenance-review rep must reach at least this fraction of its questions to
// count as a genuine re-verification (mirrors COGNITIVE_MASTERY_DEFAULTS
// minCompletion). Below it, the review is recorded as failed rather than passed.
const MIN_REVIEW_COMPLETION = 0.75;
const APPLIED_NUMERACY_MASTERY = { minSamples: 3, accuracy: 0.8, completion: 0.75 };

/**
 * Aggregate complexity-level evidence for Applied Numeracy. Its rungs measure
 * representation changes, units, and multi-step transforms rather than larger
 * operands, so retention can schedule a targeted rep at the earned level.
 */
export async function getAppliedNumeracyProgress() {
  const sessions = await getPostSessions();
  const buckets = Object.fromEntries([1, 2, 3].map(level => [level, { samples: 0, accuracy: 0, completion: 0 }]));
  for (const session of sessions) {
    for (const task of session.tasks || []) {
      if (task.type !== APPLIED_NUMERACY_DRILL_TYPE) continue;
      const level = APPLIED_NUMERACY_DIFFICULTIES.includes(task.config?.difficulty) ? task.config.difficulty : 1;
      const accuracy = deriveTaskAccuracy(task);
      const completion = deriveTaskCompletion(task);
      if (accuracy == null) continue;
      buckets[level].samples += 1;
      buckets[level].accuracy += accuracy;
      buckets[level].completion += completion ?? 1;
    }
  }
  return {
    levels: Object.entries(buckets).map(([level, bucket]) => {
      const samples = bucket.samples;
      const accuracy = samples ? bucket.accuracy / samples : 0;
      const completion = samples ? bucket.completion / samples : 0;
      return {
        level: Number(level),
        samples,
        accuracy,
        completion,
        mastered: samples >= APPLIED_NUMERACY_MASTERY.minSamples
          && accuracy >= APPLIED_NUMERACY_MASTERY.accuracy
          && completion >= APPLIED_NUMERACY_MASTERY.completion,
      };
    }),
  };
}

/**
 * Current mastered-but-inactive skills eligible for re-verification tracking:
 *   - multiplication / Powers rungs strictly BELOW the resolved current level
 *     (you've moved past them, so they're no longer actively drilled),
 *   - cognitive rungs strictly below the current level, per laddered type.
 * Memory items own their durable-mastery + one-time spot-check lifecycle in
 * meatspacePostMemory.js, so they are intentionally not duplicated here.
 * Returns opaque skill descriptors the review scheduler upserts + schedules.
 */
export async function getMasteredSkills() {
  const skills = [];

  const [mul, powers, cog, numeracy] = await Promise.all([
    getMultiplicationProgress(),
    getPowersProgress(),
    getCognitiveProgress(),
    getAppliedNumeracyProgress(),
  ]);
  for (const rung of mul.levels || []) {
    if (rung.mastered && rung.level < mul.level) {
      skills.push({
        skillId: `multiplication:L${rung.level}`,
        kind: 'multiplication',
        label: `Multiplication ${rung.label}`,
        drillType: 'multiplication',
        module: 'mental-math',
        level: rung.level,
        factors: rung.factors,
      });
    }
  }

  for (const rung of powers.levels || []) {
    if (rung.mastered && rung.level < powers.level) {
      skills.push({
        skillId: `powers:L${rung.level}`,
        kind: 'powers',
        label: `Powers ${rung.label}`,
        drillType: 'powers',
        module: 'mental-math',
        level: rung.level,
        config: { technique: rung.technique },
      });
    }
  }

  for (const [type, prog] of Object.entries(cog)) {
    if (!prog) continue;
    for (const rung of prog.levels || []) {
      if (rung.mastered && rung.level < prog.level) {
        skills.push({
          skillId: `cognitive:${type}:L${rung.level}`,
          kind: 'cognitive',
          label: `${type} ${rung.label}`,
          drillType: type,
          module: 'cognitive',
          level: rung.level,
          config: cognitiveLevelConfig(type, rung.level),
        });
      }
    }
  }

  for (const rung of numeracy.levels || []) {
    if (!rung.mastered) continue;
    skills.push({
      skillId: `applied-numeracy:D${rung.level}`,
      kind: APPLIED_NUMERACY_DRILL_TYPE,
      label: `Applied Numeracy level ${rung.level}`,
      drillType: APPLIED_NUMERACY_DRILL_TYPE,
      module: 'mental-math',
      difficulty: rung.level,
    });
  }

  return skills;
}

/**
 * Extract, from a scored session, which tracked skills were exercised:
 *   - `reviewResults`: maintenance-review reps (tasks whose config carries a
 *     `reviewSkillId`), pass/fail decided by the task's answered accuracy.
 *   - `practicedSkillIds`: mastered skills a NORMAL (non-review) task drilled,
 *     so their staleness clock resets (an actively-used skill never goes stale).
 */
export function getSessionSkillContext(session) {
  const practicedSkillIds = new Set();
  const reviewResults = [];
  for (const task of session?.tasks || []) {
    const cfg = task.config || {};
    if (cfg.reviewSkillId) {
      // A review passes only when it's both accurate AND sufficiently completed:
      // accuracy is answered-only, so without the completion gate answering one
      // question correctly and skipping the rest would bank a "pass" (acc===1)
      // and push the interval out without actually re-verifying the skill. A
      // low-completion attempt is recorded as a FAIL → needs-refresh + sooner
      // re-review, which is the safe outcome for a bailed review.
      const acc = deriveTaskAccuracy(task);
      const completion = deriveTaskCompletion(task);
      const passed = acc != null && acc >= MASTERY_TARGET_ACCURACY
        && (completion == null || completion >= MIN_REVIEW_COMPLETION);
      reviewResults.push({ skillId: cfg.reviewSkillId, passed });
      continue;
    }
    if (task.type === 'multiplication' && Number.isInteger(cfg.level)) {
      practicedSkillIds.add(`multiplication:L${cfg.level}`);
    } else if (task.type === 'powers' && Number.isInteger(cfg.level)) {
      practicedSkillIds.add(`powers:L${cfg.level}`);
    } else if (cognitiveLadder(task.type) && Number.isInteger(cfg.level)) {
      practicedSkillIds.add(`cognitive:${task.type}:L${cfg.level}`);
    } else if (task.type === APPLIED_NUMERACY_DRILL_TYPE) {
      const difficulty = APPLIED_NUMERACY_DIFFICULTIES.includes(cfg.difficulty) ? cfg.difficulty : 1;
      practicedSkillIds.add(`applied-numeracy:D${difficulty}`);
    } else if (task.memoryItemId) {
      for (const q of task.questions || []) {
        if (q?.chunkId) practicedSkillIds.add(`memory:${task.memoryItemId}:${q.chunkId}`);
      }
    }
  }
  return { practicedSkillIds: [...practicedSkillIds], reviewResults };
}

/** Reconcile the review schedule against a just-completed scored session. */
export async function syncReviewScheduleForSession(session, now = new Date()) {
  const masteredSkills = await getMasteredSkills();
  const { practicedSkillIds, reviewResults } = getSessionSkillContext(session);
  return applySessionToReviewSchedule({ masteredSkills, practicedSkillIds, reviewResults, now });
}

function mean(list) {
  return list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
}

// Accumulate one task's metrics into a `key -> (date -> bucket)` map, so a
// domain/drill series can aggregate multiple same-day tasks into one point.
function pushMetricSeries(map, key, date, score, accuracy, avgResponseMs) {
  if (key == null) return;
  let byDate = map.get(key);
  if (!byDate) { byDate = new Map(); map.set(key, byDate); }
  let bucket = byDate.get(date);
  if (!bucket) { bucket = { scores: [], accs: [], resp: [] }; byDate.set(date, bucket); }
  if (typeof score === 'number' && !Number.isNaN(score)) bucket.scores.push(score);
  if (accuracy != null) bucket.accs.push(accuracy);
  if (avgResponseMs != null) bucket.resp.push(avgResponseMs);
}

// Finalize a `key -> (date -> bucket)` map into `key -> [{ date, score,
// accuracy, avgResponseMs, count }]`, chronologically sorted. `count` is the
// number of score samples bucketed into that day — for a series pushed once
// per session (e.g. the benchmark trend) that's the session count; for a
// series pushed once per task (byDomain/byDrill) it's the task count.
function finalizeMetricSeries(map) {
  const out = {};
  for (const [key, byDate] of map) {
    out[key] = Array.from(byDate.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, b]) => {
        const acc = mean(b.accs);
        const resp = mean(b.resp);
        const score = mean(b.scores);
        return {
          date,
          score: score == null ? null : Math.round(score),
          accuracy: acc == null ? null : acc,
          avgResponseMs: resp == null ? null : Math.round(resp),
          count: b.scores.length,
        };
      });
  }
  return out;
}

/**
 * Time-series progress across scored sessions, the training log, and memory
 * mastery — the data behind the unified Progress dashboard (issue #2091).
 *
 * - `series.byDay`     per-day buckets (same-day sessions aggregated) of score,
 *   accuracy, avg response time, minutes, and session count.
 * - `series.byDomain`  per-day series keyed by coarse module (`mental-math`, …).
 * - `series.byDrill`   per-day series keyed by drill type (`multiplication`, …).
 * - `series.benchmark` protocol-scoped trend: only sessions run under the
 *   CURRENT `POST_BENCHMARK_PROTOCOL` (protocolId+protocolVersion+
 *   scorerVersion), with `excludedCount` covering benchmark runs under a
 *   retired protocol/scorer version (issue #4442). Ordinary Quick/Test/Train
 *   sessions never appear here at all.
 * - `totals`           minutes trained (sessions + practice), session count,
 *   practice-entry count over the window.
 * - `streak`           ONE unified streak (sessions OR training-log activity),
 *   computed over ALL history like `getPostStats`.
 * - `mastery`          multiplication/cognitive ladder evidence + memory items.
 *
 * Accuracy/speed are reported separately (issue #2094): the persisted per-task
 * `accuracy`/`avgResponseMs` are preferred, with a per-question derivation
 * fallback for legacy sessions.
 */
export async function getPostProgress({ days = 90 } = {}) {
  const atDate = new Date();
  const timezone = await getUserTimezone();
  const todayStr = todayInTimezone(timezone, atDate);
  const window = Number.isFinite(days) && days > 0 ? Math.min(days, 365) : 0;

  const allSessions = await getPostSessions();
  const allTraining = await getAllTrainingEntries();

  // Unified streak is computed over ALL history, independent of the window.
  const streak = computeUnifiedStreak(allSessions, allTraining, todayStr, timezone);

  let cutoffStr = null;
  if (window > 0) {
    cutoffStr = new Date(ymdToUTC(todayStr) - window * 86400000).toISOString().split('T')[0];
  }
  const sessions = cutoffStr
    ? allSessions.filter(s => {
      const date = recordDayKey(s, timezone);
      return date && date >= cutoffStr;
    })
    : allSessions;
  const training = cutoffStr
    ? allTraining.filter(e => {
      const date = recordDayKey(e, timezone);
      return date && date >= cutoffStr;
    })
    : allTraining;

  // Per-day buckets for the headline trends, plus per-domain/per-drill series.
  const dayMap = new Map();      // date -> { scores, accs, resp, minutes, sessions }
  const domainMap = new Map();   // module -> Map(date -> metric bucket)
  const drillMap = new Map();    // type   -> Map(date -> metric bucket)
  // Protocol-scoped series (issue #4442): pushed through the SAME date-bucket
  // aggregator as byDomain/byDrill below, under a single constant key, so a
  // benchmark trend is "filter + reuse the existing bucketer" rather than a
  // bespoke Map/ensure/finalize block. Only sessions run under the CURRENT
  // POST_BENCHMARK_PROTOCOL contribute, so the trend never blends across a
  // protocol/scorer version change or with ordinary Quick/Test/Train
  // sessions. `excludedCount` surfaces what was left out (benchmark runs
  // under a retired version) so the UI can say so rather than silently
  // under-counting.
  const benchmarkMap = new Map();
  let benchmarkExcludedCount = 0;

  const ensureDay = (date) => {
    let d = dayMap.get(date);
    if (!d) { d = { scores: [], accs: [], resp: [], minutes: 0, sessions: 0 }; dayMap.set(date, d); }
    return d;
  };

  for (const s of sessions) {
    const date = recordDayKey(s, timezone);
    if (!date) continue;
    const day = ensureDay(date);
    day.sessions += 1;
    day.minutes += (s.durationMs || 0) / 60000;
    if (typeof s.score === 'number' && !Number.isNaN(s.score)) day.scores.push(s.score);

    const compat = benchmarkCompatibility(s);
    if (compat === 'compatible') {
      pushMetricSeries(benchmarkMap, 'benchmark', date, s.score, null, null);
    } else if (compat === 'legacy') {
      benchmarkExcludedCount += 1;
    }

    const sessionAccs = [];
    const sessionResp = [];
    for (const task of s.tasks || []) {
      const acc = deriveTaskAccuracy(task);
      const resp = deriveTaskAvgResponseMs(task);
      if (acc != null) sessionAccs.push(acc);
      if (resp != null) sessionResp.push(resp);
      pushMetricSeries(domainMap, task.module, date, task.score, acc, resp);
      pushMetricSeries(drillMap, task.type, date, task.score, acc, resp);
    }
    const sAcc = mean(sessionAccs);
    if (sAcc != null) day.accs.push(sAcc);
    const sResp = mean(sessionResp);
    if (sResp != null) day.resp.push(sResp);
  }

  // Practice time (Morse / memory) folds into each day's minutes — a practice-
  // only day still shows time-in-training even with no scored session.
  for (const e of training) {
    const date = recordDayKey(e, timezone);
    if (!date) continue;
    ensureDay(date).minutes += (e.totalMs || 0) / 60000;
    const task = trainingEntryTask(e);
    const accuracy = deriveTaskAccuracy(task);
    const responseMs = deriveTaskAvgResponseMs(task);
    // Training updates skill/domain evidence, but it does not enter the scored
    // benchmark headline (`byDay.score`, session count, or overall score).
    pushMetricSeries(domainMap, task.module, date, task.score, accuracy, responseMs);
    pushMetricSeries(drillMap, task.type, date, task.score, accuracy, responseMs);
  }

  const byDay = Array.from(dayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => {
      const score = mean(d.scores);
      const acc = mean(d.accs);
      const resp = mean(d.resp);
      return {
        date,
        score: score == null ? null : Math.round(score),
        accuracy: acc == null ? null : acc,
        avgResponseMs: resp == null ? null : Math.round(resp),
        minutes: Math.round(d.minutes),
        sessions: d.sessions,
      };
    });

  const benchmarkByDay = (finalizeMetricSeries(benchmarkMap).benchmark || [])
    .map(({ date, score, count }) => ({ date, score, sessions: count }));

  const sessionMs = sessions.reduce((sum, s) => sum + (s.durationMs || 0), 0);
  const trainingMs = training.reduce((sum, e) => sum + (e.totalMs || 0), 0);

  // Mastery block: multiplication + cognitive ladder evidence and per-item
  // memory mastery/due. Cognitive entries retain every exact-rung measure used
  // to promote or hold so the Progress UI can explain the decision.
  const [mulProgress, cognitiveProgress, memoryItems, dueItems, reviews] = await Promise.all([
    getMultiplicationProgress(),
    getCognitiveProgress(),
    getMemoryItems(),
    getDueMemoryItems(),
    getRetentionReport(new Date()),
  ]);
  const dueIds = new Set(dueItems.map(i => i.id));
  // Skill re-verification retention state (issue #2096): per-skill fresh / due /
  // needs-refresh + a 90-day retention %. Empty on fresh installs (nothing
  // tracked until the first skill is mastered).
  return {
    days: window,
    series: {
      byDay,
      byDomain: finalizeMetricSeries(domainMap),
      byDrill: finalizeMetricSeries(drillMap),
      // Protocol-scoped benchmark trend (issue #4442) — additive, does not
      // change `byDay`'s existing blended-score semantics. `byDay` above
      // stays the general activity headline; this is the narrower "only
      // compatible, versioned benchmark runs" comparison the issue's
      // acceptance criteria require, with legacy/incompatible sessions
      // visibly excluded via `excludedCount` rather than silently dropped.
      benchmark: {
        protocolId: POST_BENCHMARK_PROTOCOL.protocolId,
        protocolVersion: POST_BENCHMARK_PROTOCOL.protocolVersion,
        scorerVersion: POST_BENCHMARK_PROTOCOL.scorerVersion,
        byDay: benchmarkByDay,
        excludedCount: benchmarkExcludedCount,
      },
    },
    totals: {
      minutesTrained: Math.round((sessionMs + trainingMs) / 60000),
      sessions: sessions.length,
      practiceEntries: training.length,
    },
    streak,
    mastery: {
      multiplication: {
        level: mulProgress.level,
        description: mulProgress.label,
        floorLevel: mulProgress.floorLevel,
      },
      cognitive: cognitiveProgress,
      memoryItems: memoryItems.map(it => ({
        id: it.id,
        title: it.title,
        overallPct: it.mastery?.overallPct ?? 0,
        // 0/1 per item so the client can sum to a total "due" count.
        dueCount: dueIds.has(it.id) ? 1 : 0,
      })),
      reviews,
    },
  };
}

/**
 * Aggregate multiplication performance per ladder level from scored history,
 * so the progressive ladder can decide whether each level has been *speed*
 * mastered. Only answered questions count as samples; each contributes its
 * correctness and clamped response time.
 *
 * Returns both the windowed per-level stats (for the mastery decision) and the
 * `floorLevel` — the highest rung the user has EVER generated (all-time, NOT
 * windowed). The floor is the anti-demotion signal: mastery is judged over a
 * rolling window, so a rung's samples fall to 0 once its evidence ages out, but
 * a user only reaches a higher rung by clearing the ones below it, so that
 * earned progress must survive the window (see resolveMultiplicationLevel).
 *
 * @returns {Promise<{stats: Record<number, {samples,accuracy,avgResponseMs}>, floorLevel: number}>}
 */
export async function getMultiplicationLevelStats(windowDays = MASTERY_DEFAULTS.windowDays) {
  const atDate = new Date();
  const [scoredSessions, training] = await Promise.all([getPostSessions(), getAllTrainingEntries()]);
  const sessions = skillEvidenceSessions(scoredSessions, training);
  // Window off the user's local today (DST-safe day math) so the cutoff stays
  // consistent with the tz-correct session dates submitPostSession now stamps
  // (issue #2681) — a UTC-day cutoff would skew the window edge by the tz offset.
  const timezone = await getUserTimezone();
  const todayStr = todayInTimezone(timezone, atDate);
  const cutoffStr = windowDays > 0 ? ymdShift(todayStr, -windowDays) : null;

  const byLevel = {};
  let floorLevel = 0;
  for (const session of sessions) {
    for (const task of session.tasks || []) {
      if (task.type !== 'multiplication') continue;
      const level = Number.isInteger(task.config?.level) ? task.config.level : null;
      if (level == null) continue; // legacy maxDigits-only tasks carry no level
      // All-time floor: any answered question at this level (regardless of the
      // window) proves the user reached — and thus earned — this rung.
      const anyAnswered = (task.questions || []).some(q => q?.answered != null);
      if (anyAnswered && level > floorLevel) floorLevel = level;
      // Mastery stats are windowed — skip out-of-window sessions for the buckets.
      const date = recordDayKey(session, timezone);
      if (cutoffStr && (!date || date < cutoffStr)) continue;
      const bucket = byLevel[level] || (byLevel[level] = { samples: 0, correct: 0, totalResponseMs: 0 });
      for (const q of task.questions || []) {
        if (q?.answered == null) continue;
        bucket.samples += 1;
        if (q.correct) bucket.correct += 1;
        // Clamp so one walked-away answer can't inflate avgResponseMs and block
        // mastery (mirrors scoreDrill's per-question clamp).
        bucket.totalResponseMs += Math.min(Math.max(0, q.responseMs || 0), MASTERY_DEFAULTS.responseMsCap);
      }
    }
  }

  const stats = {};
  for (const [level, b] of Object.entries(byLevel)) {
    stats[level] = {
      samples: b.samples,
      accuracy: b.samples ? b.correct / b.samples : 0,
      avgResponseMs: b.samples ? b.totalResponseMs / b.samples : 0,
    };
  }
  return { stats, floorLevel };
}

export async function getPowersLevelStats(windowDays = POWERS_MASTERY_DEFAULTS.windowDays) {
  const atDate = new Date();
  const [scoredSessions, training] = await Promise.all([getPostSessions(), getAllTrainingEntries()]);
  const sessions = skillEvidenceSessions(scoredSessions, training);
  const timezone = await getUserTimezone();
  const todayStr = todayInTimezone(timezone, atDate);
  const cutoffStr = windowDays > 0 ? ymdShift(todayStr, -windowDays) : null;
  const byLevel = {};
  let floorLevel = 0;
  for (const session of sessions) {
    for (const task of session.tasks || []) {
      if (task.type !== 'powers') continue;
      const level = Number.isInteger(task.config?.level) ? task.config.level : null;
      if (level == null) continue;
      const anyAnswered = (task.questions || []).some(question => question?.answered != null);
      if (anyAnswered && level > floorLevel) floorLevel = level;
      const date = recordDayKey(session, timezone);
      if (cutoffStr && (!date || date < cutoffStr)) continue;
      for (const question of task.questions || []) {
        if (question?.answered == null) continue;
        const match = typeof question.prompt === 'string' ? question.prompt.match(/^(\d+)\^(\d+)$/) : null;
        const pair = match ? powersTechniqueForPair(Number(match[1]), Number(match[2])) : null;
        // Progressive pools are cumulative for review, but mastery belongs to
        // the technique that actually covered this question. Otherwise quick
        // recall reps in a later-rung session could unlock that rung without
        // the user ever answering one of its new pairs.
        const sampleLevel = pair?.level ?? level;
        const bucket = byLevel[sampleLevel] || (byLevel[sampleLevel] = { samples: 0, correct: 0, totalResponseMs: 0 });
        bucket.samples += 1;
        if (question.correct) bucket.correct += 1;
        bucket.totalResponseMs += Math.min(
          Math.max(0, question.responseMs || 0),
          POWERS_MASTERY_DEFAULTS.responseMsCap
        );
      }
    }
  }
  return {
    stats: Object.fromEntries(Object.entries(byLevel).map(([level, bucket]) => [level, {
      samples: bucket.samples,
      accuracy: bucket.samples ? bucket.correct / bucket.samples : 0,
      avgResponseMs: bucket.samples ? bucket.totalResponseMs / bucket.samples : 0,
    }])),
    floorLevel,
  };
}

/**
 * Resolve the current progressive-multiplication difficulty from history.
 * Exposed for the config UI / route so it can show the ladder + mastery status.
 */
export async function getMultiplicationProgress() {
  const { stats, floorLevel } = await getMultiplicationLevelStats(MASTERY_DEFAULTS.windowDays);
  const progression = resolveMultiplicationLevel(stats, {}, floorLevel);
  return { ...progression, windowDays: MASTERY_DEFAULTS.windowDays, thresholds: { minSamples: MASTERY_DEFAULTS.minSamples, targetAccuracy: MASTERY_DEFAULTS.targetAccuracy } };
}

export async function getPowersProgress() {
  const { stats, floorLevel } = await getPowersLevelStats(POWERS_MASTERY_DEFAULTS.windowDays);
  const progression = resolvePowersLevel(stats, {}, floorLevel);
  return {
    ...progression,
    windowDays: POWERS_MASTERY_DEFAULTS.windowDays,
    thresholds: {
      minSamples: POWERS_MASTERY_DEFAULTS.minSamples,
      targetAccuracy: POWERS_MASTERY_DEFAULTS.targetAccuracy,
    },
  };
}

/**
 * Aggregate a laddered cognitive drill's performance per level from scored
 * history so its ladder can decide whether each rung is mastered. A "sample"
 * is one completion-qualified drill (not one answered question), bucketed by
 * its exact stamped level. Each task contributes task-level accuracy (balanced
 * SDT accuracy for n-back, #2094) and response latency for the two speed-gated
 * skills. Incomplete attempts remain visible but do not bank mastery samples.
 *
 * Returns the windowed per-level stats plus the all-time `floorLevel` (the
 * highest rung ever reached), the anti-demotion signal for resolveLevel.
 *
 * @returns {Promise<{stats: Record<number, {samples,attempts,accuracy,completion,incompleteSamples,avgResponseMs}>, floorLevel: number}>}
 */
export async function getCognitiveLevelStats(type, windowDays = COGNITIVE_MASTERY_DEFAULTS.windowDays) {
  const atDate = new Date();
  const [scoredSessions, training] = await Promise.all([getPostSessions(), getAllTrainingEntries()]);
  const sessions = skillEvidenceSessions(scoredSessions, training);
  // Window off the user's local today (DST-safe) so the cutoff stays consistent
  // with the tz-correct session dates submitPostSession now stamps (issue #2681).
  const timezone = await getUserTimezone();
  const todayStr = todayInTimezone(timezone, atDate);
  const cutoffStr = windowDays > 0 ? ymdShift(todayStr, -windowDays) : null;

  const byLevel = {};
  let floorLevel = 0;
  for (const session of sessions) {
    for (const task of session.tasks || []) {
      if (task.type !== type) continue;
      const level = Number.isInteger(task.config?.level) ? task.config.level : null;
      if (level == null) continue; // pre-#2095 tasks carry no level
      // All-time floor: any reached (non-empty) drill at this level proves the
      // user earned the rung, regardless of the window.
      const reached = ((task.totalCount ?? (task.questions?.length || 0)) > 0);
      if (reached && level > floorLevel) floorLevel = level;
      // Mastery stats are windowed.
      const date = recordDayKey(session, timezone);
      if (cutoffStr && (!date || date < cutoffStr)) continue;
      const acc = deriveTaskAccuracy(task);
      const derivedComp = deriveTaskCompletion(task);
      const comp = derivedComp == null ? 1 : derivedComp;
      const bucket = byLevel[level] || (byLevel[level] = {
        attempts: 0,
        samples: 0,
        incompleteSamples: 0,
        accSum: 0,
        completionSum: 0,
        responseSamples: 0,
        totalResponseMs: 0,
      });
      bucket.attempts += 1;
      bucket.completionSum += comp;
      // Skip low-completion runs: accuracy is answered-only, so a run that
      // leaves the harder trials blank must not bank a high-accuracy sample and
      // promote the rung (issue #2095 review). A null completion (legacy tasks)
      // is treated as complete so old history still counts.
      if (acc == null || comp < COGNITIVE_MASTERY_DEFAULTS.minCompletion) {
        bucket.incompleteSamples += 1;
        continue;
      }
      bucket.samples += 1;
      bucket.accSum += acc;
      const responseMs = deriveTaskAvgResponseMs(task);
      if (responseMs != null && responseMs > 0) {
        bucket.responseSamples += 1;
        bucket.totalResponseMs += Math.min(responseMs, COGNITIVE_MASTERY_DEFAULTS.responseMsCap);
      }
    }
  }

  const stats = {};
  for (const [level, b] of Object.entries(byLevel)) {
    stats[level] = {
      samples: b.samples,
      attempts: b.attempts,
      accuracy: b.samples ? b.accSum / b.samples : 0,
      completion: b.attempts ? b.completionSum / b.attempts : 0,
      incompleteSamples: b.incompleteSamples,
      timedSamples: b.responseSamples,
      avgResponseMs: b.responseSamples ? b.totalResponseMs / b.responseSamples : 0,
    };
  }
  return { stats, floorLevel };
}

/**
 * Resolve the current progressive difficulty for every laddered cognitive drill
 * from history — the current rung + per-rung mastery for the config/preview UI.
 * Keyed by drill type (`{ 'n-back': {...}, 'digit-span': {...}, … }`).
 */
export async function getCognitiveProgress() {
  const out = {};
  for (const type of COGNITIVE_LADDER_TYPES) {
    const { stats, floorLevel } = await getCognitiveLevelStats(type);
    out[type] = resolveCognitiveProgression(type, stats, floorLevel);
  }
  return out;
}
