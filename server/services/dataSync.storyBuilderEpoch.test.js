/**
 * dataSync Story Builder mutation-epoch fingerprint (#1016).
 *
 * When Story Builder sessions move to PostgreSQL, a session edit no longer
 * touches data/story-builder/, so the directory file-fingerprint that gates
 * dataSync's storyBuilder snapshot cache goes stale — peers would silently stop
 * receiving session edits. The fix folds the store's monotonic mutation epoch
 * into the storyBuilder checksum fingerprint.
 *
 * This test isolates that mechanism: listSyncableSessionsForWire is mocked so the
 * snapshot CONTENT can change with NO file change, and getStoryBuilderMutationEpoch
 * is mocked so we control the epoch. It proves (a) a content change WITHOUT an
 * epoch bump is masked by the cache, and (b) bumping the epoch invalidates the
 * cache and surfaces the new content.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-datasync-stb-epoch-' });

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

let sessionsContent = [];
let epoch = 0;

vi.mock('./storyBuilder.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listSyncableSessionsForWire: vi.fn(async () => sessionsContent),
    mergeStorySessionsFromSync: vi.fn(async () => ({ applied: false, count: 0 })),
  };
});
vi.mock('./storyBuilderStore/store.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getStoryBuilderMutationEpoch: vi.fn(() => epoch) };
});

const dataSync = await import('./dataSync.js');

afterAll(cleanup);

beforeEach(() => {
  sessionsContent = [{ id: 'stb-1', title: 'A', sync: true, updatedAt: '2026-05-17T10:00:00Z' }];
  epoch = 0;
});

describe('dataSync — Story Builder mutation-epoch fingerprint', () => {
  it('a content change WITHOUT an epoch bump or file change is masked by the cache', async () => {
    const before = await dataSync.getChecksum('storyBuilder');
    sessionsContent = [{ id: 'stb-1', title: 'CHANGED', sync: true, updatedAt: '2026-05-17T11:00:00Z' }];
    const after = await dataSync.getChecksum('storyBuilder');
    expect(after.checksum).toBe(before.checksum); // masked — fingerprint identical
  });

  it('bumping the epoch invalidates the cache and surfaces the new content', async () => {
    const before = await dataSync.getChecksum('storyBuilder');
    sessionsContent = [{ id: 'stb-1', title: 'CHANGED', sync: true, updatedAt: '2026-05-17T11:00:00Z' }];
    epoch += 1; // the store bumps this on every record write/delete
    const after = await dataSync.getChecksum('storyBuilder');
    expect(after.checksum).not.toBe(before.checksum);
    expect(after.checksum).toBe((await dataSync.getSnapshot('storyBuilder')).checksum);
  });
});
