/**
 * dataSync universe mutation-epoch fingerprint (#1014).
 *
 * When universes move to PostgreSQL, a universe edit no longer touches
 * data/universes/, so the directory file-fingerprint that gates dataSync's
 * snapshot cache goes stale — peers would silently stop receiving universe
 * edits. The fix folds the universe store's monotonic mutation epoch into the
 * universe + mediaCollections checksum fingerprints.
 *
 * This test isolates that mechanism: `listUniverses` is mocked so the snapshot
 * CONTENT can change with NO file/directory change, and `getUniverseMutationEpoch`
 * is mocked so we control the epoch. It proves (a) a content change WITHOUT an
 * epoch bump is masked by the cache (the bug the fix exists to prevent, shown
 * here as the cache correctly holding when the epoch is the only honest signal),
 * and (b) bumping the epoch invalidates the cache and surfaces the new content.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-datasync-epoch-' });

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

// Controllable universe content + epoch. The data dir is a fresh empty tmpdir
// (no universes/ subdir), so its fingerprint is constant across the test — the
// ONLY varying input to the universe fingerprint is the mocked epoch.
let universeContent = [];
let epoch = 0;

// Partial mock — keep every real export (storyBuilder + others import shared
// constants from this module at load time) and override only listUniverses.
vi.mock('./universeBuilder.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listUniverses: vi.fn(async () => universeContent),
    mergeUniversesFromSync: vi.fn(async () => ({ applied: false, count: 0 })),
  };
});
vi.mock('./universeBuilder/store.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getUniverseMutationEpoch: vi.fn(() => epoch) };
});

// mediaCollections snapshot filters collections by their linked universe's
// ephemeral state, so a universe edit must re-checksum it. Mock listCollections
// so we can change what the snapshot would contain without touching any file.
let collectionContent = [];
vi.mock('./mediaCollections.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listCollections: vi.fn(async () => collectionContent),
    mergeMediaCollectionsFromSync: vi.fn(async () => ({ applied: false, count: 0 })),
  };
});

const dataSync = await import('./dataSync.js');

afterAll(cleanup);

beforeEach(() => {
  universeContent = [{ id: 'u1', name: 'A', createdAt: '2026-05-17T09:00:00Z', updatedAt: '2026-05-17T10:00:00Z' }];
  collectionContent = [];
  epoch = 0;
});

describe('dataSync — universe mutation-epoch fingerprint', () => {
  it('a content change WITHOUT an epoch bump or file change is masked by the cache', async () => {
    const before = await dataSync.getChecksum('universe');
    // Simulate a PG-backed edit that does NOT bump the epoch and does NOT touch
    // the directory. The cache fingerprint is unchanged → stale checksum served.
    // (This is exactly why the epoch MUST be bumped on every store write.)
    universeContent = [{ id: 'u1', name: 'CHANGED', updatedAt: '2026-05-17T11:00:00Z' }];
    const after = await dataSync.getChecksum('universe');
    expect(after.checksum).toBe(before.checksum); // masked — fingerprint identical
  });

  it('bumping the epoch invalidates the cache and surfaces the new content', async () => {
    const before = await dataSync.getChecksum('universe');
    universeContent = [{ id: 'u1', name: 'CHANGED', updatedAt: '2026-05-17T11:00:00Z' }];
    epoch += 1; // the store bumps this on every record write/delete
    const after = await dataSync.getChecksum('universe');
    expect(after.checksum).not.toBe(before.checksum);
    expect(after.checksum).toBe((await dataSync.getSnapshot('universe')).checksum);
  });

  it('the mediaCollections fingerprint folds in the universe epoch (re-filters on universe change)', async () => {
    // A collection linked to u1. getMediaCollectionsSnapshot drops collections
    // whose linked universe is ephemeral — so when u1 flips ephemeral (a PG edit
    // that bumps the epoch but touches no file), the mediaCollections snapshot
    // must change. Without the epoch in its fingerprint, the cache would mask it.
    collectionContent = [{ id: 'c1', name: 'Universe: A', universeId: 'u1', items: [], updatedAt: '2026-05-17T10:00:00Z' }];
    const before = await dataSync.getChecksum('mediaCollections');
    universeContent = [{ id: 'u1', name: 'A', ephemeral: true, updatedAt: '2026-05-17T11:00:00Z' }];
    epoch += 1;
    const after = await dataSync.getChecksum('mediaCollections');
    expect(after.checksum).not.toBe(before.checksum);
  });
});
