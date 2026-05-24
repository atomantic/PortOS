import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
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
