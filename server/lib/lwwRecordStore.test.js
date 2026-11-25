import { join } from 'node:path';
import { afterAll, expect, it as vitestIt, vi } from 'vitest';
import { getSyncBaseHash } from './conflictJournal.js';
import { PATHS } from './fileUtils.js';
import { createLwwRecordFileBackend } from './lwwRecordStore.js';
import { compareNewerWins } from './lwwTimestamp.js';
import { cleanupTempDataRoots, ownTestBodies } from './mockPathsDataRoot.js';

vi.mock('./fileUtils.js', async (importOriginal) => {
  const { lazyTempDataRoot, makePathsProxy } = await import('./mockPathsDataRoot.js');
  return makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('lww-record-store-') });
});
vi.mock('./conflictJournal.js', async (importOriginal) => ({
  ...await importOriginal(),
  // Toy records have no federation wire schema. Exercise real base-hash storage.
  contentHashForRecord: (_kind, record) => record.updatedAt,
}));

const { it, drain } = ownTestBodies(vitestIt);
afterAll(async () => {
  try {
    await drain();
  } finally {
    cleanupTempDataRoots();
  }
});

const sanitize = (record) => record?.id && record.title ? record : null;
const toyStore = (file) => createLwwRecordFileBackend({
  kind: 'toy',
  filePath: join(PATHS.data, file),
  idPrefix: 'toy-',
  labelColumn: 'title',
  emoji: '🧸',
  build: (input, { id, now }) => sanitize({ ...input, id, createdAt: now, updatedAt: now, deleted: false }),
  applyPatch: (record, patch) => sanitize({ ...record, ...patch }),
  sanitize,
  merge(local, incoming) {
    const remote = sanitize(incoming);
    const remoteWins = Boolean(remote && (!local || compareNewerWins(remote.updatedAt, local.updatedAt)));
    return {
      next: remoteWins ? remote : local,
      inserted: remoteWins && !local,
      remoteWins,
      changed: remoteWins,
    };
  },
});

it('validates writes, sorts visible records and keeps soft-deleted records addressable', async () => {
  const store = toyStore('crud.json');
  await expect(store.create({})).rejects.toMatchObject({ code: 'VALIDATION', status: 400 });
  const first = await store.create({ title: 'Zebra' });
  const second = await store.create({ title: 'Ant' });
  expect(first.id).toMatch(/^toy-/);
  expect(await store.list()).toEqual([second, first]);

  const renamed = await store.update(first.id, { title: 'Bee' });
  expect(await store.get(first.id)).toEqual(renamed);
  expect(await store.remove(second.id)).toEqual({ id: second.id });
  expect(await store.get(second.id)).toBeNull();
  expect(await store.get(second.id, { includeDeleted: true })).toMatchObject({ deleted: true });
  expect(await store.list()).toEqual([renamed]);
  expect(await store.listIds()).toEqual([first.id]);
  expect(await store.listIds({ includeDeleted: true })).toEqual([first.id, second.id]);
  await expect(store.update(second.id, { title: 'Cat' })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
});

it('merges newer versions and evicts the sync base hash only after tombstone pruning', async () => {
  const store = toyStore('sync.json');
  const old = { id: 'toy-remote', title: 'First', updatedAt: '2026-01-01T00:00:00.000Z' };
  const newer = { ...old, title: 'Second', updatedAt: '2026-02-01T00:00:00.000Z' };
  expect(await store.mergeFromSync([old, newer])).toEqual({ applied: true, count: 2 });
  expect(await store.mergeFromSync([old, newer])).toEqual({ applied: false, count: 0 });
  expect(await store.get(old.id)).toEqual(newer);
  expect(await getSyncBaseHash('toy', old.id)).toBe(newer.updatedAt);

  const deletedAt = '2026-03-01T00:00:00.000Z';
  const tombstone = { ...newer, updatedAt: deletedAt, deletedAt, deleted: true };
  expect(await store.mergeFromSync([tombstone])).toEqual({ applied: true, count: 1 });
  expect(await store.pruneTombstoned(Date.parse(deletedAt))).toEqual({ pruned: 0 });
  expect(await getSyncBaseHash('toy', old.id)).toBe(deletedAt);
  expect(await store.pruneTombstoned(Date.parse(deletedAt) + 1)).toEqual({ pruned: 1 });
  expect(await store.get(old.id, { includeDeleted: true })).toBeNull();
  expect(await getSyncBaseHash('toy', old.id)).toBeNull();
});
