import { describe, expect, it } from 'vitest';
import { validateVideoKeyframes } from './useVideoGenValidation.js';

const frame = (index, file = `frame-${index}.png`) => ({ file, index });
const validate = (overrides = {}) => validateVideoKeyframes({
  active: true,
  frames: 33,
  height: 512,
  keyframes: [frame(0), frame(32)],
  maxSafeFrames: 33,
  width: 768,
  ...overrides,
});

describe('validateVideoKeyframes', () => {
  it('requires between two and eight keyframes', () => {
    expect(validate({ keyframes: [frame(0)] })).toBe('Add at least 2 keyframes.');
    expect(validate({ keyframes: Array.from({ length: 9 }, (_, index) => frame(index)) }))
      .toBe('Use at most 8 keyframes.');
  });

  it.each([-1, 1.5])('rejects the invalid frame index %s', (index) => {
    expect(validate({ keyframes: [frame(index), frame(2)] }))
      .toBe('Keyframe 1 needs a frame index ≥ 0.');
  });

  it('rejects indices outside numFrames', () => {
    expect(validate({ frames: 17, keyframes: [frame(0), frame(17)], maxSafeFrames: 17 }))
      .toBe('Keyframe 2 frame 17 must be below numFrames (17).');
  });

  it('rejects indices outside the resolution-dependent pixel budget', () => {
    expect(validate({ keyframes: [frame(0), frame(24)], maxSafeFrames: 17 }))
      .toBe('Keyframe 2 frame 24 exceeds the 768×512 pixel budget (max frame 16). Lower the resolution or raise FFLF_LTX2_PIXEL_BUDGET.');
  });

  it('accepts the upper frame and cardinality boundaries', () => {
    const keyframes = Array.from({ length: 8 }, (_, index) => frame(index * 4));
    expect(validate({ keyframes })).toBeNull();
  });
});
