import { describe, it, expect } from 'vitest';
import { musicVideoAspect, musicVideoFrameGenSize } from './musicVideoAspect.js';

describe('musicVideoAspect', () => {
  it('reads the brief aspect and defaults to 16:9', () => {
    expect(musicVideoAspect({ treatment: { brief: { aspectRatio: '9:16' } } })).toBe('9:16');
    expect(musicVideoAspect({ treatment: { brief: { aspectRatio: '4:3' } } })).toBe('16:9');
    expect(musicVideoAspect({})).toBe('16:9');
  });

  it('requests landscape frames for a 16:9 project and portrait for 9:16', () => {
    expect(musicVideoFrameGenSize({})).toEqual({ width: 1536, height: 864 });
    expect(musicVideoFrameGenSize({ treatment: { brief: { aspectRatio: '9:16' } } })).toEqual({ width: 864, height: 1536 });
  });
});
