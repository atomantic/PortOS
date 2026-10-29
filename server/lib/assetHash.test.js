import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from './mockPathsDataRoot.js';

// The positive sha256-compute / cache / invalidate cases need the sidecar
// resolver to hit a REAL callsite — i.e. a path it derives from `PATHS.images`
// itself, not one the test hands it. They used to get that by writing fixtures
// into the install's live `data/images`, which is the write-leak class #6176
// closed at runtime: a stray failure between the write and the try/finally
// cleanup left `portos-assethash-test-*` fixtures in the user's image library.
// Redirecting the data root keeps the callsite exactly as honest — the helper
// still resolves through `PATHS.images` — while pointing it somewhere
// disposable.
let hashGate = null; // () => Promise — awaited inside sha256File to hold the hash "between read and write"
vi.mock('./fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  const proxy = makePathsProxy(actual, { dataRoot: () => lazyTempDataRoot('portos-assethash-') });
  return new Proxy(proxy, {
    get(target, prop) {
      if (prop === 'sha256File') {
        return async (...args) => {
          const gate = hashGate;
          hashGate = null;
          if (gate) await gate();
          return actual.sha256File(...args);
        };
      }
      return target[prop];
    },
  });
});
afterAll(cleanupTempDataRoots);

const { sidecarPathForImage, getOrComputeImageSha256, sidecarGenParamsHash, sidecarMatchesGenParamsHash } = await import('./assetHash.js');

let imageDir;

beforeEach(async () => {
  imageDir = join(tmpdir(), `portos-assethash-${Date.now()}-${Math.random()}`);
  await mkdir(imageDir, { recursive: true });
});

afterEach(async () => {
  await rm(imageDir, { recursive: true, force: true });
});

const { PATHS } = await import('./fileUtils.js');

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
      // A name under the (redirected) PATHS.images dir, so the sidecar write
      // hits a path the helper derived rather than one the test supplied.
      const token = `portos-assethash-test-${Date.now()}-${Math.random()}.png`;
      const imagePath = join(PATHS.images, token);
      const sidecarPath = sidecarPathForImage(imagePath);
      try {
        await mkdir(dirname(imagePath), { recursive: true });
        await writeFile(imagePath, Buffer.from('hello world'));
        await writeFile(sidecarPath, JSON.stringify({ prompt: 'p' }));
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
        // try/finally so a thrown assertion above doesn't leave the fixture
        // behind for the sibling cases that enumerate PATHS.images.
        await rm(imagePath, { force: true });
        await rm(sidecarPath, { force: true });
      }
    });

    it('keeps a concurrent sidecar edit made while the hash is being computed', async () => {
      const token = `portos-assethash-test-${Date.now()}-${Math.random()}.png`;
      const imagePath = join(PATHS.images, token);
      const sidecarPath = sidecarPathForImage(imagePath);
      try {
        await mkdir(dirname(imagePath), { recursive: true });
        await writeFile(imagePath, Buffer.from('racing'));
        await writeFile(sidecarPath, JSON.stringify({ prompt: 'p', hidden: false }));
        let release;
        hashGate = () => new Promise((r) => { release = r; });
        const pending = getOrComputeImageSha256(imagePath);
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        const { setImageHidden } = await import('../services/imageGen/local.js');
        await setImageHidden(token, true);
        release();
        const result = await pending;
        const onDisk = JSON.parse(await readFile(sidecarPath, 'utf8'));
        expect(onDisk.hidden).toBe(true);
        expect(onDisk.sha256.value).toBe(result.hash);
        expect(result.sidecar.hidden).toBe(true);
      } finally {
        hashGate = null;
        await rm(imagePath, { force: true });
        await rm(sidecarPath, { force: true });
      }
    });

    it('does not create a sidecar just to cache the hash', async () => {
      const token = `portos-assethash-test-${Date.now()}-${Math.random()}.png`;
      const imagePath = join(PATHS.images, token);
      const sidecarPath = sidecarPathForImage(imagePath);
      try {
        await mkdir(dirname(imagePath), { recursive: true });
        await writeFile(imagePath, Buffer.from('bare'));
        const result = await getOrComputeImageSha256(imagePath);
        expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
        await expect(readFile(sidecarPath, 'utf8')).rejects.toThrow(/ENOENT/);
      } finally {
        await rm(imagePath, { force: true });
      }
    });

    it('reuses cached sha256 on second call (no recompute)', async () => {
      const token = `portos-assethash-test-${Date.now()}-${Math.random()}.png`;
      const imagePath = join(PATHS.images, token);
      const sidecarPath = sidecarPathForImage(imagePath);
      try {
        await mkdir(dirname(imagePath), { recursive: true });
        await writeFile(imagePath, Buffer.from('one'));
        await writeFile(sidecarPath, JSON.stringify({ prompt: 'p' }));
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
        await writeFile(sidecarPath, JSON.stringify({ prompt: 'p' }));
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

    it("keeps a sidecar's hash when it has no machine-local fields, and ignores them when it does", () => {
      // Pinned literal: a sidecar without the new fields must hash exactly as before them.
      expect(sidecarGenParamsHash({ prompt: 'a cat', model: 'flux' }))
        .toBe('dd5c5c8b0546483c663b3c28fafee51aab023e76e7bb4038fef0481209104747');
      const plain = sidecarGenParamsHash({ prompt: 'a cat', originInstanceId: 'inst-a' });
      expect(sidecarGenParamsHash({
        prompt: 'a cat', originInstanceId: 'inst-a',
        hidden: true, pendingDelete: { peerId: 'p', queuedAt: '2026-01-01T00:00:00.000Z' }, suppliedByInstanceId: 'inst-b',
      })).toBe(plain);
      // The origin syncs, so it is part of the hash.
      expect(sidecarGenParamsHash({ prompt: 'a cat' })).not.toBe(plain);
    });

    it("matches an older peer's hash that still counts its own hide flag", () => {
      const local = { prompt: 'a cat', hidden: false };
      const otherParams = sidecarGenParamsHash({ prompt: 'a cat', other: 1 });
      expect(sidecarMatchesGenParamsHash(local, sidecarGenParamsHash({ prompt: 'a cat' }))).toBe(true);
      for (const hidden of [true, false]) {
        // What an older peer advertises: the canonical hash with its `hidden` included.
        const advertised = createHash('sha256').update(JSON.stringify({ hidden, prompt: 'a cat' })).digest('hex');
        expect(sidecarMatchesGenParamsHash(local, advertised)).toBe(true);
      }
      expect(sidecarMatchesGenParamsHash(local, otherParams)).toBe(false);
    });

    it("matches a sender's copy that differs only by an origin this held copy never takes", () => {
      const local = { prompt: 'a cat' };
      const senders = sidecarGenParamsHash({ prompt: 'a cat', originInstanceId: 'sender-inst' });
      expect(sidecarMatchesGenParamsHash(local, senders)).toBe(false);
      expect(sidecarMatchesGenParamsHash(local, senders, { originCandidates: ['sender-inst'] })).toBe(true);
      // A held copy that has its own origin keeps comparing strictly.
      expect(sidecarMatchesGenParamsHash({ ...local, originInstanceId: 'other-inst' }, senders, { originCandidates: ['sender-inst'] })).toBe(false);
      // Any other difference still re-pulls.
      expect(sidecarMatchesGenParamsHash({ prompt: 'a dog' }, senders, { originCandidates: ['sender-inst'] })).toBe(false);
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
