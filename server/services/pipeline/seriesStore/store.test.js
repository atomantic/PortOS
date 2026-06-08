/**
 * Pipeline series store facade — file-backend dispatcher behavior (#1015).
 *
 * NODE_ENV=test selects the file backend (collectionStore over a real tmpdir),
 * so this exercises the facade WITHOUT a database: the collectionStore-compatible
 * read/write/delete surface series.js uses, recordDir resolving to the on-disk
 * path (so manuscript-review.json siblings stay file-backed), and the shared
 * pipeline mutation epoch that record writes/deletes bump (and reads do not) —
 * the signal dataSync folds into its fingerprint so the storage swap stays
 * invisible to federation.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'series-store-test-'));

vi.mock('../../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT } };
});

const { getSeriesStore, _resetSeriesStore } = await import('./store.js');
const { getPipelineMutationEpoch } = await import('../syncEpoch.js');

const passthroughSanitize = (r) => (r ? { ...r, _sanitized: true } : r);

describe('pipeline series store facade — file backend', () => {
  beforeEach(() => {
    rmSync(join(TEST_DATA_ROOT, 'pipeline-series'), { recursive: true, force: true });
    _resetSeriesStore();
  });
  afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

  it('selects the file backend under NODE_ENV=test', async () => {
    const s = getSeriesStore(passthroughSanitize);
    await s.listIds();
    expect(s.getBackendName()).toBe('file');
  });

  it('saveOneNow persists, loadOneRaw returns verbatim, loadOne sanitizes', async () => {
    const s = getSeriesStore(passthroughSanitize);
    await s.saveOneNow('ser-1', { id: 'ser-1', name: 'Salt Run' });
    expect(await s.loadOneRaw('ser-1')).toEqual({ id: 'ser-1', name: 'Salt Run' });
    expect(await s.loadOne('ser-1')).toEqual({ id: 'ser-1', name: 'Salt Run', _sanitized: true });
    expect(await s.listIds()).toEqual(['ser-1']);
  });

  it('loadAll returns every record sanitized', async () => {
    const s = getSeriesStore(passthroughSanitize);
    await s.saveOneNow('ser-1', { id: 'ser-1', name: 'A' });
    await s.saveOneNow('ser-2', { id: 'ser-2', name: 'B' });
    const all = await s.loadAll();
    expect(all.map((r) => r.id).sort()).toEqual(['ser-1', 'ser-2']);
    expect(all.every((r) => r._sanitized)).toBe(true);
  });

  it('deleteOneNow removes the record', async () => {
    const s = getSeriesStore(passthroughSanitize);
    await s.saveOneNow('ser-1', { id: 'ser-1', name: 'X' });
    await s.deleteOneNow('ser-1');
    expect(await s.loadOneRaw('ser-1')).toBeNull();
    expect(await s.listIds()).toEqual([]);
  });

  it('recordDir resolves to the on-disk path regardless of backend (review siblings)', async () => {
    const s = getSeriesStore(passthroughSanitize);
    expect(s.recordDir('ser-1')).toBe(join(TEST_DATA_ROOT, 'pipeline-series', 'ser-1'));
  });

  it('record writes AND deletes bump the pipeline mutation epoch; reads do not', async () => {
    const s = getSeriesStore(passthroughSanitize);
    const e0 = getPipelineMutationEpoch();
    await s.saveOneNow('ser-1', { id: 'ser-1', name: 'X' });
    const e1 = getPipelineMutationEpoch();
    expect(e1).toBeGreaterThan(e0);
    await s.loadOne('ser-1');
    await s.listIds();
    expect(getPipelineMutationEpoch()).toBe(e1); // reads don't bump
    await s.deleteOneNow('ser-1');
    expect(getPipelineMutationEpoch()).toBeGreaterThan(e1);
  });

  it('queueRecordWrite serializes same-id RMW and rejects bad ids', async () => {
    const s = getSeriesStore(passthroughSanitize);
    expect(() => s.queueRecordWrite('bad-id', async () => 'never')).toThrow(/invalid record id/);
    const order = [];
    await Promise.all([
      s.queueRecordWrite('ser-x', async () => { order.push('a-start'); await Promise.resolve(); order.push('a-end'); }),
      s.queueRecordWrite('ser-x', async () => { order.push('b'); }),
    ]);
    expect(order).toEqual(['a-start', 'a-end', 'b']);
  });

  it('saveOneNow / deleteOneNow reject ids outside the ser- allowlist (backend parity)', async () => {
    const s = getSeriesStore(passthroughSanitize);
    await expect(s.saveOneNow('iss-1', { id: 'iss-1', name: 'X' })).rejects.toThrow(/invalid record id/);
    await expect(s.deleteOneNow('nope')).rejects.toThrow(/invalid record id/);
  });

  it('verifySchemaVersion reports the file collection version', async () => {
    const s = getSeriesStore(passthroughSanitize);
    await s.saveOneNow('ser-1', { id: 'ser-1', name: 'X' });
    const status = await s.verifySchemaVersion();
    expect(status.ok).toBe(true);
    expect(status.type).toBe('pipelineSeries');
  });
});
