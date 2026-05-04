import { describe, it, expect } from 'vitest';
import { presetToRenderParams, ASPECT_PRESETS, QUALITY_PRESETS } from './creativeDirectorPresets.js';

describe('presetToRenderParams', () => {
  it('returns valid params for all current aspect ratios', () => {
    for (const aspectRatio of ['16:9', '9:16', '1:1']) {
      const params = presetToRenderParams({ aspectRatio, quality: 'standard', durationSeconds: 3 });
      expect(params).toMatchObject({ width: expect.any(Number), height: expect.any(Number), fps: expect.any(Number) });
      expect(params.numFrames % 8).toBe(0);
      expect(params.numFrames).toBeGreaterThanOrEqual(8);
    }
  });

  it('does not throw for legacy 1:1-small and returns same dims as 1:1', () => {
    const legacy = presetToRenderParams({ aspectRatio: '1:1-small', quality: 'draft', durationSeconds: 3 });
    const current = presetToRenderParams({ aspectRatio: '1:1', quality: 'draft', durationSeconds: 3 });
    expect(legacy).toEqual(current);
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
