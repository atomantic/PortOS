/**
 * Gallery image delete → media-asset-index delete hook (#2738).
 *
 * deleteImage unlinks real files, so PATHS.images is redirected at a temp
 * gallery (same pattern as saveUploadedGalleryImage.test.js) — this suite must
 * never touch the repo's real data/images. The index module is mocked: the
 * contract under test is the WIRING (the delete path calls the hook, with the
 * gallery filename, and survives a failing hook), not the SQL — db.test.js
 * covers the row/count side against a real table.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { makePathsProxy } from '../../lib/mockPathsDataRoot.js';

let imagesDir;
vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return makePathsProxy(actual, {
    dataRoot: () => imagesDir,
    extraOverrides: () => ({ images: imagesDir }),
  });
});

// local.js imports pythonSetup at load; stub it so the module loads without
// resolving a real venv (mirrors local.test.js).
vi.mock('../../lib/pythonSetup.js', () => ({
  resolveFlux2Python: () => null,
  FLUX2_VENV_DEFAULT: '/fake/home/.portos/venv-flux2/bin/python3',
}));

const unindexImage = vi.fn(async () => {});
vi.mock('../mediaAssetIndex/index.js', () => ({ unindexImage }));

let tmpRoot;
let priorRegistryEnv;
let deleteImage;

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'portos-gallery-delete-test-'));
  imagesDir = join(tmpRoot, 'images');
  priorRegistryEnv = process.env.PORTOS_MEDIA_MODELS_FILE;
  process.env.PORTOS_MEDIA_MODELS_FILE = join(tmpRoot, 'media-models.json');
  vi.resetModules();
  ({ deleteImage } = await import('./local.js'));
});

afterAll(() => {
  if (priorRegistryEnv === undefined) delete process.env.PORTOS_MEDIA_MODELS_FILE;
  else process.env.PORTOS_MEDIA_MODELS_FILE = priorRegistryEnv;
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  rmSync(imagesDir, { recursive: true, force: true });
});

// Seed a gallery image + its sidecar in the temp dir.
function seedImage(filename) {
  mkdirSync(imagesDir, { recursive: true });
  writeFileSync(join(imagesDir, filename), 'not-a-real-png');
  writeFileSync(join(imagesDir, filename.replace('.png', '.metadata.json')), JSON.stringify({ prompt: 'p' }));
}

describe('deleteImage → media asset index delete hook', () => {
  it('unindexes the deleted image by its gallery filename', async () => {
    seedImage('img-1.png');
    const res = await deleteImage('img-1.png');

    expect(res).toEqual({ ok: true });
    expect(existsSync(join(imagesDir, 'img-1.png'))).toBe(false);
    // The ref must be the gallery filename — the key the index wrote the row under.
    expect(unindexImage).toHaveBeenCalledWith('img-1.png');
  });

  it('is non-fatal: a failing index removal still deletes the file and returns ok', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    unindexImage.mockRejectedValueOnce(new Error('db down'));
    seedImage('img-2.png');

    // The file is already gone by the time the hook runs — a throwing index must
    // never turn a successful delete into a 500.
    await expect(deleteImage('img-2.png')).resolves.toEqual({ ok: true });
    expect(existsSync(join(imagesDir, 'img-2.png'))).toBe(false);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('db down'));
    errSpy.mockRestore();
  });
});
