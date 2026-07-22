import { describe, it, expect } from 'vitest';
import {
  videoModelMemoryGb, computeFflfSafeFrames, isModelAllowedForMode,
  VIDEO_EDGE_BOUNDS, FRAME_OPTIONS, FPS_OPTIONS,
} from './videoGenParams.js';

describe('videoModelMemoryGb', () => {
  it('prefers an explicit positive memoryGb field', () => {
    expect(videoModelMemoryGb({ memoryGb: 24, name: '~48 GB' })).toBe(24);
  });
  it('falls back to a "~NN GB" hint in the name', () => {
    expect(videoModelMemoryGb({ name: 'LTX 2.3 (~12.5 GB)' })).toBe(12.5);
  });
  it('returns +Infinity when neither is present so it never spuriously fits a budget', () => {
    expect(videoModelMemoryGb({ name: 'mystery model' })).toBe(Number.POSITIVE_INFINITY);
    expect(videoModelMemoryGb(null)).toBe(Number.POSITIVE_INFINITY);
  });
  it('ignores a non-positive memoryGb and falls through', () => {
    expect(videoModelMemoryGb({ memoryGb: 0, name: '~8 GB' })).toBe(8);
  });
});

describe('computeFflfSafeFrames', () => {
  it('returns numFrames unchanged when it already fits the budget', () => {
    expect(computeFflfSafeFrames(768, 512, 121, 768 * 512 * 200)).toBe(121);
  });
  it('is fail-open (returns numFrames) when the budget is unknown', () => {
    expect(computeFflfSafeFrames(768, 512, 121, undefined)).toBe(121);
    expect(computeFflfSafeFrames(768, 512, 121, 0)).toBe(121);
  });
  it('clamps down to the LTX 8k+1 latent boundary when over budget', () => {
    // budget fits ~50 pixel-frames → safeLatent = floor((50-1)/8)=6 → 6*8+1=49
    const budget = 768 * 512 * 50;
    const out = computeFflfSafeFrames(768, 512, 121, budget);
    expect(out).toBe(49);
    expect((out - 1) % 8).toBe(0);
    expect(out).toBeLessThan(121);
  });
  it('returns numFrames for degenerate (0) dimensions', () => {
    expect(computeFflfSafeFrames(0, 512, 121, 1000)).toBe(121);
  });
});

describe('isModelAllowedForMode', () => {
  it('rejects a null model', () => {
    expect(isModelAllowedForMode(null, 'text')).toBe(false);
  });
  it('allows any runtime for non-a2v modes', () => {
    expect(isModelAllowedForMode({ runtime: 'mlx_video' }, 'text')).toBe(true);
    expect(isModelAllowedForMode({ runtime: 'ltx2' }, 'image')).toBe(true);
  });
  it('requires the ltx2 runtime for a2v', () => {
    expect(isModelAllowedForMode({ runtime: 'ltx2' }, 'a2v')).toBe(true);
    expect(isModelAllowedForMode({ runtime: 'mlx_video' }, 'a2v')).toBe(false);
  });
});

describe('constants', () => {
  it('VIDEO_EDGE_BOUNDS mirrors the server 64..2048 grid', () => {
    expect(VIDEO_EDGE_BOUNDS).toEqual({ min: 64, max: 2048, step: 64 });
  });
  it('frame/fps option lists are on the expected boundaries', () => {
    expect(FRAME_OPTIONS[0]).toBe(25);
    expect(FRAME_OPTIONS.every((f) => (f - 1) % 8 === 0)).toBe(true);
    expect(FPS_OPTIONS).toEqual([16, 24, 30]);
  });
});
