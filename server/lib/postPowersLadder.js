/**
 * Technique-anchored progressive ladder for the POST Powers drill.
 *
 * Every pair in this module has a named fast mental path. Progressive
 * generation derives its candidate pool from this table, so unsupported
 * base/exponent combinations can never leak into a laddered drill.
 */

import { createProgression, PROGRESSION_MASTERY_DEFAULTS } from './postProgression.js';

const rangePairs = (base, first, last) => Array.from(
  { length: last - first + 1 },
  (_, index) => ({ base, exponent: first + index })
);

export const POWERS_TECHNIQUES = [
  {
    id: 'recall-2',
    label: 'Powers of 2 — recall table',
    pairs: rangePairs(2, 2, 10),
    targetMs: 4000,
  },
  {
    id: 'recall-small',
    label: 'Small squares & cubes',
    pairs: [
      ...rangePairs(3, 2, 5),
      ...rangePairs(5, 2, 4),
      { base: 7, exponent: 2 },
      { base: 9, exponent: 2 },
    ],
    targetMs: 5000,
  },
  {
    id: 'double-chain',
    label: 'Double up from 2^10',
    pairs: rangePairs(2, 11, 16),
    targetMs: 7000,
  },
  {
    id: 'halve-shift',
    label: 'Use 5^n = 10^n / 2^n',
    pairs: rangePairs(5, 5, 7),
    targetMs: 9000,
  },
  {
    id: 'split-exponent',
    label: 'Split the exponent from an anchor',
    pairs: [
      ...rangePairs(3, 6, 9),
      ...rangePairs(5, 8, 10),
    ],
    targetMs: 11000,
  },
];

export const POWERS_LADDER = POWERS_TECHNIQUES.map(technique => technique.id);
export const MAX_POWERS_LEVEL = POWERS_LADDER.length - 1;
export const POWERS_MASTERY_DEFAULTS = {
  ...PROGRESSION_MASTERY_DEFAULTS,
  minSamples: 12,
  targetAccuracy: 0.9,
  windowDays: 30,
  responseMsCap: 90000,
};

const pairKey = (base, exponent) => `${base}^${exponent}`;
const PAIR_INDEX = new Map();
for (const [level, technique] of POWERS_TECHNIQUES.entries()) {
  for (const pair of technique.pairs) {
    PAIR_INDEX.set(pairKey(pair.base, pair.exponent), { ...pair, level, technique: technique.id });
  }
}

export const ALL_POWERS_PAIRS = [...PAIR_INDEX.values()];

const progression = createProgression({
  levels: POWERS_LADDER,
  describeLevel: level => POWERS_TECHNIQUES[level].label,
  mastery: POWERS_MASTERY_DEFAULTS,
  speedTargetForLevel: level => POWERS_TECHNIQUES[level].targetMs,
});

export function clampPowersLevel(level) {
  return progression.clampLevel(level);
}

export function powersTechniqueForPair(base, exponent) {
  return PAIR_INDEX.get(pairKey(base, exponent)) || null;
}

export function powersPoolForLevel(level) {
  const maxLevel = clampPowersLevel(level);
  return ALL_POWERS_PAIRS.filter(pair => pair.level <= maxLevel);
}

export function resolvePowersLevel(levelStats = {}, opts = {}, floorLevel = 0) {
  const result = progression.resolveLevel(levelStats, opts, floorLevel);
  return {
    ...result,
    technique: POWERS_TECHNIQUES[result.level].id,
    levels: result.levels.map(({ descriptor, ...rung }) => ({ ...rung, technique: descriptor })),
  };
}

export function powersLevelMastered(stat, level, opts = POWERS_MASTERY_DEFAULTS) {
  return progression.isLevelMastered(stat, level, opts);
}
