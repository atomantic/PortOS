/**
 * listSpriteAssets image-metadata enrichment (#2930 phase 2). The asset
 * inspector needs dimensions/format/frame count per asset, and the listing
 * must degrade — never throw — for non-images and unreadable files. Lives in
 * its own file because paths.test.js is deliberately dependency-free (no
 * PATHS mock) and this suite needs a real tmpdir sprite tree.
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import sharp from 'sharp';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'sprite-paths-assets-'));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  Object.assign(actual.PATHS, { data: TEST_ROOT, sprites: join(TEST_ROOT, 'sprites') });
  return actual;
});

const { listSpriteAssets } = await import('./paths.js');

afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

const RECORD = 'meta-probe';
const recDir = join(TEST_ROOT, 'sprites', RECORD);

const byPath = (assets) => Object.fromEntries(assets.map((a) => [a.path, a]));

describe('listSpriteAssets image metadata', () => {
  it('reports dimensions/format/frameCount for readable images and degrades for the rest', async () => {
    await mkdir(join(recDir, 'reference'), { recursive: true });
    await sharp({
      create: { width: 48, height: 32, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).png().toFile(join(recDir, 'reference', 'main.png'));
    // A truncated PNG: right extension, unparseable bytes.
    await writeFile(join(recDir, 'reference', 'corrupt.png'), 'not actually a png');
    // A non-image sibling — never probed at all.
    await writeFile(join(recDir, 'reference', 'main.generation.json'), '{}');

    const assets = byPath(await listSpriteAssets(RECORD));

    expect(assets['reference/main.png']).toMatchObject({
      width: 48, height: 32, format: 'png', frameCount: 1,
    });
    expect(assets['reference/main.png'].size).toBeGreaterThan(0);

    // Both degrade to the base shape with no dimensions — but they must stay
    // DISTINGUISHABLE: "sharp tried and failed" carries imageError, "never an
    // image" carries nothing. The inspector words the two differently.
    for (const p of ['reference/corrupt.png', 'reference/main.generation.json']) {
      expect(assets[p]).toHaveProperty('size');
      expect(assets[p]).toHaveProperty('mtime');
      expect(assets[p]).not.toHaveProperty('width');
      expect(assets[p]).not.toHaveProperty('format');
    }
    expect(assets['reference/corrupt.png'].imageError).toBe(true);
    expect(assets['reference/main.generation.json']).not.toHaveProperty('imageError');
  });

  it('reuses the cached probe until the file changes on disk', async () => {
    const spinner = join(recDir, 'reference', 'cached.png');
    await sharp({
      create: { width: 4, height: 4, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).png().toFile(spinner);
    expect(byPath(await listSpriteAssets(RECORD))['reference/cached.png'].width).toBe(4);

    // Rewrite at a different size — mtime AND size both move, so the cache key
    // changes and the new dimensions must be picked up rather than served stale.
    await sharp({
      create: { width: 16, height: 16, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).png().toFile(spinner);
    expect(byPath(await listSpriteAssets(RECORD))['reference/cached.png'].width).toBe(16);
  });

  it('counts pages for an animated image', async () => {
    const gifDir = join(recDir, 'walk');
    await mkdir(gifDir, { recursive: true });
    // Hand-assembled 1x1 two-frame GIF89a. Trim GIFs are encoded by ffmpeg in
    // production (walkTrims.js), and sharp's own gif writer collapses a
    // pageHeight input to a single page — so a literal is the only way to get
    // a real multi-page fixture without shelling out to ffmpeg in a unit test.
    const header = '474946383961' // "GIF89a"
      + '0100' + '0100'            // 1x1 logical screen
      + '800000'                   // global colour table, 2 entries
      + '000000' + 'ffffff';       // black, white
    const frame = '21f904000a000000'                 // graphic control ext, 100ms
      + '2c00000000010001000002024401' + '00';       // 1x1 image descriptor + LZW block
    const gif = Buffer.from(`${header}${frame}${frame}3b`, 'hex');
    await writeFile(join(gifDir, 'loop.gif'), gif);

    const assets = byPath(await listSpriteAssets(RECORD));
    expect(assets['walk/loop.gif'].format).toBe('gif');
    expect(assets['walk/loop.gif'].frameCount).toBe(2);
  });
});
