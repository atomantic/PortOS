import { describe, expect, it, vi } from 'vitest';
import { randomInt } from 'node:crypto';
import { planVideoBatch, validateVideoBatch } from './batch.js';

vi.mock('node:crypto', async (original) => ({ ...await original(), randomInt: vi.fn() }));
const model = { runtime: 'minimax_h3' };

describe('warm video batch request contract', () => {
  it('draws separately for every random render and preserves zero as an incrementing seed', () => {
    vi.mocked(randomInt).mockReturnValueOnce(85).mockReturnValueOnce(2).mockReturnValueOnce(99);
    expect(planVideoBatch({ jobId: 'job', batchSize: 3 }).map((item) => item.seed)).toEqual([85, 2, 99]);
    expect(randomInt).toHaveBeenCalledTimes(3);
    expect(planVideoBatch({ jobId: 'job', batchSize: 3, seed: 0 }).map((item) => item.seed)).toEqual([0, 1, 2]);
    expect(randomInt).toHaveBeenCalledTimes(3);
  });

  it('rejects invalid counts, overflowing seeds and unsupported dispatch before rendering', () => {
    for (const batchSize of [0, -1, 1.5, 21, NaN]) {
      expect(() => validateVideoBatch({ batchSize }, model)).toThrow(/Batch size/);
    }
    expect(() => validateVideoBatch({ batchSize: 2, seed: 2 ** 32 - 1 }, model)).toThrow(/batch seeds/);
    expect(() => validateVideoBatch({ batchSize: 2, seed: 2 ** 32 - 2 }, model)).not.toThrow();
    for (const fields of [{ backend: 'fal' }, { mediaProviderPeerId: 'peer' }, { chunks: 2 }, { fableLoom: {} }, { musicVideo: {} }]) {
      expect(() => validateVideoBatch({ batchSize: 2, ...fields }, model)).toThrow();
    }
    expect(() => validateVideoBatch({ batchSize: 2 }, { runtime: 'ltx25' })).toThrow(/require a local/);
    expect(() => validateVideoBatch({}, { runtime: 'ltx25' })).not.toThrow();
  });
});
