/**
 * MeatSpace POST (Power On Self Test) Service
 *
 * Drill generators, scoring, and session CRUD for cognitive self-tests.
 * Reads/writes to meatspace data files.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { atomicWrite, PATHS, ensureDir, readJSONFile } from '../lib/fileUtils.js';
import { deepMerge, isPlainObject } from '../lib/objects.js';
import { LLM_DRILL_TYPES, MEMORY_DRILL_TYPES, POST_SUPPORTED_MEMORY_TYPES } from '../lib/postValidation.js';
import { adaptDrillConfig, ADAPTIVE_SPECS, ADAPTIVE_DEFAULTS } from '../lib/postAdaptive.js';
import { resolveMultiplicationLevel, MASTERY_DEFAULTS } from '../lib/postMultiplicationLadder.js';
import { COGNITIVE_DRILL_TYPES, generateCognitiveDrill, scoreCognitiveDrill } from './meatspacePostCognitive.js';
import { advanceScheduleFromSession, mergeMasteryFromSession, getMemoryItems, getDueMemoryItems } from './meatspacePostMemory.js';
import { getAllTrainingEntries } from './meatspacePostTraining.js';
import { computePostStreaks, computeUnifiedStreak, ymdToUTC } from '../lib/postStreak.js';

// Re-export the shared streak helper so existing importers of
// `computePostStreaks` from this module keep working after it moved to
// server/lib/postStreak.js (single implementation — see that file).
export { computePostStreaks };

const MEATSPACE_DIR = PATHS.meatspace;
const SESSIONS_FILE = join(MEATSPACE_DIR, 'post-sessions.json');
const CONFIG_FILE = join(MEATSPACE_DIR, 'post-config.json');

// Tiny pub/sub (mirrors settingsEvents in server/services/settings.js) so
// features that react to a specific config slice — e.g. meatspacePostReminder.js
// rescheduling its cron when `reminder` changes — can subscribe without
// meatspacePost.js importing back into them (which would create a service
// cycle). This is what makes updatePostConfig() the single place ANY current
// or future caller gets slice-specific side effects "for free", instead of
// each route handler having to remember to bolt one on (#2015).
export const postConfigEvents = new EventEmitter();

const DEFAULT_CONFIG = {
  mentalMath: {
    enabled: true,
    drillTypes: {
      'doubling-chain': { enabled: true, steps: 8, timeLimitSec: 60 },
      'serial-subtraction': { enabled: true, steps: 10, subtrahend: 7, startRange: [100, 200], timeLimitSec: 90 },
      // `progressive` (default ON) makes multiplication ramp up a mastery-gated
      // difficulty ladder (server/lib/postMultiplicationLadder.js) starting at
      // single-digit × single-digit, instead of jumping straight to the fixed
      // `maxDigits` difficulty. `maxDigits` is retained as the fallback for when
      // a user turns the progressive ladder off.
      'multiplication': { enabled: true, count: 10, maxDigits: 2, progressive: true, timeLimitSec: 120 },
      'powers': { enabled: true, bases: [2, 3, 5], maxExponent: 10, count: 8, timeLimitSec: 90 },
      'estimation': { enabled: true, count: 5, tolerancePct: 10, timeLimitSec: 120 }
    }
  },
  llmDrills: {
    enabled: true,
    providerId: null,
    model: null,
    drillTypes: {
      'word-association': { enabled: true, count: 5, timeLimitSec: 120 },
      'story-recall': { enabled: true, count: 3, timeLimitSec: 180 },
      'verbal-fluency': { enabled: true, count: 3, timeLimitSec: 60 },
      'wit-comeback': { enabled: true, count: 5, timeLimitSec: 120 },
      'pun-wordplay': { enabled: true, count: 5, timeLimitSec: 120 }
    }
  },
  // Deterministic cognitive drills (working-memory / attention / inhibition).
  // No provider calls — enabled by default since they're free to run. No
  // timeLimitSec — these drills are self-paced/stimulus-driven and never
  // enforce a countdown (see client PostCognitiveDrillRunner.jsx / issue #2008).
  cognitive: {
    enabled: true,
    drillTypes: {
      'n-back': { enabled: true, n: 2, length: 20 },
      'digit-span': { enabled: true, direction: 'forward', startLength: 3, maxLength: 8 },
      'stroop': { enabled: true, count: 15 },
      'schulte-table': { enabled: true, size: 5 },
      'mental-rotation': { enabled: true, count: 8 },
      'reaction-time': { enabled: true, mode: 'simple', count: 15, minDelayMs: 1000, maxDelayMs: 3000, choices: 3 }
    }
  },
  sessionModules: ['mental-math'],
  scoring: { weights: { 'mental-math': 1.0, 'llm-drills': 1.0, 'cognitive': 1.0 } },
  // Opt-in adaptive difficulty (default OFF). When enabled, math drills are
  // nudged harder/easier at generation time from recent scored performance.
  adaptive: { enabled: false },
  // Opt-in daily reminder (default OFF, off-by-default per CLAUDE.md's
  // single-user/no-surprise-background-behavior convention). When enabled,
  // meatspacePostReminder.js fires a deterministic (no-LLM) in-app notification
  // at `time` (HH:MM, user's configured timezone) if today's POST is incomplete.
  reminder: { enabled: false, time: '09:00' }
};

// Math tasks are logged under this coarse module in scored sessions, so the
// adaptive signal reads `byDrill['mental-math:<type>']`.
const MATH_MODULE = 'mental-math';

async function ensureMeatspaceDir() {
  await ensureDir(MEATSPACE_DIR);
}

// =============================================================================
// CONFIG
// =============================================================================

export async function getPostConfig() {
  const baseDefaults = structuredClone(DEFAULT_CONFIG);
  const config = await readJSONFile(CONFIG_FILE, baseDefaults);
  return deepMerge(baseDefaults, config);
}

export async function updatePostConfig(updates) {
  const config = await getPostConfig();
  const merged = deepMerge(config, updates);
  if (updates?.reminder) {
    // Stamp WHEN the reminder's enabled/time settings last changed. Read by
    // meatspacePostReminder.js's missed-slot catch-up: a cron occurrence
    // that fell before this timestamp happened under a DIFFERENT (possibly
    // disabled) configuration, so replaying it after a restart would nag for
    // a slot the current settings never actually owned — e.g. enabling the
    // reminder for an already-past time today, then restarting later that
    // same day, would otherwise catch up a slot the reminder wasn't even
    // active for.
    merged.reminder = { ...merged.reminder, updatedAt: new Date().toISOString() };
  }
  await ensureMeatspaceDir();
  await atomicWrite(CONFIG_FILE, merged);
  console.log(`🧪 POST config updated`);
  // Emit AFTER the write succeeds so a subscriber (reminder rescheduler, etc.)
  // never reacts to a config change that didn't actually persist. `updates` is
  // included (not just `merged`) so subscribers can gate on which slice was
  // touched rather than re-evaluating on every unrelated save.
  postConfigEvents.emit('post-config:updated', { config: merged, updates });
  return merged;
}

// =============================================================================
// SESSIONS
// =============================================================================

async function loadSessions() {
  const raw = await readJSONFile(SESSIONS_FILE, { sessions: [] }, { allowArray: false });
  const data = isPlainObject(raw) ? raw : { sessions: [] };
  if (!Array.isArray(data.sessions)) data.sessions = [];
  return data;
}

export async function getPostSessions(from, to) {
  const data = await loadSessions();
  let sessions = data.sessions;
  if (from) sessions = sessions.filter(s => s.date >= from);
  if (to) sessions = sessions.filter(s => s.date <= to);
  return sessions;
}

export async function getPostSession(id) {
  const data = await loadSessions();
  return data.sessions.find(s => s.id === id) || null;
}

export async function submitPostSession(sessionData) {
  const config = await getPostConfig();
  const data = await loadSessions();
  const now = new Date().toISOString();

  // Strip client-provided score/correct — plus every separated metric field
  // (issue #2094) — and recompute server-side. Stripping up front means the
  // LLM/memory branches (which trust the client `score` but never carry these
  // metrics) can't persist stale client-sent values that stats aggregation
  // would then prefer over a questions[] derivation.
  const rawTasks = Array.isArray(sessionData.tasks) ? sessionData.tasks : [];
  const rescoredTasks = rawTasks.map(t => {
    const {
      score: _score, correct: _correct,
      accuracy: _acc, completion: _comp, avgResponseMs: _avg,
      answeredCount: _ac, totalCount: _tc, medianMs: _med, bestMs: _best, span: _span,
      hits: _h, misses: _m, falseAlarms: _fa, correctRejections: _cr,
      ...rest
    } = t || {};

    // LLM drills: score was computed server-side via /post/score-llm and
    // passed back by the client. Re-scoring here would add latency + cost.
    // This is a single-user internal tool so client score trust is acceptable.
    // The evaluation field and per-response llmScore/llmFeedback contain the server-generated breakdown.
    if (LLM_DRILL_TYPES.includes(rest.type)) {
      return { ...rest, score: t.score || 0 };
    }

    // Memory drills: trust client-side scoring only for supported types
    if (POST_SUPPORTED_MEMORY_TYPES.includes(rest.type)) {
      return { ...rest, score: t.score || 0 };
    }
    // Unsupported memory drills (e.g. memory-fill-blank): preserve data, zero score
    if (MEMORY_DRILL_TYPES.includes(rest.type)) {
      return { ...rest, score: 0 };
    }

    // Cognitive drills: deterministic — recompute the answer key from the
    // generated drillData (never trust client `correct`/`score`). Spread the
    // full scored bundle so the separated metrics (accuracy/completion/
    // avgResponseMs, plus n-back SDT counts and reaction-time median/best) are
    // persisted alongside the blended score (issue #2094).
    if (COGNITIVE_DRILL_TYPES.includes(rest.type)) {
      const scored = scoreCognitiveDrill(rest.type, rest.drillData, rest.questions || []);
      return { ...rest, ...scored };
    }

    // Math drills: strip correct from individual questions and rescore
    const sanitizedQuestions = (rest.questions || []).map(q => {
      const { correct: _qCorrect, ...qRest } = q;
      return qRest;
    });
    const drillConfig = config.mentalMath?.drillTypes?.[rest.type] || {};
    const timeLimitMs = (drillConfig.timeLimitSec || 120) * 1000;
    const scored = scoreDrill(rest.type, sanitizedQuestions, timeLimitMs, rest.config || drillConfig);
    return { ...rest, ...scored };
  });

  const session = {
    id: randomUUID(),
    date: now.split('T')[0],
    startedAt: now,
    completedAt: now,
    durationMs: rescoredTasks.reduce((sum, t) => sum + (t.totalMs || 0), 0),
    cadence: sessionData.cadence || 'daily',
    modules: sessionData.modules,
    tasks: rescoredTasks,
    score: computeSessionScore(rescoredTasks),
    tags: sessionData.tags || {}
  };

  data.sessions.push(session);
  data.sessions.sort((a, b) => a.date.localeCompare(b.date));
  await ensureMeatspaceDir();
  await atomicWrite(SESSIONS_FILE, data);
  console.log(`🧪 POST session saved: score=${session.score} modules=${session.modules.join(',')}`);

  // A memory drill completed inside this session IS a review — mirror the
  // dedicated MemoryBuilder practice flow (submitPractice) and advance each
  // drilled item's spaced-repetition schedule, so it reschedules and clears
  // from "Due Today" just like a direct MemoryBuilder practice session would.
  // Ratio comes from raw correctness (not `score`, which also folds in a speed
  // bonus) to match the accuracy signal `advanceSchedule` expects. Chunk/element
  // MASTERY is also merged (mergeMasteryFromSession) using the chunkId/element
  // attribution usePostSession.js's submitAnswer now preserves per-question —
  // the other half of submitPractice's bookkeeping, deferred out of #2010 into
  // #2016 until the client carried that attribution.
  // Sequential, not Promise.all: advanceScheduleFromSession/mergeMasteryFromSession
  // each do a full read-modify-write of the shared memory-items file with no
  // write queue, so two tasks (or two calls for the same task) resolved
  // concurrently could race and drop an update (last write wins). A session
  // rarely has more than 1-2 memory tasks, so the latency cost of awaiting
  // each is negligible.
  for (const task of rescoredTasks) {
    if (!POST_SUPPORTED_MEMORY_TYPES.includes(task.type) || !task.memoryItemId) continue;
    const total = task.questions?.length || 0;
    const correct = task.questions?.filter(q => q.correct).length || 0;
    const ratio = total ? correct / total : 0;
    await advanceScheduleFromSession(task.memoryItemId, ratio, new Date(now));
    await mergeMasteryFromSession(task.memoryItemId, task.questions, new Date(now));
  }

  return session;
}

/**
 * Answered-only accuracy for a scored task, tolerant of legacy sessions that
 * predate the persisted `accuracy` field (issue #2094). Order: the stored value
 * first, else derive from `questions[]` (correct over ANSWERED, not total), else
 * `null` — never NaN. Used by stats aggregation and the adaptive signal so old
 * and new session shapes both read cleanly.
 */
/**
 * Balanced (signal-detection) accuracy for n-back questions, derived from only
 * `answered` + `correct` — fields both legacy stored sessions and pre-save
 * client results carry. Works because `correct` was always computed as
 * "(pressed ? match : no-match) === expected", so `isTarget = pressed === correct`
 * is an identity across old and new scorers. A missing signal class counts as
 * chance (0.5), matching scoreNBack. Exported for the client-fallback mirror
 * tests; the client copy lives in components/meatspace/post/constants.js.
 */
export function nBackBalancedAccuracy(questions) {
  let hits = 0, misses = 0, falseAlarms = 0, correctRejections = 0;
  for (const q of Array.isArray(questions) ? questions : []) {
    const pressed = q?.answered === 'match';
    const isTarget = pressed === !!q?.correct;
    if (isTarget) { if (pressed) hits += 1; else misses += 1; }
    else if (pressed) falseAlarms += 1;
    else correctRejections += 1;
  }
  const hitRate = hits + misses ? hits / (hits + misses) : null;
  const crRate = correctRejections + falseAlarms ? correctRejections / (correctRejections + falseAlarms) : null;
  return hitRate == null && crRate == null ? null : ((hitRate ?? 0.5) + (crRate ?? 0.5)) / 2;
}

export function deriveTaskAccuracy(task) {
  if (typeof task?.accuracy === 'number' && !Number.isNaN(task.accuracy)) return task.accuracy;
  const qs = Array.isArray(task?.questions) ? task.questions : [];
  if (!qs.length) return null;
  // n-back is go/no-go: a withheld press is a deliberate "no-match" decision,
  // and its legacy `correct` flags encode the OLD raw-position model — so the
  // fallback recomputes balanced SDT accuracy rather than averaging them
  // (otherwise a legacy never-press run still reads ~70%). Mirrors the client
  // fallbacks in PostHistory/PostSessionResults.
  if (task?.type === 'n-back') return nBackBalancedAccuracy(qs);
  const answered = qs.filter(q => q?.answered != null);
  if (!answered.length) return null;
  return answered.filter(q => q?.correct).length / answered.length;
}

/**
 * Completion (answered / total) for a scored task, with the same legacy fallback
 * as deriveTaskAccuracy. `null` when there are no questions to derive from.
 * n-back legacy tasks are always fully reached — every trial gets a decision.
 */
export function deriveTaskCompletion(task) {
  if (typeof task?.completion === 'number' && !Number.isNaN(task.completion)) return task.completion;
  const qs = Array.isArray(task?.questions) ? task.questions : [];
  if (!qs.length) return null;
  if (task?.type === 'n-back') return 1;
  return qs.filter(q => q?.answered != null).length / qs.length;
}

/**
 * Mean response time (ms) for a scored task, tolerant of legacy sessions that
 * predate the persisted `avgResponseMs` field (issue #2094): the stored value
 * first, else the mean of the answered questions' `responseMs` (>0 only), else
 * `null` — never NaN. Used by progress aggregation so the "getting faster"
 * trend reads cleanly across old and new session shapes.
 */
export function deriveTaskAvgResponseMs(task) {
  if (typeof task?.avgResponseMs === 'number' && !Number.isNaN(task.avgResponseMs)) return task.avgResponseMs;
  const qs = Array.isArray(task?.questions) ? task.questions : [];
  const timed = qs.filter(q => (q?.responseMs || 0) > 0);
  if (!timed.length) return null;
  return Math.round(timed.reduce((sum, q) => sum + q.responseMs, 0) / timed.length);
}

export async function getPostStats(days = 30) {
  const sessions = await getPostSessions();
  // Streaks are computed over ALL history, independent of the stats window.
  const streaks = computePostStreaks(sessions, new Date().toISOString().split('T')[0]);
  let recent = sessions;
  if (days > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    recent = sessions.filter(s => s.date >= cutoffStr);
  }

  if (recent.length === 0) {
    return { days, sessionCount: 0, overall: null, byModule: {}, byDrill: {}, byDrillCount: {}, byDrillAccuracy: {}, byDrillCompletion: {}, ...streaks };
  }

  const scores = recent.map(s => s.score);
  const overall = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);

  const byModule = {};
  const byDrill = {};
  // Accuracy (answered-only) and completion tracked per drill alongside the
  // blended score, so reporting and the adaptive signal can separate "how right"
  // from "how fast/complete" (issue #2094). Legacy tasks are derived, not skipped.
  const byDrillAccuracyList = {};
  const byDrillCompletionList = {};
  for (const session of recent) {
    for (const task of session.tasks) {
      if (!byModule[task.module]) byModule[task.module] = [];
      byModule[task.module].push(task.score);

      const key = `${task.module}:${task.type}`;
      if (!byDrill[key]) byDrill[key] = [];
      byDrill[key].push(task.score);

      const acc = deriveTaskAccuracy(task);
      if (acc != null) (byDrillAccuracyList[key] ||= []).push(acc);
      const comp = deriveTaskCompletion(task);
      if (comp != null) (byDrillCompletionList[key] ||= []).push(comp);
    }
  }

  const avg = arr => Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
  const avgFrac = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  for (const key of Object.keys(byModule)) byModule[key] = avg(byModule[key]);
  // byDrillCount is the per-drill sample size, used to gate adaptive difficulty
  // (don't adapt off a single lucky/unlucky run). Captured before averaging.
  const byDrillCount = {};
  for (const key of Object.keys(byDrill)) byDrillCount[key] = byDrill[key].length;
  for (const key of Object.keys(byDrill)) byDrill[key] = avg(byDrill[key]);
  // Per-drill accuracy (0-1) and completion (0-1) means. Separate sample lists so
  // a drill with no derivable accuracy still reports a completion figure.
  const byDrillAccuracy = {};
  for (const key of Object.keys(byDrillAccuracyList)) byDrillAccuracy[key] = avgFrac(byDrillAccuracyList[key]);
  const byDrillCompletion = {};
  for (const key of Object.keys(byDrillCompletionList)) byDrillCompletion[key] = avgFrac(byDrillCompletionList[key]);

  return { days, sessionCount: recent.length, overall, byModule, byDrill, byDrillCount, byDrillAccuracy, byDrillCompletion, ...streaks };
}

// =============================================================================
// PROGRESS (time-series) — issue #2091
// =============================================================================

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
// accuracy, avgResponseMs }]`, chronologically sorted.
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
 * - `totals`           minutes trained (sessions + practice), session count,
 *   practice-entry count over the window.
 * - `streak`           ONE unified streak (sessions OR training-log activity),
 *   computed over ALL history like `getPostStats`.
 * - `mastery`          multiplication ladder rung + memory items (mastery/due).
 *
 * Accuracy/speed are reported separately (issue #2094): the persisted per-task
 * `accuracy`/`avgResponseMs` are preferred, with a per-question derivation
 * fallback for legacy sessions.
 */
export async function getPostProgress({ days = 90 } = {}) {
  const todayStr = new Date().toISOString().split('T')[0];
  const window = Number.isFinite(days) && days > 0 ? Math.min(days, 365) : 0;

  const allSessions = await getPostSessions();
  const allTraining = await getAllTrainingEntries();

  // Unified streak is computed over ALL history, independent of the window.
  const streak = computeUnifiedStreak(allSessions, allTraining, todayStr);

  let cutoffStr = null;
  if (window > 0) {
    cutoffStr = new Date(ymdToUTC(todayStr) - window * 86400000).toISOString().split('T')[0];
  }
  const sessions = cutoffStr ? allSessions.filter(s => (s.date || '') >= cutoffStr) : allSessions;
  const training = cutoffStr ? allTraining.filter(e => String(e.date || '').split('T')[0] >= cutoffStr) : allTraining;

  // Per-day buckets for the headline trends, plus per-domain/per-drill series.
  const dayMap = new Map();      // date -> { scores, accs, resp, minutes, sessions }
  const domainMap = new Map();   // module -> Map(date -> metric bucket)
  const drillMap = new Map();    // type   -> Map(date -> metric bucket)

  const ensureDay = (date) => {
    let d = dayMap.get(date);
    if (!d) { d = { scores: [], accs: [], resp: [], minutes: 0, sessions: 0 }; dayMap.set(date, d); }
    return d;
  };

  for (const s of sessions) {
    const date = s.date;
    if (!date) continue;
    const day = ensureDay(date);
    day.sessions += 1;
    day.minutes += (s.durationMs || 0) / 60000;
    if (typeof s.score === 'number' && !Number.isNaN(s.score)) day.scores.push(s.score);

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
    const date = String(e.date || '').split('T')[0];
    if (!date) continue;
    ensureDay(date).minutes += (e.totalMs || 0) / 60000;
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

  const sessionMs = sessions.reduce((sum, s) => sum + (s.durationMs || 0), 0);
  const trainingMs = training.reduce((sum, e) => sum + (e.totalMs || 0), 0);

  // Mastery block: multiplication ladder rung + per-item memory mastery/due.
  const mulProgress = await getMultiplicationProgress();
  const memoryItems = await getMemoryItems();
  const dueItems = await getDueMemoryItems();
  const dueIds = new Set(dueItems.map(i => i.id));

  return {
    days: window,
    series: {
      byDay,
      byDomain: finalizeMetricSeries(domainMap),
      byDrill: finalizeMetricSeries(drillMap),
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
      memoryItems: memoryItems.map(it => ({
        id: it.id,
        title: it.title,
        overallPct: it.mastery?.overallPct ?? 0,
        // 0/1 per item so the client can sum to a total "due" count.
        dueCount: dueIds.has(it.id) ? 1 : 0,
      })),
    },
  };
}

// =============================================================================
// DRILL GENERATORS (pure functions)
// =============================================================================

export function generateDoublingChain(startValue, steps = 8) {
  const start = startValue ?? (Math.floor(Math.random() * 7) + 3); // 3-9
  const questions = [];
  let current = start;
  for (let i = 0; i < steps; i++) {
    const next = current * 2;
    questions.push({ prompt: `${current} x 2`, expected: next });
    current = next;
  }
  return { type: 'doubling-chain', config: { startValue: start, steps }, questions };
}

export function generateSerialSubtraction(start, subtrahend = 7, steps = 10, startRange) {
  let startVal = start;
  if (startVal == null && Array.isArray(startRange) && startRange.length === 2) {
    const [lo, hi] = startRange;
    startVal = Math.floor(Math.random() * (hi - lo + 1)) + lo;
  }
  startVal = startVal ?? (Math.floor(Math.random() * 101) + 100); // 100-200
  const questions = [];
  let current = startVal;
  for (let i = 0; i < steps; i++) {
    const next = current - subtrahend;
    questions.push({ prompt: `${current} - ${subtrahend}`, expected: next });
    current = next;
  }
  return { type: 'serial-subtraction', config: { startValue: startVal, subtrahend, steps }, questions };
}

// Random integer with exactly `digits` digits (1 → 1-9, 2 → 10-99, …).
function randInt(digits) {
  const maxVal = Math.pow(10, digits) - 1;
  const minVal = digits > 1 ? Math.pow(10, digits - 1) : 1;
  return Math.floor(Math.random() * (maxVal - minVal + 1)) + minVal;
}

/**
 * Generate a multiplication drill.
 *
 * Two shapes:
 *  - Progressive ladder: pass `factors` (an array of per-factor digit counts,
 *    e.g. `[1, 2]` or `[1, 1, 1]`) and, optionally, the `level` that produced it
 *    (stamped into the returned config so scored history can bucket by level).
 *  - Legacy: pass `maxDigits` for a symmetric two-factor problem (both factors
 *    have `maxDigits` digits). Kept for when the progressive ladder is off.
 */
export function generateMultiplication(count = 10, maxDigits = 2, factors = null, level = null) {
  const useFactors = Array.isArray(factors) && factors.length >= 2
    ? factors.map(d => Math.max(1, Math.min(4, Math.trunc(d))))
    : null;
  const digitPlan = useFactors || [maxDigits, maxDigits];
  const questions = [];
  for (let i = 0; i < count; i++) {
    const nums = digitPlan.map(d => randInt(d));
    const expected = nums.reduce((product, n) => product * n, 1);
    questions.push({ prompt: nums.join(' x '), expected });
  }
  const config = { count };
  if (useFactors) {
    config.factors = useFactors;
    if (Number.isInteger(level)) config.level = level;
  } else {
    config.maxDigits = maxDigits;
  }
  return { type: 'multiplication', config, questions };
}

export function generatePowers(bases, maxExponent = 10, count = 8) {
  bases = Array.isArray(bases) && bases.length > 0 ? bases : [2, 3, 5];
  const questions = [];
  for (let i = 0; i < count; i++) {
    const base = bases[Math.floor(Math.random() * bases.length)];
    const exp = Math.floor(Math.random() * (maxExponent - 1)) + 2; // 2 to maxExponent
    questions.push({ prompt: `${base}^${exp}`, expected: Math.pow(base, exp) });
  }
  return { type: 'powers', config: { bases, maxExponent, count }, questions };
}

export function generateEstimation(count = 5, tolerancePct) {
  const ops = ['+', '-', 'x'];
  const questions = [];
  for (let i = 0; i < count; i++) {
    const a = Math.floor(Math.random() * 900) + 100; // 100-999
    const b = Math.floor(Math.random() * 900) + 100;
    const op = ops[Math.floor(Math.random() * ops.length)];
    let expected;
    let prompt;
    if (op === '+') {
      expected = a + b;
      prompt = `${a} + ${b}`;
    } else if (op === '-') {
      expected = a - b;
      prompt = `${a} - ${b}`;
    } else {
      expected = a * b;
      prompt = `${a} x ${b}`;
    }
    questions.push({ prompt, expected });
  }
  const config = { count };
  if (tolerancePct != null) config.tolerancePct = tolerancePct;
  return { type: 'estimation', config, questions };
}

export function generateDrill(type, config = {}) {
  switch (type) {
    case 'doubling-chain':
      return generateDoublingChain(config.startValue, config.steps);
    case 'serial-subtraction':
      return generateSerialSubtraction(config.startValue, config.subtrahend, config.steps, config.startRange);
    case 'multiplication':
      return generateMultiplication(config.count, config.maxDigits, config.factors, config.level);
    case 'powers':
      return generatePowers(config.bases, config.maxExponent, config.count);
    case 'estimation':
      return generateEstimation(config.count, config.tolerancePct);
    case 'n-back':
    case 'digit-span':
    case 'stroop':
    case 'schulte-table':
    case 'mental-rotation':
    case 'reaction-time':
      return generateCognitiveDrill(type, config);
    default:
      return null;
  }
}

// =============================================================================
// ADAPTIVE DIFFICULTY
// =============================================================================

/**
 * Read the recent performance signal for one math drill type from scored
 * sessions. Returns { score, samples, completion } where `score` is now the avg
 * ACCURACY (0-100, answered-only) — not the blended session score — so a
 * fast-but-sloppy run and a slow-but-accurate run produce different adaptive
 * directions (issue #2094). `completion` (0-1) lets adaptDrillConfig skip
 * adaptation when the user barely reached the drill (too little signal).
 */
async function getAdaptiveSignal(type) {
  const stats = await getPostStats(ADAPTIVE_DEFAULTS.windowDays);
  const key = `${MATH_MODULE}:${type}`;
  const accuracy = stats.byDrillAccuracy?.[key];
  const samples = stats.byDrillCount?.[key] || 0;
  const completion = stats.byDrillCompletion?.[key];
  return {
    score: accuracy == null ? null : Math.round(accuracy * 100),
    samples,
    completion: completion == null ? null : completion,
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
async function getMultiplicationLevelStats(windowDays = MASTERY_DEFAULTS.windowDays) {
  const sessions = await getPostSessions();
  let cutoffStr = null;
  if (windowDays > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - windowDays);
    cutoffStr = cutoff.toISOString().split('T')[0];
  }

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
      if (cutoffStr && session.date < cutoffStr) continue;
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

/**
 * Resolve the current progressive-multiplication difficulty from history.
 * Exposed for the config UI / route so it can show the ladder + mastery status.
 */
export async function getMultiplicationProgress() {
  const { stats, floorLevel } = await getMultiplicationLevelStats(MASTERY_DEFAULTS.windowDays);
  const progression = resolveMultiplicationLevel(stats, {}, floorLevel);
  return { ...progression, windowDays: MASTERY_DEFAULTS.windowDays, thresholds: { minSamples: MASTERY_DEFAULTS.minSamples, targetAccuracy: MASTERY_DEFAULTS.targetAccuracy } };
}

/**
 * Resolve the effective drill config for generation.
 *
 * - Multiplication with the progressive ladder ON (default): factor structure
 *   and difficulty come from mastery-gated level history, not the manual
 *   `maxDigits`. Returns a `progression` explainer.
 * - Adaptive toggle ON: math drill params are nudged from recent scored
 *   performance within clamped bounds. Returns an `adaptive` explainer.
 * - Otherwise (default): the caller's manual config passes through unchanged.
 *
 * @returns {{ config: object, adaptive: object|null, progression?: object|null }}
 */
export async function resolveDrillConfig(type, requestedConfig = {}) {
  const config = await getPostConfig();

  // Progressive multiplication ladder (default ON) — independent of the generic
  // Adaptive toggle. Selects the factor structure by speed-gated mastery so a
  // fresh user starts at single-digit × single-digit instead of a fixed hard
  // difficulty. `maxDigits` is stripped so generation uses `factors`.
  if (type === 'multiplication') {
    const mulCfg = config?.mentalMath?.drillTypes?.multiplication || {};
    if (mulCfg.progressive !== false) {
      const { stats, floorLevel } = await getMultiplicationLevelStats(MASTERY_DEFAULTS.windowDays);
      const progression = resolveMultiplicationLevel(stats, {}, floorLevel);
      const { maxDigits: _drop, ...rest } = requestedConfig || {};
      const effective = {
        ...rest,
        count: rest.count ?? mulCfg.count ?? 10,
        level: progression.level,
        factors: progression.factors,
      };
      return { config: effective, adaptive: null, progression };
    }
  }

  if (!config?.adaptive?.enabled || !ADAPTIVE_SPECS[type]) {
    return { config: requestedConfig, adaptive: null };
  }
  const signal = await getAdaptiveSignal(type);
  const result = adaptDrillConfig(type, requestedConfig, signal);
  return { config: result.config, adaptive: result };
}

/**
 * Build a transparent per-type preview of the effective adaptive difficulty for
 * every supported math drill, so the config UI can show what Adaptive will do
 * before a session starts. `enabled` reflects the saved Adaptive toggle.
 */
export async function getAdaptivePreview() {
  const config = await getPostConfig();
  const enabled = !!config?.adaptive?.enabled;
  const stats = await getPostStats(ADAPTIVE_DEFAULTS.windowDays);
  const savedDrills = config?.mentalMath?.drillTypes || {};

  const drills = {};
  for (const type of Object.keys(ADAPTIVE_SPECS)) {
    const key = `${MATH_MODULE}:${type}`;
    const accuracy = stats.byDrillAccuracy?.[key];
    const completion = stats.byDrillCompletion?.[key];
    const signal = {
      // Preview mirrors the live adaptive signal: accuracy (0-100), not the
      // blended score, plus completion for the low-completion skip (issue #2094).
      score: accuracy == null ? null : Math.round(accuracy * 100),
      samples: stats.byDrillCount?.[key] || 0,
      completion: completion == null ? null : completion,
    };
    // Base off the user's saved config so the preview matches what a session
    // would actually use; adaptDrillConfig falls back to the spec base per field.
    drills[type] = adaptDrillConfig(type, savedDrills[type] || {}, signal);
  }

  return { enabled, windowDays: ADAPTIVE_DEFAULTS.windowDays, thresholds: { highScore: ADAPTIVE_DEFAULTS.highScore, lowScore: ADAPTIVE_DEFAULTS.lowScore, minSamples: ADAPTIVE_DEFAULTS.minSamples, minCompletion: ADAPTIVE_DEFAULTS.minCompletion }, drills };
}

// =============================================================================
// SCORING (pure functions)
// =============================================================================

export function computeExpectedFromPrompt(prompt) {
  const s = typeof prompt === 'string' ? prompt.trim() : '';
  // Chained multiplication: "a x b" or "a x b x c x …" (progressive ladder can
  // emit 3+ factors). Handled first so a single "a x b" also flows through here.
  if (/^-?\d+(\s*x\s*-?\d+)+$/.test(s)) {
    const factors = s.split(/\s*x\s*/).map(n => parseInt(n, 10));
    if (factors.some(Number.isNaN)) return null;
    return factors.reduce((product, n) => product * n, 1);
  }
  const match = s.match(/^(-?\d+)\s*([+\-^])\s*(-?\d+)$/);
  if (!match) return null;
  const [, aStr, op, bStr] = match;
  const a = parseInt(aStr, 10);
  const b = parseInt(bStr, 10);
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '^': return Math.pow(a, b);
    default: return null;
  }
}

export function scoreDrill(type, questions, timeLimitMs, config = {}) {
  if (!questions?.length) {
    return { score: 0, questions, accuracy: null, completion: null, avgResponseMs: null, answeredCount: 0, totalCount: 0 };
  }

  // Recompute expected from the prompt server-side — never trust client-provided expected
  const recomputed = questions.map(q => {
    const expected = computeExpectedFromPrompt(q.prompt);
    // Coerce answered to number: empty/whitespace → null, NaN → null, "42" → 42
    let answered = null;
    if (q.answered != null) {
      if (typeof q.answered === 'string' && q.answered.trim() === '') {
        answered = null;
      } else {
        const rawNum = Number(q.answered);
        answered = Number.isNaN(rawNum) ? null : rawNum;
      }
    }
    let correct;
    if (expected == null || answered == null || isNaN(answered)) {
      correct = false;
    } else if (type === 'estimation') {
      const tolerance = ((config.tolerancePct ?? 10) / 100);
      correct = Math.abs(answered - expected) <= Math.abs(expected * tolerance);
    } else {
      correct = answered === expected;
    }
    return { ...q, answered, expected, correct };
  });

  const answered = recomputed.filter(q => q.answered != null);
  const answeredCount = answered.length;
  const totalCount = recomputed.length;
  const correctCount = recomputed.filter(q => q.correct).length;
  // Blended `score` stays keyed on correct-over-TOTAL (== accuracy × completion),
  // so the headline gamification number is unchanged for existing sessions and
  // fully-answered tasks (back-compat). The separated metrics below are what
  // reporting and the adaptive signal now consume (issue #2094).
  const correctRatio = totalCount ? correctCount / totalCount : 0;

  // Clamp responseMs to [0, timeLimitMs] to prevent inflated speed bonuses
  const totalResponseMs = answered.reduce((sum, q) => sum + Math.min(Math.max(q.responseMs || 0, 0), timeLimitMs), 0);
  // Speed bonus falls back to the full time window when nothing was answered, so
  // an empty drill scores 0 (no accuracy, no bonus) rather than dividing by zero.
  const avgForBonus = answeredCount > 0 ? totalResponseMs / answeredCount : timeLimitMs;

  const speedBonus = Math.max(0, 1 - avgForBonus / timeLimitMs);
  const score = Math.round((correctRatio * 0.8 + speedBonus * 0.2) * 100);
  return {
    score: Math.min(100, Math.max(0, score)),
    questions: recomputed,
    // Accuracy is answered-only: running out of time reduces `completion`, never
    // accuracy (issue #2094). `null` (never NaN) when nothing was answered.
    accuracy: answeredCount ? correctCount / answeredCount : null,
    completion: totalCount ? answeredCount / totalCount : null,
    avgResponseMs: answeredCount ? Math.round(totalResponseMs / answeredCount) : null,
    answeredCount,
    totalCount,
  };
}

function computeSessionScore(tasks) {
  const valid = (tasks || []).filter(t => typeof t.score === 'number' && !Number.isNaN(t.score));
  if (!valid.length) return 0;
  const totalScore = valid.reduce((sum, t) => sum + t.score, 0);
  return Math.round(totalScore / valid.length);
}

