/** Exercise the real dataset/file workflows at their file-versus-record seam. */
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

let afterFileWrite = async () => {};
let beforeRemove = async () => {};
let beforeRecordWrite = async () => {};
vi.mock('../lib/fileUtils.js', async importOriginal => {
  const actual = await importOriginal();
  return makePathsProxy(actual, {
    dataRoot: () => lazyTempDataRoot('portos-lora-backup-'),
    overrides: {
      copyFileGuarded: async (source, dest) => { await actual.copyFileGuarded(source, dest); await afterFileWrite(dest); },
      unlinkGuarded: async path => { await beforeRemove(path); return actual.unlinkGuarded(path); },
      atomicWrite: async (path, value) => { await beforeRecordWrite(path); return actual.atomicWrite(path, value); },
    },
  });
});
vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, rm: async (path, options) => { await beforeRemove(path); return actual.rm(path, options); } };
});
vi.mock('sharp', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, default: new Proxy(actual.default, {
    apply(target, thisArg, args) {
      const instance = Reflect.apply(target, thisArg, args);
      const toFile = instance.toFile.bind(instance);
      instance.toFile = async path => { const result = await toFile(path); await afterFileWrite(path); return result; };
      return instance;
    },
  }) };
});
vi.mock('../lib/databaseMaintenanceJournal.js', () => ({ assertDatabaseAdmission: () => {} }));
vi.mock('./universeBuilder.js', () => ({ getUniverse: async () => ({
  id: 'universe-1', characters: [{ id: 'subject-1', name: 'Example Character', referenceSheetImageRef: 'sheet.png' }],
}) }));
vi.mock('./settings.js', () => ({ getSettings: async () => ({ imageGen: { mode: 'local', local: { modelId: 'example-model' } } }) }));
vi.mock('../lib/mediaModels.js', async importOriginal => ({
  ...(await importOriginal()), getImageModels: () => [{ id: 'example-model', hardwareCompatibility: { state: 'available' } }],
}));
vi.mock('./visionTest.js', () => ({ describeImageDataUrlDetailed: vi.fn() }));
vi.mock('./loraDatasetCaption.js', () => ({ resolveCaptionModel: vi.fn(), withCaptionVisionLock: work => work() }));
vi.mock('./universeCharacterSheet.js', () => ({
  extractCharacterPromptCommon: () => ({ name: 'Example Character' }),
  REFERENCE_SHEET_CONSTANTS: { DEFAULT_EXPRESSIONS: ['neutral'] },
}));
vi.mock('./mediaJobQueue/index.js', async () => ({
  mediaJobEvents: new (await import('node:events')).EventEmitter(),
  getJob: () => null, enqueueJob: async () => ({ jobId: 'job-1' }),
  assertMediaQueueRoom: () => {}, partialBatchAdmissionError: error => error,
}));

const { PATHS } = await import('../lib/fileUtils.js');
const { acquireBackupSnapshotCut, runOutsideBackupAssetPublication, withBackupAssetPublication } = await import('../lib/backupSnapshotBoundary.js');
const {
  addUploadedImage, deleteDataset, deleteImage, datasetImagePath, datasetImagesDir,
  getDataset, importGalleryImages, loraDatasetStore, reconcileRenderingImages, updateDataset,
} = await import('./loraDatasets.js');
const { generateDatasetImages, sliceReferenceSheet } = await import('./loraDatasetGenerate.js');
const { mediaJobEvents } = await import('./mediaJobQueue/index.js');
const id = 'dataset-1';
const recordPath = loraDatasetStore.recordPath(id);
const oldBytes = await sharp({ create: { width: 128, height: 128, channels: 3, background: 'red' } }).png().toBuffer();
const newBytes = await sharp({ create: { width: 128, height: 128, channels: 3, background: 'blue' } }).png().toBuffer();
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const readRecord = () => readFile(recordPath, 'utf8').then(JSON.parse);
const readImage = file => readFile(datasetImagePath(id, file));

beforeEach(async () => {
  afterFileWrite = beforeRemove = beforeRecordWrite = async () => {};
  await rm(PATHS.data, { recursive: true, force: true });
  await Promise.all([datasetImagesDir(id), PATHS.images, PATHS.imageRefs].map(path => mkdir(path, { recursive: true })));
  await loraDatasetStore.saveOne(id, {
    schemaVersion: 1, id, triggerWord: 'example_character',
    character: { universeId: 'universe-1', entryId: 'subject-1', entryKind: 'characters', name: 'Example Character' },
    images: [
      { id: 'ready-1', file: 'ready.png', status: 'ready', caption: 'before' },
      { id: 'pending-1', file: 'pending.png', status: 'rendering', sourceJobId: 'render-1' },
    ],
  });
  await Promise.all([
    writeFile(datasetImagePath(id, 'ready.png'), oldBytes),
    writeFile(datasetImagePath(id, 'pending.png'), oldBytes),
    writeFile(join(PATHS.images, 'source.png'), newBytes),
    writeFile(join(PATHS.imageRefs, 'sheet.png'), newBytes),
    writeFile(join(PATHS.data, 'upload.png'), newBytes),
  ]);
});
afterAll(cleanupTempDataRoots);

// The cut is requested AFTER bytes change but BEFORE updateDataset is entered.
// Merely locking updateDataset or fileCore independently fails these contracts.
it.each([
  ['upload', () => addUploadedImage(id, { tmpPath: join(PATHS.data, 'upload.png') })],
  ['gallery import', () => importGalleryImages(id, { filenames: ['source.png'] })],
  ['reference-sheet crop', () => sliceReferenceSheet(id, { cols: 1, rows: 1, useVision: false })],
  ['recovered render replacement', () => reconcileRenderingImages(id, {
    jobLookup: () => ({ status: 'completed', result: { filename: 'source.png' } }),
  })],
])('drains the complete %s workflow before capturing dataset files', async (_name, mutate) => {
  const fileWritten = deferred();
  const finishWrite = deferred();
  afterFileWrite = async path => {
    if (path.startsWith(datasetImagesDir(id))) { fileWritten.resolve(); await finishWrite.promise; }
  };
  const mutation = mutate();
  await fileWritten.promise;
  const before = await readRecord();
  expect(before.images).toHaveLength(2);
  expect(before.images[1].status).toBe('rendering');
  let entered = false;
  const cut = acquireBackupSnapshotCut().then(release => { entered = true; return release; });
  try {
    await readdir(datasetImagesDir(id));
    expect(entered).toBe(false);
  } finally {
    finishWrite.resolve();
    await mutation;
    (await cut)();
  }
  const published = await getDataset(id);
  for (const image of published.images.filter(image => image.status === 'ready')) {
    expect((await readImage(image.file)).length).toBeGreaterThan(0);
  }
});

it.each([
  ['image deletion', () => deleteImage(id, 'ready-1'), () => readImage('ready.png')],
  ['dataset deletion', () => deleteDataset(id), () => readRecord()],
])('drains %s through its final file removal', async (_name, mutate, readDeleted) => {
  const removing = deferred();
  const finishRemoval = deferred();
  beforeRemove = async path => {
    if (path.startsWith(loraDatasetStore.recordDir(id))) { removing.resolve(); await finishRemoval.promise; }
  };
  const mutation = mutate();
  await removing.promise;
  let entered = false;
  const cut = acquireBackupSnapshotCut().then(release => { entered = true; return release; });
  try {
    expect(await readImage('ready.png')).toEqual(oldBytes);
    expect(entered).toBe(false);
  } finally {
    finishRemoval.resolve();
    await mutation;
    (await cut)();
  }
  await expect(readDeleted()).rejects.toMatchObject({ code: 'ENOENT' });
});

it('keeps an existing snapshot stable while replacement and deletion wait', async () => {
  const release = await acquireBackupSnapshotCut();
  const replacement = reconcileRenderingImages(id, {
    jobLookup: () => ({ status: 'completed', result: { filename: 'source.png' } }),
  });
  const deletion = deleteImage(id, 'ready-1');
  try {
    expect(await readImage('pending.png')).toEqual(oldBytes);
    expect(await readImage('ready.png')).toEqual(oldBytes);
    expect((await readRecord()).images.map(image => image.status)).toEqual(['ready', 'rendering']);
  } finally {
    release();
    await Promise.all([replacement, deletion]);
  }
  expect(await readImage('pending.png')).toEqual(newBytes);
  await expect(readImage('ready.png')).rejects.toMatchObject({ code: 'ENOENT' });
});

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

it('joins a draining completion fan-out synchronously and keeps its own lease through the dataset write', async () => {
  const result = await generateDatasetImages(id, { count: 1 });
  const rendered = result.images[0];
  const emitCompletion = deferred();
  const fileWritten = deferred();
  const finishCopy = deferred();
  const writingRecord = deferred();
  const finishRecord = deferred();
  afterFileWrite = async () => { fileWritten.resolve(); await finishCopy.promise; };
  beforeRecordWrite = async path => { if (path === recordPath) { writingRecord.resolve(); await finishRecord.promise; } };
  const queueCompletion = withBackupAssetPublication(async () => {
    await emitCompletion.promise;
    runOutsideBackupAssetPublication(() => mediaJobEvents.emit('completed', {
      id: rendered.jobId, result: { filename: 'source.png' },
    }));
  });
  let entered = false;
  const cut = acquireBackupSnapshotCut().then(release => { entered = true; return release; });
  try {
    emitCompletion.resolve();
    expect(await Promise.race([fileWritten.promise.then(() => 'copy'), cut.then(() => 'snapshot')])).toBe('copy');
    await queueCompletion;
    finishCopy.resolve();
    await writingRecord.promise;
    expect((await readRecord()).images.find(image => image.id === rendered.imageId).status).toBe('rendering');
    expect(entered).toBe(false);
  } finally {
    emitCompletion.resolve();
    finishCopy.resolve();
    finishRecord.resolve();
    (await cut)();
    await queueCompletion;
  }
  const published = (await getDataset(id)).images.find(image => image.id === rendered.imageId);
  expect(published.status).toBe('ready');
  expect(await readImage(published.file)).toEqual(newBytes);
});

it('releases admission after an invalid import without publishing an image entry', async () => {
  await expect(importGalleryImages(id, { filenames: ['source.png', 'missing.png'] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  const release = await acquireBackupSnapshotCut();
  try {
    expect((await readRecord()).images).toHaveLength(2);
    expect((await readdir(datasetImagesDir(id))).sort()).toEqual(['pending.png', 'ready.png']);
  } finally {
    release();
  }
});
