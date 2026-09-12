import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdir, readFile, writeFile, rm } from 'fs/promises';
import { dirname, join } from 'path';
import { mockPathsDataRoot, mockNoPeers, mockNoPeerSync, mockTestIdentity } from '../lib/mockPathsDataRoot.js';

// Keep the real parser/writer; inject an OS fault only for the targeted file.
const faults = vi.hoisted(() => new Map());
vi.mock('fs/promises', async (original) => {
  const actual = await original();
  return { ...actual, readFile: (...args) => faults.has(args[0])
    ? Promise.reject(Object.assign(new Error('injected read fault'), { code: faults.get(args[0]) }))
    : actual.readFile(...args) };
});
const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-sharing-durability-' });
vi.mock('../lib/fileUtils.js', async (original) => new Proxy(makeProxy(await original()), {
  get: (target, key) => key === 'dataPath' ? (...parts) => join(tempRoot, ...parts) : target[key],
}));
vi.mock('./instances.js', () => mockNoPeers({}, { resolveEffectiveCategories: () => ({}), updatePeer: async () => {} }));
vi.mock('./instanceIdentity.js', () => mockTestIdentity());
vi.mock('./sharing/peerSync.js', () => mockNoPeerSync({}, {
  getOutboundCoverageForPeer: async () => ({ universe: new Set(), pipeline: new Set(), mediaCollections: new Set() }),
}));
vi.mock('./mediaJobQueue/index.js', () => ({ getJob: () => null }));
vi.mock('./sharing/annotationIdentity.js', () => ({ resolveBucketSourceName: async () => 'Test' }));
vi.mock('../lib/peerHttpClient.js', () => ({ peerFetch: vi.fn(() => { throw new Error('Unexpected network request'); }) }));

const backup = await import('./backup.js');
const dataSync = await import('./dataSync.js');
const peerUsage = await import('./peerUsage.js');
const quotas = await import('./providerQuotaShare.js');
const sync = await import('./syncOrchestrator.js');
const buckets = await import('./sharing/buckets.js');
const subscriptions = await import('./sharing/subscriptions.js');
const manifests = await import('./sharing/manifest.js');
const importer = await import('./sharing/importer.js');
const annotations = await import('./sharing/annotationsSync.js');
const { PATHS } = await import('../lib/fileUtils.js');
const bucketPath = join(tempRoot, 'bucket');
let bucket;
const seed = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
};
const card = (family) => ({ family, limits: [{ key: 'weekly', percentUsed: 20 }], fetchedAt: '2026-09-01T00:00:00Z' });
const incoming = { id: 'incoming', senderInstanceId: 'remote', kind: 'media', recordIds: ['job-new'], assetRefs: [] };

beforeEach(async () => {
  faults.clear();
  annotations.__resetBucketAssetKeysCache();
  subscriptions.__resetForTests();
  await rm(tempRoot, { recursive: true, force: true });
  await mkdir(bucketPath, { recursive: true });
  bucket = await buckets.createBucket({ name: 'Bucket', path: bucketPath, mode: 'inbox' });
  await seed(join(bucketPath, 'manifests', 'incoming.json'), incoming);
  await seed(join(bucketPath, 'records', 'media', 'job-new.json'), { id: 'job-new', status: 'completed' });
  await seed(join(bucketPath, 'assets', 'images', 'note.png'), 'image');
  await seed(join(bucketPath, 'assets', 'images', 'new.png'), 'image');
});
afterAll(cleanup);

// Each row pins a separate durable mutation boundary; rejection must preserve
// bytes, and a repair must unblock the same queue/operation without a restart.
const cases = [
  ['backup state', () => join(tempRoot, 'backup/state.json'), { lastRun: 'old' },
    () => backup.saveState({ status: 'ok' }), saved => expect(saved).toMatchObject({ lastRun: 'old', status: 'ok' })],
  ['goals', () => join(PATHS.digitalTwin, 'goals.json'), { goals: [{ id: 'old' }] },
    () => dataSync.applyRemote('goals', { goals: [{ id: 'new', updatedAt: '2026-09-02' }] }),
    saved => expect(saved.goals.map(g => g.id)).toEqual(['old', 'new'])],
  ['character', () => join(tempRoot, 'character.json'), { events: [{ id: 'old', timestamp: '2026-09-01' }], syncedTaskIds: ['old'] },
    () => dataSync.applyRemote('character', { events: [{ id: 'new', timestamp: '2026-09-02' }], updatedAt: '2026-09-02', level: 99 }),
    saved => { expect(saved.events.map(e => e.id)).toEqual(['old', 'new']); expect(saved.syncedTaskIds).toEqual(['old']); expect(saved).not.toHaveProperty('level'); }],
  ['personal log', () => join(tempRoot, 'meatspace/daily-log.json'), { entries: [{ date: '2026-09-01' }], custom: true },
    () => dataSync.applyRemote('meatspace', { 'daily-log.json': { entries: [{ date: '2026-09-02' }] } }),
    saved => { expect(saved.entries).toHaveLength(2); expect(saved.custom).toBe(true); }],
  ['personal config', () => join(tempRoot, 'meatspace/config.json'), { updatedAt: '2026-09-03', custom: true },
    () => dataSync.applyRemote('meatspace', { 'config.json': { updatedAt: '2026-09-02', custom: false } }), saved => expect(saved.custom).toBe(true)],
  ['peer retirements', () => peerUsage.PEER_USAGE_FILE, { instances: { retained: { capturedAt: '2026-09-01' } }, tombstones: [] },
    () => peerUsage.forgetInstanceUsage('retired'), saved => { expect(saved.instances).toHaveProperty('retained'); expect(saved.tombstones).toEqual(expect.arrayContaining([expect.objectContaining({ instanceId: 'retired' })])); }],
  ['quota families', () => quotas.PROVIDER_QUOTAS_FILE, { quotas: [card('old')] },
    () => quotas.recordLocalQuotaCards([card('new')]), saved => expect(saved.quotas.map(c => c.family)).toEqual(['old', 'new'])],
  ['bucket registry', () => join(tempRoot, 'sharing/buckets.json'), () => ({ buckets: [bucket] }),
    async () => { const other = join(tempRoot, 'other'); await mkdir(other, { recursive: true }); return buckets.createBucket({ name: 'Other', path: other }); },
    saved => expect(saved.buckets.map(b => b.name)).toEqual(['Bucket', 'Other'])],
  ['bucket identity', () => join(bucketPath, 'bucket.json'), { id: 'original', schemaVersion: 1, custom: true },
    () => buckets.ensureBucketLayout(bucket), saved => expect(saved).toEqual({ id: 'original', schemaVersion: 1, custom: true })],
  ['subscriptions', () => join(tempRoot, 'sharing/subscriptions.json'), { subscriptions: [{ id: 'old', recordKind: 'series', recordId: 'old' }] },
    () => subscriptions.adoptImportedSubscription({ bucketId: bucket.id, recordKind: 'series', recordId: 'new' }),
    saved => expect(saved.subscriptions.map(s => s.recordId)).toEqual(['old', 'new'])],
  ['sharing cursors', () => join(tempRoot, 'sharing/cursors', `${bucket.id}.json`), { processedById: { old: 'old-id' }, processed: ['legacy'] },
    () => manifests.markProcessed(bucket.id, 'new', 'new-id'), saved => { expect(saved.processedById).toEqual({ old: 'old-id', new: 'new-id' }); expect(saved.processed).toEqual(['legacy']); }],
  ['import inbox', () => join(tempRoot, 'sharing/inbox', `${bucket.id}.json`), { items: [{ manifestId: 'old' }] },
    () => importer.processManifest(bucket.id, 'incoming.json'), saved => expect(saved.items.map(i => i.manifestId)).toEqual(['old', 'incoming'])],
  ['import media jobs', () => join(tempRoot, 'media-jobs.json'), { jobs: [{ id: 'old' }], custom: true },
    () => importer.processManifest(bucket.id, 'incoming.json'), saved => { expect(saved.jobs.map(j => j.id)).toEqual(['old', 'job-new']); expect(saved.custom).toBe(true); }],
  ['annotation tombstones', () => join(bucketPath, 'records/media-annotations/test-instance.json'), { annotations: { 'image:note.png': { note: 'old' } } },
    () => annotations.exportAnnotationsToBucket({ ...bucket, mode: 'auto-merge' }, { 'image:new.png': { note: 'new' } }, 'test-instance'),
    saved => { expect(saved.annotations['image:note.png'].note).toBe(''); expect(saved.annotations['image:new.png'].note).toBe('new'); }],
  ['sync cursors', () => join(tempRoot, 'instances_sync_cursors.json'), { old: { brainSeq: 42 } },
    () => sync.syncWithPeer({ instanceId: 'new', name: 'Test' }), saved => { expect(saved.old).toEqual({ brainSeq: 42 }); expect(saved.new.lastSyncAt).toBeTruthy(); }],
];

describe.each(cases)('%s preserves unreadable data', (_name, getPath, fixture, mutate, retained) => {
  it('preserves corrupt/empty bytes and read faults, then retries after repair', async () => {
    const path = getPath();
    for (const bytes of ['{"truncated":', 'not json', '']) {
      await seed(path, bytes);
      await expect(mutate()).rejects.toMatchObject({ code: 'UNREADABLE_STORE' });
      expect(await readFile(path, 'utf8')).toBe(bytes);
    }
    await seed(path, typeof fixture === 'function' ? fixture() : fixture);
    const original = await readFile(path, 'utf8');
    faults.set(path, 'EACCES');
    await expect(mutate()).rejects.toMatchObject({ code: 'UNREADABLE_STORE' });
    faults.delete(path);
    expect(await readFile(path, 'utf8')).toBe(original);
    await mutate();
    retained(JSON.parse(await readFile(path, 'utf8')));
  });
  it('initializes only when the file is absent', async () => {
    const path = getPath();
    await rm(path, { force: true });
    await mutate();
    expect(JSON.parse(await readFile(path, 'utf8'))).toBeTruthy();
  });
});

// An unreadable shared identity must not leave a new local registry entry.
it('does not register a bucket whose existing identity cannot be read', async () => {
  const other = join(tempRoot, 'other');
  const identityPath = join(other, 'bucket.json');
  const registryPath = join(tempRoot, 'sharing/buckets.json');
  await seed(identityPath, '{"id":');
  const before = await readFile(registryPath, 'utf8');
  await expect(buckets.createBucket({ name: 'Other', path: other })).rejects.toMatchObject({ code: 'UNREADABLE_STORE' });
  expect(await readFile(registryPath, 'utf8')).toBe(before);
  expect(await readFile(identityPath, 'utf8')).toBe('{"id":');
});
