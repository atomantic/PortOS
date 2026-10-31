import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_ROOT = join(tmpdir(), `portos-inputimages-test-${process.pid}-${Date.now()}`);
const FAKE_IMAGES_DIR = join(TEST_ROOT, 'data-images');
vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  actual.PATHS.images = FAKE_IMAGES_DIR;
  return actual;
});

const { resolveInputImages } = await import('./inputImages.js');
const { IMAGE_GEN_MODE } = await import('./modes.js');
const { maxInputImages } = await import('./cloudProviderConfig.js');

const stage = async (...names) => {
  await mkdir(FAKE_IMAGES_DIR, { recursive: true });
  for (const name of names) await writeFile(join(FAKE_IMAGES_DIR, name), 'fake');
};
const abs = (name) => join(FAKE_IMAGES_DIR, name);

beforeEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  await mkdir(TEST_ROOT, { recursive: true });
});
afterEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe('resolveInputImages', () => {
  it('orders the init image first and re-anchors every path to an approved root', async () => {
    await stage('init.png', 'ref-a.png', 'ref-b.png');
    const out = resolveInputImages({
      mode: IMAGE_GEN_MODE.CODEX,
      initImagePath: 'init.png',
      referenceImagePaths: ['ref-a.png', 'ref-b.png'],
    });
    expect(out.paths).toEqual([abs('init.png'), abs('ref-a.png'), abs('ref-b.png')]);
    expect(out.initPath).toBe(abs('init.png'));
    expect(out.referencePaths).toEqual([abs('ref-a.png'), abs('ref-b.png')]);
  });

  it('reports references without an init image as references, not a source image', async () => {
    await stage('ref-a.png');
    const out = resolveInputImages({
      mode: IMAGE_GEN_MODE.GROK,
      referenceImagePaths: ['ref-a.png'],
    });
    expect(out.initPath).toBeNull();
    expect(out.referencePaths).toEqual([abs('ref-a.png')]);
  });

  it('caps at the per-backend limit, dropping from the tail', async () => {
    await stage('init.png', 'a.png', 'b.png', 'c.png', 'd.png');
    const out = resolveInputImages({
      mode: IMAGE_GEN_MODE.AGY,
      initImagePath: 'init.png',
      referenceImagePaths: ['a.png', 'b.png', 'c.png', 'd.png'],
    });
    expect(maxInputImages(IMAGE_GEN_MODE.AGY)).toBe(3);
    expect(out.paths).toEqual([abs('init.png'), abs('a.png'), abs('b.png')]);
  });

  it('keeps every image for a backend whose tool declares no cap', async () => {
    // grok carries `maxInputImages: null`. The route's own
    // MAX_REFERENCE_IMAGES is what bounds them, so this resolver must not
    // invent a ceiling — a null cap that fell through to 0 would silently
    // strip every reference from a grok render.
    await stage('init.png', 'a.png', 'b.png', 'c.png', 'd.png');
    expect(maxInputImages(IMAGE_GEN_MODE.GROK)).toBeNull();
    const out = resolveInputImages({
      mode: IMAGE_GEN_MODE.GROK,
      initImagePath: 'init.png',
      referenceImagePaths: ['a.png', 'b.png', 'c.png', 'd.png'],
    });
    expect(out.paths).toEqual([abs('init.png'), abs('a.png'), abs('b.png'), abs('c.png'), abs('d.png')]);
    expect(out.referencePaths).toHaveLength(4);
  });

  it('refuses a missing or disallowed input instead of turning an edit into text-only', () => {
    expect(() => resolveInputImages({ mode: IMAGE_GEN_MODE.CODEX, initImagePath: '/etc/passwd' }))
      .toThrow(/input image is unavailable/);
    expect(() => resolveInputImages({ mode: IMAGE_GEN_MODE.CODEX, referenceImagePaths: ['missing.png'] }))
      .toThrow(/input image is unavailable/);
  });

  it('returns an empty list for a render with no input images', () => {
    const out = resolveInputImages({ mode: IMAGE_GEN_MODE.CODEX });
    expect(out.paths).toEqual([]);
    expect(out.referencePaths).toEqual([]);
  });

  it('leaves an unknown mode uncapped rather than truncating it to nothing', async () => {
    await stage('a.png', 'b.png');
    const out = resolveInputImages({
      mode: 'not-a-backend',
      referenceImagePaths: ['a.png', 'b.png'],
    });
    expect(out.paths).toHaveLength(2);
  });
});
