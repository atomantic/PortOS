import { describe, it, expect } from 'vitest';
import {
  MULTIPLICATION_LADDER,
  MAX_MULTIPLICATION_LEVEL,
  MASTERY_DEFAULTS,
  clampMultiplicationLevel,
  ladderFactors,
  describeMultiplicationLevel,
  speedTargetMs,
  isLevelMastered,
  resolveMultiplicationLevel,
} from './postMultiplicationLadder.js';

describe('multiplication ladder shape', () => {
  it('starts at single-digit × single-digit and grows monotonically in total digits', () => {
    expect(MULTIPLICATION_LADDER[0]).toEqual([1, 1]);
    expect(MULTIPLICATION_LADDER[1]).toEqual([1, 2]);
    expect(MULTIPLICATION_LADDER[2]).toEqual([1, 1, 1]);
    // Every rung has at least two factors and 1-4 digit factors.
    for (const factors of MULTIPLICATION_LADDER) {
      expect(factors.length).toBeGreaterThanOrEqual(2);
      for (const d of factors) {
        expect(d).toBeGreaterThanOrEqual(1);
        expect(d).toBeLessThanOrEqual(4);
      }
    }
  });

  it('MAX_MULTIPLICATION_LEVEL is the last index', () => {
    expect(MAX_MULTIPLICATION_LEVEL).toBe(MULTIPLICATION_LADDER.length - 1);
  });
});

describe('clampMultiplicationLevel', () => {
  it('clamps into range and coerces non-integers to 0', () => {
    expect(clampMultiplicationLevel(-5)).toBe(0);
    expect(clampMultiplicationLevel(999)).toBe(MAX_MULTIPLICATION_LEVEL);
    expect(clampMultiplicationLevel(2)).toBe(2);
    expect(clampMultiplicationLevel('x')).toBe(0);
    expect(clampMultiplicationLevel(undefined)).toBe(0);
  });
});

describe('ladderFactors / describeMultiplicationLevel', () => {
  it('returns the rung factors and a readable label', () => {
    expect(ladderFactors(0)).toEqual([1, 1]);
    expect(describeMultiplicationLevel(0)).toBe('1×1-digit');
    expect(describeMultiplicationLevel(2)).toBe('1×1×1-digit');
  });
});

describe('speedTargetMs', () => {
  it('scales with total digit count, floored at minTargetMs', () => {
    // [1,1] → 2 digits → 4400ms > floor 4000
    expect(speedTargetMs(0)).toBe(2 * MASTERY_DEFAULTS.baseMsPerFactorDigit);
    // [2,2] → 4 digits → 8800ms
    expect(speedTargetMs(3)).toBe(4 * MASTERY_DEFAULTS.baseMsPerFactorDigit);
    // Never below the floor even with a tiny base override.
    expect(speedTargetMs(0, { baseMsPerFactorDigit: 100, minTargetMs: 4000 })).toBe(4000);
  });
});

describe('isLevelMastered', () => {
  const good = { samples: 12, accuracy: 0.95, avgResponseMs: 3000 };
  it('true when samples, accuracy and speed all clear the bar', () => {
    expect(isLevelMastered(good, 0)).toBe(true);
  });
  it('false with too few samples', () => {
    expect(isLevelMastered({ ...good, samples: 5 }, 0)).toBe(false);
  });
  it('false when accuracy under target', () => {
    expect(isLevelMastered({ ...good, accuracy: 0.7 }, 0)).toBe(false);
  });
  it('false when too slow', () => {
    expect(isLevelMastered({ ...good, avgResponseMs: 99999 }, 0)).toBe(false);
  });
  it('false when no timed samples (avgResponseMs 0)', () => {
    expect(isLevelMastered({ samples: 20, accuracy: 1, avgResponseMs: 0 }, 0)).toBe(false);
  });
});

describe('resolveMultiplicationLevel', () => {
  it('starts a fresh user at level 0', () => {
    const r = resolveMultiplicationLevel({});
    expect(r.level).toBe(0);
    expect(r.factors).toEqual([1, 1]);
    expect(r.atHardest).toBe(false);
    expect(r.levels).toHaveLength(MULTIPLICATION_LADDER.length);
  });

  it('advances past mastered lower rungs to the first unmastered rung', () => {
    const mastered = { samples: 20, accuracy: 1, avgResponseMs: 3000 };
    const r = resolveMultiplicationLevel({ 0: mastered, 1: mastered });
    expect(r.level).toBe(2); // 0 and 1 mastered → sits on 2
    expect(r.levels[0].mastered).toBe(true);
    expect(r.levels[1].mastered).toBe(true);
    expect(r.levels[2].mastered).toBe(false);
  });

  it('does not skip an unmastered gap even if a higher rung looks mastered', () => {
    const mastered = { samples: 20, accuracy: 1, avgResponseMs: 3000 };
    // Level 0 mastered, level 1 NOT, level 2 mastered → must stop at 1.
    const r = resolveMultiplicationLevel({ 0: mastered, 2: mastered });
    expect(r.level).toBe(1);
  });

  it('caps at the hardest rung when everything is mastered', () => {
    const stats = {};
    for (let i = 0; i < MULTIPLICATION_LADDER.length; i++) {
      stats[i] = { samples: 20, accuracy: 1, avgResponseMs: 1000 };
    }
    const r = resolveMultiplicationLevel(stats);
    expect(r.level).toBe(MAX_MULTIPLICATION_LEVEL);
    expect(r.atHardest).toBe(true);
    expect(r.currentMastered).toBe(true);
  });

  it('accepts string-keyed level stats', () => {
    const mastered = { samples: 20, accuracy: 1, avgResponseMs: 3000 };
    const r = resolveMultiplicationLevel({ '0': mastered });
    expect(r.level).toBe(1);
  });
});
