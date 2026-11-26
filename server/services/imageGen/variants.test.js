import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it as vitestIt, vi } from 'vitest';
import { PATHS } from '../../lib/fileUtils.js';
import { cleanupTempDataRoots, ownTestBodies } from '../../lib/mockPathsDataRoot.js';
import { addItem, ERR_DUPLICATE, listCollections } from '../mediaCollections.js';
import { applyImageClean, applyLightRegenVariant, applyWatermarkRemoval, autoFileCleanedToSourceCollections, persistVariant } from './variants.js';

vi.mock('../../lib/fileUtils.js', async original => {
  const { lazyTempDataRoot, makePathsProxy } = await import('../../lib/mockPathsDataRoot.js');
  return makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('portos-image-variants-') });
});
vi.mock('../../lib/backupSnapshotBoundary.js', () => ({
  withBackupAssetPublication: work => work(),
}));
vi.mock('../instanceIdentity.js', async () => {
  const { mockTestIdentity } = await import('../../lib/mockPathsDataRoot.js');
  return mockTestIdentity();
});
vi.mock('../mediaAssetIndex/index.js', () => ({ indexImage: vi.fn() }));
vi.mock('../mediaCollections.js', () => ({
  listCollections: vi.fn(),
  addItem: vi.fn(),
  ERR_DUPLICATE: 'DUPLICATE',
}));

const { it, drain } = ownTestBodies(vitestIt);
const sourceMeta = {
  id: 'source-id',
  filename: 'source.png',
  hidden: true,
  prompt: 'A synthetic landscape',
  createdAt: '2025-01-01T00:00:00.000Z',
};
const renderFields = {
  renderMs: 20,
  renderStartedAt: '2025-01-01T00:00:00.000Z',
  renderCompletedAt: '2025-01-01T00:00:00.020Z',
  falRequestId: 'source-request',
  runwayTaskId: 'source-task',
};
const regenFields = {
  regenerated: true,
  regenMethod: 'flux',
  regenSteps: 4,
  regenStrength: 0.2,
  regenModelId: 'dev',
  regenPixelDeltaPct: 42,
  regenPsnr: 10,
};

beforeAll(() => mkdir(PATHS.images, { recursive: true }));
beforeEach(() => {
  vi.resetAllMocks();
  listCollections.mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  try {
    await drain();
  } finally {
    cleanupTempDataRoots();
  }
});

async function writeSource(filename, format) {
  const whiteSquare = { create: { width: 16, height: 16, channels: 3, background: '#ffffff' } };
  const data = await sharp({ create: { width: 96, height: 64, channels: 3, background: '#283c5a' } })
    .composite([{ input: whiteSquare, left: 80, top: 48 }])
    .toFormat(format)
    .toBuffer();
  const path = join(PATHS.images, filename);
  await writeFile(path, data);
  return { path, data };
}

const readSidecar = async stem => JSON.parse(await readFile(join(PATHS.images, `${stem}.metadata.json`), 'utf8'));

it('cleans a JPEG into a PNG and files the result with the source', async () => {
  const filename = 'source.v2.jpeg';
  const { data } = await writeSource(filename, 'jpeg');
  listCollections.mockResolvedValue([{ id: 'gallery', items: [{ kind: 'image', ref: filename }] }]);
  const stem = 'source.v2_clean-resize-squeeze';
  const variant = await applyImageClean({ filename, sourceMeta });

  expect(variant).toMatchObject({
    filename: `${stem}.png`, path: `/data/images/${stem}.png`, width: 96, height: 64,
    cleanedFrom: filename, cleanLevel: 'resize-squeeze', c2paStripped: false, sizeBefore: data.length,
  });
  const output = await readFile(join(PATHS.images, variant.filename));
  expect(await sharp(output).metadata()).toMatchObject({ format: 'png', width: 96, height: 64 });
  expect(variant.sizeAfter).toBe(output.length);
  expect(await readSidecar(stem)).toEqual({
    prompt: sourceMeta.prompt, createdAt: variant.createdAt, originInstanceId: 'test-instance',
    cleanedFrom: filename, cleanLevel: 'resize-squeeze', c2paStripped: false,
  });
  expect(variant.createdAt).not.toBe(sourceMeta.createdAt);
  expect(addItem).toHaveBeenCalledWith('gallery', { kind: 'image', ref: variant.filename });
  expect(await readFile(join(PATHS.images, filename))).toEqual(data);
});

it('removes the watermark from a WebP variant and anchors it to the original', async () => {
  const filename = 'watermark.regen.webp';
  await writeSource(filename, 'webp');
  const region = { x: 80, y: 48, w: 16, h: 16 };
  const variant = await applyWatermarkRemoval({
    filename, region, sourceMeta: { ...sourceMeta, ...regenFields, cleanedFrom: 'original.jpeg' },
  });

  expect(variant).toMatchObject({
    filename: 'watermark.regen_nowatermark.png', cleanedFrom: 'original.jpeg',
    watermarkRemoved: true, watermarkRegion: region,
  });
  const output = sharp(join(PATHS.images, variant.filename));
  expect(await output.metadata()).toMatchObject({ format: 'png', width: 96, height: 64 });
  const pixel = await output.extract({ left: 88, top: 56, width: 1, height: 1 }).raw().toBuffer();
  expect(Math.max(...pixel.subarray(0, 3))).toBeLessThan(120);
  const sidecar = await readSidecar('watermark.regen_nowatermark');
  expect(sidecar).toMatchObject({ cleanedFrom: 'original.jpeg', watermarkRemoved: true, watermarkRegion: region });
  for (const field of Object.keys(regenFields)) expect(sidecar).not.toHaveProperty(field);
});

it('records fresh light-regen fidelity with the original group root', async () => {
  const filename = 'source.regen.jpeg';
  const { path } = await writeSource(filename, 'jpeg');
  const variant = await applyLightRegenVariant({
    filename, sourceAbsPath: path, sourceMeta: { ...sourceMeta, ...regenFields, cleanedFrom: 'original.jpeg' },
  });

  expect(variant).toMatchObject({
    filename: 'source.regen_regen-light.png', width: 96, height: 64,
    cleanedFrom: 'original.jpeg', regenerated: true, regenMethod: 'light-spatial',
  });
  const sidecar = await readSidecar('source.regen_regen-light');
  expect(sidecar).toMatchObject({
    cleanedFrom: 'original.jpeg', regenMethod: 'light-spatial',
    regenPixelDeltaPct: variant.regenPixelDeltaPct, regenPsnr: variant.regenPsnr,
  });
  expect(sidecar.regenPixelDeltaPct).toBeGreaterThan(0);
  expect(Number.isFinite(sidecar.regenPsnr)).toBe(true);
  for (const field of ['regenStrength', 'regenSteps', 'regenModelId']) expect(sidecar).not.toHaveProperty(field);
  expect(await sharp(join(PATHS.images, variant.filename)).metadata()).toMatchObject({ format: 'png' });
});

for (const [outFilename, stem] of [
  ['derived.v2.jpeg', 'derived.v2'],
  ['derived.v3.JPG', 'derived.v3'],
  ['derived', 'derived'],
  ['.derived', '.derived'],
]) {
  it(`persists ${outFilename} with a matching sidecar and strips source-specific metadata`, async () => {
    const data = Buffer.from('synthetic variant bytes');
    const variant = await persistVariant({
      sourceFilename: 'original.png', outFilename, data, logLine: 'Published test variant',
      variantMeta: {
        ...renderFields, originInstanceId: 'source-peer', restoredAt: sourceMeta.createdAt,
        pendingDelete: true, suppliedByInstanceId: 'relay-peer', hidden: true,
        cleanedFrom: 'original.png', prompt: sourceMeta.prompt, createdAt: sourceMeta.createdAt,
      },
    });

    const sidecar = {
      cleanedFrom: 'original.png', prompt: sourceMeta.prompt, createdAt: sourceMeta.createdAt, originInstanceId: 'test-instance',
    };
    expect(await readFile(join(PATHS.images, outFilename))).toEqual(data);
    expect(await readSidecar(stem)).toEqual(sidecar);
    expect(variant).toEqual({ ...sidecar, filename: outFilename, path: `/data/images/${outFilename}` });
  });
}

for (const [operation, apply] of [
  ['clean', applyImageClean],
  ['watermark', applyWatermarkRemoval],
  ['light-regen', applyLightRegenVariant],
]) {
  it(`refuses missing and corrupt ${operation} sources without publishing`, async () => {
    const filename = `bad-${operation}.png`;
    const sourceAbsPath = join(PATHS.images, filename);
    const input = { filename, sourceAbsPath, sourceMeta };
    await expect(apply(input)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    await writeFile(sourceAbsPath, 'not an image');
    await expect(apply(input)).rejects.toMatchObject({ status: 400, code: 'INVALID_IMAGE' });
    expect((await readdir(PATHS.images)).filter(name => name.startsWith(`bad-${operation}`))).toEqual([filename]);
    expect(listCollections).not.toHaveBeenCalled();
  });
}

it('returns every successfully filed collection and skips duplicates and failures', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const source = { kind: 'image', ref: 'source.jpeg' };
  listCollections.mockResolvedValue([
    { id: 'first', items: [source] },
    { id: 'duplicate', items: [source] },
    { id: 'unavailable', items: [source] },
    { id: 'video-only', items: [{ ...source, kind: 'video' }] },
    { id: 'last', items: [source] },
  ]);
  addItem.mockImplementation(async id => {
    if (id === 'duplicate') throw Object.assign(new Error('Already filed'), { code: ERR_DUPLICATE });
    if (id === 'unavailable') throw new Error('Collection unavailable');
  });

  await expect(autoFileCleanedToSourceCollections(source.ref, 'variant.png')).resolves.toEqual(['first', 'last']);
  expect(addItem.mock.calls).toEqual(['first', 'duplicate', 'unavailable', 'last'].map(
    id => [id, { kind: 'image', ref: 'variant.png' }],
  ));
  expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Collection unavailable'));
});
