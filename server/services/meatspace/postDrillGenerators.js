/** Generates and scores deterministic POST drills. */

import { resolveEstimationTolerancePct } from '../../lib/postScoring.js';
import { APPLIED_NUMERACY_DRILL_TYPE, generateAppliedNumeracyDrill, scoreAppliedNumeracyDrill } from '../../lib/postAppliedNumeracy.js';
import { powersPoolForLevel } from '../../lib/postPowersLadder.js';
import { generateCognitiveDrill } from './meatspacePostCognitive.js';

// Math tasks are logged under this coarse module in scored sessions, so the
// adaptive signal in meatspacePostAdaptive.js reads `byDrill['mental-math:<type>']`.
export const MATH_MODULE = 'mental-math';

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

// Random integer in [min, max], inclusive.
function between(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Random integer with exactly `digits` digits (1 → 1-9, 2 → 10-99, …).
function randInt(digits) {
  return between(digits > 1 ? Math.pow(10, digits - 1) : 1, Math.pow(10, digits) - 1);
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

export function generatePowers(bases, maxExponent = 10, count = 8, level = null, review = false) {
  if (Number.isInteger(level)) {
    const cumulativePool = powersPoolForLevel(level);
    const pool = review
      ? cumulativePool.filter(pair => pair.level === level)
      : cumulativePool;
    const questions = Array.from({ length: count }, () => {
      const pair = pool[Math.floor(Math.random() * pool.length)];
      return {
        prompt: `${pair.base}^${pair.exponent}`,
        expected: Math.pow(pair.base, pair.exponent),
        technique: pair.technique,
        techniqueLevel: pair.level,
      };
    }).sort((a, b) => a.techniqueLevel - b.techniqueLevel);
    return {
      type: 'powers',
      config: {
        count,
        level,
        technique: pool.at(-1).technique,
      },
      questions,
    };
  }
  bases = Array.isArray(bases) && bases.length > 0 ? bases : [2, 3, 5];
  const questions = [];
  for (let i = 0; i < count; i++) {
    const base = bases[Math.floor(Math.random() * bases.length)];
    const exp = Math.floor(Math.random() * (maxExponent - 1)) + 2; // 2 to maxExponent
    questions.push({ prompt: `${base}^${exp}`, expected: Math.pow(base, exp) });
  }
  return { type: 'powers', config: { bases, maxExponent, count }, questions };
}

const MIN_ESTIMATION_DIFFERENCE = 100;

// Subtraction operands, larger first and at least MIN_ESTIMATION_DIFFERENCE
// apart. Two independently-drawn 3-digit numbers land closer than that about a
// fifth of the time, and a PERCENTAGE tolerance of a tiny difference is a
// sub-unit band — `509 - 499` grades to ±1 at the default 10%, exact arithmetic
// wearing an estimation label. Keeping the answer itself 3-digit is what rules
// that out; how precise the drillee must then be is the tolerance's job to say,
// and the drill UI states it. Ordering the pair also settles whether a
// `309 - 925` prompt wants 616 or -616.
function estimationSubtractionPair() {
  const hi = between(100 + MIN_ESTIMATION_DIFFERENCE, 999);
  return [hi, between(100, hi - MIN_ESTIMATION_DIFFERENCE)];
}

export function generateEstimation(count = 5, tolerancePct) {
  const ops = ['+', '-', 'x'];
  const questions = [];
  for (let i = 0; i < count; i++) {
    const op = ops[Math.floor(Math.random() * ops.length)];
    const [a, b] = op === '-' ? estimationSubtractionPair() : [randInt(3), randInt(3)];
    const expected = op === '+' ? a + b : op === '-' ? a - b : a * b;
    questions.push({ prompt: `${a} ${op} ${b}`, expected });
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
      return generatePowers(config.bases, config.maxExponent, config.count, config.level, config.review);
    case 'estimation':
      return generateEstimation(config.count, config.tolerancePct);
    case APPLIED_NUMERACY_DRILL_TYPE:
      return generateAppliedNumeracyDrill({
        ...config,
        // The generator itself is pure for a seed. New runs get a seed once;
        // it is stamped into the returned config and becomes the score key.
        seed: config.seed ?? Math.floor(Math.random() * 0x100000000),
      });
    case 'n-back':
    case 'digit-span':
    case 'stroop':
    case 'schulte-table':
    case 'mental-rotation':
    case 'reaction-time':
    case 'task-switching':
    case 'go-no-go':
    case 'flanker':
      return generateCognitiveDrill(type, config);
    default:
      return null;
  }
}

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
  if (type === APPLIED_NUMERACY_DRILL_TYPE) {
    return scoreAppliedNumeracyDrill(questions, timeLimitMs, config);
  }
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
      const tolerance = resolveEstimationTolerancePct(config.tolerancePct) / 100;
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
