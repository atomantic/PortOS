import { describe, it, expect } from 'vitest';
import {
  scoreEvaluation,
  decideKeepRevert,
  shouldStopPolish,
  resolveCycles,
  EVAL_SEVERITY_WEIGHTS,
  SAFE_POLISH_CUT_TYPES,
  POLISH_DEFAULTS,
} from './writersRoomPolish.js';

describe('scoreEvaluation', () => {
  it('returns null for absent/invalid input (distinct from a genuine 0)', () => {
    expect(scoreEvaluation(null)).toBeNull();
    expect(scoreEvaluation(undefined)).toBeNull();
    expect(scoreEvaluation('nope')).toBeNull();
  });

  it('scores a clean draft (no issues) at 100', () => {
    expect(scoreEvaluation({ issues: [] })).toBe(100);
    expect(scoreEvaluation({})).toBe(100);
  });

  it('penalizes by severity weight', () => {
    expect(scoreEvaluation({ issues: [{ severity: 'major' }] })).toBe(100 - EVAL_SEVERITY_WEIGHTS.major);
    expect(scoreEvaluation({ issues: [{ severity: 'moderate' }] })).toBe(100 - EVAL_SEVERITY_WEIGHTS.moderate);
    expect(scoreEvaluation({ issues: [{ severity: 'minor' }] })).toBe(100 - EVAL_SEVERITY_WEIGHTS.minor);
  });

  it('sums multiple issues and clamps at 0', () => {
    const issues = Array.from({ length: 12 }, () => ({ severity: 'major' }));
    expect(scoreEvaluation({ issues })).toBe(0); // 12 * 12 = 144 penalty, clamped
  });

  it('treats an unknown severity as a minor nit (never free)', () => {
    expect(scoreEvaluation({ issues: [{ severity: 'wat' }] })).toBe(100 - EVAL_SEVERITY_WEIGHTS.minor);
    expect(scoreEvaluation({ issues: [{}] })).toBe(100 - EVAL_SEVERITY_WEIGHTS.minor);
  });

  it('does not reward strengths (cannot exceed 100)', () => {
    expect(scoreEvaluation({ issues: [], strengths: ['a', 'b', 'c'] })).toBe(100);
  });
});

describe('decideKeepRevert', () => {
  it('keeps when the score improves by at least minKeepDelta', () => {
    expect(decideKeepRevert(80, 85, { minKeepDelta: 1 })).toMatchObject({ keep: true, delta: 5, reason: 'improved' });
    expect(decideKeepRevert(80, 81, { minKeepDelta: 1 })).toMatchObject({ keep: true, delta: 1 });
  });

  it('reverts when the score regresses', () => {
    expect(decideKeepRevert(80, 70, { minKeepDelta: 1 })).toMatchObject({ keep: false, reason: 'regressed' });
  });

  it('reverts an improvement below the threshold', () => {
    expect(decideKeepRevert(80, 80.5, { minKeepDelta: 1 })).toMatchObject({ keep: false, reason: 'below-threshold' });
  });

  it('reverts a no-op (delta 0)', () => {
    expect(decideKeepRevert(80, 80, { minKeepDelta: 1 })).toMatchObject({ keep: false, reason: 'regressed' });
  });

  it('reverts when the after-evaluation failed (no proof of improvement)', () => {
    expect(decideKeepRevert(80, null)).toMatchObject({ keep: false, reason: 'no-after-score' });
  });

  it('keeps conservatively when only the after-score exists', () => {
    expect(decideKeepRevert(null, 80)).toMatchObject({ keep: true, reason: 'no-before-score' });
  });

  it('defaults minKeepDelta from POLISH_DEFAULTS', () => {
    expect(decideKeepRevert(80, 80 + POLISH_DEFAULTS.minKeepDelta).keep).toBe(true);
  });
});

describe('shouldStopPolish', () => {
  it('stops at the max cycle count', () => {
    expect(shouldStopPolish({ cycle: 3, cycles: 3, kept: true, delta: 10 })).toMatchObject({ stop: true, reason: 'max-cycles' });
  });

  it('stops after a reverted cycle (no improvement over the same body)', () => {
    expect(shouldStopPolish({ cycle: 1, cycles: 3, kept: false, delta: -2 })).toMatchObject({ stop: true, reason: 'reverted' });
  });

  it('stops on plateau (kept but improvement below plateauDelta)', () => {
    expect(shouldStopPolish({ cycle: 1, cycles: 3, kept: true, delta: 1, plateauDelta: 2 })).toMatchObject({ stop: true, reason: 'plateau' });
  });

  it('continues when kept with a healthy improvement and cycles remain', () => {
    expect(shouldStopPolish({ cycle: 1, cycles: 3, kept: true, delta: 10, plateauDelta: 2 })).toMatchObject({ stop: false, reason: 'continue' });
  });

  it('a null delta (no-before-score keep) does not trigger the plateau branch', () => {
    expect(shouldStopPolish({ cycle: 1, cycles: 3, kept: true, delta: null, plateauDelta: 2 })).toMatchObject({ stop: false });
  });
});

describe('resolveCycles', () => {
  it('defaults an invalid/missing count to POLISH_DEFAULTS.cycles', () => {
    expect(resolveCycles(undefined)).toBe(POLISH_DEFAULTS.cycles);
    expect(resolveCycles(0)).toBe(POLISH_DEFAULTS.cycles);
    expect(resolveCycles(-4)).toBe(POLISH_DEFAULTS.cycles);
    expect(resolveCycles(2.5)).toBe(POLISH_DEFAULTS.cycles);
    expect(resolveCycles('x')).toBe(POLISH_DEFAULTS.cycles);
  });

  it('passes through a valid count and clamps to maxCycles', () => {
    expect(resolveCycles(2)).toBe(2);
    expect(resolveCycles(3)).toBe(3);
    expect(resolveCycles(99)).toBe(POLISH_DEFAULTS.maxCycles);
  });
});

describe('constants', () => {
  it('SAFE_POLISH_CUT_TYPES is the OVER-EXPLAIN + REDUNDANT safe subset', () => {
    expect(SAFE_POLISH_CUT_TYPES).toEqual(['OVER-EXPLAIN', 'REDUNDANT']);
  });
});
