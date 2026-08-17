// Deterministic applied-numeracy drill generation and authoritative scoring.
// Each question is reconstructed from the persisted seed/config on submit, so
// client-supplied expected values, prompts, and correctness never affect scores.

export const APPLIED_NUMERACY_DRILL_TYPE = 'applied-numeracy';
export const APPLIED_NUMERACY_FAMILIES = ['percentage', 'ratio', 'unit', 'rate', 'estimate'];
export const APPLIED_NUMERACY_DIFFICULTIES = [1, 2, 3];

const EPSILON = 1e-9;

const UNIT_DIMENSIONS = {
  distance: { m: 1, km: 1000, cm: 0.01 },
  duration: { s: 1, min: 60, h: 3600 },
  volume: { ml: 1, l: 1000 },
  mass: { g: 1, kg: 1000 },
};

const UNIT_ALIASES = {
  meter: 'm', meters: 'm', metre: 'm', metres: 'm',
  kilometer: 'km', kilometers: 'km', kilometre: 'km', kilometres: 'km',
  centimeter: 'cm', centimeters: 'cm', centimetre: 'cm', centimetres: 'cm',
  second: 's', seconds: 's', sec: 's', secs: 's',
  minute: 'min', minutes: 'min', mins: 'min',
  hour: 'h', hours: 'h', hr: 'h', hrs: 'h',
  milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml',
  liter: 'l', liters: 'l', litre: 'l', litres: 'l',
  gram: 'g', grams: 'g', kilogram: 'kg', kilograms: 'kg',
};

function normalizeSeed(seed = 0) {
  return Number.isInteger(seed) && seed >= 0 && seed <= 0xFFFFFFFF ? seed : 0;
}

function seededRandom(seed) {
  let state = normalizeSeed(seed) || 0x6D2B79F5;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(random, values) {
  return values[Math.floor(random() * values.length)];
}

function integer(random, min, max) {
  return Math.floor(random() * (max - min + 1)) + min;
}

function trimNumber(value) {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}

function unitQuestion({ prompt, expected, unit, dimension, method, tolerance = null }) {
  const unitOptions = UNIT_DIMENSIONS[dimension];
  const unitAliases = Object.fromEntries(
    Object.entries(UNIT_ALIASES).filter(([, canonical]) => unitOptions[canonical])
  );
  return {
    prompt,
    promptLabel: `Enter a number and unit (for example, ${trimNumber(expected)} ${unit})`,
    expected,
    unit,
    dimension,
    unitOptions,
    unitAliases,
    answerDisplay: `${trimNumber(expected)} ${unit}`,
    method,
    ...(tolerance ? { tolerance } : {}),
  };
}

function numberQuestion({ prompt, expected, method, tolerance = null }) {
  return {
    prompt,
    promptLabel: 'Enter a number',
    expected,
    answerDisplay: trimNumber(expected),
    method,
    ...(tolerance ? { tolerance } : {}),
  };
}

function percentageQuestion(random, difficulty) {
  const amount = integer(random, difficulty === 1 ? 40 : 80, difficulty === 3 ? 240 : 160);
  const percent = pick(random, difficulty === 1 ? [10, 20, 25, 50] : [12, 15, 20, 25, 30]);
  if (difficulty === 1) {
    const expected = amount * (1 - percent / 100);
    return numberQuestion({
      prompt: `A ${amount}-credit pass is discounted ${percent}%. What is the sale price?`,
      expected,
      method: `${percent}% of ${amount} is ${trimNumber(amount * percent / 100)}; subtract that discount from ${amount}.`,
    });
  }
  const expected = amount * (1 + percent / 100);
  const step = difficulty === 3 ? 'Then round only after the percentage change.' : '';
  return numberQuestion({
    prompt: `A ${amount}-credit refill gets a ${percent}% markup. What is the new price?`,
    expected,
    method: `A ${percent}% markup means multiply ${amount} by ${trimNumber(1 + percent / 100)}. ${step}`.trim(),
  });
}

function ratioQuestion(random, difficulty) {
  const left = integer(random, 2, 4);
  const right = integer(random, left + 1, 6);
  if (difficulty === 3) {
    const expected = left / (left + right);
    return numberQuestion({
      prompt: `A pattern has ${left} blue tiles and ${right} yellow tiles in each repeat. What fraction of one repeat is blue?`,
      expected,
      method: `There are ${left + right} tiles in one repeat, so blue is ${left}/${left + right}. An equivalent fraction or decimal is accepted.`,
    });
  }
  const known = right * integer(random, difficulty === 1 ? 3 : 4, difficulty === 3 ? 8 : 6);
  const expected = known * left / right;
  const label = difficulty === 3 ? 'tiles' : 'parts';
  return numberQuestion({
    prompt: `A pattern uses ${left} blue ${label} for every ${right} yellow ${label}. If it has ${known} yellow ${label}, how many blue ${label} are needed?`,
    expected,
    method: `${known} ÷ ${right} = ${trimNumber(known / right)} equal ratio groups; multiply by ${left} blue ${label} per group.`,
  });
}

function unitConversionQuestion(random, difficulty) {
  const choices = difficulty === 1
    ? [
      { from: 'km', to: 'm', dimension: 'distance', amount: integer(random, 2, 9) },
      { from: 'l', to: 'ml', dimension: 'volume', amount: integer(random, 2, 8) },
    ]
    : [
      { from: 'm', to: 'cm', dimension: 'distance', amount: integer(random, 15, 90) },
      { from: 'h', to: 'min', dimension: 'duration', amount: integer(random, 2, 6) },
      { from: 'kg', to: 'g', dimension: 'mass', amount: integer(random, 2, 9) },
    ];
  const choice = pick(random, choices);
  const options = UNIT_DIMENSIONS[choice.dimension];
  const expected = choice.amount * options[choice.from] / options[choice.to];
  return unitQuestion({
    prompt: `Convert ${choice.amount} ${choice.from} to ${choice.to}.`,
    expected,
    unit: choice.to,
    dimension: choice.dimension,
    method: `Use the ${choice.from} → ${choice.to} scale: ${choice.amount} ${choice.from} equals ${trimNumber(expected)} ${choice.to}.`,
  });
}

function rateQuestion(random, difficulty) {
  const per = integer(random, difficulty === 1 ? 6 : 8, difficulty === 3 ? 18 : 12);
  const baseMinutes = integer(random, 2, 6);
  const targetMinutes = baseMinutes * integer(random, difficulty === 1 ? 2 : 3, difficulty === 3 ? 5 : 4);
  const completed = per * baseMinutes;
  const expected = per * targetMinutes;
  return numberQuestion({
    prompt: `A crew sorts ${completed} sample cards in ${baseMinutes} minutes at a steady rate. How many sample cards can it sort in ${targetMinutes} minutes?`,
    expected,
    method: `${completed} ÷ ${baseMinutes} = ${per} cards per minute; multiply ${per} by ${targetMinutes} minutes.`,
  });
}

function estimateQuestion(random, difficulty) {
  const a = integer(random, difficulty === 1 ? 35 : 120, difficulty === 3 ? 760 : 420);
  const b = integer(random, difficulty === 1 ? 16 : 40, difficulty === 3 ? 190 : 120);
  const nearest = difficulty === 1 ? 100 : difficulty === 2 ? 1000 : 10000;
  const expected = Math.round((a * b) / nearest) * nearest;
  const tolerance = difficulty === 1
    ? { absolute: nearest }
    : { relative: difficulty === 2 ? 0.15 : 0.2 };
  return numberQuestion({
    prompt: `Estimate ${a} × ${b}. Give a sensible order-of-magnitude estimate (nearest ${nearest}).`,
    expected,
    tolerance,
    method: `Round ${a} and ${b} to easy nearby values, multiply, then keep the result near ${nearest}. Answers within the stated estimate band count.`,
  });
}

const FAMILY_GENERATORS = {
  percentage: percentageQuestion,
  ratio: ratioQuestion,
  unit: unitConversionQuestion,
  rate: rateQuestion,
  estimate: estimateQuestion,
};

function normalizedConfig(config = {}) {
  const count = Number.isInteger(config.count) ? Math.max(1, Math.min(50, config.count)) : 5;
  const difficulty = APPLIED_NUMERACY_DIFFICULTIES.includes(config.difficulty) ? config.difficulty : 1;
  const family = APPLIED_NUMERACY_FAMILIES.includes(config.family) ? config.family : 'mixed';
  return { count, difficulty, family, seed: normalizeSeed(config.seed) };
}

/** Pure seeded generator. Given the same config it always emits the same pack. */
export function generateAppliedNumeracyDrill(config = {}) {
  const resolved = normalizedConfig(config);
  const random = seededRandom(resolved.seed);
  const offset = Math.floor(random() * APPLIED_NUMERACY_FAMILIES.length);
  const questions = Array.from({ length: resolved.count }, (_, index) => {
    const family = resolved.family === 'mixed'
      ? APPLIED_NUMERACY_FAMILIES[(offset + index) % APPLIED_NUMERACY_FAMILIES.length]
      : resolved.family;
    return { index, family, difficulty: resolved.difficulty, ...FAMILY_GENERATORS[family](random, resolved.difficulty) };
  });
  return { type: APPLIED_NUMERACY_DRILL_TYPE, config: resolved, questions };
}

function parseNumber(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const fraction = text.match(/^(-?\d+)\s*\/\s*(-?\d+)$/);
  if (fraction) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
    return numerator / denominator;
  }
  if (!/^-?(?:\d+|\d+\.\d+)$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** Parse a numeric or fractional response with an optional unit; malformed input returns null. */
export function parseAppliedNumeracyAnswer(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const match = text.match(/^(-?(?:\d+|\d+\.\d+|\d+\s*\/\s*-?\d+))\s*([a-zA-Z]+)?$/);
  if (!match) return null;
  const value = parseNumber(match[1]);
  if (value == null) return null;
  const supplied = match[2]?.toLowerCase() || null;
  return { value, unit: supplied ? (UNIT_ALIASES[supplied] || supplied) : null };
}

function correctAppliedAnswer(question, raw) {
  const parsed = parseAppliedNumeracyAnswer(raw);
  if (!parsed) return { parsed: null, correct: false };
  let expected = question.expected;
  let actual = parsed.value;
  if (question.unit) {
    const unitFactor = question.unitOptions?.[parsed.unit];
    const expectedFactor = question.unitOptions?.[question.unit];
    if (!unitFactor || !expectedFactor) return { parsed, correct: false };
    actual *= unitFactor;
    expected *= expectedFactor;
  } else if (parsed.unit) {
    return { parsed, correct: false };
  }
  const difference = Math.abs(actual - expected);
  const tolerance = question.tolerance || {};
  const permitted = Math.max(tolerance.absolute || 0, Math.abs(expected) * (tolerance.relative || 0));
  return { parsed, correct: difference <= permitted + EPSILON };
}

function scoreBundle(questions, timeLimitMs) {
  const answered = questions.filter(question => question.answered != null);
  const answeredCount = answered.length;
  const totalCount = questions.length;
  const correctCount = questions.filter(question => question.correct).length;
  const correctRatio = totalCount ? correctCount / totalCount : 0;
  const totalResponseMs = answered.reduce((sum, question) => sum + Math.min(Math.max(question.responseMs || 0, 0), timeLimitMs), 0);
  const avgForBonus = answeredCount ? totalResponseMs / answeredCount : timeLimitMs;
  const speedBonus = Math.max(0, 1 - avgForBonus / timeLimitMs);
  return {
    score: Math.min(100, Math.max(0, Math.round((correctRatio * 0.8 + speedBonus * 0.2) * 100))),
    questions,
    accuracy: answeredCount ? correctCount / answeredCount : null,
    completion: totalCount ? answeredCount / totalCount : null,
    avgResponseMs: answeredCount ? Math.round(totalResponseMs / answeredCount) : null,
    answeredCount,
    totalCount,
  };
}

/** Rebuild the pack from its seed and score only its server-derived answer keys. */
export function scoreAppliedNumeracyDrill(submittedQuestions = [], timeLimitMs = 120000, config = {}) {
  const generated = generateAppliedNumeracyDrill(config);
  const source = Array.isArray(submittedQuestions) ? submittedQuestions : [];
  const questions = generated.questions.map((question, index) => {
    const submitted = source[index] || {};
    const raw = submitted.answered;
    const answered = raw == null || String(raw).trim() === '' ? null : String(raw).trim();
    const { correct } = correctAppliedAnswer(question, answered);
    return {
      ...question,
      answered,
      expected: question.answerDisplay,
      correct,
      responseMs: Number.isFinite(submitted.responseMs) ? submitted.responseMs : 0,
    };
  });
  return scoreBundle(questions, Math.max(1, timeLimitMs));
}
