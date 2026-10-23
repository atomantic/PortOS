/**
 * FableLoom store facade — file-backend id projections (#6851).
 *
 * NODE_ENV=test selects the file backend (collectionStore over a real
 * tmpdir). Focused on the id-only projections added for the tombstone-sweep
 * hydration fix — `listIds`/`listLiveIds` (tombstoneGc's orphan-sweep
 * listers, re-exported through fableLoom/index.js) and
 * `listTombstoneIdsBefore` (the candidate scan `pruneTombstonedLooms` uses in
 * records.js). The pre-existing readRaw/listRaw/writeRaw/deleteRaw surface is
 * already exercised end-to-end through the service layer in records.test.js.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'fableloom-store-test-'));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT } };
});

const {
  listIds, listLiveIds, listTombstoneIdsBefore, writeRaw, _resetFableLoomBackend,
  readRaw, withLoomMediaReferences,
} = await import('./store.js');

describe('fableLoom store facade — file backend id projections', () => {
  beforeEach(() => {
    rmSync(join(TEST_DATA_ROOT, 'fableloom'), { recursive: true, force: true });
    _resetFableLoomBackend();
  });
  afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

  it('listIds returns live and tombstoned ids alike', async () => {
    await writeRaw('loom-live', { id: 'loom-live', name: 'Live' });
    await writeRaw('loom-dead', { id: 'loom-dead', name: 'Dead', deleted: true, deletedAt: '2026-01-01T00:00:00.000Z' });
    expect((await listIds()).sort()).toEqual(['loom-dead', 'loom-live']);
  });

  it('holds file-backend writes until media retirement settles, including failure', async () => {
    const saved = { id: 'loom-live', videoHistoryId: 'saved-video' };
    await writeRaw(saved.id, saved);
    const ready = Promise.withResolvers();
    const settle = Promise.withResolvers();
    const retirement = withLoomMediaReferences(async owners => {
      expect(owners).toEqual([saved]);
      ready.resolve();
      await settle.promise;
      throw new Error('Retirement failed');
    });
    retirement.catch(ready.reject);
    const failure = expect(retirement).rejects.toThrow('Retirement failed');
    await ready.promise;
    const changed = { ...saved, videoHistoryId: 'new-video' };
    const writer = writeRaw(saved.id, changed);
    try {
      expect(await readRaw(saved.id)).toEqual(saved);
    } finally {
      settle.resolve();
      await Promise.all([failure, writer]);
    }
    expect(await readRaw(saved.id)).toEqual(changed);
  });

  it('listLiveIds returns only non-deleted ids', async () => {
    await writeRaw('loom-live', { id: 'loom-live', name: 'Live' });
    await writeRaw('loom-dead', { id: 'loom-dead', name: 'Dead', deleted: true, deletedAt: '2026-01-01T00:00:00.000Z' });
    expect(await listLiveIds()).toEqual(['loom-live']);
  });

  it('listTombstoneIdsBefore returns only tombstones older than the cutoff, keeping unparseable deletedAt', async () => {
    await writeRaw('loom-live', { id: 'loom-live', name: 'Live' });
    await writeRaw('loom-old', { id: 'loom-old', name: 'Old', deleted: true, deletedAt: '2026-01-01T00:00:00.000Z' });
    await writeRaw('loom-new', { id: 'loom-new', name: 'New', deleted: true, deletedAt: '2026-06-01T00:00:00.000Z' });
    // Non-parseable deletedAt is conservatively KEPT — never a candidate,
    // regardless of cutoff (mirrors the JS filter this projection replaces).
    await writeRaw('loom-bad', { id: 'loom-bad', name: 'Bad', deleted: true, deletedAt: 'not-a-date' });
    const cutoff = Date.parse('2026-03-01T00:00:00.000Z');
    expect(await listTombstoneIdsBefore(cutoff)).toEqual(['loom-old']);
  });
});
