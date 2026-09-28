import { describe, expect, it } from 'vitest';
import './kit/portos-motion.js';

const { spring, track, rng, indicator } = globalThis.PortosMotion;

describe('PortOS motion kit', () => {
  it('retargets a tracked value without a positional pop and settles on the last key', () => {
    const keys = [[0, 0], [0.2, 100], [0.35, 40], [0.5, 300]];
    // Retargeting mid-flight (before the previous spring settles) stays continuous.
    for (const [time] of keys.slice(1)) {
      expect(Math.abs(track(time + 1e-4, keys) - track(time - 1e-4, keys))).toBeLessThan(0.5);
    }
    expect(track(5, keys)).toBeCloseTo(300, 3);
    expect(spring(0)).toBe(0);
    expect(spring(3, 120, 30)).toBeCloseTo(1, 5); // critically damped path
  });

  it('stretches an indicator while travelling and closes it back to its width', () => {
    const stops = [[0, 0], [0.1, 400]];
    const moving = indicator(0.2, stops, 120);
    expect(moving.right - moving.left).toBeGreaterThan(160);
    const settled = indicator(4, stops, 120);
    expect(settled.right - settled.left).toBeCloseTo(120, 1);
  });

  it('repeats a seeded sequence exactly, so seek(t) redraws the same frame', () => {
    const a = rng(7);
    const b = rng(7);
    const first = Array.from({ length: 50 }, () => a());
    expect(Array.from({ length: 50 }, () => b())).toEqual(first);
    expect(first.every(value => value >= 0 && value < 1)).toBe(true);
    expect(rng(8)()).not.toBe(first[0]);
  });

  describe('song()', () => {
    const analysis = {
      bpm: 120,
      beats: [0.5, 1, 1.5, 2],
      downbeats: [0.5, 2.5],
      sections: [{ label: 'a', startSec: 0, endSec: 1, energy: 0.2 }, { label: 'b', startSec: 1, endSec: 3, energy: 0.9 }],
      features: {
        envelopes: { fps: 10, rms: [0, 0.5, 1], low: [0, 1, 0], mid: [0.2, 0.2, 0.2], high: [0, 0, 0] },
        onsets: { low: [0.5, 1], mid: [0.75], high: [] },
        truncatedAtSec: null,
      },
    };
    const song = globalThis.PortosMotion.song(analysis);

    it('returns identical values for the same t regardless of query order', () => {
      const times = Array.from({ length: 40 }, (_, i) => i * 0.0625 - 0.2);
      const read = (t) => [song.env('low', t), song.hit('kick', t), song.hit('snare', t, 0.3), song.beatAt(t), song.beatPhase(t), song.barAt(t)];
      const forward = times.map(read);
      const order = times.map((_, i) => i).sort((a, b) => ((a * 7) % 13) - ((b * 7) % 13));
      const shuffled = [];
      for (const i of order) shuffled[i] = read(times[i]);
      expect(shuffled).toEqual(forward);
    });

    it('interpolates envelopes, decays hit pulses from past onsets only, and reads 0 outside the song', () => {
      expect(song.env('low', 0.05)).toBeCloseTo(0.5, 6);
      expect(song.env('low', 0.1)).toBeCloseTo(1, 6);
      expect(song.env('low', -1)).toBe(0);
      expect(song.env('low', 5)).toBe(0);
      expect(song.hit('kick', 0.49)).toBe(0); // before any onset
      expect(song.hit('kick', 0.5)).toBeCloseTo(1, 6);
      expect(song.hit('kick', 0.62, 0.12)).toBeCloseTo(0.5, 6);
      expect(song.hit('low', 1.0, 0.12)).toBeCloseTo(1 + 0.5 ** (0.5 / 0.12), 6);
      expect(song.hit('hat', 1)).toBe(0);
    });

    it('locates beat, bar, phase and section', () => {
      expect(song.beatAt(0.4)).toBe(-1);
      expect(song.beatAt(1.25)).toBe(1);
      expect(song.barAt(2.6)).toBe(1);
      expect(song.beatPhase(1.25)).toBeCloseTo(0.5, 6);
      expect(song.beatPhase(0.25)).toBeCloseTo(0.5, 6); // extends the first interval backwards
      expect(song.sectionAt(1.5)).toMatchObject({ index: 1, label: 'b', progress: 0.25 });
      expect(song.sectionAt(9)).toBeNull();
    });

    it('is not ready, and reads as silence, when the analysis has no feature track', () => {
      const legacy = globalThis.PortosMotion.song({ bpm: 120, beats: [0], features: null });
      expect(legacy.ready).toBe(false);
      expect(legacy.env('low', 1)).toBe(0);
      expect(legacy.hit('kick', 1)).toBe(0);
      expect(song.ready).toBe(true);
    });
  });
});
