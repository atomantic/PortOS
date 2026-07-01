import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock file I/O so tests never touch disk. readFile rejects (no cache file
// on disk yet) so loadCache() starts every CACHEABLE_TYPES entry at [].
vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
}));

vi.mock('../lib/fileUtils.js', () => ({
  atomicWrite: vi.fn().mockResolvedValue(undefined),
  ensureDir: vi.fn().mockResolvedValue(undefined),
  PATHS: { data: '/tmp/test-data', meatspace: '/tmp/test-data/meatspace' },
  safeJSONParse: (str, defaultValue) => {
    try { return JSON.parse(str); } catch { return defaultValue; }
  },
}));

vi.mock('./meatspacePostLlm.js', () => ({
  generateLlmDrill: vi.fn(),
}));

import { generateLlmDrill } from './meatspacePostLlm.js';
import {
  initDrillCache, getCachedDrill, triggerReplenish, requestCacheFill, getCacheStats,
} from './meatspacePostDrillCache.js';

describe('meatspacePostDrillCache', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    generateLlmDrill.mockImplementation(async (type) => ({ type, challenges: [{ rootWord: 'fire' }] }));
    vi.useFakeTimers();
    await initDrillCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports a never-filled type as cold with zero count', () => {
    expect(getCacheStats()['compound-chain']).toEqual({ count: 0, cold: true });
  });

  it('triggerReplenish is a no-op on a cold (never-filled) type — no LLM calls without consent', async () => {
    triggerReplenish('compound-chain', null, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(generateLlmDrill).not.toHaveBeenCalled();
    expect(getCacheStats()['compound-chain'].cold).toBe(true);
  });

  it('requestCacheFill primes a type so it is no longer cold', async () => {
    requestCacheFill(['compound-chain'], null, null);
    await vi.advanceTimersByTimeAsync(20000);
    const stats = getCacheStats()['compound-chain'];
    expect(stats.cold).toBe(false);
    expect(stats.count).toBeGreaterThan(0);
    expect(generateLlmDrill).toHaveBeenCalled();
  });

  it('keeps replenishing after draining a primed type back to zero (regression)', async () => {
    // Prime the type and let the fill batch fully complete.
    requestCacheFill(['compound-chain'], null, null);
    await vi.advanceTimersByTimeAsync(20000);
    expect(getCacheStats()['compound-chain'].count).toBeGreaterThan(0);

    // Drain every cached drill via normal consumption.
    let drained;
    do { drained = getCachedDrill('compound-chain'); } while (drained);
    expect(getCacheStats()['compound-chain'].count).toBe(0);

    // A type that has been primed at least once must stay "warm" even after
    // draining to zero — the whole point is that background top-ups keep
    // working silently going forward. Before the fix, isCacheCold() read the
    // live (post-drain) count instead of a persistent primed flag, so this
    // was misclassified as cold and permanently skipped replenishment.
    expect(getCacheStats()['compound-chain'].cold).toBe(false);

    generateLlmDrill.mockClear();
    triggerReplenish('compound-chain', null, null);
    await vi.advanceTimersByTimeAsync(20000);
    expect(generateLlmDrill).toHaveBeenCalled();
    expect(getCacheStats()['compound-chain'].count).toBeGreaterThan(0);
  });

  it('requestCacheFill ignores unknown drill types', () => {
    const triggered = requestCacheFill(['not-a-real-type'], null, null);
    expect(triggered).toEqual([]);
  });
});
