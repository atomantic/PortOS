import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CONTEXT_FRAMES, MIN_CONTEXT_FRAMES, MAX_CONTEXT_FRAMES,
  resolveContextFrames, resolveContinuityStrategy, supportsContextWindow, continuationContract,
  extendLatentFrames, extendedPixelFrames, contextPrefixFrames, tailWindowStartFrame, planExtendSplice,
} from './videoContinuity.js';

describe('resolveContextFrames', () => {
  it('defaults when the value is absent', () => {
    for (const absent of [null, undefined, '']) {
      expect(resolveContextFrames(absent)).toBe(DEFAULT_CONTEXT_FRAMES);
    }
  });

  it('preserves an explicit 0 instead of collapsing it into the default', () => {
    // This is the whole sentinel discipline: 0 means "last frame only", and
    // treating it as absent would make windowed continuation impossible to
    // turn off once it became the default.
    expect(resolveContextFrames(0)).toBe(0);
    expect(resolveContextFrames('0')).toBe(0);
  });

  it('clamps into range rather than rejecting', () => {
    expect(resolveContextFrames(-5)).toBe(MIN_CONTEXT_FRAMES);
    expect(resolveContextFrames(MAX_CONTEXT_FRAMES + 500)).toBe(MAX_CONTEXT_FRAMES);
  });

  it('floors a fractional value', () => {
    expect(resolveContextFrames(22.9)).toBe(22);
  });

  it('falls back to the default for a non-numeric value', () => {
    // NaN would otherwise poison every frame index derived from it.
    expect(resolveContextFrames('lots')).toBe(DEFAULT_CONTEXT_FRAMES);
    expect(resolveContextFrames(Infinity)).toBe(DEFAULT_CONTEXT_FRAMES);
  });
});

describe('supportsContextWindow / resolveContinuityStrategy', () => {
  it('only verified LTX runtimes have an extend pipeline to feed a window to', () => {
    expect(supportsContextWindow({ runtime: 'ltx2' })).toBe(true);
    expect(supportsContextWindow({ runtime: 'ltx25' })).toBe(true);
    for (const runtime of ['mlx_video', 'minimax_h3', 'minimax_h3_cuda', 'wan22', 'fastvideo']) {
      expect(supportsContextWindow({ runtime })).toBe(false);
    }
    expect(supportsContextWindow(null)).toBe(false);
    expect(supportsContextWindow({})).toBe(false);
  });

  it('is not the same question as "declares the extend mode"', () => {
    // #3737 resolves a supportedModes list for every entry, and mlx_video's
    // includes 'extend' — but it implements that by extracting a last frame and
    // running i2v, with no pipeline to hand a video to. Deriving this from
    // supportedModes would route mlx_video chains into a window path its helper
    // cannot honor, so the runtime check has to stay a separate fact.
    const mlx = { runtime: 'mlx_video', supportedModes: ['text', 'image', 'fflf', 'extend'] };
    expect(mlx.supportedModes).toContain('extend');
    expect(supportsContextWindow(mlx)).toBe(false);
  });

  it('windows when the runtime supports it and a window was asked for', () => {
    expect(resolveContinuityStrategy({ model: { runtime: 'ltx2' }, contextFrames: 22 })).toBe('window');
  });

  it('falls back to last-frame chaining, never an error, on an unsupported runtime', () => {
    // Silently degrading is deliberate — switching models mid-form must not
    // strand a request that was legal a moment ago.
    expect(resolveContinuityStrategy({ model: { runtime: 'minimax_h3' }, contextFrames: 22 })).toBe('frame');
    expect(resolveContinuityStrategy({ model: null, contextFrames: 22 })).toBe('frame');
  });

  it('honors an explicit 0 as an opt-out on a supported runtime', () => {
    expect(resolveContinuityStrategy({ model: { runtime: 'ltx2' }, contextFrames: 0 })).toBe('frame');
  });
});

describe('extend latent arithmetic', () => {
  it('converts a pixel-frame request to latents with no leading +1', () => {
    // The context window already supplies the anchor frame, so this is a plain
    // divide — an off-by-one here desyncs the trim from what was rendered.
    expect(extendLatentFrames(97, 'ltx2')).toBe(12);
    expect(extendLatentFrames(25, 'ltx2')).toBe(3);
  });

  it('floors at one latent so a tiny request still renders something', () => {
    expect(extendLatentFrames(4, 'ltx2')).toBe(1);
    expect(extendLatentFrames(0, 'ltx2')).toBe(1);
    expect(extendLatentFrames(null, 'ltx2')).toBe(1);
    expect(extendLatentFrames('nope', 'ltx2')).toBe(1);
  });

  it('round-trips back to pixel frames at the VAE stride', () => {
    expect(extendedPixelFrames(3, 'ltx2')).toBe(24);
    expect(extendedPixelFrames(0, 'ltx2')).toBe(0);
    expect(extendedPixelFrames(-4, 'ltx2')).toBe(0);
  });
});

describe('contextPrefixFrames', () => {
  it('measures the echo as everything before the newly-generated frames', () => {
    // A 25-frame render that appended 3 latents (24 frames) opens with 1 frame
    // of echoed context.
    expect(contextPrefixFrames({ runtime: 'ltx2', totalFrames: 25, extendLatents: 3 })).toBe(1);
    expect(contextPrefixFrames({ runtime: 'ltx2', totalFrames: 120, extendLatents: 12 })).toBe(24);
  });

  it('returns 0 — "leave it alone" — when the numbers do not support a trim', () => {
    // An unprobeable output must never be read as "trim everything", which
    // would delete the chunk's real content.
    expect(contextPrefixFrames({ runtime: 'ltx2', totalFrames: null, extendLatents: 3 })).toBe(0);
    expect(contextPrefixFrames({ runtime: 'ltx2', totalFrames: 0, extendLatents: 3 })).toBe(0);
    expect(contextPrefixFrames({ runtime: 'ltx2', totalFrames: 24, extendLatents: 3 })).toBe(0);
    expect(contextPrefixFrames({ runtime: 'ltx2', totalFrames: 10, extendLatents: 3 })).toBe(0);
    expect(contextPrefixFrames({ runtime: 'ltx2', totalFrames: 100, extendLatents: 0 })).toBe(0);
  });
});

describe('tailWindowStartFrame', () => {
  it('starts the window `frames` back from the end', () => {
    expect(tailWindowStartFrame({ totalFrames: 97, frames: 22 })).toBe(75);
  });

  it('keeps the whole clip when the window is longer than it', () => {
    expect(tailWindowStartFrame({ totalFrames: 16, frames: 22 })).toBe(0);
  });

  it('falls back to frame 0 on unusable inputs', () => {
    expect(tailWindowStartFrame({ totalFrames: null, frames: 22 })).toBe(0);
    expect(tailWindowStartFrame({ totalFrames: 97, frames: NaN })).toBe(0);
  });
});

describe('planExtendSplice', () => {
  it('keeps every source frame the model saw and takes the rest from the render', () => {
    // 121-frame source (1 + 8*15) extended by 12 latents → 121 + 96 = 217.
    expect(planExtendSplice({ runtime: 'ltx2', sourceFrames: 121, outputFrames: 217, extendLatents: 12 }))
      .toEqual({ keepFrames: 121, newStartFrame: 121, newFrames: 96, droppedSourceFrames: 0 });
  });

  it('drops the ragged tail LTX never conditioned on', () => {
    // 125 source frames → the model saw 1 + 8*15 = 121 of them.
    expect(planExtendSplice({ runtime: 'ltx2', sourceFrames: 125, outputFrames: 121 + 24, extendLatents: 3 }))
      .toEqual({ keepFrames: 121, newStartFrame: 121, newFrames: 24, droppedSourceFrames: 4 });
  });

  it('declines (null = keep the model output) when the layout is not the one it assumes', () => {
    // Echo longer than the source: the render holds frames the source lacks.
    expect(planExtendSplice({ runtime: 'ltx2', sourceFrames: 20, outputFrames: 25 + 24, extendLatents: 3 })).toBeNull();
    // The model skipped more than a latent of the source tail: it truncated the
    // context, so which frames it kept is unknown.
    expect(planExtendSplice({ runtime: 'ltx2', sourceFrames: 200, outputFrames: 121 + 24, extendLatents: 3 })).toBeNull();
    // Unmeasurable clips and a nonsensical extension never read as a plan.
    expect(planExtendSplice({ runtime: 'ltx2', sourceFrames: null, outputFrames: 145, extendLatents: 3 })).toBeNull();
    expect(planExtendSplice({ runtime: 'ltx2', sourceFrames: 121, outputFrames: null, extendLatents: 3 })).toBeNull();
    expect(planExtendSplice({ runtime: 'ltx2', sourceFrames: 121, outputFrames: 145, extendLatents: 0 })).toBeNull();
  });
});


describe('runtime continuation timing boundary', () => {
  it.each(['ltx2', 'ltx25'])('keeps history pixels, extension latents and echoed output separate for %s', (runtime) => {
    const historyStart = tailWindowStartFrame({ totalFrames: 121, frames: 22 });
    const extendLatents = extendLatentFrames(97, runtime);
    expect(historyStart).toBe(99);
    expect(extendLatents).toBe(12);
    expect(extendedPixelFrames(extendLatents, runtime)).toBe(96);
    // The encoded history may echo 25 frames even though we supplied only 22.
    expect(contextPrefixFrames({ runtime, totalFrames: 121, extendLatents })).toBe(25);
  });

  it('refuses unverified or omitted runtimes instead of borrowing LTX timing', () => {
    for (const runtime of ['minimax_h3', 'minimax_h3_cuda', 'future-runtime', 'constructor', undefined]) {
      const contract = continuationContract(runtime);
      expect(contract.temporalContext).toBe(false);
      expect(contract.unavailableReason).toMatch(/no verified/);
      expect(() => extendLatentFrames(124, runtime)).toThrow('Temporal continuation unavailable');
      expect(() => extendedPixelFrames(7, runtime)).toThrow('Temporal continuation unavailable');
      expect(() => contextPrefixFrames({ runtime, totalFrames: 141, extendLatents: 7 }))
        .toThrow('Temporal continuation unavailable');
      expect(() => planExtendSplice({ runtime, sourceFrames: 17, outputFrames: 141, extendLatents: 7 }))
        .toThrow('Temporal continuation unavailable');
    }
    expect(continuationContract('minimax_h3').unavailableReason).toContain('H3 MLX');
    expect(continuationContract('minimax_h3_cuda').unavailableReason).toContain('H3 CUDA');
  });

  it('does not allow a consumer to mutate the verified timing/capability', () => {
    expect(() => { continuationContract('ltx2').latentFrameStride = 17; }).toThrow(TypeError);
    expect(() => { continuationContract('minimax_h3').temporalContext = true; }).toThrow(TypeError);
    expect(extendLatentFrames(97, 'ltx2')).toBe(12);
    expect(supportsContextWindow({ runtime: 'minimax_h3' })).toBe(false);
  });
});
