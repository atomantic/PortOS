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
import { advanceScheduleFromSession, mergeMasteryFromSession } from './meatspacePostMemory.js';

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
  // Per-module weight applied to a session's blended score (issue #2099).
  // Uniform 1.0 defaults reproduce the old unweighted-mean behavior exactly —
  // a user only sees a change once they actually adjust a weight.
  scoring: { weights: { 'mental-math': 1.0, 'llm-drills': 1.0, 'cognitive': 1.0, 'memory': 1.0 } },
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
    score: computeSessionScore(rescoredTasks, config.scoring?.weights),
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

// Local-date arithmetic on `YYYY-MM-DD` strings via UTC midnight so day math
// never drifts across DST boundaries (the activity-streak bug class).
function ymdToUTC(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
function ymdShift(s, deltaDays) {
  return new Date(ymdToUTC(s) + deltaDays * 86400000).toISOString().split('T')[0];
}

/**
 * Compute POST practice streaks from session records. Pure (takes `todayStr`
 * explicitly) so it's unit-testable without faking the clock.
 *
 * - `completedToday`  — at least one session dated today
 * - `currentStreak`   — consecutive days with a session counting back from
 *   today; a not-yet-done today does NOT break the streak as long as yesterday
 *   has one (grace window), mirroring `usage.js` `calculateStreak`
 * - `longestStreak`   — longest consecutive-day run in all history
 * - `lastDate`        — most recent session date (null if never practiced)
 * - `todayScore`      — best session score recorded today (null if none)
 */
export function computePostStreaks(sessions, todayStr) {
  const dateSet = new Set((sessions || []).map(s => s?.date).filter(Boolean));
  const dates = Array.from(dateSet).sort();
  const completedToday = dateSet.has(todayStr);
  const lastDate = dates.length ? dates[dates.length - 1] : null;

  const todayScores = (sessions || [])
    .filter(s => s?.date === todayStr && typeof s?.score === 'number')
    .map(s => s.score);
  const todayScore = todayScores.length ? Math.max(...todayScores) : null;

  let longestStreak = 0;
  let run = 0;
  let prev = null;
  for (const d of dates) {
    run = prev && ymdToUTC(d) - ymdToUTC(prev) === 86400000 ? run + 1 : 1;
    if (run > longestStreak) longestStreak = run;
    prev = d;
  }

  // Anchor the current streak at today, or yesterday if today isn't done yet.
  let cursor = completedToday ? todayStr : ymdShift(todayStr, -1);
  let currentStreak = 0;
  while (dateSet.has(cursor)) {
    currentStreak += 1;
    cursor = ymdShift(cursor, -1);
  }

  return { completedToday, currentStreak, longestStreak, lastDate, todayScore };
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
 *
 * Multiplication is a special case: `resolveDrillConfig` (above) hands
 * multiplication's difficulty entirely to the progressive ladder whenever
 * `progressive !== false` (the default) — the `maxDigits` Adaptive knob is
 * short-circuited and never applied in that mode. Previewing it via
 * `adaptDrillConfig` regardless would advertise a maxDigits adjustment that
 * can never actually happen (issue #2099). So this mirrors resolveDrillConfig's
 * own branch: ladder rung when progressive is on, the maxDigits Adaptive
 * preview only when the user has turned progressive off.
 */
export async function getAdaptivePreview() {
  const config = await getPostConfig();
  const enabled = !!config?.adaptive?.enabled;
  const stats = await getPostStats(ADAPTIVE_DEFAULTS.windowDays);
  const savedDrills = config?.mentalMath?.drillTypes || {};
  const multiplicationProgressive = savedDrills.multiplication?.progressive !== false;

  const drills = {};
  for (const type of Object.keys(ADAPTIVE_SPECS)) {
    if (type === 'multiplication' && multiplicationProgressive) {
      // Same source of truth resolveDrillConfig uses for the ladder rung —
      // not the generic maxDigits Adaptive signal.
      drills[type] = { ladder: true, ...(await getMultiplicationProgress()) };
      continue;
    }
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

/**
 * Blend a session's per-task scores into one headline number, weighted by
 * each task's module (`config.scoring.weights`, issue #2099). A module absent
 * from `weights` (or a non-numeric entry) defaults to 1.0, so an all-uniform
 * (or empty/missing) weights map reproduces the exact old unweighted mean —
 * existing configs and sessions score identically until a user actually
 * adjusts a weight.
 */
function computeSessionScore(tasks, weights = {}) {
  const valid = (tasks || []).filter(t => typeof t.score === 'number' && !Number.isNaN(t.score));
  if (!valid.length) return 0;
  let totalWeighted = 0;
  let totalWeight = 0;
  for (const t of valid) {
    const w = typeof weights?.[t.module] === 'number' ? weights[t.module] : 1.0;
    totalWeighted += t.score * w;
    totalWeight += w;
  }
  // All-zero weights (every touched module explicitly zeroed) would otherwise
  // divide by zero — fall back to 0 rather than NaN.
  if (!totalWeight) return 0;
  return Math.round(totalWeighted / totalWeight);
}

