/**
 * Pipeline issues store facade — file-backend dispatcher behavior (#1015).
 *
 * NODE_ENV=test selects the file backend (collectionStore over a real tmpdir),
 * so this exercises the facade WITHOUT a database: the collectionStore-compatible
 * surface issues.js uses (loadAll / loadOne / saveOneNow / deleteOne /
 * queueTypeIndexWrite), and the shared pipeline mutation epoch that record
 * writes/deletes bump (and reads do not).
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'issues-store-test-'));

vi.mock('../../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT } };
});

const { getIssuesStore, _resetIssuesStore } = await import('./store.js');
const { getPipelineMutationEpoch } = await import('../syncEpoch.js');

const passthroughSanitize = (r) => (r ? { ...r, _sanitized: true } : r);

describe('pipeline issues store facade — file backend', () => {
  beforeEach(() => {
    rmSync(join(TEST_DATA_ROOT, 'pipeline-issues'), { recursive: true, force: true });
    _resetIssuesStore();
  });
  afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

  it('selects the file backend under NODE_ENV=test', async () => {
    const s = getIssuesStore(passthroughSanitize);
    await s.listIds();
    expect(s.getBackendName()).toBe('file');
  });

  it('saveOneNow persists, loadOne sanitizes, loadAll lists', async () => {
    const s = getIssuesStore(passthroughSanitize);
    await s.saveOneNow('iss-1', { id: 'iss-1', seriesId: 'ser-1', title: 'One' });
    expect(await s.loadOne('iss-1')).toEqual({ id: 'iss-1', seriesId: 'ser-1', title: 'One', _sanitized: true });
    await s.saveOneNow('iss-2', { id: 'iss-2', seriesId: 'ser-1', title: 'Two' });
    expect((await s.loadAll()).map((r) => r.id).sort()).toEqual(['iss-1', 'iss-2']);
  });

  it('loadAllForSeries returns only the requested series, sanitized', async () => {
    const s = getIssuesStore(passthroughSanitize);
    await s.saveOneNow('iss-1', { id: 'iss-1', seriesId: 'ser-1', title: 'One' });
    await s.saveOneNow('iss-2', { id: 'iss-2', seriesId: 'ser-2', title: 'Two' });
    await s.saveOneNow('iss-3', { id: 'iss-3', seriesId: 'ser-1', title: 'Three' });
    const ser1 = await s.loadAllForSeries('ser-1');
    expect(ser1.map((r) => r.id).sort()).toEqual(['iss-1', 'iss-3']);
    expect(ser1.every((r) => r._sanitized === true)).toBe(true);
    expect((await s.loadAllForSeries('ser-2')).map((r) => r.id)).toEqual(['iss-2']);
    expect(await s.loadAllForSeries('ser-missing')).toEqual([]);
  });

  it('listIds({ includeDeleted: false }) drops tombstones; default keeps them (#2540)', async () => {
    const s = getIssuesStore(passthroughSanitize);
    await s.saveOneNow('iss-live', { id: 'iss-live', seriesId: 'ser-1', title: 'Live' });
    await s.saveOneNow('iss-dead', { id: 'iss-dead', seriesId: 'ser-1', title: 'Dead', deleted: true });
    expect((await s.listIds()).sort()).toEqual(['iss-dead', 'iss-live']);
    expect((await s.listIds({ includeDeleted: true })).sort()).toEqual(['iss-dead', 'iss-live']);
    expect(await s.listIds({ includeDeleted: false })).toEqual(['iss-live']);
  });

  it('deleteOne removes the record', async () => {
    const s = getIssuesStore(passthroughSanitize);
    await s.saveOneNow('iss-1', { id: 'iss-1', seriesId: 'ser-1', title: 'X' });
    await s.deleteOne('iss-1');
    expect(await s.loadOne('iss-1')).toBeNull();
    expect(await s.listIds()).toEqual([]);
  });

  it('record writes AND deletes bump the pipeline mutation epoch; reads do not', async () => {
    const s = getIssuesStore(passthroughSanitize);
    const e0 = getPipelineMutationEpoch();
    await s.saveOneNow('iss-1', { id: 'iss-1', seriesId: 'ser-1', title: 'X' });
    const e1 = getPipelineMutationEpoch();
    expect(e1).toBeGreaterThan(e0);
    await s.loadOne('iss-1');
    await s.loadAll();
    expect(getPipelineMutationEpoch()).toBe(e1);
    await s.deleteOne('iss-1');
    expect(getPipelineMutationEpoch()).toBeGreaterThan(e1);
  });

  it('queueTypeIndexWrite single-tail serializes against itself', async () => {
    const s = getIssuesStore(passthroughSanitize);
    const order = [];
    await Promise.all([
      s.queueTypeIndexWrite(async () => { order.push('a-start'); await Promise.resolve(); order.push('a-end'); }),
      s.queueTypeIndexWrite(async () => { order.push('b'); }),
    ]);
    expect(order).toEqual(['a-start', 'a-end', 'b']);
  });

  it('saveOneNow rejects ids outside the iss- allowlist', async () => {
    const s = getIssuesStore(passthroughSanitize);
    await expect(s.saveOneNow('ser-1', { id: 'ser-1', seriesId: 'ser-1', title: 'X' })).rejects.toThrow(/invalid record id/);
  });

  it('verifySchemaVersion reports the file collection version', async () => {
    const s = getIssuesStore(passthroughSanitize);
    await s.saveOneNow('iss-1', { id: 'iss-1', seriesId: 'ser-1', title: 'X' });
    const status = await s.verifySchemaVersion();
    expect(status.ok).toBe(true);
    expect(status.type).toBe('pipelineIssues');
  });
});
