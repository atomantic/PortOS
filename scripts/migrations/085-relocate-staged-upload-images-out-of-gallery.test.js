import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './085-relocate-staged-upload-images-out-of-gallery.js';

describe('migration 085 — relocate staged-upload images out of gallery', () => {
  let rootDir;
  let imagesDir;
  let refsDir;

  const write = (dir, name, body = 'x') => writeFileSync(join(dir, name), body);

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-085-'));
    imagesDir = join(rootDir, 'data', 'images');
    refsDir = join(rootDir, 'data', 'image-refs');
    mkdirSync(imagesDir, { recursive: true });
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('moves sidecar-less init-/ref- uploads into image-refs', async () => {
    write(imagesDir, 'init-299d377d-0f13-465c-9e3c-a91860836416.png');
    write(imagesDir, 'ref-2ccd8f2f-f781-4626-a4af-b6da3b4a27da.jpg');

    const res = await migration.up({ rootDir });
    expect(res).toMatchObject({ ok: true, reason: 'relocated', moved: 2 });

    expect(existsSync(join(imagesDir, 'init-299d377d-0f13-465c-9e3c-a91860836416.png'))).toBe(false);
    expect(existsSync(join(refsDir, 'init-299d377d-0f13-465c-9e3c-a91860836416.png'))).toBe(true);
    expect(existsSync(join(refsDir, 'ref-2ccd8f2f-f781-4626-a4af-b6da3b4a27da.jpg'))).toBe(true);
  });

  it('leaves real generated gallery images untouched', async () => {
    write(imagesDir, 'job-abc.png');
    write(imagesDir, 'job-abc.metadata.json', '{}');

    const res = await migration.up({ rootDir });
    expect(res.reason).toBe('none');
    expect(existsSync(join(imagesDir, 'job-abc.png'))).toBe(true);
  });

  it('keeps a prefixed file that has a sidecar (user-imported as a real entry)', async () => {
    write(imagesDir, 'init-deadbeef-0000.png');
    write(imagesDir, 'init-deadbeef-0000.metadata.json', '{}');

    const res = await migration.up({ rootDir });
    expect(res).toMatchObject({ moved: 0, skippedSidecar: 1 });
    expect(existsSync(join(imagesDir, 'init-deadbeef-0000.png'))).toBe(true);
    expect(existsSync(join(refsDir, 'init-deadbeef-0000.png'))).toBe(false);
  });

  it('also recognizes the alternate <name>.metadata.json sidecar shape', async () => {
    write(imagesDir, 'ref-cafe-1111.png');
    write(imagesDir, 'ref-cafe-1111.png.metadata.json', '{}');

    const res = await migration.up({ rootDir });
    expect(res.skippedSidecar).toBe(1);
    expect(existsSync(join(imagesDir, 'ref-cafe-1111.png'))).toBe(true);
  });

  it('never clobbers an existing refs file with the same name', async () => {
    mkdirSync(refsDir, { recursive: true });
    write(imagesDir, 'init-c0111510.png', 'gallery-copy');
    write(refsDir, 'init-c0111510.png', 'refs-copy');

    const res = await migration.up({ rootDir });
    expect(res).toMatchObject({ moved: 0, skippedCollision: 1 });
    // Both copies survive; the refs original is not overwritten.
    expect(existsSync(join(imagesDir, 'init-c0111510.png'))).toBe(true);
    expect(existsSync(join(refsDir, 'init-c0111510.png'))).toBe(true);
  });

  it('is idempotent — a second run is a no-op', async () => {
    write(imagesDir, 'init-abcd-2222.png');
    const first = await migration.up({ rootDir });
    expect(first).toMatchObject({ moved: 1 });
    const second = await migration.up({ rootDir });
    expect(second.reason).toBe('none');
  });

  it('no-op on a fresh install with no images dir', async () => {
    rmSync(imagesDir, { recursive: true, force: true });
    const res = await migration.up({ rootDir });
    expect(res.reason).toBe('no-images-dir');
  });
});
