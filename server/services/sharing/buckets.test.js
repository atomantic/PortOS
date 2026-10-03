import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { vi } from 'vitest';
import { makePathsProxy } from '../../lib/mockPathsDataRoot.js';

let tempRoot;
let bucketTargetDir;

// Mock PATHS so the registry writes into a temp dir per test.
vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: () => tempRoot });
});

const buckets = await import('./buckets.js');

describe('sharing/buckets', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'portos-sharing-test-'));
    bucketTargetDir = mkdtempSync(join(tmpdir(), 'portos-sharing-bucket-'));
  });
  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    if (bucketTargetDir) rmSync(bucketTargetDir, { recursive: true, force: true });
  });

  it('listBuckets returns [] for fresh state', async () => {
    expect(await buckets.listBuckets()).toEqual([]);
  });

  it('createBucket lays out the canonical structure inside the target path', async () => {
    const b = await buckets.createBucket({ name: 'Test', path: bucketTargetDir });
    expect(b.id).toMatch(/^bkt-/);
    expect(b.name).toBe('Test');
    expect(b.path).toBe(bucketTargetDir);
    expect(b.mode).toBe('inbox');

    const fs = await import('fs');
    expect(fs.existsSync(join(bucketTargetDir, 'manifests'))).toBe(true);
    expect(fs.existsSync(join(bucketTargetDir, 'records', 'series'))).toBe(true);
    expect(fs.existsSync(join(bucketTargetDir, 'records', 'issues'))).toBe(true);
    expect(fs.existsSync(join(bucketTargetDir, 'records', 'universes'))).toBe(true);
    expect(fs.existsSync(join(bucketTargetDir, 'records', 'media'))).toBe(true);
    expect(fs.existsSync(join(bucketTargetDir, 'records', 'reviews'))).toBe(true);
    expect(fs.existsSync(join(bucketTargetDir, 'assets', 'images'))).toBe(true);
    expect(fs.existsSync(join(bucketTargetDir, 'assets', 'videos'))).toBe(true);
    expect(fs.existsSync(join(bucketTargetDir, 'assets', 'blobs'))).toBe(true);
    expect(fs.existsSync(join(bucketTargetDir, 'bucket.json'))).toBe(true);
  });

  it('createBucket rejects an unusable path', async () => {
    await expect(buckets.createBucket({ name: 'X', path: '/nonexistent/path/here' }))
      .rejects.toMatchObject({ code: buckets.ERR_PATH_UNUSABLE });
  });

  it('createBucket rejects duplicate paths', async () => {
    await buckets.createBucket({ name: 'A', path: bucketTargetDir });
    await expect(buckets.createBucket({ name: 'B', path: bucketTargetDir }))
      .rejects.toMatchObject({ code: buckets.ERR_VALIDATION });
  });

  it('createBucket accepts mode override', async () => {
    const b = await buckets.createBucket({ name: 'T', path: bucketTargetDir, mode: 'auto-merge' });
    expect(b.mode).toBe('auto-merge');
  });

  it('updateBucket patches name + mode but NOT path', async () => {
    const created = await buckets.createBucket({ name: 'A', path: bucketTargetDir });
    const updated = await buckets.updateBucket(created.id, { name: 'B', mode: 'auto-merge', path: '/other/path' });
    expect(updated.name).toBe('B');
    expect(updated.mode).toBe('auto-merge');
    expect(updated.path).toBe(bucketTargetDir); // path is immutable
  });

  it('deleteBucket removes from registry', async () => {
    const created = await buckets.createBucket({ name: 'A', path: bucketTargetDir });
    await buckets.deleteBucket(created.id);
    expect(await buckets.listBuckets()).toEqual([]);
  });

  it('getBucket throws for missing id', async () => {
    await expect(buckets.getBucket('does-not-exist'))
      .rejects.toMatchObject({ code: buckets.ERR_NOT_FOUND });
  });

  it('list is sorted alphabetically', async () => {
    const a = mkdtempSync(join(tmpdir(), 'b1-'));
    const b = mkdtempSync(join(tmpdir(), 'b2-'));
    try {
      await buckets.createBucket({ name: 'Zeta', path: a });
      await buckets.createBucket({ name: 'Alpha', path: b });
      const list = await buckets.listBuckets();
      expect(list.map((x) => x.name)).toEqual(['Alpha', 'Zeta']);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  describe('concurrent registry mutations', () => {
    const extraDirs = [];
    const mkDir = () => { const d = mkdtempSync(join(tmpdir(), 'portos-sharing-extra-')); extraDirs.push(d); return d; };
    afterEach(() => { while (extraDirs.length) rmSync(extraDirs.pop(), { recursive: true, force: true }); });

    it('keeps both registrations when two creates at different paths overlap', async () => {
      const [a, b] = await Promise.all([
        buckets.createBucket({ name: 'A', path: mkDir() }),
        buckets.createBucket({ name: 'B', path: mkDir() }),
      ]);
      const ids = (await buckets.listBuckets()).map((x) => x.id).sort();
      expect(ids).toEqual([a.id, b.id].sort());
    });

    it('admits only one bucket when the same path is registered concurrently', async () => {
      const results = await Promise.allSettled([
        buckets.createBucket({ name: 'A', path: bucketTargetDir }),
        buckets.createBucket({ name: 'B', path: bucketTargetDir }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(results.find((r) => r.status === 'rejected').reason.code).toBe(buckets.ERR_VALIDATION);
      expect(await buckets.listBuckets()).toHaveLength(1);
    });

    it('preserves updates to different buckets', async () => {
      const a = await buckets.createBucket({ name: 'A', path: mkDir() });
      const b = await buckets.createBucket({ name: 'B', path: mkDir() });
      await Promise.all([
        buckets.updateBucket(a.id, { name: 'A2' }),
        buckets.updateBucket(b.id, { mode: 'auto-merge' }),
      ]);
      const list = await buckets.listBuckets();
      expect(list.find((x) => x.id === a.id).name).toBe('A2');
      expect(list.find((x) => x.id === b.id).mode).toBe('auto-merge');
    });

    it('does not resurrect a bucket when a rename is queued ahead of its delete, and later renames report not-found', async () => {
      const created = await buckets.createBucket({ name: 'A', path: bucketTargetDir });
      const rename = buckets.updateBucket(created.id, { name: 'Renamed' });
      const remove = buckets.deleteBucket(created.id);
      const lateRename = buckets.updateBucket(created.id, { name: 'Late' });
      await expect(rename).resolves.toMatchObject({ name: 'Renamed' });
      await expect(remove).resolves.toEqual({ id: created.id });
      await expect(lateRename).rejects.toMatchObject({ code: buckets.ERR_NOT_FOUND });
      expect(await buckets.listBuckets()).toEqual([]);
    });

    it('a rejected mutation does not poison later queued work, and an unreadable registry is never overwritten', async () => {
      const failing = buckets.updateBucket('missing', { name: 'X' });
      const ok = buckets.createBucket({ name: 'A', path: bucketTargetDir });
      await expect(failing).rejects.toMatchObject({ code: buckets.ERR_NOT_FOUND });
      await expect(ok).resolves.toMatchObject({ name: 'A' });

      const registry = join(tempRoot, 'sharing', 'buckets.json');
      writeFileSync(registry, '{ not json');
      await expect(buckets.createBucket({ name: 'B', path: mkDir() })).rejects.toBeTruthy();
      expect(readFileSync(registry, 'utf8')).toBe('{ not json');
      writeFileSync(registry, JSON.stringify({ buckets: [] }));
      await expect(buckets.createBucket({ name: 'C', path: mkDir() })).resolves.toMatchObject({ name: 'C' });
    });
  });

  describe('bucketRecordsDir / bucketRecordPath', () => {
    it('joins the per-type records directory under the bucket path', () => {
      expect(buckets.bucketRecordsDir('/b', 'series')).toBe(join('/b', 'records', 'series'));
      expect(buckets.bucketRecordsDir('/b', 'reviews')).toBe(join('/b', 'records', 'reviews'));
    });

    it('joins the per-record file path under its type directory', () => {
      expect(buckets.bucketRecordPath('/b', 'series', 'ser-1')).toBe(join('/b', 'records', 'series', 'ser-1.json'));
      expect(buckets.bucketRecordPath('/b', 'media', 'abc')).toBe(join('/b', 'records', 'media', 'abc.json'));
    });

    it('nests inside the matching records directory', () => {
      expect(buckets.bucketRecordPath('/b', 'issues', 'iss-9'))
        .toBe(join(buckets.bucketRecordsDir('/b', 'issues'), 'iss-9.json'));
    });
  });

  describe('sanitizeAssetFilename', () => {
    it('returns the name for a safe bare basename', () => {
      expect(buckets.sanitizeAssetFilename('abc-123.png')).toBe('abc-123.png');
      // `..` inside a basename is legitimate (gallery validator permits it).
      expect(buckets.sanitizeAssetFilename('my..render.png')).toBe('my..render.png');
    });

    it('rejects path separators, parent-dir tokens, and non-basename values', () => {
      expect(buckets.sanitizeAssetFilename('../../etc/passwd')).toBeNull();
      expect(buckets.sanitizeAssetFilename('..\\windows\\system32')).toBeNull();
      expect(buckets.sanitizeAssetFilename('sub/dir/asset.png')).toBeNull();
      expect(buckets.sanitizeAssetFilename('/etc/hosts')).toBeNull();
      expect(buckets.sanitizeAssetFilename('.')).toBeNull();
      expect(buckets.sanitizeAssetFilename('..')).toBeNull();
    });

    it('rejects non-string and empty inputs', () => {
      expect(buckets.sanitizeAssetFilename('')).toBeNull();
      expect(buckets.sanitizeAssetFilename(null)).toBeNull();
      expect(buckets.sanitizeAssetFilename(undefined)).toBeNull();
      expect(buckets.sanitizeAssetFilename(42)).toBeNull();
    });
  });
});
