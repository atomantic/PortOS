import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { openComposition } from '../htmlComposition/browser.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { applyFilmLookBake, FILM_LOOK_SCRATCH_DIR, readFilmLookSource } from './filmLookBake.js';
import { persistVariant } from './variants.js';

let root;
let images;
let removalError;
const fs = await vi.importActual('fs/promises');
vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    rm: (path, options) => removalError ? Promise.reject(removalError) : actual.rm(path, options),
  };
});
vi.mock('../../lib/fileUtils.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { get images() { return images; }, get data() { return root; } } };
});
vi.mock('./local.js', () => import('./localGallery.js'));
vi.mock('../../lib/maintenanceAdmission.js', () => ({ maintenance: { markCurrentUnsettled: vi.fn() } }));
vi.mock('../htmlComposition/browser.js', () => ({ openComposition: vi.fn() }));
vi.mock('./variants.js', () => ({ persistVariant: vi.fn() }));

const source = 'source.png';
const look = { grain: 0.5 };
const v2Look = { version: 2, vignette: 0.5 };

function writeSidecar(filename, metadata) {
  return writeFile(join(images, filename.replace(/\.png$/, '.metadata.json')), JSON.stringify(metadata));
}

function writeImage(filename, width = 4) {
  return sharp({ create: { width, height: 3, channels: 3, background: '#123456' } }).png().toFile(join(images, filename));
}

function scratchEntries() {
  return readdir(join(root, FILM_LOOK_SCRATCH_DIR));
}

const bake = options => applyFilmLookBake({ filename: source, sourceMeta: {}, look, ...options });

function fakeBrowser({ screenshotError, closeError, ownerUnsettled = false } = {}) {
  const page = {
    send: vi.fn(async method => {
      if (method !== 'Page.captureScreenshot') return {};
      if (screenshotError) throw screenshotError;
      return { data: Buffer.from('captured pixels').toString('base64') };
    }),
    evaluate: vi.fn(),
    check: vi.fn(),
    close: vi.fn(),
  };
  openComposition.mockImplementation(async (_directory, options) => {
    page.close.mockImplementation(async () => {
      if (ownerUnsettled) options.onOwnerCleanupFailure(closeError);
      if (closeError) throw closeError;
    });
    return page;
  });
  return page;
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  removalError = null;
  root = await mkdtemp(join(tmpdir(), 'film-look-bake-'));
  images = join(root, 'images');
  await mkdir(images);
  await writeImage(source);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('readFilmLookSource', () => {
  it('rejects cyclic film lineage', async () => {
    await writeSidecar('first.png', { filmLookFrom: 'second.png' });
    await writeSidecar('second.png', { filmLookFrom: 'first.png' });

    await expect(readFilmLookSource('first.png')).rejects.toMatchObject({ code: 'FILM_LOOK_LINEAGE', message: expect.stringContaining('cycle') });
  });

  it('rejects a lineage that reaches its original after the depth limit', async () => {
    await Promise.all(Array.from({ length: 32 }, (_, index) =>
      writeSidecar(`grade-${index}.png`, { filmLookFrom: index === 31 ? source : `grade-${index + 1}.png` })));

    await expect(readFilmLookSource('grade-0.png')).rejects.toMatchObject({ code: 'FILM_LOOK_LINEAGE', message: expect.stringContaining('too deep') });
  });

  it.each([{ regenerated: true }, { watermarkRemoved: true }, { cleanLevel: 1 }])('refuses a grade with an intervening edit %j', async edit => {
    await writeSidecar('graded.png', { filmLookFrom: source, ...edit });

    await expect(readFilmLookSource('graded.png')).rejects.toMatchObject({ code: 'FILM_LOOK_INTERVENING_EDIT' });
  });
});

describe('applyFilmLookBake', () => {
  it.each([
    [{ look: { preset: 'none' } }, 'FILM_LOOK_NEUTRAL'],
    [{ filename: 'still.bmp' }, 'FILM_LOOK_SOURCE_TYPE'],
    [{ filename: 'missing.png' }, 'NOT_FOUND'],
    [{ filename: 'corrupt.png' }, 'INVALID_IMAGE'],
    [{ filename: 'oversize.png' }, 'FILM_LOOK_TOO_LARGE'],
  ])('rejects invalid input before opening the browser (%j)', async (options, code) => {
    await writeFile(join(images, 'corrupt.png'), 'not a PNG');
    await writeImage('oversize.png', 4097);

    await expect(bake(options)).rejects.toMatchObject({ code });
    expect(openComposition).not.toHaveBeenCalled();
  });

  it('rebakes a v2 grade from the ungraded edit and publishes the rendered variant after verified close', async () => {
    await writeSidecar('v2.png', { filmLookFrom: 'v1.png', filmLook: v2Look });
    await writeSidecar('v1.png', { filmLookFrom: source, filmLook: look });
    await writeSidecar(source, { cleanedFrom: 'original.png', cleanLevel: 1, prompt: 'Example still' });
    const page = fakeBrowser();
    const original = await readFile(join(images, source));
    persistVariant.mockImplementation(async () => {
      expect(await scratchEntries()).toEqual([]);
      return { filename: 'variant.png' };
    });

    await expect(bake({ filename: 'v2.png', sourceMeta: { filmLookFrom: 'v1.png' }, look: v2Look })).resolves.toEqual({ filename: 'variant.png' });
    expect(page.close).toHaveBeenCalledExactlyOnceWith({ verify: true });
    expect(page.send).toHaveBeenCalledWith('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    expect(persistVariant).toHaveBeenCalledWith(expect.objectContaining({
      sourceFilename: source,
      data: Buffer.from('captured pixels'),
      width: 4,
      height: 3,
      variantMeta: expect.objectContaining({ filmLookFrom: source, cleanedFrom: 'original.png', prompt: 'Example still' }),
    }));
    expect(await readFile(join(images, source))).toEqual(original);
  });

  it.each([false, true])('preserves the screenshot failure when close rejects (owner unsettled: %s)', async ownerUnsettled => {
    const screenshotError = new Error('Screenshot failed');
    const page = fakeBrowser({ screenshotError, closeError: new Error('Close failed'), ownerUnsettled });
    const onCleanupFailure = vi.fn();

    await expect(bake({ onCleanupFailure })).rejects.toBe(screenshotError);

    expect(page.close).toHaveBeenCalledExactlyOnceWith({ verify: false });
    expect(await scratchEntries()).toHaveLength(Number(ownerUnsettled));
    expect(onCleanupFailure).toHaveBeenCalledTimes(Number(ownerUnsettled));
    expect(maintenance.markCurrentUnsettled).toHaveBeenCalledTimes(Number(ownerUnsettled));
    expect(console.error).toHaveBeenCalledWith('❌ Film look browser close failed');
    expect(persistVariant).not.toHaveBeenCalled();
  });

  it('returns a close failure after successful rendering and removes scratch when shutdown settled', async () => {
    const closeError = new Error('Context disposal failed');
    fakeBrowser({ closeError });

    await expect(bake()).rejects.toBe(closeError);
    expect(await scratchEntries()).toEqual([]);
    expect(persistVariant).not.toHaveBeenCalled();
  });

  it('keeps the cancellation reason when closing an aborted page fails', async () => {
    const controller = new AbortController();
    const reason = new Error('Film look canceled');
    const page = fakeBrowser({ closeError: new Error('Close failed') });
    page.evaluate.mockImplementation(async () => { controller.abort(reason); });
    page.check.mockImplementation(() => controller.signal.throwIfAborted());

    await expect(bake({ signal: controller.signal })).rejects.toBe(reason);
    expect(await scratchEntries()).toEqual([]);
    expect(persistVariant).not.toHaveBeenCalled();
  });

  it.each([false, true])('reports scratch removal failure (screenshot failed: %s)', async screenshotFailed => {
    removalError = new Error('Scratch removal failed');
    const screenshotError = screenshotFailed ? new Error('Screenshot failed') : undefined;
    fakeBrowser({ screenshotError });
    const onCleanupFailure = vi.fn();

    await expect(bake({ onCleanupFailure })).rejects.toBe(screenshotError ?? removalError);
    expect(onCleanupFailure).toHaveBeenCalledOnce();
    expect(maintenance.markCurrentUnsettled).toHaveBeenCalledOnce();
    expect(await scratchEntries()).toHaveLength(1);
    expect(persistVariant).not.toHaveBeenCalled();
  });
});
