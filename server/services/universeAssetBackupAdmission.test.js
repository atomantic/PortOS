/** Universe asset workflows over real files, with the universe row write held
 * at its commit seam. A backup cut must never land between a sheet copy or file
 * removal and the universe row that names (or stops naming) those bytes. */
import { EventEmitter } from 'node:events';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async importOriginal => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-universe-assets-'),
}));

// In-memory universe rows standing in for the PostgreSQL store. Every write
// awaits `beforeRowWrite`, so a test can hold the commit after the files changed.
const universes = new Map();
let beforeRowWrite = async () => {};
vi.mock('./universeBuilder.js', () => ({
  ENTRY_REF_KIND: { VARIATION: 'variation', SHEET: 'sheet', CANON: 'canon' },
  joinInfluenceList: () => '',
  getUniverse: async id => structuredClone(universes.get(id)),
  listUniverses: async () => [...universes.values()].map(universe => structuredClone(universe)),
  // Read-modify-write runs in one turn after the hold, like the store's per-id queue.
  updateUniverse: async (id, mutate) => {
    await beforeRowWrite();
    const patch = mutate(structuredClone(universes.get(id)));
    if (patch) universes.set(id, { ...universes.get(id), ...patch });
    return structuredClone(universes.get(id));
  },
  appendEntryImageRef: async (id, entryRef, filename) => {
    await beforeRowWrite();
    const universe = universes.get(id);
    universes.set(id, {
      ...universe,
      [entryRef.kindKey]: universe[entryRef.kindKey].map(entry => (
        entry.id === entryRef.id ? { ...entry, imageRefs: [...(entry.imageRefs || []), filename] } : entry
      )),
    });
    return true;
  },
}));

vi.mock('./mediaJobQueue/index.js', () => ({
  mediaJobEvents: new EventEmitter(),
  enqueueJob: async () => ({ jobId: 'sheet-job', position: 1 }),
}));
vi.mock('./mediaCollections.js', () => ({ addItem: vi.fn(), ERR_DUPLICATE: 'DUPLICATE' }));
vi.mock('./mediaAssetIndex/index.js', () => ({ indexImage: async () => {}, unindexImage: async () => {} }));
vi.mock('./settings.js', () => ({ getSettings: async () => ({ imageGen: { mode: 'local', local: { modelId: 'dev' } } }) }));
vi.mock('./universeRunTag.js', () => ({ buildUniverseRunTag: async () => null }));
vi.mock('../lib/mediaModels.js', async importOriginal => ({
  ...(await importOriginal()),
  getImageModels: () => [{ id: 'dev', hardwareCompatibility: { state: 'available' } }],
}));

const { PATHS } = await import('../lib/fileUtils.js');
const {
  acquireBackupSnapshotCut, runOutsideBackupAssetPublication, withBackupAssetPublication,
} = await import('../lib/backupSnapshotBoundary.js');
const { mediaJobEvents } = await import('./mediaJobQueue/index.js');
const { deleteCharacterReferenceSheet, renderCharacterReferenceSheet } = await import('./universeCharacterSheet.js');
const { initUniverseBuilderCollectionHook } = await import('./universeBuilderCollectionHook.js');
const { deleteGalleryImage } = await import('./galleryImageDeletion.js');

const RENDER = 'render.png';
const OLD_SHEET = 'old-sheet.png';
const renderPath = () => join(PATHS.images, RENDER);
const oldSheetPath = () => join(PATHS.imageRefs, OLD_SHEET);
const character = () => universes.get('universe-1').characters[0];
const exists = path => readFile(path).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const holdRowWrite = () => {
  const reached = deferred();
  const commit = deferred();
  beforeRowWrite = async () => { reached.resolve(); await commit.promise; };
  return { reached: reached.promise, commit: commit.resolve };
};
const settle = () => new Promise(resolve => setImmediate(resolve));

initUniverseBuilderCollectionHook();
afterAll(cleanupTempDataRoots);
beforeEach(async () => {
  beforeRowWrite = async () => {};
  await rm(PATHS.data, { recursive: true, force: true });
  await Promise.all([PATHS.images, PATHS.imageRefs].map(directory => mkdir(directory, { recursive: true })));
  await writeFile(renderPath(), 'synthetic render');
  await writeFile(join(PATHS.images, 'render.metadata.json'), JSON.stringify({ prompt: 'example prompt' }));
  await writeFile(oldSheetPath(), 'synthetic sheet');
  universes.clear();
  universes.set('universe-1', {
    id: 'universe-1',
    name: 'Example Universe',
    characters: [{ id: 'character-1', name: 'Example Character', imageRefs: [RENDER], referenceSheetImageRef: OLD_SHEET }],
  });
});

// The media queue stages a completion inside its own admission and fans
// `completed` out through runOutsideBackupAssetPublication
// (mediaJobQueue/index.js). Here the cut is requested while that completion
// lease is still held, so each listener must take its own lease synchronously
// inside the fan-out — one taken after an await queues behind the cut instead.
describe('render completion listeners', () => {
  let sheet;
  const entrySidecar = () => readFile(join(PATHS.images, 'entry-render.metadata.json'), 'utf8').then(JSON.parse);
  it.each([
    {
      name: 'character reference sheet',
      job: async () => {
        const { jobId, destFilename } = await renderCharacterReferenceSheet('universe-1', 'character-1');
        sheet = destFilename;
        return { id: jobId, kind: 'image', result: { filename: RENDER } };
      },
      changedFiles: async () => {
        expect(await readFile(join(PATHS.imageRefs, sheet), 'utf8')).toBe('synthetic render');
        expect(character().referenceSheetImageRef).toBe(OLD_SHEET);
      },
      captured: async () => {
        expect(character().referenceSheetImageRef).toBe(sheet);
        expect(await readFile(join(PATHS.imageRefs, sheet), 'utf8')).toBe('synthetic render');
      },
    },
    {
      name: 'universe entry image append',
      job: async () => ({
        id: 'entry-job',
        kind: 'image',
        params: { universeRun: { universeId: 'universe-1', entryRef: { kind: 'canon', kindKey: 'characters', id: 'character-1' } } },
        result: { filename: 'entry-render.png' },
      }),
      setup: async () => {
        await writeFile(join(PATHS.images, 'entry-render.png'), 'synthetic entry render');
        await writeFile(join(PATHS.images, 'entry-render.metadata.json'), JSON.stringify({ prompt: 'example prompt' }));
      },
      changedFiles: async () => {
        await vi.waitFor(async () => expect(await entrySidecar()).toMatchObject({ universeId: 'universe-1' }));
        expect(character().imageRefs).toEqual([RENDER]);
      },
      captured: async () => {
        expect(character().imageRefs).toEqual([RENDER, 'entry-render.png']);
        expect(await readFile(join(PATHS.images, 'entry-render.png'), 'utf8')).toBe('synthetic entry render');
        expect(await entrySidecar()).toMatchObject({ universeId: 'universe-1', entryId: 'character-1', entryName: 'Example Character' });
      },
    },
  ])('keeps the $name inside a cut that started draining before the fan-out', async ({ job, setup, changedFiles, captured }) => {
    await setup?.();
    const completedJob = await job();
    const row = holdRowWrite();
    const fanOut = deferred();
    const completion = withBackupAssetPublication(async () => {
      await fanOut.promise;
      runOutsideBackupAssetPublication(() => mediaJobEvents.emit('completed', completedJob));
    });
    let acquired = false;
    const cut = acquireBackupSnapshotCut().then(release => { acquired = true; return release; });
    fanOut.resolve();
    await completion;
    // A listener queued behind the cut would never reach its row write here.
    await row.reached;
    try {
      await changedFiles();
      await settle();
      expect(acquired).toBe(false);
    } finally {
      row.commit();
      (await cut)();
    }
    await captured();
  });
});

describe('durable asset deletions', () => {
  it.each([
    {
      name: 'character reference sheet deletion',
      mutate: () => deleteCharacterReferenceSheet('universe-1', 'character-1'),
      removedPath: oldSheetPath,
      captured: () => expect(character().referenceSheetImageRef ?? null).toBeNull(),
    },
    {
      name: 'gallery image deletion with its universe canon refs',
      mutate: () => deleteGalleryImage(RENDER),
      removedPath: renderPath,
      captured: () => expect(character().imageRefs).toEqual([]),
    },
  ])('drains the complete $name before admitting a snapshot', async ({ mutate, removedPath, captured }) => {
    const row = holdRowWrite();
    const mutation = mutate();
    await row.reached;
    let acquired = false;
    const cut = acquireBackupSnapshotCut().then(release => { acquired = true; return release; });
    try {
      expect(await exists(removedPath())).toBe(false);
      await settle();
      // The cut would already resolve if only the file removal held a lease.
      expect(acquired).toBe(false);
    } finally {
      row.commit();
      await mutation;
      (await cut)();
    }
    captured();
  });

  it('holds both deletions behind an active cut, preserving the captured bytes and refs', async () => {
    const release = await acquireBackupSnapshotCut();
    const deletions = [deleteGalleryImage(RENDER), deleteCharacterReferenceSheet('universe-1', 'character-1')];
    try {
      await settle();
      expect(await exists(renderPath())).toBe(true);
      expect(await exists(oldSheetPath())).toBe(true);
      expect(character()).toMatchObject({ imageRefs: [RENDER], referenceSheetImageRef: OLD_SHEET });
    } finally {
      release();
    }
    await expect(Promise.all(deletions)).resolves.toEqual([
      expect.objectContaining({ ok: true, canonRefsRemoved: 1 }),
      { filename: OLD_SHEET, fileDeleted: true, cleared: 1 },
    ]);
    expect(await exists(renderPath())).toBe(false);
    expect(await exists(oldSheetPath())).toBe(false);
  });
});
