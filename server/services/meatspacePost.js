/**
 * MeatSpace POST (Power On Self Test) Service
 *
 * Drill generators, scoring, and session CRUD for cognitive self-tests.
 * Reads/writes to meatspace data files.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { atomicWrite, PATHS, ensureDir, readJSONFile } from '../lib/fileUtils.js';
import { deepMerge, isPlainObject } from '../lib/objects.js';
import { LLM_DRILL_TYPES, MEMORY_DRILL_TYPES, POST_SUPPORTED_MEMORY_TYPES } from '../lib/postValidation.js';
import { adaptDrillConfig, ADAPTIVE_SPECS, ADAPTIVE_DEFAULTS } from '../lib/postAdaptive.js';
import { COGNITIVE_DRILL_TYPES, generateCognitiveDrill, scoreCognitiveDrill } from './meatspacePostCognitive.js';

const MEATSPACE_DIR = PATHS.meatspace;
const SESSIONS_FILE = join(MEATSPACE_DIR, 'post-sessions.json');
const CONFIG_FILE = join(MEATSPACE_DIR, 'post-config.json');

const DEFAULT_CONFIG = {
  mentalMath: {
    enabled: true,
    drillTypes: {
      'doubling-chain': { enabled: true, steps: 8, timeLimitSec: 60 },
      'serial-subtraction': { enabled: true, steps: 10, subtrahend: 7, startRange: [100, 200], timeLimitSec: 90 },
      'multiplication': { enabled: true, count: 10, maxDigits: 2, timeLimitSec: 120 },
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
  // No provider calls — enabled by default since they're free to run.
  cognitive: {
    enabled: true,
    drillTypes: {
      'n-back': { enabled: true, n: 2, length: 20, timeLimitSec: 90 },
      'digit-span': { enabled: true, direction: 'forward', startLength: 3, maxLength: 8, timeLimitSec: 120 },
      'stroop': { enabled: true, count: 15, timeLimitSec: 60 },
      'schulte-table': { enabled: true, size: 5, timeLimitSec: 120 },
      'mental-rotation': { enabled: true, count: 8, timeLimitSec: 120 },
      'reaction-time': { enabled: true, mode: 'simple', count: 15, minDelayMs: 1000, maxDelayMs: 3000, choices: 3, timeLimitSec: 90 }
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
  await ensureMeatspaceDir();
  await atomicWrite(CONFIG_FILE, merged);
  console.log(`🧪 POST config updated`);
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

  // Strip client-provided score/correct and recompute server-side (math drills only)
  const rawTasks = Array.isArray(sessionData.tasks) ? sessionData.tasks : [];
  const rescoredTasks = rawTasks.map(t => {
    const { score: _score, correct: _correct, ...rest } = t || {};

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
    // generated drillData (never trust client `correct`/`score`).
    if (COGNITIVE_DRILL_TYPES.includes(rest.type)) {
      const { score, questions } = scoreCognitiveDrill(rest.type, rest.drillData, rest.questions || []);
      return { ...rest, questions, score };
    }

    // Math drills: strip correct from individual questions and rescore
    const sanitizedQuestions = (rest.questions || []).map(q => {
      const { correct: _qCorrect, ...qRest } = q;
      return qRest;
    });
    const drillConfig = config.mentalMath?.drillTypes?.[rest.type] || {};
    const timeLimitMs = (drillConfig.timeLimitSec || 120) * 1000;
    const { score, questions } = scoreDrill(rest.type, sanitizedQuestions, timeLimitMs, rest.config || drillConfig);
    return { ...rest, questions, score };
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
    return { days, sessionCount: 0, overall: null, byModule: {}, byDrill: {}, byDrillCount: {}, ...streaks };
  }

  const scores = recent.map(s => s.score);
  const overall = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);

  const byModule = {};
  const byDrill = {};
  for (const session of recent) {
    for (const task of session.tasks) {
      if (!byModule[task.module]) byModule[task.module] = [];
      byModule[task.module].push(task.score);

      const key = `${task.module}:${task.type}`;
      if (!byDrill[key]) byDrill[key] = [];
      byDrill[key].push(task.score);
    }
  }

  const avg = arr => Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
  for (const key of Object.keys(byModule)) byModule[key] = avg(byModule[key]);
  // byDrillCount is the per-drill sample size, used to gate adaptive difficulty
  // (don't adapt off a single lucky/unlucky run). Captured before averaging.
  const byDrillCount = {};
  for (const key of Object.keys(byDrill)) byDrillCount[key] = byDrill[key].length;
  for (const key of Object.keys(byDrill)) byDrill[key] = avg(byDrill[key]);

  return { days, sessionCount: recent.length, overall, byModule, byDrill, byDrillCount, ...streaks };
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

export function generateMultiplication(count = 10, maxDigits = 2) {
  const maxVal = Math.pow(10, maxDigits) - 1;
  const minVal = maxDigits > 1 ? Math.pow(10, maxDigits - 1) : 1;
  const questions = [];
  for (let i = 0; i < count; i++) {
    const a = Math.floor(Math.random() * (maxVal - minVal + 1)) + minVal;
    const b = Math.floor(Math.random() * (maxVal - minVal + 1)) + minVal;
    questions.push({ prompt: `${a} x ${b}`, expected: a * b });
  }
  return { type: 'multiplication', config: { count, maxDigits }, questions };
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
      return generateMultiplication(config.count, config.maxDigits);
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
 * sessions. Returns { score, samples } — score is the avg session score (0-100)
 * over the adaptive window; samples is how many task samples backed it.
 */
async function getAdaptiveSignal(type) {
  const stats = await getPostStats(ADAPTIVE_DEFAULTS.windowDays);
  const key = `${MATH_MODULE}:${type}`;
  const score = stats.byDrill?.[key];
  const samples = stats.byDrillCount?.[key] || 0;
  return { score: score == null ? null : score, samples };
}

/**
 * Resolve the effective drill config for generation. When the Adaptive toggle
 * is off (default), the caller's manual config is returned unchanged. When on,
 * math drills are nudged from recent scored performance within clamped bounds.
 * Non-math (LLM/memory) types and unsupported math types pass through untouched.
 *
 * @returns {{ config: object, adaptive: object|null }}
 */
export async function resolveDrillConfig(type, requestedConfig = {}) {
  const config = await getPostConfig();
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
    const signal = {
      score: stats.byDrill?.[key] == null ? null : stats.byDrill[key],
      samples: stats.byDrillCount?.[key] || 0,
    };
    // Base off the user's saved config so the preview matches what a session
    // would actually use; adaptDrillConfig falls back to the spec base per field.
    drills[type] = adaptDrillConfig(type, savedDrills[type] || {}, signal);
  }

  return { enabled, windowDays: ADAPTIVE_DEFAULTS.windowDays, thresholds: { highScore: ADAPTIVE_DEFAULTS.highScore, lowScore: ADAPTIVE_DEFAULTS.lowScore, minSamples: ADAPTIVE_DEFAULTS.minSamples }, drills };
}

// =============================================================================
// SCORING (pure functions)
// =============================================================================

export function computeExpectedFromPrompt(prompt) {
  const match = prompt?.match(/^(-?\d+)\s*([+\-x^])\s*(-?\d+)$/);
  if (!match) return null;
  const [, aStr, op, bStr] = match;
  const a = parseInt(aStr, 10);
  const b = parseInt(bStr, 10);
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case 'x': return a * b;
    case '^': return Math.pow(a, b);
    default: return null;
  }
}

export function scoreDrill(type, questions, timeLimitMs, config = {}) {
  if (!questions?.length) return { score: 0, questions };

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
  const correctCount = recomputed.filter(q => q.correct).length;
  const correctRatio = correctCount / recomputed.length;

  // Clamp responseMs to [0, timeLimitMs] to prevent inflated speed bonuses
  const totalResponseMs = answered.reduce((sum, q) => sum + Math.min(Math.max(q.responseMs || 0, 0), timeLimitMs), 0);
  const avgResponseMs = answered.length > 0 ? totalResponseMs / answered.length : timeLimitMs;

  const speedBonus = Math.max(0, 1 - avgResponseMs / timeLimitMs);
  const score = Math.round((correctRatio * 0.8 + speedBonus * 0.2) * 100);
  return { score: Math.min(100, Math.max(0, score)), questions: recomputed };
}

function computeSessionScore(tasks) {
  const valid = (tasks || []).filter(t => typeof t.score === 'number' && !Number.isNaN(t.score));
  if (!valid.length) return 0;
  const totalScore = valid.reduce((sum, t) => sum + t.score, 0);
  return Math.round(totalScore / valid.length);
}

