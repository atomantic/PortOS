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
});
