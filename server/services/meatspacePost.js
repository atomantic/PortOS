/**
 * MeatSpace POST (Power On Self Test) Service
 *
 * Drill generators, scoring, and session CRUD for cognitive self-tests.
 * Reads/writes to meatspace data files.
 */

import { writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, ensureDir, readJSONFile } from '../lib/fileUtils.js';

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
  sessionModules: ['mental-math'],
  scoring: { weights: { 'mental-math': 1.0 } }
};

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
  await writeFile(CONFIG_FILE, JSON.stringify(merged, null, 2));
  console.log(`🧪 POST config updated`);
  return merged;
}

// =============================================================================
// SESSIONS
// =============================================================================

async function loadSessions() {
  const raw = await readJSONFile(SESSIONS_FILE, { sessions: [] }, { allowArray: false });
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { sessions: [] };
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

  // Strip client-provided score/correct and recompute server-side
  const rawTasks = Array.isArray(sessionData.tasks) ? sessionData.tasks : [];
  const rescoredTasks = rawTasks.map(t => {
    const { score: _score, correct: _correct, ...rest } = t || {};
    // Strip correct from individual questions too
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
  await writeFile(SESSIONS_FILE, JSON.stringify(data, null, 2));
  console.log(`🧪 POST session saved: score=${session.score} modules=${session.modules.join(',')}`);
  return session;
}

export async function getPostStats(days = 30) {
  const sessions = await getPostSessions();
  let recent = sessions;
  if (days > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    recent = sessions.filter(s => s.date >= cutoffStr);
  }

  if (recent.length === 0) {
    return { days, sessionCount: 0, overall: null, byModule: {}, byDrill: {} };
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
  for (const key of Object.keys(byDrill)) byDrill[key] = avg(byDrill[key]);

  return { days, sessionCount: recent.length, overall, byModule, byDrill };
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
    default:
      return null;
  }
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
    let correct;
    if (expected == null || q.answered == null) {
      correct = false;
    } else if (type === 'estimation') {
      const tolerance = ((config.tolerancePct ?? 10) / 100);
      correct = Math.abs(q.answered - expected) <= Math.abs(expected * tolerance);
    } else {
      correct = q.answered === expected;
    }
    return { ...q, expected, correct };
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
  if (!tasks?.length) return 0;
  const totalScore = tasks.reduce((sum, t) => sum + t.score, 0);
  return Math.round(totalScore / tasks.length);
}

// =============================================================================
// UTILITY
// =============================================================================

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
        target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
