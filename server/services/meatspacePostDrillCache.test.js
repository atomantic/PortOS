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

  it('requestCacheFill fills multiple types sequentially, not concurrently — avoids spamming the provider with parallel batches', async () => {
    requestCacheFill(['compound-chain', 'bridge-word'], null, null);

    // Only the first type's initial (no-delay) call should have fired yet —
    // a second type's batch must not start until the first type's full
    // MAX_PER_TYPE batch (up to 10 sequential calls, 2s apart) completes.
    await vi.advanceTimersByTimeAsync(0);
    expect(generateLlmDrill).toHaveBeenCalledWith('compound-chain', expect.anything(), null, null);
    expect(generateLlmDrill).not.toHaveBeenCalledWith('bridge-word', expect.anything(), null, null);

    await vi.advanceTimersByTimeAsync(40000);
    expect(getCacheStats()['compound-chain'].cold).toBe(false);
    expect(getCacheStats()['bridge-word'].cold).toBe(false);
  });

  it('saveCache persists primedTypes alongside the drills so a restart mid-drain stays warm', async () => {
    const { atomicWrite } = await import('../lib/fileUtils.js');
    requestCacheFill(['compound-chain'], null, null);
    await vi.advanceTimersByTimeAsync(20000);

    const [, written] = atomicWrite.mock.calls.at(-1);
    expect(written.primedTypes).toContain('compound-chain');
    expect(Array.isArray(written.drills['compound-chain'])).toBe(true);
  });
});

// Disk-shape scenarios need an isolated module instance per test (cache/
// primedTypes are module-level state that would otherwise leak between
// cases), so these reset modules and re-import instead of sharing the
// describe block above.
describe('meatspacePostDrillCache — on-disk cache shape', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('infers primed from a legacy flat-shape file ({ [type]: [...] }, no primedTypes key)', async () => {
    const { readFile } = await import('fs/promises');
    readFile.mockResolvedValueOnce(JSON.stringify({
      'compound-chain': [{ type: 'compound-chain', challenges: [] }],
      'bridge-word': [],
    }));
    const { initDrillCache, getCacheStats } = await import('./meatspacePostDrillCache.js');
    await initDrillCache();

    expect(getCacheStats()['compound-chain'].cold).toBe(false);
    expect(getCacheStats()['bridge-word'].cold).toBe(true);
  });

  it('stays warm across a restart that lands mid-drain (persisted primedTypes, 0 on-disk drills)', async () => {
    const { readFile } = await import('fs/promises');
    readFile.mockResolvedValueOnce(JSON.stringify({
      drills: { 'compound-chain': [] },
      primedTypes: ['compound-chain'],
    }));
    const { initDrillCache, getCacheStats } = await import('./meatspacePostDrillCache.js');
    await initDrillCache();

    // Before persisting primedTypes, a restart landing here (0 cached on
    // disk) would re-classify this type as cold, permanently stalling future
    // replenishment — the same bug the in-process primedTypes fix targeted,
    // just triggered by a restart instead of a drain.
    const stats = getCacheStats()['compound-chain'];
    expect(stats.count).toBe(0);
    expect(stats.cold).toBe(false);
  });
});
