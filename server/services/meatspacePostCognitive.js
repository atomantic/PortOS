/**
 * MeatSpace POST — Deterministic Cognitive Drills
 *
 * Pure generators + scorers for non-LLM cognitive-training exercises:
 *   - n-back          (working memory)      — signal when the current item matches N steps back
 *   - digit-span      (working memory)      — recall a shown digit sequence forward/backward
 *   - stroop          (attention/inhibition) — name the INK color, not the word
 *   - schulte-table   (visual attention)     — scan a shuffled grid for sequential numbers
 *   - mental-rotation (spatial reasoning)    — pick the rotated (not mirrored) match
 *   - reaction-time   (processing speed)     — simple/choice reaction-time baseline
 *
 * These are deterministic: the drill's answer key lives in the generated data
 * and every score is recomputed here on session submit, so a client-supplied
 * `correct`/`score` is never trusted (mirrors the math `scoreDrill` contract).
 * NO AI-provider calls happen anywhere in this module.
 */

// Coarse module tag stored on scored cognitive tasks, so stats read as
// `byDrill['cognitive:<type>']` (parallel to `mental-math:<type>`).
export const COGNITIVE_MODULE = 'cognitive';
export const COGNITIVE_DRILL_TYPES = ['n-back', 'digit-span', 'stroop', 'schulte-table', 'mental-rotation', 'reaction-time'];

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

// Fisher-Yates shuffle. Used by Schulte table cell placement and mental
// rotation option ordering — never a naive `sort(() => Math.random() - 0.5)`.
function shuffle(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// --- Mental rotation: grid-cell shape helpers -------------------------------
// Four chiral pentomino footprints, each within a 4x4 box. Verified (see the
// "ROTATION_SHAPES chirality invariant" test in meatspacePostCognitive.test.js,
// which exercises this exact set via the exported ROTATION_SHAPES) that every
// rotation is distinct from every mirrored-rotation, AND all 4 rotations of
// each are themselves distinct — so "rotated match" vs "mirrored distractor"
// is always unambiguous and there are always 3 distinct mirrored candidates
// to fill the distractor slots. (The classic Z/S-pentomino was excluded: it
// has 180deg rotational symmetry, leaving only 2 distinct mirrored variants —
// not enough for 3 distractors.) Exported so the test can assert the
// invariant directly against the real shape set, not a hand-copied one.
export const ROTATION_SHAPES = {
  F: [[1, 0], [2, 0], [0, 1], [1, 1], [1, 2]],
  L: [[0, 0], [0, 1], [0, 2], [0, 3], [1, 3]],
  N: [[0, 0], [0, 1], [1, 1], [1, 2], [1, 3]],
  Y: [[1, 0], [0, 1], [1, 1], [1, 2], [1, 3]],
};

function normalizeCells(cells) {
  const minX = Math.min(...cells.map(([x]) => x));
  const minY = Math.min(...cells.map(([, y]) => y));
  return cells.map(([x, y]) => [x - minX, y - minY]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

// Rotate 90deg clockwise `times` times (0-3) around the origin, then
// re-normalize into the non-negative quadrant. Exported so tests can verify
// the ROTATION_SHAPES chirality invariant directly (see meatspacePostCognitive.test.js).
export function rotateCells(cells, times) {
  let pts = cells;
  for (let t = 0; t < ((times % 4) + 4) % 4; t++) {
    pts = pts.map(([x, y]) => [y, -x]);
  }
  return normalizeCells(pts);
}

// Mirror across the vertical axis (flip x) — same footprint size, opposite
// chirality, so it looks similar but is not reachable by rotation alone.
export function mirrorCells(cells) {
  return normalizeCells(cells.map(([x, y]) => [-x, y]));
}

export function cellsKey(cells) {
  return cells.map(([x, y]) => `${x},${y}`).join('|');
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

/**
 * Schulte table: a size x size grid holding the numbers 1..size*size shuffled
 * into random cells. The player scans the grid and taps 1, 2, 3... in order —
 * pure visual-attention/scan-speed, no recall required.
 */
export function generateSchulteTable(config = {}) {
  const size = clampInt(config.size, 3, 7, 5);
  const total = size * size;
  const numbers = Array.from({ length: total }, (_, i) => i + 1);
  const cells = shuffle(numbers);
  return {
    type: 'schulte-table',
    config: { size, timeLimitSec: clampInt(config.timeLimitSec, 10, 600, 120) },
    cells,
  };
}

/**
 * Mental rotation: each trial shows a reference shape (an asymmetric
 * grid-cell footprint) and 4 candidate shapes — exactly one is the reference
 * rotated (0/90/180/270deg); the rest are mirrored (reflected) at a random
 * rotation, so they share a silhouette "feel" without being a true rotation
 * match. `correctIndex` is the answer key; scoring recomputes it independently
 * from `shape`/`rotationSteps`, never trusting the stored index round-trip.
 */
export function generateMentalRotation(config = {}) {
  const count = clampInt(config.count, 4, 20, 8);
  const shapeKeys = Object.keys(ROTATION_SHAPES);
  const trials = [];
  for (let i = 0; i < count; i++) {
    const shapeKey = pick(shapeKeys);
    const baseCells = ROTATION_SHAPES[shapeKey];
    const rotationSteps = 1 + Math.floor(Math.random() * 3); // 1-3 (nonzero: 90/180/270deg)
    const correctCells = rotateCells(baseCells, rotationSteps);

    const options = [{ cells: correctCells, isMatch: true }];
    let guard = 0;
    while (options.length < 4 && guard < 50) {
      guard++;
      const mirrored = mirrorCells(rotateCells(baseCells, Math.floor(Math.random() * 4)));
      const key = cellsKey(mirrored);
      if (options.some(o => cellsKey(o.cells) === key)) continue;
      options.push({ cells: mirrored, isMatch: false });
    }
    const shuffled = shuffle(options);
    const correctIndex = shuffled.findIndex(o => o.isMatch);

    trials.push({
      shape: shapeKey,
      target: normalizeCells(baseCells),
      options: shuffled.map(o => o.cells),
      correctIndex,
    });
  }
  return { type: 'mental-rotation', config: { count, gridSize: 4 }, trials };
}

/**
 * Reaction time: simple (react the instant a stimulus appears) or choice
 * (react to WHICH of `choices` stimuli appeared) RT baseline. Each trial's
 * `delayMs` is randomized so the stimulus onset can't be anticipated.
 */
export function generateReactionTime(config = {}) {
  const mode = config.mode === 'choice' ? 'choice' : 'simple';
  const count = clampInt(config.count, 5, 40, 15);
  const minDelayMs = clampInt(config.minDelayMs, 300, 5000, 1000);
  const maxDelayMs = Math.max(minDelayMs, clampInt(config.maxDelayMs, 300, 8000, 3000));
  const choices = mode === 'choice' ? clampInt(config.choices, 2, 4, 3) : 1;

  const trials = [];
  for (let i = 0; i < count; i++) {
    const delayMs = minDelayMs + Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1));
    const trial = { delayMs };
    if (mode === 'choice') trial.target = Math.floor(Math.random() * choices);
    trials.push(trial);
  }
  return { type: 'reaction-time', config: { mode, count, minDelayMs, maxDelayMs, choices }, trials };
}

export function generateCognitiveDrill(type, config = {}) {
  switch (type) {
    case 'n-back':
      return generateNBack(config);
    case 'digit-span':
      return generateDigitSpan(config);
    case 'stroop':
      return generateStroop(config);
    case 'schulte-table':
      return generateSchulteTable(config);
    case 'mental-rotation':
      return generateMentalRotation(config);
    case 'reaction-time':
      return generateReactionTime(config);
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

// Schulte table: each question is one "find the next number" step, keyed by
// `index` (0-based position in the 1..N sequence). Reference response window
// scales with grid size — a bigger grid needs more scanning per step.
function scoreSchulteTable(drillData, questions) {
  const size = drillData?.config?.size || 5;
  const total = size * size;
  const refMs = 1000 + size * 500;
  const recomputed = questions.map(q => {
    const i = Number.isInteger(q.index) ? q.index : -1;
    const expected = i + 1;
    const answered = q.answered == null ? null : Number(q.answered);
    return {
      prompt: `${expected}`,
      index: i,
      expected,
      answered,
      correct: i >= 0 && i < total && answered === expected,
      responseMs: clampMs(q.responseMs, refMs),
    };
  });
  return { score: accuracySpeedScore(recomputed, refMs), questions: recomputed };
}

// Mental rotation: `index` selects the trial; `answered` is the option index
// (0-3) the player picked. Expected is recomputed from `trials[index]`, never
// trusted from the client round-trip.
function scoreMentalRotation(drillData, questions) {
  const trials = drillData?.trials || [];
  const refMs = 6000;
  const recomputed = questions.map(q => {
    const trial = trials[q.index] || {};
    const expected = Number.isInteger(trial.correctIndex) ? trial.correctIndex : null;
    const answered = q.answered == null ? null : Number(q.answered);
    return {
      prompt: q.prompt ?? `shape ${trial.shape ?? ''}`,
      index: q.index,
      expected,
      answered,
      correct: expected != null && answered === expected,
      responseMs: clampMs(q.responseMs, refMs),
    };
  });
  return { score: accuracySpeedScore(recomputed, refMs), questions: recomputed };
}

// Reaction time: 'simple' trials just need a clean (non-false-start) press;
// 'choice' trials must also match the lit target index. A `falseStart` (press
// before the stimulus appeared) is always wrong regardless of client claims.
function scoreReactionTime(drillData, questions) {
  const trials = drillData?.trials || [];
  const mode = drillData?.config?.mode === 'choice' ? 'choice' : 'simple';
  const refMs = mode === 'choice' ? 1200 : 600;
  const recomputed = questions.map(q => {
    const trial = trials[q.index] || {};
    const falseStart = q.falseStart === true;
    let expected;
    let answered;
    let correct;
    if (mode === 'choice') {
      expected = Number.isInteger(trial.target) ? String(trial.target) : null;
      answered = falseStart || q.answered == null ? null : String(q.answered);
      correct = !falseStart && expected != null && answered === expected;
    } else {
      expected = 'react';
      answered = falseStart ? 'false-start' : q.responseMs > 0 ? 'react' : null;
      correct = answered === 'react';
    }
    return {
      prompt: mode === 'choice' ? `target ${trial.target ?? ''}` : 'react',
      index: q.index,
      expected,
      answered,
      correct,
      responseMs: clampMs(q.responseMs, refMs * 3),
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
    case 'schulte-table':
      return scoreSchulteTable(drillData, list);
    case 'mental-rotation':
      return scoreMentalRotation(drillData, list);
    case 'reaction-time':
      return scoreReactionTime(drillData, list);
    default:
      return { score: 0, questions: list };
  }
}
