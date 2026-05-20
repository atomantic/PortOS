import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock store for atomicWrite + readJSONFile so we can inspect record writes.
const fileStore = new Map();
const writeCalls = [];

vi.mock('../../lib/fileUtils.js', () => ({
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn(async (path, data) => {
    fileStore.set(path, data);
    writeCalls.push({ path, data });
  }),
  readJSONFile: vi.fn(async (path, fallback) => (fileStore.has(path) ? fileStore.get(path) : fallback)),
  PATHS: { data: '/mock/data' },
}));

// Mock manifest module so we don't need real bucket directories.
const writeManifestMock = vi.fn(async (bucketPath, manifest) => `${manifest.kind}.manifest.json`);
vi.mock('./manifest.js', () => ({
  buildManifest: vi.fn((args) => ({ ...args })),
  writeManifest: writeManifestMock,
  readManifest: vi.fn(),
  listManifestFilenames: vi.fn(async () => []),
  annotationManifestFilename: vi.fn(),
}));

vi.mock('./version.js', () => ({ getProducedByVersion: vi.fn(async () => '1.0.0-test') }));

vi.mock('./buckets.js', () => ({
  listBuckets: vi.fn(async () => []),
}));

vi.mock('../instances.js', () => ({
  getInstanceId: vi.fn(async () => 'local-instance'),
  UNKNOWN_INSTANCE_ID: 'unknown',
}));

vi.mock('./annotationIdentity.js', () => ({
  // Honors `displayNameOverride`; mirrors the real helper's contract.
  resolveBucketSourceName: vi.fn(async (bucket) => bucket?.displayNameOverride || 'Global Name'),
}));

vi.mock('../mediaAnnotations.js', () => ({
  onLocalAnnotationChange: vi.fn(),
  listLocalAuthorAnnotations: vi.fn(async () => ({})),
}));

// Make existsSync return true for any assets dir so the legacy-v1 scan no-ops
// without touching the disk.
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return { ...actual, existsSync: vi.fn(() => false) };
});

// Stub `assets/{images,videos}` readdir to return [] (legacy v1 fallback) and
// `stat` so the manifests-dir mtime can be driven from individual tests (used
// by the cache hit/miss assertions). `vi.mock` factories are hoisted above
// top-level `const`s, so the shared `statMock` binding must come from
// `vi.hoisted` or the closure can fire before initialization.
const { statMock } = vi.hoisted(() => ({ statMock: vi.fn(async () => ({ mtimeMs: 1 })) }));
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual('fs/promises');
  return { ...actual, readdir: vi.fn(async () => []), stat: statMock };
});

const svc = await import('./annotationsSync.js');

function bucket({ id = 'bkt-1', name = 'B1', path = '/mock/bucket', mode = 'auto-merge', displayNameOverride = null } = {}) {
  return { id, name, path, mode, displayNameOverride };
}

describe('sharing/annotationsSync.exportAnnotationsToBucket', () => {
  beforeEach(() => {
    fileStore.clear();
    writeCalls.length = 0;
    writeManifestMock.mockClear();
    svc.__resetBucketAssetKeysCache();
    statMock.mockReset();
    statMock.mockResolvedValue({ mtimeMs: 1 });
  });

  async function stubBucketAssets(bucketPath, keys) {
    // Simulate the bucket containing `keys` (each `${kind}:${ref}`).
    const { listManifestFilenames, readManifest } = await import('./manifest.js');
    listManifestFilenames.mockResolvedValue(['mock.manifest.json']);
    readManifest.mockResolvedValue({
      assetRefs: keys.map((k) => {
        const [kind, ref] = k.split(':');
        return { kind, ref };
      }),
      collection: null,
    });
  }

  it('skips without scanning bucket assets when local has zero annotations and no prior record', async () => {
    // Common fan-out case for a fresh install: every set/clear hits every
    // auto-merge bucket. Most have no prior record and no local annotation
    // matching their assets — this branch keeps them off the slow path.
    const { listManifestFilenames } = await import('./manifest.js');
    listManifestFilenames.mockClear();
    const res = await svc.exportAnnotationsToBucket(bucket(), {}, 'local-instance');
    expect(res).toEqual({ skipped: true, reason: 'no-annotations-for-bucket' });
    expect(listManifestFilenames).not.toHaveBeenCalled();
  });

  it('skips when bucket has no assets', async () => {
    const { listManifestFilenames } = await import('./manifest.js');
    listManifestFilenames.mockResolvedValue([]);

    const res = await svc.exportAnnotationsToBucket(bucket(), { 'image:a.png': { starred: true, note: '', updatedAt: '2026-01-01T00:00:00.000Z' } }, 'local-instance');
    expect(res).toEqual({ skipped: true, reason: 'no-bucket-assets' });
    expect(writeManifestMock).not.toHaveBeenCalled();
  });

  it('skips when no annotations apply to bucket and nothing was previously written', async () => {
    await stubBucketAssets('/mock/bucket', ['image:other.png']);

    const res = await svc.exportAnnotationsToBucket(
      bucket(),
      { 'image:a.png': { starred: true, note: '', updatedAt: '2026-01-01T00:00:00.000Z' } },
      'local-instance',
    );
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe('no-annotations-for-bucket');
    expect(writeManifestMock).not.toHaveBeenCalled();
  });

  it('writes record + manifest when the bucket holds a matching asset', async () => {
    await stubBucketAssets('/mock/bucket', ['image:a.png']);

    const res = await svc.exportAnnotationsToBucket(
      bucket(),
      { 'image:a.png': { starred: true, note: 'hi', updatedAt: '2026-01-01T00:00:00.000Z' } },
      'local-instance',
    );
    expect(res.skipped).toBe(false);
    expect(res.entryCount).toBe(1);
    expect(writeManifestMock).toHaveBeenCalledTimes(1);
    const written = writeCalls[0].data;
    expect(written.annotations['image:a.png']).toMatchObject({ starred: true, note: 'hi' });
    expect(written.authorName).toBe('Global Name');
  });

  it('honors per-bucket displayNameOverride in both the written record AND the manifest envelope', async () => {
    await stubBucketAssets('/mock/bucket', ['image:a.png']);

    await svc.exportAnnotationsToBucket(
      bucket({ displayNameOverride: 'Per-Bucket Alias' }),
      { 'image:a.png': { starred: true, note: 'hi', updatedAt: '2026-01-01T00:00:00.000Z' } },
      'local-instance',
    );
    // Record's authorName carries the per-bucket alias.
    expect(writeCalls[0].data.authorName).toBe('Per-Bucket Alias');
    // Manifest envelope's `source` (the field consumed by peers when
    // attributing the bucket's authorship) carries the same alias — this is
    // the surface that previously regressed by stamping the global name.
    expect(writeManifestMock).toHaveBeenCalledTimes(1);
    const manifest = writeManifestMock.mock.calls[0][1];
    expect(manifest.source).toBe('Per-Bucket Alias');
    // producedByVersion must be a string, not an unawaited Promise.
    expect(typeof manifest.producedByVersion).toBe('string');
    expect(manifest.producedByVersion).toBe('1.0.0-test');
  });

  it('emits tombstones for keys that were previously published but no longer applicable', async () => {
    await stubBucketAssets('/mock/bucket', ['image:a.png', 'image:gone.png']);
    // Pre-seed a prior record where both keys had notes.
    fileStore.set('/mock/bucket/records/media-annotations/local-instance.json', {
      id: 'local-instance',
      instanceId: 'local-instance',
      authorName: 'Global Name',
      updatedAt: '2026-01-01T00:00:00.000Z',
      annotations: {
        'image:a.png': { starred: true, note: 'old', updatedAt: '2026-01-01T00:00:00.000Z' },
        'image:gone.png': { starred: true, note: 'will-tombstone', updatedAt: '2026-01-01T00:00:00.000Z' },
      },
    });

    // Local now only has `image:a.png`; `image:gone.png` should get tombstoned.
    const res = await svc.exportAnnotationsToBucket(
      bucket(),
      { 'image:a.png': { starred: true, note: 'still-here', updatedAt: '2026-02-01T00:00:00.000Z' } },
      'local-instance',
    );
    expect(res.skipped).toBe(false);
    const written = writeCalls[0].data;
    expect(written.annotations['image:a.png']).toMatchObject({ note: 'still-here' });
    expect(written.annotations['image:gone.png']).toMatchObject({ starred: false, note: '' });
  });

  it('skips inbox-mode buckets', async () => {
    const res = await svc.exportAnnotationsToBucket(
      bucket({ mode: 'inbox' }),
      { 'image:a.png': { starred: true, note: 'hi', updatedAt: '2026-01-01T00:00:00.000Z' } },
      'local-instance',
    );
    expect(res).toEqual({ skipped: true, reason: 'not-auto-merge' });
  });
});

describe('sharing/annotationsSync.listBucketAssetKeys cache', () => {
  beforeEach(() => {
    fileStore.clear();
    writeCalls.length = 0;
    writeManifestMock.mockClear();
    svc.__resetBucketAssetKeysCache();
    statMock.mockReset();
    statMock.mockResolvedValue({ mtimeMs: 100 });
  });

  it('reuses parsed manifests on the next flush when manifests-dir mtime is unchanged', async () => {
    const { listManifestFilenames, readManifest } = await import('./manifest.js');
    listManifestFilenames.mockClear();
    readManifest.mockClear();
    listManifestFilenames.mockResolvedValue(['a.manifest.json']);
    readManifest.mockResolvedValue({ assetRefs: [{ kind: 'image', ref: 'a.png' }], collection: null });

    const ann = { 'image:a.png': { starred: true, note: 'hi', updatedAt: '2026-01-01T00:00:00.000Z' } };
    await svc.exportAnnotationsToBucket(bucket(), ann, 'local-instance');
    await svc.exportAnnotationsToBucket(bucket(), ann, 'local-instance');
    await svc.exportAnnotationsToBucket(bucket(), ann, 'local-instance');

    // Three flushes — the manifests-dir mtime never moved, so the manifest
    // parse only ran on the first call. The other two are cache hits.
    expect(listManifestFilenames).toHaveBeenCalledTimes(1);
    expect(readManifest).toHaveBeenCalledTimes(1);
  });

  it('rolls the cached mtime forward after a successful annotation write so the next flush still hits', async () => {
    // exportAnnotationsToBucket calls writeManifest, which atomicWrite's
    // temp+rename bumps the manifests-dir mtime. Without the post-write
    // refresh, the very next flush against the same bucket misses the cache
    // and re-parses every other manifest — defeating the optimization in
    // the common "buckets I've actually written to" case.
    const { listManifestFilenames, readManifest } = await import('./manifest.js');
    listManifestFilenames.mockClear();
    readManifest.mockClear();
    listManifestFilenames.mockResolvedValue(['a.manifest.json']);
    readManifest.mockResolvedValue({ assetRefs: [{ kind: 'image', ref: 'a.png' }], collection: null });

    const ann = { 'image:a.png': { starred: true, note: 'hi', updatedAt: '2026-01-01T00:00:00.000Z' } };
    // First call: cache miss, populates entry, then writes manifest. Simulate
    // the post-write stat returning a NEW mtime (rename bumped it).
    statMock.mockResolvedValueOnce({ mtimeMs: 100 }); // pre-scan stat
    statMock.mockResolvedValueOnce({ mtimeMs: 200 }); // post-write stat
    const r1 = await svc.exportAnnotationsToBucket(bucket(), ann, 'local-instance');
    expect(r1.skipped).toBe(false);

    // Second call: cache lookup sees mtime 200 (rolled forward post-write)
    // and the live stat also returns 200 — cache hit, no re-parse.
    statMock.mockResolvedValueOnce({ mtimeMs: 200 });
    statMock.mockResolvedValueOnce({ mtimeMs: 300 }); // post-write of 2nd flush
    await svc.exportAnnotationsToBucket(bucket(), ann, 'local-instance');

    // Manifest parse only ran on the first flush — the post-write refresh
    // prevented a spurious invalidation between flushes.
    expect(listManifestFilenames).toHaveBeenCalledTimes(1);
  });

  it('invalidates when manifests-dir mtime advances (new/removed manifest)', async () => {
    const { listManifestFilenames, readManifest } = await import('./manifest.js');
    listManifestFilenames.mockClear();
    readManifest.mockClear();
    listManifestFilenames.mockResolvedValue(['a.manifest.json']);
    readManifest.mockResolvedValue({ assetRefs: [{ kind: 'image', ref: 'a.png' }], collection: null });

    const ann = { 'image:a.png': { starred: true, note: 'hi', updatedAt: '2026-01-01T00:00:00.000Z' } };
    await svc.exportAnnotationsToBucket(bucket(), ann, 'local-instance');
    // Bucket gains a new manifest — atomicWrite's temp+rename bumps the dir
    // mtime. The next flush must re-scan.
    statMock.mockResolvedValue({ mtimeMs: 200 });
    listManifestFilenames.mockResolvedValue(['a.manifest.json', 'b.manifest.json']);
    await svc.exportAnnotationsToBucket(bucket(), ann, 'local-instance');

    expect(listManifestFilenames).toHaveBeenCalledTimes(2);
    expect(readManifest).toHaveBeenCalledTimes(3); // 1 first call + 2 on re-scan
  });

  it('keeps separate cache entries per bucket path', async () => {
    const { listManifestFilenames, readManifest } = await import('./manifest.js');
    listManifestFilenames.mockClear();
    readManifest.mockClear();
    listManifestFilenames.mockResolvedValue(['a.manifest.json']);
    readManifest.mockResolvedValue({ assetRefs: [{ kind: 'image', ref: 'a.png' }], collection: null });

    const ann = { 'image:a.png': { starred: true, note: 'hi', updatedAt: '2026-01-01T00:00:00.000Z' } };
    await svc.exportAnnotationsToBucket(bucket({ path: '/mock/bucket-A' }), ann, 'local-instance');
    await svc.exportAnnotationsToBucket(bucket({ path: '/mock/bucket-B' }), ann, 'local-instance');
    await svc.exportAnnotationsToBucket(bucket({ path: '/mock/bucket-A' }), ann, 'local-instance');
    await svc.exportAnnotationsToBucket(bucket({ path: '/mock/bucket-B' }), ann, 'local-instance');

    // Two cache misses (one per bucket), two cache hits.
    expect(listManifestFilenames).toHaveBeenCalledTimes(2);
  });

  it('does not cache the legacy v1 assets-dir fallthrough across calls', async () => {
    // v1 buckets have no manifests at all — `listManifestFilenames` returns []
    // and the only key source is the assets/{images,videos} dir scan. That
    // scan must run every call so newly-dropped legacy files are picked up
    // without needing a manifest-dir mtime bump.
    const fs = await import('fs');
    const fsp = await import('fs/promises');
    const { listManifestFilenames } = await import('./manifest.js');
    listManifestFilenames.mockClear();
    listManifestFilenames.mockResolvedValue([]);
    fs.existsSync.mockReturnValue(true);
    fsp.readdir.mockClear();
    fsp.readdir.mockResolvedValueOnce(['a.png']).mockResolvedValueOnce([]);
    fsp.readdir.mockResolvedValueOnce(['a.png', 'b.png']).mockResolvedValueOnce([]);

    const ann = { 'image:a.png': { starred: true, note: 'hi', updatedAt: '2026-01-01T00:00:00.000Z' } };
    const r1 = await svc.exportAnnotationsToBucket(bucket(), ann, 'local-instance');
    const r2 = await svc.exportAnnotationsToBucket(bucket(), ann, 'local-instance');
    fs.existsSync.mockReturnValue(false);
    expect(r1.skipped).toBe(false);
    expect(r2.skipped).toBe(false);
    // Each call scans both image+video dirs (4 readdir calls total over 2
    // flushes). If the legacy scan were incorrectly cached this would be 2.
    expect(fsp.readdir).toHaveBeenCalledTimes(4);
  });

  it('skips caching when stat fails with a non-ENOENT error so the real fault stays observable', async () => {
    const { listManifestFilenames, readManifest } = await import('./manifest.js');
    const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    statMock.mockRejectedValue(eacces);
    listManifestFilenames.mockClear();
    readManifest.mockClear();
    listManifestFilenames.mockResolvedValue(['a.manifest.json']);
    readManifest.mockResolvedValue({ assetRefs: [{ kind: 'image', ref: 'a.png' }], collection: null });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const ann = { 'image:a.png': { starred: true, note: 'hi', updatedAt: '2026-01-01T00:00:00.000Z' } };
    await svc.exportAnnotationsToBucket(bucket(), ann, 'local-instance');
    await svc.exportAnnotationsToBucket(bucket(), ann, 'local-instance');

    // Both calls re-scan because EACCES poisons caching for this bucket.
    expect(listManifestFilenames).toHaveBeenCalledTimes(2);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('layers legacy v1 keys onto the manifest set without polluting the cache for the next call', async () => {
    // First call has v1 dirs populated → returned Set contains the v1 key.
    // Second call has v1 dirs empty → returned Set must NOT contain the v1
    // key. If the legacy fall-through had `.add()`d into the cached manifest
    // set instead of allocating a fresh union Set, the second call would
    // still see the stale v1 key. We probe this by feeding an annotation
    // that ONLY matches the v1 key: it should write on call 1 (legacy
    // present) and skip on call 2 (legacy gone, manifest set untouched).
    const fs = await import('fs');
    const fsp = await import('fs/promises');
    const { listManifestFilenames, readManifest } = await import('./manifest.js');
    listManifestFilenames.mockClear();
    readManifest.mockClear();
    listManifestFilenames.mockResolvedValue(['a.manifest.json']);
    readManifest.mockResolvedValue({ assetRefs: [{ kind: 'image', ref: 'a.png' }], collection: null });

    fs.existsSync.mockReturnValue(true);
    fsp.readdir.mockResolvedValueOnce(['rogue.png']).mockResolvedValueOnce([]);
    const ann = { 'image:rogue.png': { starred: true, note: 'hi', updatedAt: '2026-01-01T00:00:00.000Z' } };
    const r1 = await svc.exportAnnotationsToBucket(bucket(), ann, 'local-instance');
    expect(r1.skipped).toBe(false); // v1 fall-through provided the matching key

    // v1 dirs disappear (deleted between flushes); cached manifest set must
    // not have absorbed the v1 key on the prior call.
    fs.existsSync.mockReturnValue(false);
    fsp.readdir.mockResolvedValue([]);
    // Drop the prior record so the late-stage tombstone path doesn't write.
    fileStore.delete('/mock/bucket/records/media-annotations/local-instance.json');
    const r2 = await svc.exportAnnotationsToBucket(bucket(), ann, 'local-instance');
    expect(r2.skipped).toBe(true);
    expect(r2.reason).toBe('no-annotations-for-bucket');
    // Manifest parse stays cached across both calls — the mutation defense
    // does not compromise the hit rate.
    expect(listManifestFilenames).toHaveBeenCalledTimes(1);
  });

  it('treats an absent manifests dir as a stable cache key', async () => {
    // Brand-new bucket with no manifests/ dir yet — stat rejects with ENOENT.
    // We still want cache reuse so repeated flushes against the same empty
    // bucket don't keep re-running listManifestFilenames.
    const { listManifestFilenames, readManifest } = await import('./manifest.js');
    statMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    listManifestFilenames.mockClear();
    readManifest.mockClear();
    listManifestFilenames.mockResolvedValue([]);

    const ann = { 'image:a.png': { starred: true, note: 'hi', updatedAt: '2026-01-01T00:00:00.000Z' } };
    await svc.exportAnnotationsToBucket(bucket(), ann, 'local-instance');
    await svc.exportAnnotationsToBucket(bucket(), ann, 'local-instance');

    // listManifestFilenames runs once on the first call; second call hits the
    // cache even though the dir doesn't exist on disk.
    expect(listManifestFilenames).toHaveBeenCalledTimes(1);
  });
});
