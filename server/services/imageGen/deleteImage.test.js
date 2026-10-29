/**
 * Gallery image delete → media-asset-index delete hook (#2738).
 *
 * deleteImage moves real files, so PATHS.images is redirected at a temp
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

// The native adapter moves into a fixture-owned bin, never the host Trash.
let trashError = null;
let tombstonesAtTrash = null;
vi.mock('../../lib/nativeTrash.js', () => ({ moveToNativeTrash: async paths => {
  const { readFile } = await vi.importActual('fs/promises');
  tombstonesAtTrash = await readFile(join(imagesDir, 'media-tombstones.json'), 'utf8').then(JSON.parse, () => null);
  if (trashError) throw trashError;
  const { rename, mkdir } = await vi.importActual('fs/promises');
  const bin = join(tmpRoot, 'trash');
  await mkdir(bin, { recursive: true });
  for (const path of paths) await rename(path, join(bin, path.split(/[\\/]/).pop()));
} }));

let tmpRoot;
let priorRegistryEnv;
let deleteImage;
let listMediaTombstones;

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'portos-gallery-delete-test-'));
  imagesDir = join(tmpRoot, 'images');
  priorRegistryEnv = process.env.PORTOS_MEDIA_MODELS_FILE;
  process.env.PORTOS_MEDIA_MODELS_FILE = join(tmpRoot, 'media-models.json');
  vi.resetModules();
  ({ deleteImage } = await import('./local.js'));
  ({ listMediaTombstones } = await import('../mediaTombstones.js'));
});

afterAll(() => {
  if (priorRegistryEnv === undefined) delete process.env.PORTOS_MEDIA_MODELS_FILE;
  else process.env.PORTOS_MEDIA_MODELS_FILE = priorRegistryEnv;
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  trashError = null;
  tombstonesAtTrash = null;
  rmSync(join(tmpRoot, 'trash'), { recursive: true, force: true });
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
    const thumbnail = join(imagesDir, 'image-thumbnails', 'img-1.webp');
    mkdirSync(join(imagesDir, 'image-thumbnails'), { recursive: true });
    writeFileSync(thumbnail, 'derived preview');
    const res = await deleteImage('img-1.png');

    expect(res).toEqual({ ok: true });
    expect(existsSync(join(imagesDir, 'img-1.png'))).toBe(false);
    expect(existsSync(thumbnail)).toBe(false);
    expect(existsSync(join(tmpRoot, 'trash', 'img-1.png'))).toBe(true);
    expect(existsSync(join(tmpRoot, 'trash', 'img-1.metadata.json'))).toBe(true);
    // The ref must be the gallery filename — the key the index wrote the row under.
    expect(unindexImage).toHaveBeenCalledWith('img-1.png');
    // The tombstone is durable before the files move, so a crash cannot lose the delete.
    expect(tombstonesAtTrash.image.map((t) => t.key)).toEqual(['img-1.png']);
    expect((await listMediaTombstones('image')).map((t) => t.key)).toEqual(['img-1.png']);
  });

  it('a delete applying a peer tombstone records nothing itself', async () => {
    seedImage('img-4.png');
    await deleteImage('img-4.png', { fromRemoteTombstone: true });
    expect(existsSync(join(imagesDir, 'img-4.png'))).toBe(false);
    expect(await listMediaTombstones('image')).toEqual([]);
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

  it('preserves the image, metadata and index when recycling fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    trashError = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    seedImage('img-3.png');
    await expect(deleteImage('img-3.png')).rejects.toMatchObject({ code: 'MEDIA_TRASH_FAILED' });
    expect(existsSync(join(imagesDir, 'img-3.png'))).toBe(true);
    expect(existsSync(join(imagesDir, 'img-3.metadata.json'))).toBe(true);
    expect(unindexImage).not.toHaveBeenCalled();
    // The tombstone recorded for the attempt is withdrawn with it.
    expect(await listMediaTombstones('image')).toEqual([]);
    errSpy.mockRestore();
  });
});
