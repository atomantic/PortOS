import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './mapWithConcurrency.js';

describe('mapWithConcurrency', () => {
  it('preserves input order while limiting in-flight work', async () => {
    let active = 0;
    let maxActive = 0;

    const out = await mapWithConcurrency([30, 10, 20, 5], 2, async (delay, index) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, delay));
      active -= 1;
      return `${index}:${delay}`;
    });

    expect(out).toEqual(['0:30', '1:10', '2:20', '3:5']);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('normalizes invalid concurrency to one worker', async () => {
    let active = 0;
    let maxActive = 0;

    const out = await mapWithConcurrency([1, 2, 3], 0, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return item * 2;
    });

    expect(out).toEqual([2, 4, 6]);
    expect(maxActive).toBe(1);
  });

  it('returns an empty array without invoking the mapper', async () => {
    let calls = 0;

    const out = await mapWithConcurrency([], 4, async () => {
      calls += 1;
    });

    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it('rejects when a mapped item rejects', async () => {
    await expect(mapWithConcurrency(['ok', 'bad'], 2, async (item) => {
      if (item === 'bad') throw new Error('boom');
      return item;
    })).rejects.toThrow('boom');
  });
});
