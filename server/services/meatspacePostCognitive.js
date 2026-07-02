/**
 * MeatSpace POST — Deterministic Cognitive Drills
 *
 * Pure generators + scorers for non-LLM cognitive-training exercises:
 *   - n-back      (working memory)   — signal when the current item matches N steps back
 *   - digit-span  (working memory)   — recall a shown digit sequence forward/backward
 *   - stroop      (attention/inhibition) — name the INK color, not the word
 *
 * These are deterministic: the drill's answer key lives in the generated data
 * and every score is recomputed here on session submit, so a client-supplied
 * `correct`/`score` is never trusted (mirrors the math `scoreDrill` contract).
 * NO AI-provider calls happen anywhere in this module.
 */

// Coarse module tag stored on scored cognitive tasks, so stats read as
// `byDrill['cognitive:<type>']` (parallel to `mental-math:<type>`).
export const COGNITIVE_MODULE = 'cognitive';
export const COGNITIVE_DRILL_TYPES = ['n-back', 'digit-span', 'stroop'];

const NBACK_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

// Named colors used by the Stroop drill. `hex` is the rendered ink color and
// the swatch on the answer buttons; `name` is the correct answer token.
export const STROOP_COLORS = [
  { name: 'red', hex: '#ef4444' },
  { name: 'blue', hex: '#3b82f6' },
  { name: 'green', hex: '#22c55e' },
  { name: 'yellow', hex: '#eab308' },
];

// =============================================================================
// HELPERS
// =============================================================================

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  // Clamp the fallback into [min,max] too — a fallback that sits outside the
  // range (e.g. maxLength's fallback 8 when startLength has clamped up to 9)
  // would otherwise slip through un-clamped and, for digit-span, make
  // maxLength < startLength → an empty drill.
  const v = Number.isFinite(n) ? n : fallback;
  return Math.min(max, Math.max(min, v));
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function clampMs(ms, refMs) {
  return Math.min(Math.max(Number(ms) || 0, 0), refMs);
}

/**
 * Shared 0-100 score: 80% accuracy + 20% speed. `refMs` is the per-trial
 * response window used for the speed bonus (avg RT over answered trials).
 */
function accuracySpeedScore(recomputed, refMs) {
  if (!recomputed.length) return 0;
  const correctRatio = recomputed.filter(q => q.correct).length / recomputed.length;
  const timed = recomputed.filter(q => q.answered != null && q.responseMs > 0);
  const avgMs = timed.length ? timed.reduce((s, q) => s + q.responseMs, 0) / timed.length : refMs;
  const speedBonus = refMs > 0 ? Math.max(0, 1 - avgMs / refMs) : 0;
  return Math.min(100, Math.max(0, Math.round((correctRatio * 0.8 + speedBonus * 0.2) * 100)));
}

// =============================================================================
// GENERATORS
// =============================================================================

/**
 * N-back sequence. ~30% of decision positions (index >= n) are targets — the
 * current letter equals the one N steps back. `targets` is a convenience mirror
 * for the client; scoring recomputes it from `sequence` + `config.n`.
 */
export function generateNBack(config = {}) {
  const n = clampInt(config.n, 1, 3, 2);
  const length = clampInt(config.length, n + 5, 60, 20);
  const sequence = [];
  const targets = [];
  for (let i = 0; i < length; i++) {
    if (i < n) {
      sequence.push(pick(NBACK_LETTERS));
      targets.push(false);
    } else if (Math.random() < 0.3) {
      sequence.push(sequence[i - n]);
      targets.push(true);
    } else {
      const nBackItem = sequence[i - n];
      let letter = pick(NBACK_LETTERS);
      if (letter === nBackItem) letter = pick(NBACK_LETTERS.filter(l => l !== nBackItem));
      sequence.push(letter);
      targets.push(false);
    }
  }
  return {
    type: 'n-back',
    config: { n, length, stimulusMs: clampInt(config.stimulusMs, 1000, 5000, 2500) },
    sequence,
    targets,
  };
}

/**
 * Digit-span trials of increasing length, from startLength to maxLength. The
 * expected recall is the sequence forward, or reversed for the backward variant.
 */
export function generateDigitSpan(config = {}) {
  const direction = config.direction === 'backward' ? 'backward' : 'forward';
  const startLength = clampInt(config.startLength, 3, 9, 3);
  const maxLength = clampInt(config.maxLength, startLength, 12, 8);
  const sequences = [];
  for (let len = startLength; len <= maxLength; len++) {
    const digits = [];
    for (let i = 0; i < len; i++) digits.push(Math.floor(Math.random() * 10));
    sequences.push({ digits, length: len });
  }
  return {
    type: 'digit-span',
    config: { direction, startLength, maxLength, showMs: clampInt(config.showMs, 400, 4000, 1000) },
    sequences,
  };
}

/**
 * Stroop trials. ~25% congruent (word matches ink), the rest incongruent. The
 * correct answer is always the INK color.
 */
export function generateStroop(config = {}) {
  const count = clampInt(config.count, 5, 40, 15);
  const trials = [];
  for (let i = 0; i < count; i++) {
    const wordColor = pick(STROOP_COLORS);
    const inkColor = Math.random() < 0.25
      ? wordColor
      : pick(STROOP_COLORS.filter(c => c.name !== wordColor.name));
    trials.push({
      word: wordColor.name,
      inkColor: inkColor.name,
      inkHex: inkColor.hex,
      congruent: wordColor.name === inkColor.name,
    });
  }
  return {
    type: 'stroop',
    config: { count },
    trials,
    options: STROOP_COLORS.map(c => ({ name: c.name, hex: c.hex })),
  };
}

export function generateCognitiveDrill(type, config = {}) {
  switch (type) {
    case 'n-back':
      return generateNBack(config);
    case 'digit-span':
      return generateDigitSpan(config);
    case 'stroop':
      return generateStroop(config);
    default:
      return null;
  }
}

// =============================================================================
// SCORERS (recompute the answer key from drillData — never trust client marks)
// =============================================================================

function scoreNBack(drillData, questions) {
  const sequence = drillData?.sequence || [];
  const n = drillData?.config?.n ?? 2;
  const refMs = drillData?.config?.stimulusMs || 2500;
  const recomputed = questions.map(q => {
    const i = Number.isInteger(q.index) ? q.index : -1;
    const isTarget = i >= n && sequence[i] != null && sequence[i] === sequence[i - n];
    const expected = isTarget ? 'match' : 'no-match';
    // Anything but an explicit "match" counts as "no-match" (including a skip).
    const answered = q.answered === 'match' ? 'match' : q.answered == null ? null : 'no-match';
    const effective = answered === 'match' ? 'match' : 'no-match';
    return {
      prompt: q.prompt ?? (i >= 0 ? sequence[i] : ''),
      index: i,
      expected,
      answered,
      correct: effective === expected,
      responseMs: clampMs(q.responseMs, refMs),
    };
  });
  return { score: accuracySpeedScore(recomputed, refMs), questions: recomputed };
}

function scoreDigitSpan(drillData, questions) {
  const sequences = drillData?.sequences || [];
  const direction = drillData?.config?.direction === 'backward' ? 'backward' : 'forward';
  const maxLength = drillData?.config?.maxLength || 12;
  const recomputed = questions.map(q => {
    const seq = sequences[q.index] || {};
    const digits = Array.isArray(seq.digits) ? seq.digits : [];
    const ordered = direction === 'backward' ? [...digits].reverse() : digits;
    const expected = ordered.join('');
    const answered = q.answered == null ? null : String(q.answered).replace(/\D/g, '');
    const correct = expected.length > 0 && answered === expected;
    return {
      prompt: q.prompt ?? `${digits.length}-digit (${direction})`,
      index: q.index,
      expected,
      answered,
      correct,
      length: digits.length,
      responseMs: clampMs(q.responseMs, (digits.length || 1) * 2000),
    };
  });
  // Span-weighted: accuracy + reaching longer spans. Speed is not part of a
  // recall span, so this scorer intentionally omits the RT bonus.
  const correctRatio = recomputed.length ? recomputed.filter(q => q.correct).length / recomputed.length : 0;
  const span = recomputed.filter(q => q.correct).reduce((m, q) => Math.max(m, q.length || 0), 0);
  const spanBonus = maxLength > 0 ? Math.min(1, span / maxLength) : 0;
  const score = Math.min(100, Math.max(0, Math.round((correctRatio * 0.7 + spanBonus * 0.3) * 100)));
  return { score, questions: recomputed, span };
}

function scoreStroop(drillData, questions) {
  const trials = drillData?.trials || [];
  const refMs = 1500;
  const recomputed = questions.map(q => {
    const trial = trials[q.index] || {};
    const expected = trial.inkColor || '';
    const answered = q.answered == null ? null : String(q.answered).toLowerCase().trim();
    return {
      prompt: q.prompt ?? trial.word ?? '',
      index: q.index,
      expected,
      answered,
      correct: expected !== '' && answered === expected,
      responseMs: clampMs(q.responseMs, refMs),
    };
  });
  return { score: accuracySpeedScore(recomputed, refMs), questions: recomputed };
}

/**
 * Rescore a completed cognitive drill from its generated `drillData` + the
 * player's per-trial `questions`. Returns `{ score, questions, span? }`.
 */
export function scoreCognitiveDrill(type, drillData, questions = []) {
  const list = Array.isArray(questions) ? questions : [];
  switch (type) {
    case 'n-back':
      return scoreNBack(drillData, list);
    case 'digit-span':
      return scoreDigitSpan(drillData, list);
    case 'stroop':
      return scoreStroop(drillData, list);
    default:
      return { score: 0, questions: list };
  }
}
