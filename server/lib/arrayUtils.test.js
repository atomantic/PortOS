import { describe, it, expect, vi } from 'vitest';
import { shuffle, dedupeByKey } from './arrayUtils.js';

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

describe('dedupeByKey', () => {
  it('keeps one item per key, in first-seen order', () => {
    const out = dedupeByKey(
      [{ k: 'a', v: 1 }, { k: 'b', v: 2 }, { k: 'a', v: 3 }],
      (x) => x.k,
    );
    expect(out.map((x) => x.k)).toEqual(['a', 'b']);
  });

  it('defaults to last-seen-wins — what a sequential upsert loop would leave', () => {
    const out = dedupeByKey([{ k: 'a', v: 1 }, { k: 'a', v: 2 }], (x) => x.k);
    expect(out).toEqual([{ k: 'a', v: 2 }]);
  });

  it('honors a `pick` comparator, so a non-latest conflict rule can win', () => {
    // memorySync's case: the newest `updatedAt` survives regardless of the
    // order a peer happened to send the duplicates in.
    const newest = (held, next) => (held.at > next.at ? held : next);
    const rows = [{ k: 'a', at: 30 }, { k: 'a', at: 10 }, { k: 'a', at: 20 }];
    expect(dedupeByKey(rows, (x) => x.k, newest)).toEqual([{ k: 'a', at: 30 }]);
    // Same set, reversed — the winner must not depend on arrival order.
    expect(dedupeByKey([...rows].reverse(), (x) => x.k, newest)).toEqual([{ k: 'a', at: 30 }]);
  });

  it('never mutates the input, and passes a unique list through unchanged', () => {
    const input = [{ k: 'a' }, { k: 'b' }];
    const out = dedupeByKey(input, (x) => x.k);
    expect(out).not.toBe(input);
    expect(out).toEqual(input);
    expect(input).toHaveLength(2);
  });

  it('handles an empty list', () => {
    expect(dedupeByKey([], (x) => x.k)).toEqual([]);
  });
});
