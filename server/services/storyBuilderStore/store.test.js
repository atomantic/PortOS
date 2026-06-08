/**
 * Story Builder store facade — file-backend dispatcher behavior (#1016).
 *
 * NODE_ENV=test selects the file backend (collectionStore over a real tmpdir),
 * so this exercises the facade WITHOUT a database: the collectionStore-compatible
 * read/write/delete surface storyBuilder.js uses, and the module-level mutation
 * epoch that record writes/deletes bump (and reads do not) — the signal dataSync
 * folds into its fingerprint so the storage swap stays invisible to federation.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'stb-store-test-'));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT } };
});

const { getStoryBuilderStore, _resetStoryBuilderStore, getStoryBuilderMutationEpoch } = await import('./store.js');

const passthroughSanitize = (r) => (r ? { ...r, _sanitized: true } : r);

describe('Story Builder store facade — file backend', () => {
  beforeEach(() => {
    rmSync(join(TEST_DATA_ROOT, 'story-builder'), { recursive: true, force: true });
    _resetStoryBuilderStore();
  });
  afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

  it('selects the file backend under NODE_ENV=test', async () => {
    const s = getStoryBuilderStore(passthroughSanitize);
    await s.listIds();
    expect(s.getBackendName()).toBe('file');
  });

  it('saveOneNow persists, loadOneRaw returns verbatim, loadOne sanitizes', async () => {
    const s = getStoryBuilderStore(passthroughSanitize);
    await s.saveOneNow('stb-1', { id: 'stb-1', title: 'Salt Run' });
    expect(await s.loadOneRaw('stb-1')).toEqual({ id: 'stb-1', title: 'Salt Run' });
    expect(await s.loadOne('stb-1')).toEqual({ id: 'stb-1', title: 'Salt Run', _sanitized: true });
    expect(await s.listIds()).toEqual(['stb-1']);
  });

  it('loadAll returns every record sanitized', async () => {
    const s = getStoryBuilderStore(passthroughSanitize);
    await s.saveOneNow('stb-1', { id: 'stb-1', title: 'A' });
    await s.saveOneNow('stb-2', { id: 'stb-2', title: 'B' });
    const all = await s.loadAll();
    expect(all.map((r) => r.id).sort()).toEqual(['stb-1', 'stb-2']);
    expect(all.every((r) => r._sanitized)).toBe(true);
  });

  it('deleteOneNow removes the record', async () => {
    const s = getStoryBuilderStore(passthroughSanitize);
    await s.saveOneNow('stb-1', { id: 'stb-1', title: 'X' });
    await s.deleteOneNow('stb-1');
    expect(await s.loadOneRaw('stb-1')).toBeNull();
    expect(await s.listIds()).toEqual([]);
  });

  it('record writes AND deletes bump the mutation epoch; reads do not', async () => {
    const s = getStoryBuilderStore(passthroughSanitize);
    const e0 = getStoryBuilderMutationEpoch();
    await s.saveOneNow('stb-1', { id: 'stb-1', title: 'X' });
    const e1 = getStoryBuilderMutationEpoch();
    expect(e1).toBeGreaterThan(e0);
    await s.loadOne('stb-1');
    await s.listIds();
    expect(getStoryBuilderMutationEpoch()).toBe(e1); // reads don't bump
    await s.deleteOneNow('stb-1');
    expect(getStoryBuilderMutationEpoch()).toBeGreaterThan(e1);
  });

  it('queueRecordWrite serializes same-id RMW and rejects bad ids', async () => {
    const s = getStoryBuilderStore(passthroughSanitize);
    expect(() => s.queueRecordWrite('bad-id', async () => 'never')).toThrow(/invalid record id/);
    const order = [];
    await Promise.all([
      s.queueRecordWrite('stb-x', async () => { order.push('a-start'); await Promise.resolve(); order.push('a-end'); }),
      s.queueRecordWrite('stb-x', async () => { order.push('b'); }),
    ]);
    expect(order).toEqual(['a-start', 'a-end', 'b']);
  });

  it('saveOneNow / deleteOneNow reject ids outside the stb- allowlist (backend parity)', async () => {
    const s = getStoryBuilderStore(passthroughSanitize);
    await expect(s.saveOneNow('ser-1', { id: 'ser-1', title: 'X' })).rejects.toThrow(/invalid record id/);
    await expect(s.deleteOneNow('nope')).rejects.toThrow(/invalid record id/);
  });

  it('verifySchemaVersion reports the file collection version', async () => {
    const s = getStoryBuilderStore(passthroughSanitize);
    await s.saveOneNow('stb-1', { id: 'stb-1', title: 'X' });
    const status = await s.verifySchemaVersion();
    expect(status.ok).toBe(true);
    expect(status.type).toBe('storyBuilder');
  });
});
