import { describe, it, expect } from 'vitest';
import { trackBeatGrid } from './audioBeatDsp.js';

describe('trackBeatGrid silent-span continuity', () => {
  it('retains earlier beats while coasting through a long silent outro', () => {
    // Exercise the DP directly: a long sparse envelope exposes score decay
    // without allocating a correspondingly huge PCM buffer or running FFTs.
    const onset = new Float32Array(120_000);
    const fps = 43;
    const periodFrames = 14.5;
    const clicks = Array.from({ length: 5 }, (_, i) => Math.round(10 + i * periodFrames));
    for (const frame of clicks) onset[frame] = 1;
    const result = trackBeatGrid(onset, fps, { bpm: 60 * fps / periodFrames, confidence: 0.5, window: null });
    for (const frame of clicks) {
      expect(Math.min(...result.beats.map((beat) => Math.abs(beat - frame / fps)))).toBeLessThanOrEqual(1 / fps);
    }
    expect(result.beats.at(-1)).toBeGreaterThan((onset.length - 2 * periodFrames) / fps);
  });
});
