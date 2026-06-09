import { describe, it, expect } from 'vitest';
import migration from './078-song-recording-pitch-analysis.js';

describe('migration 078 — song recording pitch-analysis registration stub', () => {
  it('is a no-op that records the additive schema bump', async () => {
    const result = await migration.up({ rootDir: '/tmp/nonexistent' });
    expect(result).toEqual({ updated: 0, reason: 'additive-no-op' });
  });

  it('is idempotent (re-running changes nothing)', async () => {
    const first = await migration.up({ rootDir: '/tmp/nonexistent' });
    const second = await migration.up({ rootDir: '/tmp/nonexistent' });
    expect(second).toEqual(first);
  });
});
