import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'lora-datasets-test-'));

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), {
    dataRoot: TEST_DATA_ROOT,
    extraOverrides: (root) => ({
      loraDatasets: join(root, 'lora-datasets'),
      images: join(root, 'images'),
    }),
  }));

const getUniverse = vi.fn();
vi.mock('./universeBuilder.js', () => ({ getUniverse: (...args) => getUniverse(...args) }));
vi.mock('./mediaJobQueue/index.js', () => ({
  getJob: vi.fn(() => null),
  enqueueJob: vi.fn(),
  mediaJobEvents: { on: vi.fn() },
}));

const {
  addUploadedImage,
  createDataset,
  deleteDataset,
  deleteImage,
  datasetImagePath,
  getDataset,
  importGalleryImages,
  listDatasets,
  patchDataset,
  reconcileRenderingImages,
  updateDataset,
  updateImageCaption,
} = await import('./loraDatasets.js');

const UNIVERSE = {
  id: 'uni-1',
  name: 'Testverse',
  characters: [
    { id: 'char-1', ingredientId: 'ing-1', name: 'Kessa Brightwater' },
    { id: 'char-2', ingredientId: null, name: 'Moss' },
  ],
  objects: [
    { id: 'obj-1', name: 'Northwind Truthbreaker', description: 'A rune-bitten greataxe.' },
  ],
  places: [
    { id: 'place-1', name: 'Moonsea Shore', description: 'Black water under cold stars.' },
  ],
};

const makePng = (path, size = 64) => sharp({
  create: { width: size, height: size, channels: 3, background: { r: 200, g: 100, b: 50 } },
}).png().toFile(path);

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

beforeEach(() => {
  rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_DATA_ROOT, { recursive: true });
  getUniverse.mockReset();
  getUniverse.mockResolvedValue(UNIVERSE);
});

describe('createDataset', () => {
  it('creates with a derived trigger word and character snapshot', async () => {
    const { dataset, created } = await createDataset({ universeId: 'uni-1', entryId: 'char-1' });
    expect(created).toBe(true);
    expect(dataset.triggerWord).toBe('kessa_brightwater');
    expect(dataset.character).toEqual({
      entryId: 'char-1', entryKind: 'characters', ingredientId: 'ing-1', universeId: 'uni-1', name: 'Kessa Brightwater',
    });
    expect(dataset.readiness.trainable).toBe(false);
  });

  it('creates an object dataset from the universe bible', async () => {
    const { dataset, created } = await createDataset({
      universeId: 'uni-1', entryKind: 'objects', entryId: 'obj-1',
    });
    expect(created).toBe(true);
    expect(dataset.triggerWord).toBe('northwind_truthbreaker');
    expect(dataset.character).toEqual({
      entryId: 'obj-1', entryKind: 'objects', ingredientId: null, universeId: 'uni-1', name: 'Northwind Truthbreaker',
    });
  });

  it('is find-or-create per (universeId, entryId)', async () => {
    const first = await createDataset({ universeId: 'uni-1', entryId: 'char-1' });
    const second = await createDataset({ universeId: 'uni-1', entryId: 'char-1' });
    expect(second.created).toBe(false);
    expect(second.dataset.id).toBe(first.dataset.id);
  });

  it('allows the same entry id in different bible subject kinds', async () => {
    getUniverse.mockResolvedValue({
      ...UNIVERSE,
      characters: [...UNIVERSE.characters, { id: 'shared-1', name: 'Shared Character' }],
      objects: [...UNIVERSE.objects, { id: 'shared-1', name: 'Shared Object' }],
    });
    const character = await createDataset({ universeId: 'uni-1', entryKind: 'characters', entryId: 'shared-1' });
    const object = await createDataset({ universeId: 'uni-1', entryKind: 'objects', entryId: 'shared-1' });
    expect(character.dataset.id).not.toBe(object.dataset.id);
    expect(await listDatasets({ entryKind: 'characters', entryId: 'shared-1' })).toHaveLength(1);
    expect(await listDatasets({ entryKind: 'objects', entryId: 'shared-1' })).toHaveLength(1);
  });

  it('avoids trigger-word collisions across datasets', async () => {
    await createDataset({ universeId: 'uni-1', entryId: 'char-1' });
    getUniverse.mockResolvedValue({
      ...UNIVERSE,
      characters: [...UNIVERSE.characters, { id: 'char-3', name: 'Kessa Brightwater' }],
    });
    const { dataset } = await createDataset({ universeId: 'uni-1', entryId: 'char-3' });
    expect(dataset.triggerWord).toBe('kessa_brightwater2');
  });

  it('404s for a character missing from the universe', async () => {
    await expect(createDataset({ universeId: 'uni-1', entryId: 'nope' }))
      .rejects.toMatchObject({ status: 404 });
  });
});

describe('patchDataset / listDatasets', () => {
  it('updates trigger word and rejects invalid ones', async () => {
    const { dataset } = await createDataset({ universeId: 'uni-1', entryId: 'char-1' });
    const next = await patchDataset(dataset.id, { triggerWord: 'kessa_v2' });
    expect(next.triggerWord).toBe('kessa_v2');
    await expect(patchDataset(dataset.id, { triggerWord: 'Bad Word!' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('re-prefixes existing captions when the trigger word changes', async () => {
    const { dataset } = await createDataset({ universeId: 'uni-1', entryId: 'char-1' });
    const tmpA = join(TEST_DATA_ROOT, 'a.png');
    const tmpB = join(TEST_DATA_ROOT, 'b.png');
    await makePng(tmpA); await makePng(tmpB);
    const a = await addUploadedImage(dataset.id, { tmpPath: tmpA });
    const b = await addUploadedImage(dataset.id, { tmpPath: tmpB });
    await updateImageCaption(dataset.id, a.id, 'kessa_brightwater, front view');
    // b stays uncaptioned — must not be fabricated.

    const next = await patchDataset(dataset.id, { triggerWord: 'kessa_v2' });
    const captioned = next.images.find((i) => i.id === a.id);
    const uncaptioned = next.images.find((i) => i.id === b.id);
    // Old prefix swapped for the new token, body preserved — so the image
    // still counts toward computeDatasetReadiness.captioned under the new word.
    expect(captioned.caption).toBe('kessa_v2, front view');
    expect(uncaptioned.caption).toBe('');
    // readiness is attached by getDataset (the route layer); the re-prefixed
    // caption must still count under the new trigger word.
    const reread = await getDataset(dataset.id);
    expect(reread.readiness.captioned).toBe(1);
  });

  it('reassigns to another character, re-snapshotting identity', async () => {
    const { dataset } = await createDataset({ universeId: 'uni-1', entryId: 'char-1' });
    const next = await patchDataset(dataset.id, { universeId: 'uni-1', entryId: 'char-2' });
    expect(next.character).toEqual({
      entryId: 'char-2', entryKind: 'characters', ingredientId: null, universeId: 'uni-1', name: 'Moss',
    });
    // Trigger word is left alone — reassignment doesn't rename the token.
    expect(next.triggerWord).toBe('kessa_brightwater');
    // The list now keys the dataset under the new character.
    expect(await listDatasets({ entryId: 'char-2' })).toHaveLength(1);
    expect(await listDatasets({ entryId: 'char-1' })).toHaveLength(0);
  });

  it('reassigns to an object, re-snapshotting kind and identity', async () => {
    const { dataset } = await createDataset({ universeId: 'uni-1', entryId: 'char-1' });
    const next = await patchDataset(dataset.id, { universeId: 'uni-1', entryKind: 'objects', entryId: 'obj-1' });
    expect(next.character).toEqual({
      entryId: 'obj-1', entryKind: 'objects', ingredientId: null, universeId: 'uni-1', name: 'Northwind Truthbreaker',
    });
    expect(await listDatasets({ entryKind: 'objects', entryId: 'obj-1' })).toHaveLength(1);
    expect(await listDatasets({ entryKind: 'characters', entryId: 'char-1' })).toHaveLength(0);
  });

  it('reassigns and renames the trigger word in one patch', async () => {
    const { dataset } = await createDataset({ universeId: 'uni-1', entryId: 'char-1' });
    const next = await patchDataset(dataset.id, { universeId: 'uni-1', entryId: 'char-2', triggerWord: 'moss_v1' });
    expect(next.character.entryId).toBe('char-2');
    expect(next.triggerWord).toBe('moss_v1');
  });

  it('resets trained status when reassigning to a new character', async () => {
    // The trained LoRA is registered against the OLD character, so a moved
    // dataset must drop its `trained` status + training metadata rather than
    // falsely advertise the new character as trained.
    const { dataset } = await createDataset({ universeId: 'uni-1', entryId: 'char-1' });
    await updateDataset(dataset.id, (current) => ({
      ...current, status: 'trained', training: { loraFilename: 'char-1.safetensors', completedAt: 'x' },
    }));
    const next = await patchDataset(dataset.id, { universeId: 'uni-1', entryId: 'char-2' });
    expect(next.status).toBe('draft');
    expect(next.training).toEqual({});
  });

  it('keeps trained status on a trigger-only patch (same character)', async () => {
    const { dataset } = await createDataset({ universeId: 'uni-1', entryId: 'char-1' });
    await updateDataset(dataset.id, (current) => ({
      ...current, status: 'trained', training: { loraFilename: 'char-1.safetensors' },
    }));
    const next = await patchDataset(dataset.id, { triggerWord: 'kessa_v2' });
    expect(next.status).toBe('trained');
    expect(next.training.loraFilename).toBe('char-1.safetensors');
  });

  it('refuses to reassign while a training run is in progress', async () => {
    // status 'training' = a queued/running job that captured this dataset id +
    // old character; reassigning now would register the adapter under the wrong
    // character. The user must cancel first.
    const { dataset } = await createDataset({ universeId: 'uni-1', entryId: 'char-1' });
    await updateDataset(dataset.id, (current) => ({ ...current, status: 'training' }));
    await expect(patchDataset(dataset.id, { universeId: 'uni-1', entryId: 'char-2' }))
      .rejects.toMatchObject({ status: 409, code: 'DATASET_TRAINING' });
  });

  it('refuses to reassign onto a character that already owns a dataset', async () => {
    const a = await createDataset({ universeId: 'uni-1', entryId: 'char-1' });
    await createDataset({ universeId: 'uni-1', entryId: 'char-2' });
    await expect(patchDataset(a.dataset.id, { universeId: 'uni-1', entryId: 'char-2' }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('404s reassignment to a character missing from the universe', async () => {
    const { dataset } = await createDataset({ universeId: 'uni-1', entryId: 'char-1' });
    await expect(patchDataset(dataset.id, { universeId: 'uni-1', entryId: 'nope' }))
      .rejects.toMatchObject({ status: 404 });
  });

  it('400s a half-specified reassignment (universe without character)', async () => {
    const { dataset } = await createDataset({ universeId: 'uni-1', entryId: 'char-1' });
    await expect(patchDataset(dataset.id, { universeId: 'uni-1' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('filters list by character ids', async () => {
    await createDataset({ universeId: 'uni-1', entryId: 'char-1' });
    await createDataset({ universeId: 'uni-1', entryId: 'char-2' });
    expect(await listDatasets()).toHaveLength(2);
    expect(await listDatasets({ entryId: 'char-1' })).toHaveLength(1);
    expect(await listDatasets({ ingredientId: 'ing-1' })).toHaveLength(1);
    expect(await listDatasets({ universeId: 'other' })).toHaveLength(0);
  });
});

describe('images', () => {
  it('normalizes uploads to PNG and records dimensions', async () => {
    const { dataset } = await createDataset({ universeId: 'uni-1', entryId: 'char-1' });
    const tmpPath = join(TEST_DATA_ROOT, 'upload.jpg');
    await sharp({ create: { width: 80, height: 60, channels: 3, background: '#888' } })
      .jpeg().toFile(tmpPath);
    const entry = await addUploadedImage(dataset.id, { tmpPath, originalname: 'photo.jpg' });
    expect(entry.source).toBe('upload');
    expect(entry.status).toBe('ready');
    expect(entry.width).toBe(80);
    expect(entry.height).toBe(60);
    expect(existsSync(datasetImagePath(dataset.id, entry.file))).toBe(true);
    expect(existsSync(tmpPath)).toBe(false); // staged temp always cleaned
  });

  it('422s on non-image uploads and cleans the temp file', async () => {
    const { dataset } = await createDataset({ universeId: 'uni-1', entryId: 'char-1' });
    const tmpPath = join(TEST_DATA_ROOT, 'not-an-image.png');
    await writeFile(tmpPath, 'plain text');
    await expect(addUploadedImage(dataset.id, { tmpPath, originalname: 'x.png' }))
      .rejects.toMatchObject({ status: 422 });
    expect(existsSync(tmpPath)).toBe(false);
  });

  it('edits captions as manual and deletes images with their files', async () => {
    const { dataset } = await createDataset({ universeId: 'uni-1', entryId: 'char-1' });
    const tmpPath = join(TEST_DATA_ROOT, 'u.png');
    await makePng(tmpPath);
    const entry = await addUploadedImage(dataset.id, { tmpPath });

    const updated = await updateImageCaption(dataset.id, entry.id, 'kessa_brightwater, side profile');
    expect(updated.captionSource).toBe('manual');
    expect(updated.caption).toContain('side profile');

    await deleteImage(dataset.id, entry.id);
    const after = await getDataset(dataset.id);
    expect(after.images).toHaveLength(0);
    expect(existsSync(datasetImagePath(dataset.id, entry.file))).toBe(false);
  });

  it('404s caption edits for unknown images', async () => {
    const { dataset } = await createDataset({ universeId: 'uni-1', entryId: 'char-1' });
    await expect(updateImageCaption(dataset.id, 'ghost', 'x'))
      .rejects.toMatchObject({ status: 404 });
  });
});

describe('reconcileRenderingImages', () => {
  const seedRendering = async (jobId) => {
    const { dataset } = await createDataset({ universeId: 'uni-1', entryId: 'char-1' });
    await updateDataset(dataset.id, (current) => ({
      ...current,
      images: [{
        id: 'img-r', file: 'img-r.png', caption: '', captionSource: null, captionedAt: null,
        source: 'generated', sourceJobId: jobId, variation: null, status: 'rendering',
        width: 1024, height: 1024, createdAt: new Date().toISOString(),
      }],
    }));
    return dataset.id;
  };

  it('copies completed renders in and marks ready', async () => {
    const id = await seedRendering('job-1');
    mkdirSync(join(TEST_DATA_ROOT, 'images'), { recursive: true });
    await makePng(join(TEST_DATA_ROOT, 'images', 'job-1.png'));
    const out = await reconcileRenderingImages(id, {
      jobLookup: () => ({ status: 'completed', result: { filename: 'job-1.png' } }),
    });
    expect(out.images[0].status).toBe('ready');
    expect(existsSync(datasetImagePath(id, 'img-r.png'))).toBe(true);
  });

  it('marks failed when the job is gone or failed', async () => {
    const id = await seedRendering('job-2');
    const out = await reconcileRenderingImages(id, { jobLookup: () => null });
    expect(out.images[0].status).toBe('failed');
  });

  it('leaves queued/running jobs as rendering', async () => {
    const id = await seedRendering('job-3');
    const out = await reconcileRenderingImages(id, {
      jobLookup: () => ({ status: 'running' }),
    });
    expect(out.images[0].status).toBe('rendering');
  });
});

describe('importGalleryImages', () => {
  const seedGallery = async (...filenames) => {
    mkdirSync(join(TEST_DATA_ROOT, 'images'), { recursive: true });
    for (const f of filenames) await makePng(join(TEST_DATA_ROOT, 'images', f));
  };

  it('imports gallery images as independent copies tagged source=gallery', async () => {
    const { dataset } = await createDataset({ universeId: 'uni-1', entryId: 'char-1' });
    await seedGallery('aaaa.png', 'bbbb.png');
    const images = await importGalleryImages(dataset.id, { filenames: ['aaaa.png', 'bbbb.png'] });
    expect(images).toHaveLength(2);
    for (const img of images) {
      expect(img.source).toBe('gallery');
      expect(img.status).toBe('ready');
      expect(img.width).toBe(64);
      expect(existsSync(datasetImagePath(dataset.id, img.file))).toBe(true);
    }
    // The copy is independent — the dataset image is NOT the gallery file.
    expect(images[0].file).not.toBe('aaaa.png');
    const after = await getDataset(dataset.id);
    expect(after.images).toHaveLength(2);
  });

  it('404s when a gallery file is missing', async () => {
    const { dataset } = await createDataset({ universeId: 'uni-1', entryId: 'char-1' });
    await expect(importGalleryImages(dataset.id, { filenames: ['ghost.png'] }))
      .rejects.toMatchObject({ status: 404 });
  });

  it('rejects path-traversal filenames before touching disk', async () => {
    const { dataset } = await createDataset({ universeId: 'uni-1', entryId: 'char-1' });
    await expect(importGalleryImages(dataset.id, { filenames: ['../../etc/passwd.png'] }))
      .rejects.toBeTruthy();
  });

  it('400s on an empty filename list', async () => {
    const { dataset } = await createDataset({ universeId: 'uni-1', entryId: 'char-1' });
    await expect(importGalleryImages(dataset.id, { filenames: [] }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('cleans up already-written copies when one image in the batch is missing', async () => {
    const { dataset } = await createDataset({ universeId: 'uni-1', entryId: 'char-1' });
    await seedGallery('good1.png', 'good2.png'); // 'missing.png' intentionally absent
    await expect(importGalleryImages(dataset.id, { filenames: ['good1.png', 'good2.png', 'missing.png'] }))
      .rejects.toMatchObject({ status: 404 });
    // The dataset records nothing on a partial failure...
    const after = await getDataset(dataset.id);
    expect(after.images).toHaveLength(0);
    // ...and no orphaned PNGs are left in the dataset's images dir.
    const imagesDir = join(TEST_DATA_ROOT, 'lora-datasets', dataset.id, 'images');
    const leftover = existsSync(imagesDir) ? readdirSync(imagesDir) : [];
    expect(leftover).toEqual([]);
  });
});

describe('deleteDataset', () => {
  it('removes the record and its images dir', async () => {
    const { dataset } = await createDataset({ universeId: 'uni-1', entryId: 'char-1' });
    const tmpPath = join(TEST_DATA_ROOT, 'd.png');
    await makePng(tmpPath);
    await addUploadedImage(dataset.id, { tmpPath });
    await deleteDataset(dataset.id);
    expect(existsSync(join(TEST_DATA_ROOT, 'lora-datasets', dataset.id))).toBe(false);
    await expect(getDataset(dataset.id)).rejects.toMatchObject({ status: 404 });
  });
});
