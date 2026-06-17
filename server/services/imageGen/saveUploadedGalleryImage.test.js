import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import sharp from 'sharp';
import { makePathsProxy } from '../../lib/mockPathsDataRoot.js';

// The PNG 8-byte signature — used to assert a written gallery file is a PNG
// without importing from the (mocked) fileUtils module.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = (buf) => buf.subarray(0, 8).equals(PNG_SIGNATURE);

// Redirect PATHS.images at a per-test temp dir so saving an uploaded image
// writes into the temp gallery, not the repo's real data/images.
let imagesDir;
vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return makePathsProxy(actual, {
    dataRoot: () => imagesDir, // unused root; images override below is what matters
    extraOverrides: () => ({ images: imagesDir }),
  });
});

// local.js imports pythonSetup at load; stub it so the module loads without
// resolving a real venv (mirrors local.test.js).
vi.mock('../../lib/pythonSetup.js', () => ({
  resolveFlux2Python: () => null,
  FLUX2_VENV_DEFAULT: '/fake/home/.portos/venv-flux2/bin/python3',
}));

let tmpRoot;
let priorRegistryEnv;
let saveUploadedGalleryImage;

// A real 1x1 GIF89a (sharp can decode it). Real PNG/JPEG are built in beforeAll.
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
let realPng;
let realJpeg;

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'portos-gallery-upload-test-'));
  imagesDir = join(tmpRoot, 'images');
  priorRegistryEnv = process.env.PORTOS_MEDIA_MODELS_FILE;
  process.env.PORTOS_MEDIA_MODELS_FILE = join(tmpRoot, 'media-models.json');
  realPng = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
  realJpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 40, g: 50, b: 60 } } }).jpeg().toBuffer();
  vi.resetModules();
  ({ saveUploadedGalleryImage } = await import('./local.js'));
});

afterAll(() => {
  if (priorRegistryEnv === undefined) delete process.env.PORTOS_MEDIA_MODELS_FILE;
  else process.env.PORTOS_MEDIA_MODELS_FILE = priorRegistryEnv;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('saveUploadedGalleryImage', () => {
  it('writes a PNG into the gallery and returns a /data/images path', async () => {
    const { filename, path } = await saveUploadedGalleryImage(realPng.toString('base64'));
    expect(filename).toMatch(/^upload-[0-9a-f]{8}\.png$/);
    expect(path).toBe(`/data/images/${filename}`);
    expect(existsSync(join(imagesDir, filename))).toBe(true);
    // Written file is a valid PNG (so the gallery's PNG-only list/delete manage it).
    expect(isPng(readFileSync(join(imagesDir, filename)))).toBe(true);
  });

  it('normalizes a non-PNG upload (GIF/JPEG) to a managed .png gallery file', async () => {
    for (const src of [GIF, realJpeg]) {
      const { filename } = await saveUploadedGalleryImage(src.toString('base64'));
      expect(filename.endsWith('.png')).toBe(true);
      expect(isPng(readFileSync(join(imagesDir, filename)))).toBe(true);
    }
  });

  it('rejects an empty upload with a 400', async () => {
    await expect(saveUploadedGalleryImage('')).rejects.toMatchObject({ status: 400 });
  });

  it('rejects non-image bytes with a 400', async () => {
    await expect(
      saveUploadedGalleryImage(Buffer.from('definitely not an image').toString('base64')),
    ).rejects.toMatchObject({ status: 400, code: 'UNSUPPORTED_IMAGE' });
  });

  it('rejects an oversized upload with a 400', async () => {
    // 17MB of zero bytes — over the 16MB ceiling, and not a valid image header.
    const huge = Buffer.alloc(17 * 1024 * 1024).toString('base64');
    await expect(saveUploadedGalleryImage(huge)).rejects.toMatchObject({ status: 400, code: 'FILE_TOO_LARGE' });
  });
});
