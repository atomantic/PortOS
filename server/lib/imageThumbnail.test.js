import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDataRoot, makePathsProxy } from './mockPathsDataRoot.js';

const tempRoot = createTempDataRoot('portos-image-thumbnails-');
const sharpCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('./fileUtils.js', async (original) => makePathsProxy(await original(), { dataRoot: tempRoot }));
vi.mock('sharp', async (original) => {
  const real = (await original()).default;
  const wrapped = (...args) => { sharpCalls.count += 1; return real(...args); };
  wrapped.cache = (...args) => real.cache(...args);
  return { default: wrapped };
});

const { default: sharp } = await import('sharp');
const { ensureImageThumbnail } = await import('./imageThumbnail.js');
afterAll(() => {
  sharp.cache({ files: 0 });
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
beforeEach(() => { sharpCalls.count = 0; });

async function source(name) {
  const dir = join(tempRoot, 'images');
  mkdirSync(dir, { recursive: true });
  const bytes = await sharp({ create: { width: 1024, height: 768, channels: 3, background: '#123456' } }).png().toBuffer();
  writeFileSync(join(dir, name), bytes);
}

describe('image thumbnails', () => {
  it('builds one derivative for concurrent requests and refreshes after a source edit', async () => {
    await source('example.png');
    sharpCalls.count = 0;
    expect(await Promise.all(Array.from({ length: 8 }, () => ensureImageThumbnail('example.webp'))))
      .toEqual(Array(8).fill(true));
    expect(sharpCalls.count).toBe(1);
    const target = join(tempRoot, 'image-thumbnails/example.webp');
    const info = await sharp(target).metadata();
    expect(info.format).toBe('webp');
    expect(info.width).toBe(683);
    // libvips may keep a metadata-read input file open in its cache. Release it
    // before testing a Windows rewrite of that same derivative.
    sharp.cache({ files: 0 });
    sharpCalls.count = 0;
    expect(await ensureImageThumbnail('example.webp')).toBe(true);
    expect(sharpCalls.count).toBe(0);
    const newer = new Date(statSync(target).mtimeMs + 2000);
    utimesSync(join(tempRoot, 'images/example.png'), newer, newer);
    expect(await ensureImageThumbnail('example.webp')).toBe(true);
    expect(sharpCalls.count).toBe(1);
  });

  it('refuses absent sources, paths, and non-image names', async () => {
    for (const name of ['missing.webp', '../example.webp', 'example.png', 'nested/example.webp', '.webp']) {
      expect(await ensureImageThumbnail(name)).toBe(false);
    }
    expect(sharpCalls.count).toBe(0);
  });
});
