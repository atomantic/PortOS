import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Universe builder evaluates PATHS.data at module top, so allocate a stable
// temp dir before any service imports. beforeEach wipes + reseeds inside.
const tempData = mkdtempSync(join(tmpdir(), 'portos-subs-test-data-'));
let tempBucket;

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'PATHS') return {
        ...actual.PATHS,
        data: tempData,
        images: join(tempData, 'images'),
        videos: join(tempData, 'videos'),
      };
      return target[prop];
    },
  });
});
vi.mock('../instances.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null), getInstanceId: () => Promise.resolve('inst-test') }));
vi.mock('../mediaJobQueue/index.js', () => ({ getJob: () => null }));

const buckets = await import('./buckets.js');
const subs = await import('./subscriptions.js');
const universeBuilder = await import('../universeBuilder.js');
const series = await import('../pipeline/series.js');

describe('sharing/subscriptions', () => {
  beforeEach(() => {
    rmSync(tempData, { recursive: true, force: true });
    mkdirSync(tempData, { recursive: true });
    mkdirSync(join(tempData, 'images'), { recursive: true });
    tempBucket = mkdtempSync(join(tmpdir(), 'portos-subs-test-bucket-'));
    subs.__resetForTests();
  });
  afterEach(() => {
    if (tempBucket) rmSync(tempBucket, { recursive: true, force: true });
  });

  it('subscribe creates a subscription and writes a deterministic-named manifest', async () => {
    const bucket = await buckets.createBucket({ name: 'B', path: tempBucket, mode: 'inbox' });
    const u = await universeBuilder.createUniverse({ name: 'U1' });

    const sub = await subs.subscribe({
      bucketId: bucket.id, recordKind: 'universe', recordId: u.id,
    });
    expect(sub.id).toMatch(/^sub-universe-/);
    expect(sub.bucketId).toBe(bucket.id);
    expect(sub.lastManifestId).toBeTruthy();

    const fs = await import('fs');
    const filename = subs.subscriptionFilename({ recordKind: 'universe', recordId: u.id, senderInstanceId: 'inst-test' });
    expect(filename).toBe(`sub-universe-${u.id}-inst-test.json`);
    expect(fs.existsSync(join(tempBucket, 'manifests', filename))).toBe(true);
  });

  it('subscriptionFilename falls back to "unknown" sender when missing', async () => {
    const filename = subs.subscriptionFilename({ recordKind: 'series', recordId: 'ser-x' });
    expect(filename).toBe('sub-series-ser-x-unknown.json');
  });

  it('subscribe is idempotent — second call re-exports onto the same file with a new manifestId', async () => {
    const bucket = await buckets.createBucket({ name: 'B', path: tempBucket });
    const u = await universeBuilder.createUniverse({ name: 'U2' });
    const first = await subs.subscribe({ bucketId: bucket.id, recordKind: 'universe', recordId: u.id });
    const second = await subs.subscribe({ bucketId: bucket.id, recordKind: 'universe', recordId: u.id });
    expect(first.id).toBe(second.id);
    expect(second.lastManifestId).not.toBe(first.lastManifestId);

    const all = await subs.listSubscriptions();
    expect(all.filter((s) => s.recordId === u.id)).toHaveLength(1);
  });

  it('unsubscribe removes the subscription and deletes the bucket file', async () => {
    const bucket = await buckets.createBucket({ name: 'B', path: tempBucket });
    const u = await universeBuilder.createUniverse({ name: 'U3' });
    const sub = await subs.subscribe({ bucketId: bucket.id, recordKind: 'universe', recordId: u.id });
    const filename = subs.subscriptionFilename({ ...sub, senderInstanceId: 'inst-test' });
    const filePath = join(tempBucket, 'manifests', filename);
    const fs = await import('fs');
    expect(fs.existsSync(filePath)).toBe(true);

    await subs.unsubscribe(sub.id);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(await subs.listSubscriptions()).toEqual([]);
  });

  it('unsubscribe also cleans up the pre-sharing-v2 legacy filename when authored by this instance', async () => {
    const bucket = await buckets.createBucket({ name: 'B', path: tempBucket });
    const u = await universeBuilder.createUniverse({ name: 'U-legacy' });
    const fs = await import('fs');

    const sub = await subs.subscribe({ bucketId: bucket.id, recordKind: 'universe', recordId: u.id });
    const legacyPath = join(tempBucket, 'manifests', `sub-universe-${u.id}.json`);
    fs.writeFileSync(legacyPath, JSON.stringify({ senderInstanceId: 'inst-test' }));

    await subs.unsubscribe(sub.id);
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it('unsubscribe preserves a legacy filename authored by a DIFFERENT peer', async () => {
    const bucket = await buckets.createBucket({ name: 'B', path: tempBucket });
    const u = await universeBuilder.createUniverse({ name: 'U-legacy-other' });
    const fs = await import('fs');

    const sub = await subs.subscribe({ bucketId: bucket.id, recordKind: 'universe', recordId: u.id });
    const legacyPath = join(tempBucket, 'manifests', `sub-universe-${u.id}.json`);
    fs.writeFileSync(legacyPath, JSON.stringify({ senderInstanceId: 'some-other-peer' }));

    await subs.unsubscribe(sub.id);
    expect(fs.existsSync(legacyPath)).toBe(true);
  });

  it('unsubscribe preserves a legacy filename with no senderInstanceId (ownership unverifiable)', async () => {
    // A pre-v2 or malformed legacy file with no `senderInstanceId` could
    // belong to any peer; deleting it on unsubscribe risks stomping a
    // peer's share. The strict-equality gate must leave it in place.
    const bucket = await buckets.createBucket({ name: 'B', path: tempBucket });
    const u = await universeBuilder.createUniverse({ name: 'U-legacy-anon' });
    const fs = await import('fs');

    const sub = await subs.subscribe({ bucketId: bucket.id, recordKind: 'universe', recordId: u.id });
    const legacyPath = join(tempBucket, 'manifests', `sub-universe-${u.id}.json`);
    fs.writeFileSync(legacyPath, JSON.stringify({ /* senderInstanceId absent */ }));

    await subs.unsubscribe(sub.id);
    expect(fs.existsSync(legacyPath)).toBe(true);
  });

  it('listSubscriptions filters by bucketId / recordKind / recordId', async () => {
    const bucket1 = await buckets.createBucket({ name: 'A', path: tempBucket });
    const bucket2Path = mkdtempSync(join(tmpdir(), 'portos-subs-b2-'));
    const bucket2 = await buckets.createBucket({ name: 'B', path: bucket2Path });
    const u = await universeBuilder.createUniverse({ name: 'U4' });
    const s = await series.createSeries({ name: 'S1' });

    await subs.subscribe({ bucketId: bucket1.id, recordKind: 'universe', recordId: u.id });
    await subs.subscribe({ bucketId: bucket2.id, recordKind: 'universe', recordId: u.id });
    await subs.subscribe({ bucketId: bucket1.id, recordKind: 'series', recordId: s.id });

    expect((await subs.listSubscriptions({ bucketId: bucket1.id }))).toHaveLength(2);
    expect((await subs.listSubscriptions({ recordKind: 'universe' }))).toHaveLength(2);
    expect((await subs.listSubscriptions({ recordKind: 'series', recordId: s.id }))).toHaveLength(1);

    rmSync(bucket2Path, { recursive: true, force: true });
  });

  it('subscribe rejects unsubscribable kinds', async () => {
    const bucket = await buckets.createBucket({ name: 'B', path: tempBucket });
    await expect(subs.subscribe({ bucketId: bucket.id, recordKind: 'media', recordId: 'x' }))
      .rejects.toMatchObject({ code: subs.ERR_VALIDATION });
  });

  it('unsubscribe throws ERR_NOT_FOUND for unknown id', async () => {
    await expect(subs.unsubscribe('does-not-exist'))
      .rejects.toMatchObject({ code: subs.ERR_NOT_FOUND });
  });

  it('findSubscription returns null when none exists', async () => {
    const bucket = await buckets.createBucket({ name: 'B', path: tempBucket });
    expect(await subs.findSubscription(bucket.id, 'universe', 'no-such-id')).toBeNull();
  });

  it('unsubscribeAllForRecord drops every matching subscription', async () => {
    const bucket1 = await buckets.createBucket({ name: 'A', path: tempBucket });
    const bucket2Path = mkdtempSync(join(tmpdir(), 'portos-subs-b2-'));
    const bucket2 = await buckets.createBucket({ name: 'B', path: bucket2Path });
    const u = await universeBuilder.createUniverse({ name: 'shared-uni' });
    await subs.subscribe({ bucketId: bucket1.id, recordKind: 'universe', recordId: u.id });
    await subs.subscribe({ bucketId: bucket2.id, recordKind: 'universe', recordId: u.id });
    expect(await subs.listSubscriptions({ recordId: u.id })).toHaveLength(2);

    const result = await subs.unsubscribeAllForRecord('universe', u.id);
    expect(result.removed).toHaveLength(2);
    expect(await subs.listSubscriptions({ recordId: u.id })).toEqual([]);
    rmSync(bucket2Path, { recursive: true, force: true });
  });

  it('adoptImportedSubscription does not flip a deliberately-subscribed record to adoptedFromImport on re-adopt', async () => {
    const bucket = await buckets.createBucket({ name: 'B', path: tempBucket });
    const u = await universeBuilder.createUniverse({ name: 'U-adopt' });
    const original = await subs.subscribe({ bucketId: bucket.id, recordKind: 'universe', recordId: u.id });
    expect(original.adoptedFromImport).toBeUndefined();

    const adopted = await subs.adoptImportedSubscription({
      bucketId: bucket.id, recordKind: 'universe', recordId: u.id, lastManifestId: 'inbound-1',
    });
    expect(adopted.id).toBe(original.id);
    expect(adopted.adoptedFromImport).toBeUndefined();
    expect(adopted.lastManifestId).toBe('inbound-1');
  });

  it('deleting the local record auto-unsubscribes via the deleted recordEvent', async () => {
    subs.installSubscriptionListener();
    const bucket = await buckets.createBucket({ name: 'D', path: tempBucket });
    const u = await universeBuilder.createUniverse({ name: 'to-delete' });
    await subs.subscribe({ bucketId: bucket.id, recordKind: 'universe', recordId: u.id });
    expect((await subs.listSubscriptions({ recordId: u.id }))).toHaveLength(1);

    await universeBuilder.deleteUniverse(u.id);
    // Listener fans out async (readState → unsubscribe → unlink → writeState);
    // wait one event-loop tick + a small slack for the I/O chain to settle.
    await new Promise((r) => setTimeout(r, 50));
    expect(await subs.listSubscriptions({ recordId: u.id })).toEqual([]);
  });
});
