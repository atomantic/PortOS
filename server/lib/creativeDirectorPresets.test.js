import { describe, it, expect } from 'vitest';
import { presetToRenderParams, ASPECT_PRESETS, QUALITY_PRESETS, ASPECT_RATIOS, resolveAspectDimensions } from './creativeDirectorPresets.js';

describe('presetToRenderParams', () => {
  it('returns valid params for all current aspect ratios', () => {
    // Iterate the exported enum so a newly added ratio is automatically
    // covered without having to remember to update this test.
    expect(ASPECT_RATIOS.length).toBeGreaterThan(0);
    for (const aspectRatio of ASPECT_RATIOS) {
      const params = presetToRenderParams({ aspectRatio, quality: 'standard', durationSeconds: 3 });
      expect(params).toMatchObject({ width: expect.any(Number), height: expect.any(Number), fps: expect.any(Number) });
      expect(params.numFrames % 8).toBe(0);
      expect(params.numFrames).toBeGreaterThanOrEqual(8);
    }
  });

  it('does not throw for legacy 1:1-small and returns original 384×384 dims', () => {
    const legacy = presetToRenderParams({ aspectRatio: '1:1-small', quality: 'draft', durationSeconds: 3 });
    expect(legacy.width).toBe(384);
    expect(legacy.height).toBe(384);
  });

  it('throws for truly unknown aspectRatio', () => {
    expect(() => presetToRenderParams({ aspectRatio: 'bogus', quality: 'draft', durationSeconds: 1 })).toThrow("Unknown aspectRatio 'bogus'");
  });

  it('throws for unknown quality', () => {
    expect(() => presetToRenderParams({ aspectRatio: '1:1', quality: 'ultra', durationSeconds: 1 })).toThrow("Unknown quality 'ultra'");
  });

  it('rounds numFrames to a multiple of 8 and floors at 8', () => {
    const params = presetToRenderParams({ aspectRatio: '1:1', quality: 'draft', durationSeconds: 0.1 });
    expect(params.numFrames).toBe(8);
  });
});

describe('resolveAspectDimensions (#1938)', () => {
  it('returns the preset dims for a known ratio', () => {
    expect(resolveAspectDimensions('16:9')).toEqual({ width: 768, height: 432 });
  });

  it('degrades to the default { width: 0, height: 0 } for an unknown ratio', () => {
    expect(resolveAspectDimensions('bogus')).toEqual({ width: 0, height: 0 });
    expect(resolveAspectDimensions(undefined)).toEqual({ width: 0, height: 0 });
  });

  it('honors a caller-supplied fallback (first-pass gen passes {} so the worker default applies)', () => {
    const dims = resolveAspectDimensions('bogus', {});
    expect(dims).toEqual({});
    expect(dims.width).toBeUndefined();
    expect(dims.height).toBeUndefined();
  });
});
