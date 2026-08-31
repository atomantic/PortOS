import { describe, expect, it } from 'vitest';
import { audioDurationToFrames } from './audioDuration.js';

describe('audioDurationToFrames', () => {
  it('covers the whole source while snapping up to LTX 8n+1', () => {
    expect(audioDurationToFrames(41.041281, 24, 8)).toBe(985);
    expect(audioDurationToFrames(20, 24, 8)).toBe(481);
    expect(audioDurationToFrames(20.01, 24, 8)).toBe(481);
    expect(audioDurationToFrames(20.05, 24, 8)).toBe(489);
  });

  it('rejects invalid inputs instead of collapsing them to a default clip', () => {
    expect(() => audioDurationToFrames(0, 24, 8)).toThrow(/durationSeconds/);
    expect(() => audioDurationToFrames(5, 0, 8)).toThrow(/fps/);
    expect(() => audioDurationToFrames(5, 24, 0)).toThrow(/frameStride/);
  });
});
