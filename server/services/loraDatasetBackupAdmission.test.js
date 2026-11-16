/** Retained dataset edits (surviving-trainer status flips) hold backup admission through their record commit. */
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { rm } from 'fs/promises';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async importOriginal => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-lora-backup-'),
}));
vi.mock('../lib/databaseMaintenanceJournal.js', () => ({ assertDatabaseAdmission: () => {} }));

const { PATHS } = await import('../lib/fileUtils.js');
const { acquireBackupSnapshotCut } = await import('../lib/backupSnapshotBoundary.js');
const { loraDatasetStore, updateDataset } = await import('./loraDatasets.js');
const id = 'dataset-1';
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

beforeEach(async () => {
  await rm(PATHS.data, { recursive: true, force: true });
  await loraDatasetStore.saveOne(id, {
    schemaVersion: 1, id, triggerWord: 'example_character',
    character: { universeId: 'universe-1', entryId: 'subject-1', entryKind: 'characters', name: 'Example Character' },
  });
});
afterAll(cleanupTempDataRoots);

it('drains a queued dataset edit through its record commit', async () => {
  const inFirst = deferred();
  const finishFirst = deferred();
  const inSecond = deferred();
  const finishSecond = deferred();
  const first = updateDataset(id, async current => { inFirst.resolve(); await finishFirst.promise; return current; });
  await inFirst.promise;
  const second = updateDataset(id, async current => { inSecond.resolve(); await finishSecond.promise; return current; });
  const cut = acquireBackupSnapshotCut();
  try {
    finishFirst.resolve();
    expect(await Promise.race([inSecond.promise.then(() => 'edit'), cut.then(() => 'snapshot')])).toBe('edit');
  } finally {
    finishFirst.resolve();
    finishSecond.resolve();
    (await cut)();
    await Promise.all([first, second]);
  }
});
