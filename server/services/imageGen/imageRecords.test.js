/**
 * A gallery image's owner: renders, uploads and variants made here record this
 * machine as their origin, once, and never take a source image's.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import sharp from 'sharp';
import { makePathsProxy } from '../../lib/mockPathsDataRoot.js';

let dataRoot;
vi.mock('../../lib/fileUtils.js', async () => makePathsProxy(await vi.importActual('../../lib/fileUtils.js'), { dataRoot: () => dataRoot }));
vi.mock('../../lib/pythonSetup.js', () => ({ resolveFlux2Python: () => null, FLUX2_VENV_DEFAULT: '/fake/venv/bin/python3' }));
vi.mock('../mediaAssetIndex/index.js', () => ({ indexImage: vi.fn(async () => {}), unindexImage: vi.fn(async () => {}) }));
vi.mock('../instanceIdentity.js', () => ({ UNKNOWN_INSTANCE_ID: 'unknown', getInstanceId: async () => 'local-inst' }));
vi.mock('../instances.js', async (importOriginal) => ({ ...(await importOriginal()), getPeers: async () => [] }));

let PATHS;
let imageGenEvents;
let initImageOriginStamping;
let readHeldImage;
let persistVariant;
let saveUploadedGalleryImage;
let disarm;

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'portos-image-records-'));
  process.env.PORTOS_MEDIA_MODELS_FILE = join(dataRoot, 'media-models.json');
  ({ PATHS } = await import('../../lib/fileUtils.js'));
  ({ imageGenEvents } = await import('../imageGenEvents.js'));
  ({ initImageOriginStamping, readHeldImage } = await import('./imageRecords.js'));
  ({ persistVariant } = await import('./variants.js'));
  ({ saveUploadedGalleryImage } = await import('./local.js'));
});
afterAll(() => {
  disarm?.();
  rmSync(dataRoot, { recursive: true, force: true });
});
beforeEach(() => {
  rmSync(PATHS.images, { recursive: true, force: true });
  mkdirSync(PATHS.images, { recursive: true });
});

const sidecarOf = (filename) => JSON.parse(readFileSync(join(PATHS.images, filename.replace(/\.png$/, '.metadata.json')), 'utf8'));
const seed = (filename, sidecar) => {
  writeFileSync(join(PATHS.images, filename), 'synthetic');
  writeFileSync(join(PATHS.images, filename.replace(/\.png$/, '.metadata.json')), JSON.stringify(sidecar));
};

describe('image origin', () => {
  it("stamps a finished render with this machine's origin once, and skips temp renders", async () => {
    disarm = initImageOriginStamping();
    seed('render.png', { prompt: 'a fox' });
    seed('claimed.png', { prompt: 'a cat', originInstanceId: 'other-inst' });
    seed('temp.png', { prompt: 'scratch' });
    imageGenEvents.emit('completed', { filename: 'render.png', path: '/data/images/render.png' });
    imageGenEvents.emit('completed', { filename: 'claimed.png', path: '/data/images/claimed.png' });
    imageGenEvents.emit('completed', { filename: 'temp.png', path: null, temp: true });
    await vi.waitFor(() => expect(sidecarOf('render.png').originInstanceId).toBe('local-inst'));
    expect(sidecarOf('claimed.png').originInstanceId).toBe('other-inst');
    expect(sidecarOf('temp.png')).not.toHaveProperty('originInstanceId');
    expect(await readHeldImage('render.png')).toEqual({ filename: 'render.png', originInstanceId: 'local-inst' });
  });

  it("gives a variant of a peer's image this machine as origin, without the source's local fields", async () => {
    seed('peer-src.png', { prompt: 'p' });
    const result = await persistVariant({
      sourceFilename: 'peer-src.png', outFilename: 'peer-src_clean.png', data: Buffer.from('variant'),
      variantMeta: { prompt: 'p', originInstanceId: 'peer-inst', suppliedByInstanceId: 'peer-inst', hidden: true, pendingDelete: { peerId: 'x' } },
      width: 1, height: 1, sizeBefore: 1, sizeAfter: 1, logLine: '✨ variant',
    });
    const written = sidecarOf('peer-src_clean.png');
    expect(written).toMatchObject({ prompt: 'p', originInstanceId: 'local-inst' });
    for (const key of ['suppliedByInstanceId', 'hidden', 'pendingDelete']) expect(written).not.toHaveProperty(key);
    expect(result.originInstanceId).toBe('local-inst');
  });

  it('records this machine as the origin of an upload', async () => {
    const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#335577' } }).jpeg().toBuffer();
    const { filename } = await saveUploadedGalleryImage(jpeg.toString('base64'));
    expect(sidecarOf(filename)).toEqual({ originInstanceId: 'local-inst' });
  });
});
