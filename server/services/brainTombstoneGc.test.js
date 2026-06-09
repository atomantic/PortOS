import { describe, it, expect, vi, beforeEach } from 'vitest';

const ENTITY_TYPES = ['people', 'projects', 'ideas', 'admin', 'memories', 'links', 'buckets', 'journals', 'inbox'];

const pruneTombstones = vi.fn();
vi.mock('./brainStorage.js', () => ({
  pruneTombstones: (...args) => pruneTombstones(...args),
  BRAIN_TOMBSTONE_GRACE_MS: 30 * 24 * 60 * 60 * 1000,
  BRAIN_ENTITY_TYPES: ['people', 'projects', 'ideas', 'admin', 'memories', 'links', 'buckets', 'journals', 'inbox'],
}));

import { sweepBrainTombstones } from './brainTombstoneGc.js';

describe('brainTombstoneGc', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prunes every entity type with a cutoff = now - grace and sums the counts', async () => {
    pruneTombstones.mockResolvedValue(2);
    const now = 1_000_000_000_000;
    const graceMs = 1000;

    const result = await sweepBrainTombstones({ now, graceMs });

    expect(result.pruned).toBe(2 * ENTITY_TYPES.length);
    expect(pruneTombstones).toHaveBeenCalledTimes(ENTITY_TYPES.length);
    for (const type of ENTITY_TYPES) {
      expect(pruneTombstones).toHaveBeenCalledWith(type, now - graceMs);
    }
  });

  it('returns pruned:0 when nothing is old enough', async () => {
    pruneTombstones.mockResolvedValue(0);
    const result = await sweepBrainTombstones({ now: 1_000_000_000_000, graceMs: 1000 });
    expect(result.pruned).toBe(0);
  });
});
