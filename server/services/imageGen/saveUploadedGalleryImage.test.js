import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { makePathsProxy } from '../../lib/mockPathsDataRoot.js';

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

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00]);

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'portos-gallery-upload-test-'));
  imagesDir = join(tmpRoot, 'images');
  priorRegistryEnv = process.env.PORTOS_MEDIA_MODELS_FILE;
  process.env.PORTOS_MEDIA_MODELS_FILE = join(tmpRoot, 'media-models.json');
  vi.resetModules();
  ({ saveUploadedGalleryImage } = await import('./local.js'));
});

afterAll(() => {
  if (priorRegistryEnv === undefined) delete process.env.PORTOS_MEDIA_MODELS_FILE;
  else process.env.PORTOS_MEDIA_MODELS_FILE = priorRegistryEnv;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('saveUploadedGalleryImage', () => {
  it('writes PNG bytes into the gallery and returns a /data/images path', async () => {
    const { filename, path } = await saveUploadedGalleryImage(PNG.toString('base64'));
    expect(filename).toMatch(/^upload-[0-9a-f]{8}\.png$/);
    expect(path).toBe(`/data/images/${filename}`);
    expect(existsSync(join(imagesDir, filename))).toBe(true);
    expect(readFileSync(join(imagesDir, filename))).toEqual(PNG);
  });

  it('derives the extension from the real bytes, not a client filename', async () => {
    const { filename } = await saveUploadedGalleryImage(GIF.toString('base64'));
    expect(filename.endsWith('.gif')).toBe(true);
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
