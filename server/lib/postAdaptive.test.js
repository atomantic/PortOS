import { describe, it, expect } from 'vitest';
import {
  adaptDrillConfig,
  scoreToDirection,
  clampNum,
  ADAPTIVE_SPECS,
  ADAPTIVE_DEFAULTS,
} from './postAdaptive.js';

describe('clampNum', () => {
  it('clamps within bounds', () => {
    expect(clampNum(5, 1, 10)).toBe(5);
    expect(clampNum(-3, 1, 10)).toBe(1);
    expect(clampNum(99, 1, 10)).toBe(10);
  });
});

describe('scoreToDirection', () => {
  it('returns 1 (harder) at/above the high threshold', () => {
    expect(scoreToDirection(90)).toBe(1);
    expect(scoreToDirection(100)).toBe(1);
  });
  it('returns -1 (easier) at/below the low threshold', () => {
    expect(scoreToDirection(50)).toBe(-1);
    expect(scoreToDirection(10)).toBe(-1);
  });
  it('holds in the middle band', () => {
    expect(scoreToDirection(70)).toBe(0);
    expect(scoreToDirection(89)).toBe(0);
    expect(scoreToDirection(51)).toBe(0);
  });
  it('holds on a null/NaN score', () => {
    expect(scoreToDirection(null)).toBe(0);
    expect(scoreToDirection(NaN)).toBe(0);
  });
});

describe('adaptDrillConfig', () => {
  it('leaves non-math / unsupported types untouched', () => {
    const res = adaptDrillConfig('word-association', { count: 5 }, { score: 95, samples: 10 });
    expect(res.applied).toBe(false);
    expect(res.reason).toBe('unsupported');
    expect(res.config).toEqual({ count: 5 });
  });

  it('does not adapt until minSamples is met', () => {
    const res = adaptDrillConfig('multiplication', { maxDigits: 2 }, { score: 99, samples: 2 });
    expect(res.applied).toBe(false);
    expect(res.reason).toBe('insufficient-samples');
    expect(res.config.maxDigits).toBe(2);
  });

  it('skips adaptation when completion is below the floor (too little signal)', () => {
    // Enough samples and a high accuracy signal, but the user only reached ~30%
    // of the drill — not a trustworthy difficulty signal, so hold (issue #2094).
    const res = adaptDrillConfig('multiplication', { maxDigits: 2 }, { score: 95, samples: 5, completion: 0.3 });
    expect(res.applied).toBe(false);
    expect(res.reason).toBe('insufficient-completion');
    expect(res.config.maxDigits).toBe(2);
  });

  it('still EASES under the completion floor — chronic time-outs must not deadlock difficulty', () => {
    // Low completion + low accuracy: the drill is too hard/long. Blocking the
    // ease would freeze difficulty forever (low completion → no adaptation →
    // completion stays low), so the easier direction passes the floor.
    const res = adaptDrillConfig('multiplication', { maxDigits: 3 }, { score: 30, samples: 5, completion: 0.3 });
    expect(res.applied).toBe(true);
    expect(res.reason).toBe('easier');
    expect(res.config.maxDigits).toBe(2);
  });

  it('adapts normally once completion clears the floor', () => {
    const res = adaptDrillConfig('multiplication', { maxDigits: 2 }, { score: 95, samples: 5, completion: 0.8 });
    expect(res.applied).toBe(true);
    expect(res.reason).toBe('harder');
    expect(res.completion).toBe(0.8);
    expect(res.config.maxDigits).toBe(3);
  });

  it('adapts when completion is absent (legacy signal without the field)', () => {
    const res = adaptDrillConfig('multiplication', { maxDigits: 2 }, { score: 95, samples: 5 });
    expect(res.applied).toBe(true);
    expect(res.reason).toBe('harder');
    expect(res.completion).toBe(null);
  });

  it('bumps the primary knob harder on sustained high scores (higher = harder)', () => {
    const res = adaptDrillConfig('multiplication', { maxDigits: 2 }, { score: 95, samples: 5 });
    expect(res.applied).toBe(true);
    expect(res.reason).toBe('harder');
    expect(res.field).toBe('maxDigits');
    expect(res.from).toBe(2);
    expect(res.to).toBe(3);
    expect(res.config.maxDigits).toBe(3);
  });

  it('eases the primary knob on repeated low scores', () => {
    const res = adaptDrillConfig('doubling-chain', { steps: 8 }, { score: 40, samples: 6 });
    expect(res.applied).toBe(true);
    expect(res.reason).toBe('easier');
    expect(res.from).toBe(8);
    expect(res.to).toBe(6);
    expect(res.config.steps).toBe(6);
  });

  it('holds when performance is in the middle band', () => {
    const res = adaptDrillConfig('powers', { maxExponent: 10 }, { score: 75, samples: 8 });
    expect(res.applied).toBe(false);
    expect(res.reason).toBe('hold');
    expect(res.config.maxExponent).toBe(10);
  });

  it('inverts direction for estimation (lower tolerance is harder)', () => {
    const harder = adaptDrillConfig('estimation', { tolerancePct: 10 }, { score: 95, samples: 5 });
    expect(harder.applied).toBe(true);
    expect(harder.reason).toBe('harder');
    expect(harder.to).toBeLessThan(harder.from); // tightened tolerance

    const easier = adaptDrillConfig('estimation', { tolerancePct: 10 }, { score: 30, samples: 5 });
    expect(easier.applied).toBe(true);
    expect(easier.reason).toBe('easier');
    expect(easier.to).toBeGreaterThan(easier.from); // widened tolerance
  });

  it('never exceeds the spec max when already at the ceiling', () => {
    const spec = ADAPTIVE_SPECS.multiplication;
    const res = adaptDrillConfig('multiplication', { maxDigits: spec.max }, { score: 100, samples: 20 });
    expect(res.applied).toBe(false);
    expect(res.reason).toBe('at-hardest');
    expect(res.config.maxDigits).toBe(spec.max);
  });

  it('never drops below the spec min when already at the floor', () => {
    const spec = ADAPTIVE_SPECS['doubling-chain'];
    const res = adaptDrillConfig('doubling-chain', { steps: spec.min }, { score: 0, samples: 20 });
    expect(res.applied).toBe(false);
    expect(res.reason).toBe('at-easiest');
    expect(res.config.steps).toBe(spec.min);
  });

  it('clamps an out-of-spec manual value into the effective config once engaged', () => {
    // The schema/UI allow doubling-chain steps up to 20, but the adaptive spec
    // caps at 16. When adaptive is engaged, the effective config must carry the
    // clamped value (16) — not the raw 20 — so generation honors the bounds the
    // preview advertises. (Regression: codex P2 on PR #2003.)
    const spec = ADAPTIVE_SPECS['doubling-chain'];
    const res = adaptDrillConfig('doubling-chain', { steps: 20 }, { score: 99, samples: 8 });
    expect(res.reason).toBe('at-hardest');
    expect(res.config.steps).toBe(spec.max); // 16, not 20
    expect(res.to).toBe(spec.max);
  });

  it('enforces the clamped value even on the hold path', () => {
    // steps=20 (out of spec) with a mid-band score → hold, but the effective
    // config is still clamped down to the adaptive max.
    const spec = ADAPTIVE_SPECS['doubling-chain'];
    const res = adaptDrillConfig('doubling-chain', { steps: 20 }, { score: 70, samples: 8 });
    expect(res.reason).toBe('hold');
    expect(res.applied).toBe(false);
    expect(res.config.steps).toBe(spec.max);
  });

  it('leaves an out-of-spec manual value untouched until adaptive engages', () => {
    // Below the sample gate, adaptive is not engaged — the manual value (even
    // out of the adaptive spec range) passes through as the override.
    const res = adaptDrillConfig('doubling-chain', { steps: 20 }, { score: 99, samples: 1 });
    expect(res.reason).toBe('insufficient-samples');
    expect(res.config.steps).toBe(20);
  });

  it('falls back to the spec base when the config omits the knob', () => {
    const spec = ADAPTIVE_SPECS.multiplication;
    const res = adaptDrillConfig('multiplication', {}, { score: 95, samples: 5 });
    expect(res.from).toBe(spec.base);
    expect(res.to).toBe(clampNum(spec.base + spec.step, spec.min, spec.max));
  });

  it('respects overridden thresholds', () => {
    const res = adaptDrillConfig(
      'multiplication',
      { maxDigits: 2 },
      { score: 80, samples: 5 },
      { highScore: 75 }
    );
    expect(res.applied).toBe(true);
    expect(res.reason).toBe('harder');
  });

  it('does not mutate the input config object', () => {
    const base = { maxDigits: 2 };
    adaptDrillConfig('multiplication', base, { score: 95, samples: 5 });
    expect(base).toEqual({ maxDigits: 2 });
  });

  it('exposes sane defaults', () => {
    expect(ADAPTIVE_DEFAULTS.highScore).toBeGreaterThan(ADAPTIVE_DEFAULTS.lowScore);
    expect(ADAPTIVE_DEFAULTS.minSamples).toBeGreaterThanOrEqual(1);
  });
});
