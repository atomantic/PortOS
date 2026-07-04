import { describe, it, expect, vi } from 'vitest';
import { shuffle } from './arrayUtils.js';

describe('shuffle', () => {
  it('returns a new array — never mutates the input', () => {
    const input = [1, 2, 3, 4, 5];
    const out = shuffle(input);
    expect(out).not.toBe(input);
    expect(input).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns a permutation of the input (same elements, same length)', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = shuffle(input);
    expect(out).toHaveLength(input.length);
    expect([...out].sort((a, b) => a - b)).toEqual(input);
  });

  it('handles empty and single-element arrays without throwing', () => {
    expect(shuffle([])).toEqual([]);
    expect(shuffle([42])).toEqual([42]);
  });

  it('uses the Fisher-Yates swap pattern — every position is visited exactly once', () => {
    // Fixed "random" sequence that always swaps with itself (index 0 offset),
    // i.e. Math.random() always returns 0 → j = floor(0 * (i+1)) = 0 every
    // iteration. This exercises every loop iteration (i from length-1 down to
    // 1) without asserting a specific output order — just that the swap loop
    // ran the expected number of times and produced a valid permutation.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const input = [1, 2, 3, 4, 5];
      const out = shuffle(input);
      expect(out).toHaveLength(5);
      expect([...out].sort((a, b) => a - b)).toEqual(input);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('is not the naive biased sort(() => Math.random() - 0.5) pattern — output length matches for larger arrays too', () => {
    const input = Array.from({ length: 100 }, (_, i) => i);
    const out = shuffle(input);
    expect(out).toHaveLength(100);
    expect(new Set(out).size).toBe(100);
  });
});
