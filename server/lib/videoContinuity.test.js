import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CONTEXT_FRAMES, MIN_CONTEXT_FRAMES, MAX_CONTEXT_FRAMES, LATENT_FRAME_STRIDE,
  resolveContextFrames, resolveContinuityStrategy, supportsContextWindow,
  extendLatentFrames, extendedPixelFrames, contextPrefixFrames, tailWindowStartFrame,
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
  it('only ltx2 has an extend pipeline to feed a window to', () => {
    expect(supportsContextWindow({ runtime: 'ltx2' })).toBe(true);
    for (const runtime of ['mlx_video', 'minimax_h3', 'wan22', 'fastvideo']) {
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
    expect(extendLatentFrames(97)).toBe(12);
    expect(extendLatentFrames(25)).toBe(3);
  });

  it('floors at one latent so a tiny request still renders something', () => {
    expect(extendLatentFrames(4)).toBe(1);
    expect(extendLatentFrames(0)).toBe(1);
    expect(extendLatentFrames(null)).toBe(1);
    expect(extendLatentFrames('nope')).toBe(1);
  });

  it('round-trips back to pixel frames at the VAE stride', () => {
    expect(extendedPixelFrames(3)).toBe(3 * LATENT_FRAME_STRIDE);
    expect(extendedPixelFrames(0)).toBe(0);
    expect(extendedPixelFrames(-4)).toBe(0);
  });
});

describe('contextPrefixFrames', () => {
  it('measures the echo as everything before the newly-generated frames', () => {
    // A 25-frame render that appended 3 latents (24 frames) opens with 1 frame
    // of echoed context.
    expect(contextPrefixFrames({ totalFrames: 25, extendLatents: 3 })).toBe(1);
    expect(contextPrefixFrames({ totalFrames: 120, extendLatents: 12 })).toBe(24);
  });

  it('returns 0 — "leave it alone" — when the numbers do not support a trim', () => {
    // An unprobeable output must never be read as "trim everything", which
    // would delete the chunk's real content.
    expect(contextPrefixFrames({ totalFrames: null, extendLatents: 3 })).toBe(0);
    expect(contextPrefixFrames({ totalFrames: 0, extendLatents: 3 })).toBe(0);
    expect(contextPrefixFrames({ totalFrames: 24, extendLatents: 3 })).toBe(0);
    expect(contextPrefixFrames({ totalFrames: 10, extendLatents: 3 })).toBe(0);
    expect(contextPrefixFrames({ totalFrames: 100, extendLatents: 0 })).toBe(0);
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
