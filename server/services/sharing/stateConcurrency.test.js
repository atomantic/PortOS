import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { makePathsProxy, mockNoPeers, mockNoPeerSync } from '../../lib/mockPathsDataRoot.js';

const tempRoot = mkdtempSync(join(tmpdir(), 'sharing-state-concurrency-'));
const bucketPath = join(tempRoot, 'bucket');
const exportRecord = vi.fn();
vi.mock('../../lib/fileUtils.js', async () =>
  makePathsProxy(await vi.importActual('../../lib/fileUtils.js'), { dataRoot: tempRoot }));
vi.mock('./exporter.js', () => ({ exportSeries: exportRecord, exportUniverse: exportRecord }));
vi.mock('../instances.js', () => mockNoPeers({}, {
  getInstanceId: async () => 'local-instance', UNKNOWN_INSTANCE_ID: 'unknown',
}));
vi.mock('./peerSync.js', () => mockNoPeerSync());
vi.mock('../mediaJobQueue/index.js', () => ({ getJob: () => null }));

const buckets = await import('./buckets.js');
const subscriptions = await import('./subscriptions.js');
const importer = await import('./importer.js');
const manifests = await import('./manifest.js');
let bucket;

beforeEach(async () => {
  rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(bucketPath, { recursive: true });
  exportRecord.mockReset().mockResolvedValue({ manifestId: 'exported' });
  bucket = await buckets.createBucket({ name: 'Concurrent shares', path: bucketPath, mode: 'inbox' });
});
afterAll(() => {
  subscriptions.__resetForTests();
  rmSync(tempRoot, { recursive: true, force: true });
});

it('keeps an unsubscribe while another subscription finishes its slow export', async () => {
  const b = await subscriptions.subscribe({ bucketId: bucket.id, recordKind: 'universe', recordId: 'b' });
  const started = Promise.withResolvers();
  const exported = Promise.withResolvers();
  exportRecord.mockImplementationOnce(() => { started.resolve(); return exported.promise; });
  const subscribing = subscriptions.subscribe({ bucketId: bucket.id, recordKind: 'universe', recordId: 'a' });
  await started.promise;
  await subscriptions.unsubscribe(b.id);
  exported.resolve({ manifestId: 'a-export' });
  await subscribing;
  expect(await subscriptions.listSubscriptions()).toEqual([
    expect.objectContaining({ recordId: 'a', lastManifestId: 'a-export' }),
  ]);
});

it('does not restore a subscription removed during its own export', async () => {
  const started = Promise.withResolvers();
  const exported = Promise.withResolvers();
  exportRecord.mockImplementationOnce(() => { started.resolve(); return exported.promise; });
  const subscribing = subscriptions.subscribe({ bucketId: bucket.id, recordKind: 'universe', recordId: 'a' });
  await started.promise;
  const [sub] = await subscriptions.listSubscriptions();
  await subscriptions.unsubscribe(sub.id);
  exported.resolve({ manifestId: 'a-export' });
  expect(await subscribing).toBeNull();
  expect(await subscriptions.listSubscriptions()).toEqual([]);
});

it('retains both concurrently received inbox manifests and their cursor entries', async () => {
  for (const id of ['a', 'b']) {
    writeFileSync(join(bucketPath, 'manifests', `${id}.json`), JSON.stringify({
      id, senderInstanceId: 'remote-instance', kind: 'universe', recordIds: [], assetRefs: [],
    }));
  }
  const outcomes = await Promise.all(['a', 'b'].map((id) => importer.processManifest(bucket.id, `${id}.json`)));
  expect(outcomes.every((result) => result.outcome.queued)).toBe(true);
  expect((await importer.listInbox(bucket.id)).map((item) => item.manifestId).sort()).toEqual(['a', 'b']);
  expect((await manifests.readCursor(bucket.id)).processedById).toEqual({ 'a.json': 'a', 'b.json': 'b' });
});

it('preserves a concurrent cursor addition when forgetting an old manifest', async () => {
  await manifests.markProcessed(bucket.id, 'old.json', 'old');
  await Promise.all([
    manifests.forgetProcessed(bucket.id, 'old.json'),
    manifests.markProcessed(bucket.id, 'new.json', 'new'),
  ]);
  expect((await manifests.readCursor(bucket.id)).processedById).toEqual({ 'new.json': 'new' });
});
