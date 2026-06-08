/**
 * dataSync pipeline mutation-epoch fingerprint (#1015).
 *
 * When pipeline series + issues move to PostgreSQL, a pipeline edit no longer
 * touches data/pipeline-series/ or data/pipeline-issues/, so the directory
 * file-fingerprint that gates dataSync's pipeline snapshot cache goes stale —
 * peers would silently stop receiving pipeline edits. The fix folds the pipeline
 * store's monotonic mutation epoch into the pipeline checksum fingerprint.
 *
 * This test isolates that mechanism: listSeries/listIssues are mocked so the
 * snapshot CONTENT can change with NO file change, and getPipelineMutationEpoch
 * is mocked so we control the epoch. It proves (a) a content change WITHOUT an
 * epoch bump is masked by the cache, and (b) bumping the epoch invalidates the
 * cache and surfaces the new content.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-datasync-pipeline-epoch-' });

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

let seriesContent = [];
let issuesContent = [];
let epoch = 0;

vi.mock('./pipeline/series.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listSeries: vi.fn(async () => seriesContent),
    mergeSeriesFromSync: vi.fn(async () => ({ applied: false, count: 0 })),
  };
});
vi.mock('./pipeline/issues.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listIssues: vi.fn(async () => issuesContent),
    mergeIssuesFromSync: vi.fn(async () => ({ applied: false, count: 0 })),
  };
});
vi.mock('./pipeline/syncEpoch.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getPipelineMutationEpoch: vi.fn(() => epoch) };
});

const dataSync = await import('./dataSync.js');

afterAll(cleanup);

beforeEach(() => {
  seriesContent = [{ id: 'ser-1', name: 'A', createdAt: '2026-05-17T09:00:00Z', updatedAt: '2026-05-17T10:00:00Z' }];
  issuesContent = [];
  epoch = 0;
});

describe('dataSync — pipeline mutation-epoch fingerprint', () => {
  it('a content change WITHOUT an epoch bump or file change is masked by the cache', async () => {
    const before = await dataSync.getChecksum('pipeline');
    seriesContent = [{ id: 'ser-1', name: 'CHANGED', updatedAt: '2026-05-17T11:00:00Z' }];
    const after = await dataSync.getChecksum('pipeline');
    expect(after.checksum).toBe(before.checksum); // masked — fingerprint identical
  });

  it('bumping the epoch invalidates the cache and surfaces the new content', async () => {
    const before = await dataSync.getChecksum('pipeline');
    seriesContent = [{ id: 'ser-1', name: 'CHANGED', updatedAt: '2026-05-17T11:00:00Z' }];
    epoch += 1; // the store bumps this on every record write/delete
    const after = await dataSync.getChecksum('pipeline');
    expect(after.checksum).not.toBe(before.checksum);
    expect(after.checksum).toBe((await dataSync.getSnapshot('pipeline')).checksum);
  });

  it('an issue content change also surfaces once the epoch bumps', async () => {
    const before = await dataSync.getChecksum('pipeline');
    issuesContent = [{ id: 'iss-1', seriesId: 'ser-1', number: 1, title: 'New', updatedAt: '2026-05-17T11:00:00Z' }];
    epoch += 1;
    const after = await dataSync.getChecksum('pipeline');
    expect(after.checksum).not.toBe(before.checksum);
  });
});
