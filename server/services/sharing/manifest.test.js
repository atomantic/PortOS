import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { vi } from 'vitest';
import { makePathsProxy } from '../../lib/mockPathsDataRoot.js';

let tempRoot;

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: () => tempRoot });
});

const manifest = await import('./manifest.js');

describe('sharing/manifest', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'portos-manifest-test-'));
  });
  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it('buildManifest produces a valid shape', () => {
    const m = manifest.buildManifest({
      kind: 'series',
      senderInstanceId: 'inst-123',
      source: 'me',
      sourceBio: null,
      bucketId: 'b1',
      bucketName: 'creative',
      recordIds: ['ser-1', 'iss-2'],
      assetRefs: [{ kind: 'image', ref: 'abc.png' }],
    });
    expect(m.id).toBeTruthy();
    expect(m.kind).toBe('series');
    expect(m.source).toBe('me');
    expect(m.recordIds).toEqual(['ser-1', 'iss-2']);
    expect(m.assetRefs).toEqual([{ kind: 'image', ref: 'abc.png' }]);
    expect(m.schemaVersion).toBe(manifest.MANIFEST_SCHEMA_VERSION);
    expect(m.sharingSchemaVersion).toBe(manifest.MANIFEST_SCHEMA_VERSION);
  });

  it('buildManifest stamps producedByVersion from the caller', () => {
    const m = manifest.buildManifest({
      kind: 'series', source: 'me', bucketId: 'b1', bucketName: 'c',
      recordIds: [], assetRefs: [],
      producedByVersion: '1.54.0',
    });
    expect(m.producedByVersion).toBe('1.54.0');
  });

  it("buildManifest defaults producedByVersion to 'unknown' when omitted", () => {
    const m = manifest.buildManifest({
      kind: 'series', source: 'me', bucketId: 'b1', bucketName: 'c',
      recordIds: [], assetRefs: [],
    });
    expect(m.producedByVersion).toBe('unknown');
  });

  it('buildManifest rejects invalid kind', () => {
    expect(() => manifest.buildManifest({ kind: 'bogus' })).toThrow(/invalid kind/);
  });

  it('manifestFilename is sortable + slug-safe', () => {
    const m = manifest.buildManifest({
      kind: 'series',
      source: 'Bob & Co!',
      bucketId: 'b1',
      bucketName: 'b',
      recordIds: [],
      assetRefs: [],
    });
    const name = manifest.manifestFilename(m);
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // `Bob & Co!` slugifies to `bob-co-` (each run of non-alphanumeric → single dash).
    expect(name).toContain('bob-co-');
    expect(name).toMatch(/\.json$/);
    expect(name).not.toMatch(/[^a-zA-Z0-9._-]/);
  });

  it('hasBeenProcessed reports cursor state correctly', async () => {
    const cursor = await manifest.readCursor('bucket-1');
    expect(manifest.hasBeenProcessed(cursor, 'foo.json')).toBe(false);
    await manifest.markProcessed('bucket-1', 'foo.json');
    const next = await manifest.readCursor('bucket-1');
    expect(manifest.hasBeenProcessed(next, 'foo.json')).toBe(true);
  });

  it('markProcessed records the manifest id and is idempotent on re-mark', async () => {
    await manifest.markProcessed('b1', 'a.json', 'mfst-1');
    await manifest.markProcessed('b1', 'a.json', 'mfst-1');
    const c = await manifest.readCursor('b1');
    expect(c.processedById['a.json']).toBe('mfst-1');
    expect(manifest.hasBeenProcessed(c, 'a.json', 'mfst-1')).toBe(true);
  });

  it('hasBeenProcessed re-processes a known filename when manifest id changes (subscription update)', async () => {
    await manifest.markProcessed('b1', 'sub-universe-abc.json', 'mfst-v1');
    let c = await manifest.readCursor('b1');
    expect(manifest.hasBeenProcessed(c, 'sub-universe-abc.json', 'mfst-v1')).toBe(true);
    expect(manifest.hasBeenProcessed(c, 'sub-universe-abc.json', 'mfst-v2')).toBe(false);
    await manifest.markProcessed('b1', 'sub-universe-abc.json', 'mfst-v2');
    c = await manifest.readCursor('b1');
    expect(c.processedById['sub-universe-abc.json']).toBe('mfst-v2');
  });

  it('forgetProcessed removes the entry so a future re-share imports cleanly', async () => {
    await manifest.markProcessed('b1', 'sub-universe-abc.json', 'mfst-1');
    await manifest.forgetProcessed('b1', 'sub-universe-abc.json');
    const c = await manifest.readCursor('b1');
    expect(c.processedById['sub-universe-abc.json']).toBeUndefined();
    expect(manifest.hasBeenProcessed(c, 'sub-universe-abc.json', 'mfst-1')).toBe(false);
  });

  describe('pruneBucketManifests', () => {
    let bucketRoot;

    function makeBucket(id = 'bkt-1') {
      bucketRoot = mkdtempSync(join(tmpdir(), 'portos-prune-bucket-'));
      // pruneBucketManifests does not create the manifests/ dir —
      // ensureBucketLayout already does. Mirror that here.
      mkdirSync(join(bucketRoot, 'manifests'), { recursive: true });
      return { id, name: 'Test', path: bucketRoot };
    }

    function writeOwnedManifest(bucketPath, name, { sender = 'me', createdAt }) {
      const stub = manifest.buildManifest({
        kind: 'series',
        senderInstanceId: sender,
        source: 'me',
        bucketId: 'bkt-1',
        bucketName: 'T',
        recordIds: [],
        assetRefs: [],
        producedByVersion: '1.0.0',
      });
      if (createdAt) stub.createdAt = createdAt;
      writeFileSync(join(bucketPath, 'manifests', name), JSON.stringify(stub));
    }

    afterEach(() => {
      if (bucketRoot) {
        rmSync(bucketRoot, { recursive: true, force: true });
        bucketRoot = null;
      }
    });

    it('noops when total candidates are under the cap', async () => {
      const bucket = makeBucket();
      writeOwnedManifest(bucket.path, '2024-01-01T00-00-00-000Z-me-a.json', { sender: 'me' });
      writeOwnedManifest(bucket.path, '2024-01-02T00-00-00-000Z-me-b.json', { sender: 'me' });
      const r = await manifest.pruneBucketManifests(bucket, { maxManifests: 10, localInstanceId: 'me' });
      expect(r.archived).toBe(0);
      expect(readdirSync(join(bucket.path, 'manifests'))).toHaveLength(2);
      expect(existsSync(join(bucket.path, '.archive'))).toBe(false);
    });

    it('archives only the oldest owned excess into .archive/manifests/', async () => {
      const bucket = makeBucket();
      // 5 owned manifests, cap at 2 → archive 3 oldest.
      for (let i = 0; i < 5; i++) {
        writeOwnedManifest(bucket.path, `2024-01-0${i + 1}T00-00-00-000Z-me-${i}.json`, { sender: 'me' });
      }
      const r = await manifest.pruneBucketManifests(bucket, { maxManifests: 2, localInstanceId: 'me' });
      expect(r.archived).toBe(3);
      expect(r.kept).toBe(2);
      expect(r.ownedTotal).toBe(5);
      const active = readdirSync(join(bucket.path, 'manifests'));
      expect(active.sort()).toEqual([
        '2024-01-04T00-00-00-000Z-me-3.json',
        '2024-01-05T00-00-00-000Z-me-4.json',
      ]);
      const archived = readdirSync(join(bucket.path, '.archive', 'manifests'));
      expect(archived.sort()).toEqual([
        '2024-01-01T00-00-00-000Z-me-0.json',
        '2024-01-02T00-00-00-000Z-me-1.json',
        '2024-01-03T00-00-00-000Z-me-2.json',
      ]);
    });

    it('never archives subscription manifests (sub-* filename) even when over cap', async () => {
      const bucket = makeBucket();
      writeOwnedManifest(bucket.path, 'sub-universe-uni-1.json', { sender: 'me' });
      writeOwnedManifest(bucket.path, 'sub-universe-uni-2.json', { sender: 'me' });
      writeOwnedManifest(bucket.path, '2024-01-01T00-00-00-000Z-me-old.json', { sender: 'me' });
      const r = await manifest.pruneBucketManifests(bucket, { maxManifests: 0, localInstanceId: 'me' });
      // 1 owned non-subscription manifest exceeds the cap → archived.
      expect(r.archived).toBe(1);
      const active = readdirSync(join(bucket.path, 'manifests')).sort();
      // Subscription manifests preserved.
      expect(active).toContain('sub-universe-uni-1.json');
      expect(active).toContain('sub-universe-uni-2.json');
      expect(active).not.toContain('2024-01-01T00-00-00-000Z-me-old.json');
    });

    it('never archives manifests authored by other peers', async () => {
      const bucket = makeBucket();
      writeOwnedManifest(bucket.path, '2024-01-01T00-00-00-000Z-other-old.json', { sender: 'peer-A' });
      writeOwnedManifest(bucket.path, '2024-01-02T00-00-00-000Z-me-a.json', { sender: 'me' });
      writeOwnedManifest(bucket.path, '2024-01-03T00-00-00-000Z-me-b.json', { sender: 'me' });
      const r = await manifest.pruneBucketManifests(bucket, { maxManifests: 1, localInstanceId: 'me' });
      expect(r.archived).toBe(1);
      expect(r.skippedForeign).toBe(1);
      const active = readdirSync(join(bucket.path, 'manifests')).sort();
      // Foreign manifest stays put; oldest owned moves to archive.
      expect(active).toContain('2024-01-01T00-00-00-000Z-other-old.json');
      expect(active).toContain('2024-01-03T00-00-00-000Z-me-b.json');
      expect(active).not.toContain('2024-01-02T00-00-00-000Z-me-a.json');
    });

    it('is a noop when localInstanceId is missing or unknown', async () => {
      const bucket = makeBucket();
      for (let i = 0; i < 3; i++) {
        writeOwnedManifest(bucket.path, `2024-01-0${i + 1}T00-00-00-000Z-me-${i}.json`, { sender: 'me' });
      }
      const r1 = await manifest.pruneBucketManifests(bucket, { maxManifests: 0 });
      const r2 = await manifest.pruneBucketManifests(bucket, { maxManifests: 0, localInstanceId: 'unknown' });
      expect(r1.archived).toBe(0);
      expect(r2.archived).toBe(0);
      expect(r1.skippedReason).toBe('no-local-instance-id');
      expect(readdirSync(join(bucket.path, 'manifests'))).toHaveLength(3);
    });

    it('marks archived filenames as pruning-in-flight to suppress watcher unshare events', async () => {
      const bucket = makeBucket();
      writeOwnedManifest(bucket.path, '2024-01-01T00-00-00-000Z-me-a.json', { sender: 'me' });
      writeOwnedManifest(bucket.path, '2024-01-02T00-00-00-000Z-me-b.json', { sender: 'me' });
      // Run prune but don't await the 5s unmark timer — check the marker
      // exists immediately after the rename.
      await manifest.pruneBucketManifests(bucket, { maxManifests: 1, localInstanceId: 'me' });
      expect(manifest.isManifestPruning(bucket.id, '2024-01-01T00-00-00-000Z-me-a.json')).toBe(true);
      // Filenames not archived are not marked.
      expect(manifest.isManifestPruning(bucket.id, '2024-01-02T00-00-00-000Z-me-b.json')).toBe(false);
    });
  });

  it('manifestFilename is deterministic per-sender when subscription is set', () => {
    const m = manifest.buildManifest({
      kind: 'universe', source: 'me', senderInstanceId: 'inst-A',
      bucketId: 'b1', bucketName: 'c',
      recordIds: [], assetRefs: [],
      subscription: { recordKind: 'universe', recordId: 'uni-abc-123' },
    });
    expect(manifest.manifestFilename(m)).toBe('sub-universe-uni-abc-123-inst-A.json');
    // Same record + same sender → same filename regardless of timestamp.
    const m2 = manifest.buildManifest({
      kind: 'universe', source: 'me', senderInstanceId: 'inst-A',
      bucketId: 'b1', bucketName: 'c',
      recordIds: [], assetRefs: [],
      subscription: { recordKind: 'universe', recordId: 'uni-abc-123' },
    });
    expect(manifest.manifestFilename(m2)).toBe(manifest.manifestFilename(m));
  });

  it('manifestFilename produces distinct names for two peers sharing the same record', () => {
    const peerA = manifest.buildManifest({
      kind: 'universe', source: 'A', senderInstanceId: 'inst-A',
      bucketId: 'b1', bucketName: 'c', recordIds: [], assetRefs: [],
      subscription: { recordKind: 'universe', recordId: 'uni-shared' },
    });
    const peerB = manifest.buildManifest({
      kind: 'universe', source: 'B', senderInstanceId: 'inst-B',
      bucketId: 'b1', bucketName: 'c', recordIds: [], assetRefs: [],
      subscription: { recordKind: 'universe', recordId: 'uni-shared' },
    });
    expect(manifest.manifestFilename(peerA)).not.toBe(manifest.manifestFilename(peerB));
    expect(manifest.manifestFilename(peerA)).toBe('sub-universe-uni-shared-inst-A.json');
    expect(manifest.manifestFilename(peerB)).toBe('sub-universe-uni-shared-inst-B.json');
  });

  it('legacySubscriptionFilename returns the pre-v2 sender-less name', () => {
    expect(manifest.legacySubscriptionFilename({ recordKind: 'series', recordId: 'ser-1' }))
      .toBe('sub-series-ser-1.json');
  });

  it('subscriptionFilename sanitizes path separators and other unsafe chars from senderInstanceId', () => {
    // A malformed persisted instance id with path separators must not be
    // able to escape the manifests directory or create nested paths.
    const f1 = manifest.subscriptionFilename({
      recordKind: 'universe', recordId: 'uni-1', senderInstanceId: '../../../etc/passwd',
    });
    expect(f1).not.toMatch(/[/\\]/);
    expect(f1).toBe('sub-universe-uni-1-_________etc_passwd.json');

    const f2 = manifest.subscriptionFilename({
      recordKind: 'series', recordId: 'ser-1', senderInstanceId: 'inst/with\\slashes',
    });
    expect(f2).not.toMatch(/[/\\]/);
    expect(f2).toBe('sub-series-ser-1-inst_with_slashes.json');

    // Length cap: a wildly oversized id is truncated to 80 chars.
    const long = 'A'.repeat(200);
    const f3 = manifest.subscriptionFilename({
      recordKind: 'universe', recordId: 'uni-1', senderInstanceId: long,
    });
    expect(f3).toBe(`sub-universe-uni-1-${'A'.repeat(80)}.json`);

    // An id of all separator chars is fully escaped, never empty.
    const f4 = manifest.subscriptionFilename({
      recordKind: 'universe', recordId: 'uni-1', senderInstanceId: '///',
    });
    expect(f4).toBe('sub-universe-uni-1-___.json');
  });
});
