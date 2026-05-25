import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { sidecarPathForImage, getOrComputeImageSha256, sidecarGenParamsHash } from './assetHash.js';

// PATHS.images is resolved at module-load from fileUtils and we deliberately
// do NOT monkey-patch it — the absent-file tests use a tmpdir-rooted dir for
// negative cases, but the positive sha256-compute / cache / invalidate tests
// write fixtures into the REAL PATHS.images dir under a unique
// `portos-assethash-test-*` token so the sidecar resolver hits a real
// callsite. Each test wraps in try/finally to clean up the fixture even on
// assertion failure (see the body of each `it()` below).

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
      try {
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
      } finally {
        // try/finally so a thrown assertion above doesn't leave the
        // portos-assethash-test-* fixture in PATHS.images.
        await rm(imagePath, { force: true });
        await rm(sidecarPath, { force: true });
      }
    });

    it('reuses cached sha256 on second call (no recompute)', async () => {
      const token = `portos-assethash-test-${Date.now()}-${Math.random()}.png`;
      const imagePath = join(PATHS.images, token);
      const sidecarPath = sidecarPathForImage(imagePath);
      try {
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
      } finally {
        await rm(imagePath, { force: true });
        await rm(sidecarPath, { force: true });
      }
    });

    it('recomputes when file changes (mtime+size invalidate cache)', async () => {
      const token = `portos-assethash-test-${Date.now()}-${Math.random()}.png`;
      const imagePath = join(PATHS.images, token);
      const sidecarPath = sidecarPathForImage(imagePath);
      try {
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
      } finally {
        await rm(imagePath, { force: true });
        await rm(sidecarPath, { force: true });
      }
    });
  });

  describe('sidecarGenParamsHash', () => {
    it('returns null when the sidecar has no gen-params (only the sha256 cache)', () => {
      expect(sidecarGenParamsHash({ sha256: { value: 'a'.repeat(64), mtimeMs: 1, size: 2 } })).toBeNull();
      expect(sidecarGenParamsHash({})).toBeNull();
    });

    it('returns null for non-object inputs', () => {
      expect(sidecarGenParamsHash(null)).toBeNull();
      expect(sidecarGenParamsHash(undefined)).toBeNull();
      expect(sidecarGenParamsHash('x')).toBeNull();
      expect(sidecarGenParamsHash([1, 2])).toBeNull();
    });

    it('returns a hex64 hash when gen-params exist', () => {
      const h = sidecarGenParamsHash({ prompt: 'a cat', model: 'flux' });
      expect(h).toMatch(/^[a-f0-9]{64}$/);
    });

    it('CONVERGENCE: identical gen-params hash regardless of the sha256 cache block', () => {
      // The core fix: two machines with byte-identical gen-params but DIFFERENT
      // per-machine sha256 cache blocks (mtimeMs/size) must produce the SAME hash.
      const a = sidecarGenParamsHash({
        prompt: 'a wizard', model: 'flux', steps: 30,
        sha256: { value: 'a'.repeat(64), mtimeMs: 111, size: 222 },
      });
      const b = sidecarGenParamsHash({
        prompt: 'a wizard', model: 'flux', steps: 30,
        sha256: { value: 'b'.repeat(64), mtimeMs: 999, size: 888 },
      });
      expect(a).toBe(b);
    });

    it('CONVERGENCE: identical hash regardless of key order', () => {
      const a = sidecarGenParamsHash({ prompt: 'x', model: 'flux', steps: 30 });
      const b = sidecarGenParamsHash({ steps: 30, model: 'flux', prompt: 'x' });
      expect(a).toBe(b);
    });

    it('different gen-params produce different hashes', () => {
      const a = sidecarGenParamsHash({ prompt: 'a cat' });
      const b = sidecarGenParamsHash({ prompt: 'a dog' });
      expect(a).not.toBe(b);
    });

    it('SECURITY: a hostile __proto__/constructor/prototype key does not pollute Object.prototype', () => {
      // JSON.parse creates these as OWN keys; sidecarGenParamsHash must skip them
      // and never mutate any prototype. Build via JSON.parse so __proto__ is a
      // real own property (an object literal would invoke the proto setter).
      const hostile = JSON.parse('{"prompt":"x","__proto__":{"polluted":true},"constructor":{"y":1},"prototype":{"z":2}}');
      sidecarGenParamsHash(hostile);
      expect({}.polluted).toBeUndefined();
      expect(Object.prototype.polluted).toBeUndefined();
    });

    it('SECURITY: the hash ignores polluting keys (identical to a sidecar without them)', () => {
      const withPolluting = JSON.parse('{"prompt":"a wizard","model":"flux","__proto__":{"a":1},"constructor":{"b":2},"prototype":{"c":3}}');
      const clean = sidecarGenParamsHash({ prompt: 'a wizard', model: 'flux' });
      expect(sidecarGenParamsHash(withPolluting)).toBe(clean);
    });
  });
});
