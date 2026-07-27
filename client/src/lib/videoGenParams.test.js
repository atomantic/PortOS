import { describe, it, expect } from 'vitest';
import {
  videoModelMemoryGb, computeFflfSafeFrames, isModelAllowedForMode,
  VIDEO_EDGE_BOUNDS, FRAME_OPTIONS, FPS_OPTIONS,
  IC_LORA_MODES, IC_LORA_MODE_VALUES, isIcLoraMode, icLoraSpecForMode,
  icResolutionIssue,
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

describe('IC-LoRA remix modes (#3100)', () => {
  it('mirrors the server registry shape', () => {
    expect(IC_LORA_MODE_VALUES).toEqual(['ic-control', 'ic-colorize', 'ic-ingredients']);
    for (const spec of IC_LORA_MODES) {
      // The `ic-` prefix drives the download-id router in useModelDownloadStatus.
      expect(spec.mode.startsWith('ic-')).toBe(true);
      expect(spec.maxReferences).toBeGreaterThanOrEqual(spec.minReferences);
      expect(spec.referenceDownscaleFactor).toBeGreaterThanOrEqual(1);
      // The panel renders these two directly — an empty one ships blank copy.
      expect(spec.uploadLabel).toBeTruthy();
      expect(spec.description).toBeTruthy();
      // Drives which input surface the panel renders (single clip vs the 2-8
      // gallery row list), so an unrecognized value would render nothing.
      expect(['video', 'image']).toContain(spec.referenceKind);
    }
  });

  it('mirrors the Ingredients bounds + image kind (#3112)', () => {
    // The 2-8 count is the weight's contract, mirrored here so the form blocks
    // before a POST the route would reject; the parity test in
    // server/lib/icLoraWeights.parity.test.js is what keeps the two in step.
    const ing = icLoraSpecForMode('ic-ingredients');
    expect(ing.minReferences).toBe(2);
    expect(ing.maxReferences).toBe(8);
    expect(ing.referenceKind).toBe('image');
    // Factor 1 → no divisibility rule at all, so an odd resolution is legal.
    expect(icResolutionIssue(ing, 705, 449)).toBeNull();
  });
  it('identifies IC modes', () => {
    expect(isIcLoraMode('ic-control')).toBe(true);
    expect(isIcLoraMode('ic-colorize')).toBe(true);
    expect(isIcLoraMode('text')).toBe(false);
    expect(isIcLoraMode(undefined)).toBe(false);
  });
  it('resolves a spec by mode, null otherwise', () => {
    expect(icLoraSpecForMode('ic-control')?.label).toBe('Control');
    expect(icLoraSpecForMode('ic-colorize')?.label).toBe('Colorize');
    expect(icLoraSpecForMode('extend')).toBeNull();
  });
  it('requires the ltx2 runtime for IC modes', () => {
    for (const mode of IC_LORA_MODE_VALUES) {
      expect(isModelAllowedForMode({ runtime: 'ltx2' }, mode)).toBe(true);
      expect(isModelAllowedForMode({ runtime: 'mlx_video' }, mode)).toBe(false);
      expect(isModelAllowedForMode({ runtime: 'wan22' }, mode)).toBe(false);
    }
  });
  it('keeps each mode on its own resolution rule (Control 2, Colorize 1)', () => {
    // Mirrors server/lib/icLoraWeights.js, where each factor is READ from that
    // weight's safetensors metadata — a drift here would let the form accept a
    // resolution the server rejects with IC_LORA_RESOLUTION_NOT_DIVISIBLE, or
    // reject one the server would happily render.
    expect(icLoraSpecForMode('ic-control').referenceDownscaleFactor).toBe(2);
    expect(icLoraSpecForMode('ic-colorize').referenceDownscaleFactor).toBe(1);
  });
  it('gives each mode a distinct upload label so the panel reads correctly', () => {
    // The panel is fully spec-driven; a shared label would tell a Colorize user
    // to upload a depth/pose clip.
    const labels = IC_LORA_MODES.map((m) => m.uploadLabel);
    expect(new Set(labels).size).toBe(labels.length);
    expect(icLoraSpecForMode('ic-colorize').uploadLabel).toMatch(/B&W/);
  });
});
