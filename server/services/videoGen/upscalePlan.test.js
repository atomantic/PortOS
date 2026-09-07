import { describe, it, expect } from 'vitest';
import {
  alignFrameCount, planLtxAlignment, planTargetDimensions, LTX_GRID, UPSCALE_SCALE,
  ltxUpscaleRuntimeId, UPSCALE_METHODS, UPSCALE_PROVENANCE_FIELDS, LANCZOS_PROVENANCE_FIELDS,
} from './upscalePlan.js';

// The grid is the model's, not ours: `scripts/generate_ltx25_cuda.py`'s
// validate_args rejects a render that violates it, so a plan that quietly
// reports "no padding needed" for a non-conforming source would hand the user a
// disclosure that the render then contradicts.
describe('alignFrameCount', () => {
  it('leaves a conforming count alone', () => {
    for (const frames of [9, 17, 25, 121]) expect(alignFrameCount(frames)).toBe(frames);
  });

  it('rounds UP to the next conforming count, never down', () => {
    // Rounding down would silently drop tail frames — duration loss #6502 forbids.
    expect(alignFrameCount(10)).toBe(17);
    expect(alignFrameCount(16)).toBe(17);
    expect(alignFrameCount(120)).toBe(121);
    expect(alignFrameCount(122)).toBe(129);
  });

  it('honors the model floor for a source shorter than the minimum', () => {
    for (const frames of [1, 5, 8, 9]) expect(alignFrameCount(frames)).toBe(LTX_GRID.minFrames);
  });

  it('never overshoots by a whole period', () => {
    for (let frames = 9; frames <= 400; frames += 1) {
      const aligned = alignFrameCount(frames);
      expect(aligned).toBeGreaterThanOrEqual(frames);
      expect(aligned - frames).toBeLessThan(LTX_GRID.frameModulus);
      expect(aligned % LTX_GRID.frameModulus).toBe(LTX_GRID.frameRemainder);
    }
  });
});

describe('planLtxAlignment', () => {
  // The model constrains the OUTPUT, and the output is 2x the source, so a
  // source axis conforms exactly when it is divisible by 32.
  it('reports zero padding for a source whose 2x output already sits on the grid', () => {
    const plan = planLtxAlignment({ width: 768, height: 512, frameCount: 121 });
    expect(plan).toMatchObject({ padWidth: 0, padHeight: 0, padFrames: 0, trimFrames: 0, conforming: true });
    expect(plan.paddedSource).toEqual({ width: 768, height: 512, frameCount: 121 });
  });

  it('reports the exact padding a non-conforming source needs on every axis', () => {
    const plan = planLtxAlignment({ width: 848, height: 480, frameCount: 100 });
    expect(plan.padWidth).toBe(16);   // 848 → 864 (1728 output, divisible by 64)
    expect(plan.padHeight).toBe(0);   // 480 is already a multiple of 32
    expect(plan.padFrames).toBe(5);   // 100 → 105
    expect(plan.conforming).toBe(false);
  });

  it('pads rather than trims, so the plan can never lose source content', () => {
    for (const frameCount of [10, 63, 100, 122]) {
      const plan = planLtxAlignment({ width: 850, height: 481, frameCount });
      expect(plan.trimFrames).toBe(0);
      expect(plan.padWidth).toBeGreaterThan(0);
      expect(plan.padHeight).toBeGreaterThan(0);
      expect(plan.paddedSource.frameCount).toBeGreaterThanOrEqual(frameCount);
    }
  });

  it('keeps an unmeasured axis null instead of reporting a confident zero', () => {
    const plan = planLtxAlignment({ width: 768, height: 512, frameCount: null });
    expect(plan.padWidth).toBe(0);
    expect(plan.padFrames).toBeNull();
    // A probe that could not read the frame count must not read as "conforming".
    expect(plan.conforming).toBeNull();
  });

  it('produces an output that satisfies the model grid on every padded axis', () => {
    for (const [width, height] of [[848, 480], [1000, 999], [512, 512], [33, 17]]) {
      const plan = planLtxAlignment({ width, height, frameCount: 61 });
      expect((plan.paddedSource.width * UPSCALE_SCALE) % LTX_GRID.spatialMultiple).toBe(0);
      expect((plan.paddedSource.height * UPSCALE_SCALE) % LTX_GRID.spatialMultiple).toBe(0);
    }
  });
});

describe('planTargetDimensions', () => {
  it('doubles the source verbatim for lanczos', () => {
    expect(planTargetDimensions({ method: 'lanczos', width: 848, height: 480, frameCount: 100 }))
      .toEqual({ width: 1696, height: 960, frameCount: 100 });
  });

  it('doubles the PADDED source for the generative method', () => {
    const source = { width: 848, height: 480, frameCount: 100 };
    const alignment = planLtxAlignment(source);
    expect(planTargetDimensions({ method: 'ltx', ...source, alignment }))
      .toEqual({ width: 1728, height: 960, frameCount: 105 });
  });

  it('reports an unmeasurable axis as null rather than zero', () => {
    expect(planTargetDimensions({ method: 'lanczos', width: null, height: 0, frameCount: null }))
      .toEqual({ width: null, height: null, frameCount: null });
  });
});

describe('contract constants', () => {
  it('keeps lanczos first so it stays the historical default', () => {
    expect(UPSCALE_METHODS).toEqual(['lanczos', 'ltx']);
  });

  it('maps each supported host class to the runtime that carries the adapter', () => {
    expect(ltxUpscaleRuntimeId('darwin')).toBe('ltx25');
    expect(ltxUpscaleRuntimeId('win32')).toBe('ltx25_cuda');
    expect(ltxUpscaleRuntimeId('linux')).toBe('ltx25_cuda');
    expect(ltxUpscaleRuntimeId('freebsd')).toBeNull();
  });

  it('keeps what lanczos writes inside the contract the generative slice must satisfy', () => {
    // Two lists drift the moment #6511 adds a field to only one of them; this is
    // the containment that makes the pair readable as one contract.
    for (const field of LANCZOS_PROVENANCE_FIELDS) {
      expect(UPSCALE_PROVENANCE_FIELDS).toContain(field);
    }
  });
});
