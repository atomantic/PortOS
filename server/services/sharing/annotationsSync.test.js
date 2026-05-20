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

// Stub `assets/{images,videos}` readdir to return [] (legacy v1 fallback).
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual('fs/promises');
  return { ...actual, readdir: vi.fn(async () => []) };
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
