import { describe, expect, it } from 'vitest';
import {
  RENDER_SEED_MAX,
  RENDER_STEPS_MAX,
  RENDER_STEPS_MIN,
  isValidRenderSeed,
  isValidRenderSteps,
  normalizeRenderOptions,
  randomRenderSeed,
  renderOptionArgs,
  validateRenderOptions,
  honorTargetRenderSupport,
} from './renderOptions.js';

describe('normalizeRenderOptions', () => {
  it('defaults to unset steps/seed with keying enabled', () => {
    expect(normalizeRenderOptions()).toEqual({ steps: null, seed: null, keyBackground: true });
    expect(normalizeRenderOptions({})).toEqual({ steps: null, seed: null, keyBackground: true });
  });

  it('keeps valid values and collapses invalid ones to the unset sentinel', () => {
    expect(normalizeRenderOptions({ steps: 24, seed: 0, keyBackground: false }))
      .toEqual({ steps: 24, seed: 0, keyBackground: false });
    expect(normalizeRenderOptions({ steps: RENDER_STEPS_MAX + 1, seed: RENDER_SEED_MAX + 1 }))
      .toEqual({ steps: null, seed: null, keyBackground: true });
    expect(normalizeRenderOptions({ steps: 12.5, seed: '42' }))
      .toEqual({ steps: null, seed: null, keyBackground: true });
  });
});

describe('renderOptionArgs', () => {
  it('emits --seed/--steps for provided values and nothing for unset ones', () => {
    expect(renderOptionArgs('x', { steps: 24, seed: 1234 }))
      .toEqual(['--seed', '1234', '--steps', '24']);
    expect(renderOptionArgs('x', { seed: 0 })).toEqual(['--seed', '0']);
    expect(renderOptionArgs('x', {})).toEqual([]);
    expect(renderOptionArgs('x')).toEqual([]);
  });

  it('throws with the caller label on out-of-range values', () => {
    expect(() => renderOptionArgs('buildGenerateArgs', { steps: 0 }))
      .toThrow(/buildGenerateArgs: steps must be an integer/);
    expect(() => renderOptionArgs('buildCudaGenerateArgs', { seed: -1 }))
      .toThrow(/buildCudaGenerateArgs: seed must be an integer/);
    expect(() => renderOptionArgs('x', { steps: RENDER_STEPS_MAX + 1 }))
      .toThrow(/steps must be an integer/);
    expect(() => renderOptionArgs('x', { seed: RENDER_SEED_MAX + 1 }))
      .toThrow(/seed must be an integer/);
  });
});

describe('randomRenderSeed', () => {
  it('stays in the valid int32 seed range', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(isValidRenderSeed(randomRenderSeed())).toBe(true);
    }
  });
});

describe('validators', () => {
  it('accept the bounds and reject just outside them', () => {
    expect(isValidRenderSteps(RENDER_STEPS_MIN)).toBe(true);
    expect(isValidRenderSteps(RENDER_STEPS_MAX)).toBe(true);
    expect(isValidRenderSteps(RENDER_STEPS_MIN - 1)).toBe(false);
    expect(isValidRenderSteps(RENDER_STEPS_MAX + 1)).toBe(false);
    expect(isValidRenderSeed(0)).toBe(true);
    expect(isValidRenderSeed(RENDER_SEED_MAX)).toBe(true);
    expect(isValidRenderSeed(-1)).toBe(false);
    expect(isValidRenderSeed(RENDER_SEED_MAX + 1)).toBe(false);
  });
});

describe('validateRenderOptions', () => {
  it('enforces the same bounds as renderOptionArgs without emitting flags', () => {
    expect(() => validateRenderOptions('x', { steps: 0 })).toThrow(/steps must be an integer/);
    expect(() => validateRenderOptions('x', { steps: 65 })).toThrow(/steps must be an integer/);
    expect(() => validateRenderOptions('x', { seed: -1 })).toThrow(/seed must be an integer/);
    expect(() => validateRenderOptions('x', { seed: 2147483648 })).toThrow(/seed must be an integer/);
    expect(validateRenderOptions('x', { steps: 12, seed: 7 })).toBeUndefined();
    expect(validateRenderOptions('x')).toBeUndefined();
  });

  it('names the caller in the error, so a lane-specific builder reads as the thrower', () => {
    expect(() => validateRenderOptions('buildPixal3dGenerateArgs', { steps: 999 }))
      .toThrow(/^buildPixal3dGenerateArgs:/);
  });
});

describe('honorTargetRenderSupport', () => {
  const opts = { steps: 24, seed: 7, keyBackground: true };

  it('passes everything through for a target that declares no limits', () => {
    // Absent support must mean "honors everything", so existing targets need no entry.
    expect(honorTargetRenderSupport(opts, undefined)).toBe(opts);
    expect(honorTargetRenderSupport(opts, null)).toBe(opts);
  });

  it('nulls only the unsupported knob, leaving the rest intact', () => {
    expect(honorTargetRenderSupport(opts, { steps: false }))
      .toEqual({ steps: null, seed: 7, keyBackground: true });
  });

  it('leaves a knob alone when support is explicitly true', () => {
    expect(honorTargetRenderSupport(opts, { steps: true })).toEqual(opts);
  });

  it('does not mutate its input', () => {
    honorTargetRenderSupport(opts, { steps: false });
    expect(opts.steps).toBe(24);
  });
});
