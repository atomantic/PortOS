import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { sidecarPathForImage, getOrComputeImageSha256 } from './assetHash.js';

// PATHS.images is resolved at module-load from fileUtils. We monkey-patch it
// per-test by writing a tmpdir-rooted image and pointing the sidecar resolver
// at it via the same getOrComputeImageSha256 signature.

let imageDir;

beforeEach(async () => {
  imageDir = join(tmpdir(), `portos-assethash-${Date.now()}-${Math.random()}`);
  await mkdir(imageDir, { recursive: true });
});

afterEach(async () => {
  await rm(imageDir, { recursive: true, force: true });
});

// The helpers above use PATHS.images from fileUtils. Rather than monkey-patch
// that, we test the sidecar-key invariant directly with a controlled writePath
// that lives under PATHS.images (using a unique-name token so cleanup is
// scoped). This keeps the tests honest about real-world callsites.
//
// We re-import PATHS so each test resolves to the real images dir.
import { PATHS } from './fileUtils.js';

describe('assetHash', () => {
  describe('sidecarPathForImage', () => {
    it('replaces extension with .metadata.json under PATHS.images', () => {
      const p = sidecarPathForImage('abc-123.png');
      expect(p).toBe(join(PATHS.images, 'abc-123.metadata.json'));
    });

    it('handles absolute path inputs by taking basename', () => {
      expect(sidecarPathForImage('/some/where/abc.png')).toBe(
        join(PATHS.images, 'abc.metadata.json'),
      );
    });

    it('null for empty', () => {
      expect(sidecarPathForImage('')).toBeNull();
    });

    it('null for non-string inputs (total over all types — no TypeError crash)', () => {
      // Regression: without the type guard, basename(null) throws TypeError
      // and crashes the calling exporter / peer-sync pipeline.
      expect(sidecarPathForImage(null)).toBeNull();
      expect(sidecarPathForImage(undefined)).toBeNull();
      expect(sidecarPathForImage(42)).toBeNull();
      expect(sidecarPathForImage({})).toBeNull();
      expect(sidecarPathForImage([])).toBeNull();
    });
  });

  describe('getOrComputeImageSha256', () => {
    it('null for missing image', async () => {
      const result = await getOrComputeImageSha256(join(imageDir, 'nope.png'));
      expect(result).toBeNull();
    });

    it('computes + persists sha256 in sidecar on first call', async () => {
      // Use a name in the real PATHS.images dir so the sidecar write hits a
      // real location. Token makes cleanup easy.
      const token = `portos-assethash-test-${Date.now()}-${Math.random()}.png`;
      const imagePath = join(PATHS.images, token);
      const sidecarPath = sidecarPathForImage(imagePath);
      await mkdir(dirname(imagePath), { recursive: true });
      await writeFile(imagePath, Buffer.from('hello world'));
      const result = await getOrComputeImageSha256(imagePath);
      expect(result).not.toBeNull();
      // "hello world" sha256:
      expect(result.hash).toBe(
        'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
      );
      const sidecarJson = JSON.parse(await readFile(sidecarPath, 'utf8'));
      expect(sidecarJson.sha256.value).toBe(result.hash);
      expect(sidecarJson.sha256.size).toBe(11);
      // cleanup
      await rm(imagePath, { force: true });
      await rm(sidecarPath, { force: true });
    });

    it('reuses cached sha256 on second call (no recompute)', async () => {
      const token = `portos-assethash-test-${Date.now()}-${Math.random()}.png`;
      const imagePath = join(PATHS.images, token);
      const sidecarPath = sidecarPathForImage(imagePath);
      await mkdir(dirname(imagePath), { recursive: true });
      await writeFile(imagePath, Buffer.from('one'));
      const first = await getOrComputeImageSha256(imagePath);
      // Tamper with the sidecar to a known-wrong value but matching the size/mtime —
      // the helper should trust the cached entry (proves it's reading sidecar first).
      const tampered = JSON.parse(await readFile(sidecarPath, 'utf8'));
      const fakeHash = 'a'.repeat(64);
      tampered.sha256.value = fakeHash;
      await writeFile(sidecarPath, JSON.stringify(tampered));
      const second = await getOrComputeImageSha256(imagePath);
      expect(second.hash).toBe(fakeHash);
      expect(second.hash).not.toBe(first.hash);
      await rm(imagePath, { force: true });
      await rm(sidecarPath, { force: true });
    });

    it('recomputes when file changes (mtime+size invalidate cache)', async () => {
      const token = `portos-assethash-test-${Date.now()}-${Math.random()}.png`;
      const imagePath = join(PATHS.images, token);
      const sidecarPath = sidecarPathForImage(imagePath);
      await mkdir(dirname(imagePath), { recursive: true });
      await writeFile(imagePath, Buffer.from('one'));
      const first = await getOrComputeImageSha256(imagePath);
      // Ensure mtime advances on slow filesystems where atime granularity
      // could match — wait a tick before the rewrite.
      await new Promise((r) => setTimeout(r, 20));
      await writeFile(imagePath, Buffer.from('two-different-bytes'));
      const second = await getOrComputeImageSha256(imagePath);
      expect(second.hash).not.toBe(first.hash);
      // Sidecar reflects the new hash + size.
      const sidecarJson = JSON.parse(await readFile(sidecarPath, 'utf8'));
      expect(sidecarJson.sha256.value).toBe(second.hash);
      expect(sidecarJson.sha256.size).toBe(19);
      await rm(imagePath, { force: true });
      await rm(sidecarPath, { force: true });
    });
  });
});
