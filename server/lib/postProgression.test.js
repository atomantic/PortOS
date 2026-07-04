import { describe, it, expect } from 'vitest';
import {
  createProgression,
  PROGRESSION_MASTERY_DEFAULTS,
  clampLevel,
  COGNITIVE_LADDERS,
  COGNITIVE_LADDER_TYPES,
  COGNITIVE_MASTERY_DEFAULTS,
  cognitiveLadder,
  cognitiveLevelConfig,
  resolveCognitiveProgression,
} from './postProgression.js';

describe('clampLevel', () => {
  it('clamps into range and coerces non-integers to 0', () => {
    expect(clampLevel(-5, 4)).toBe(0);
    expect(clampLevel(999, 4)).toBe(4);
    expect(clampLevel(2, 4)).toBe(2);
    expect(clampLevel('x', 4)).toBe(0);
    expect(clampLevel(undefined, 4)).toBe(0);
  });
});

// A speed-gated ladder (mirrors the multiplication ladder's mastery contract:
// samples + accuracy + a per-level response-time target) exercised against the
// same matrix the multiplication suite uses, to prove the shared helper carries
// that behaviour.
describe('createProgression — speed-gated ladder', () => {
  const p = createProgression({
    levels: [[1, 1], [1, 2], [1, 1, 1], [2, 2]],
    describeLevel: level => `L${level}`,
    mastery: { minSamples: 12, targetAccuracy: 0.9, baseMsPerFactorDigit: 2200, minTargetMs: 4000 },
    speedTargetForLevel: (level, opts) => {
      const totalDigits = [[1, 1], [1, 2], [1, 1, 1], [2, 2]][level].reduce((a, b) => a + b, 0);
      return Math.max(opts.minTargetMs, opts.baseMsPerFactorDigit * totalDigits);
    },
  });

  it('speedTargetMs scales with total digit count, floored at minTargetMs', () => {
    expect(p.speedTargetMs(0)).toBe(2 * 2200); // [1,1] → 4400
    expect(p.speedTargetMs(3)).toBe(4 * 2200); // [2,2] → 8800
    expect(p.speedTargetMs(0, { baseMsPerFactorDigit: 100, minTargetMs: 4000 })).toBe(4000);
  });

  it('isLevelMastered gates on samples, accuracy AND speed', () => {
    const good = { samples: 12, accuracy: 0.95, avgResponseMs: 3000 };
    expect(p.isLevelMastered(good, 0)).toBe(true);
    expect(p.isLevelMastered({ ...good, samples: 5 }, 0)).toBe(false);
    expect(p.isLevelMastered({ ...good, accuracy: 0.7 }, 0)).toBe(false);
    expect(p.isLevelMastered({ ...good, avgResponseMs: 99999 }, 0)).toBe(false);
    // No timed samples → never "instant mastery" on a speed-gated ladder.
    expect(p.isLevelMastered({ samples: 20, accuracy: 1, avgResponseMs: 0 }, 0)).toBe(false);
  });

  it('resolveLevel advances past mastered rungs and stops at an unmastered gap', () => {
    const m = { samples: 20, accuracy: 1, avgResponseMs: 3000 };
    expect(p.resolveLevel({ 0: m, 1: m }).level).toBe(2);
    // A higher mastered rung must not let the walk skip an unmastered one.
    expect(p.resolveLevel({ 0: m, 2: m }).level).toBe(1);
    expect(p.resolveLevel({ '0': m }).level).toBe(1); // string keys
  });

  it('resolveLevel caps at the hardest rung and never demotes below the floor', () => {
    const m = { samples: 20, accuracy: 1, avgResponseMs: 1000 };
    const all = p.resolveLevel({ 0: m, 1: m, 2: m, 3: m });
    expect(all.level).toBe(3);
    expect(all.atHardest).toBe(true);
    // Empty window but earned rung 2 → holds at 2, lower rungs render mastered.
    const floored = p.resolveLevel({}, {}, 2);
    expect(floored.level).toBe(2);
    expect(floored.floorLevel).toBe(2);
    expect(floored.levels[0].mastered).toBe(true);
    expect(floored.levels[2].mastered).toBe(false);
  });
});

// An accuracy-only ladder (no speedTargetForLevel) — the cognitive contract:
// mastery is samples + accuracy, response time irrelevant.
describe('createProgression — accuracy-only ladder', () => {
  const p = createProgression({
    levels: ['a', 'b', 'c'],
    describeLevel: level => `L${level}`,
    mastery: { minSamples: 3, targetAccuracy: 0.85 },
  });

  it('masters on samples + accuracy alone, ignoring avgResponseMs', () => {
    expect(p.speedTargetMs(0)).toBeNull();
    expect(p.isLevelMastered({ samples: 3, accuracy: 0.9, avgResponseMs: 0 }, 0)).toBe(true);
    expect(p.isLevelMastered({ samples: 2, accuracy: 1 }, 0)).toBe(false);
    expect(p.isLevelMastered({ samples: 5, accuracy: 0.8 }, 0)).toBe(false);
  });

  it('resolveLevel walks up on sustained accuracy', () => {
    const m = { samples: 4, accuracy: 0.9 };
    expect(p.resolveLevel({ 0: m }).level).toBe(1);
    expect(p.resolveLevel({ 0: m, 1: m }).level).toBe(2);
  });
});

describe('PROGRESSION_MASTERY_DEFAULTS', () => {
  it('exposes the shared threshold shape', () => {
    expect(PROGRESSION_MASTERY_DEFAULTS.minSamples).toBe(12);
    expect(PROGRESSION_MASTERY_DEFAULTS.targetAccuracy).toBe(0.9);
  });
});

describe('cognitive ladders', () => {
  it('ladders exist for every skill drill but not reaction-time', () => {
    expect(COGNITIVE_LADDER_TYPES).toEqual(['n-back', 'digit-span', 'schulte-table', 'mental-rotation', 'stroop']);
    expect(cognitiveLadder('reaction-time')).toBeNull();
    expect(cognitiveLadder('nope')).toBeNull();
  });

  it('n-back raises n first (1→2→3) then squeezes stimulusMs', () => {
    const l = COGNITIVE_LADDERS['n-back'].levels;
    expect(l.map(r => r.n)).toEqual([1, 2, 3, 3, 3]);
    expect(l.map(r => r.stimulusMs)).toEqual([2500, 2500, 2500, 2000, 1600]);
  });

  it('digit-span grows forward then adds backward recall', () => {
    const l = COGNITIVE_LADDERS['digit-span'].levels;
    expect(l[0]).toMatchObject({ direction: 'forward', startLength: 4 });
    expect(l[l.length - 1]).toMatchObject({ direction: 'backward', maxLength: 9 });
  });

  it('cognitiveLevelConfig returns the clamped rung knobs (a fresh copy)', () => {
    expect(cognitiveLevelConfig('n-back', 0)).toEqual({ n: 1, stimulusMs: 2500 });
    expect(cognitiveLevelConfig('n-back', 99)).toEqual({ n: 3, stimulusMs: 1600 });
    expect(cognitiveLevelConfig('schulte-table', 1)).toEqual({ size: 5 });
    expect(cognitiveLevelConfig('reaction-time', 0)).toEqual({});
    // Mutating the result must not corrupt the ladder.
    const cfg = cognitiveLevelConfig('n-back', 0);
    cfg.n = 99;
    expect(COGNITIVE_LADDERS['n-back'].levels[0].n).toBe(1);
  });

  it('resolveCognitiveProgression maps a fresh user to level 0 with rung config + thresholds', () => {
    const r = resolveCognitiveProgression('n-back', {}, 0);
    expect(r.type).toBe('n-back');
    expect(r.level).toBe(0);
    expect(r.config).toEqual({ n: 1, stimulusMs: 2500 });
    expect(r.label).toBe('1-back @ 2500ms');
    expect(r.thresholds).toEqual({ minSamples: COGNITIVE_MASTERY_DEFAULTS.minSamples, targetAccuracy: COGNITIVE_MASTERY_DEFAULTS.targetAccuracy });
    expect(r.levels).toHaveLength(5);
  });

  it('resolveCognitiveProgression advances on sustained balanced accuracy', () => {
    const m = { samples: 3, accuracy: 0.9, avgResponseMs: 0 };
    const r = resolveCognitiveProgression('n-back', { 0: m, 1: m }, 0);
    expect(r.level).toBe(2); // 1-back and 2-back mastered → sits on 3-back
    expect(r.config).toEqual({ n: 3, stimulusMs: 2500 });
  });

  it('resolveCognitiveProgression is null for a non-laddered type', () => {
    expect(resolveCognitiveProgression('reaction-time', {}, 0)).toBeNull();
  });
});
