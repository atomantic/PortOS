import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
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
// syncWithPeer logs the peer through instances.js's pure `peerLogLabel`; pull
// the real one so a log helper cannot turn an injected store fault into a
// missing-export error. Everything else stays doubled (no live peers).
vi.mock('./instances.js', async (importOriginal) => mockNoPeers({}, {
  peerLogLabel: (await importOriginal()).peerLogLabel,
  resolveEffectiveCategories: () => ({}),
  updatePeer: async () => {},
}));
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
const alcohol = await import('./meatspaceAlcohol.js');
const nicotine = await import('./meatspaceNicotine.js');
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

it('merges same-date daily-log tenants without duplicating them on replay', async () => {
  const path = join(PATHS.meatspace, 'daily-log.json');
  const date = '2026-01-02';
  await seed(path, {
    lastEntryDate: date,
    entries: [{
      date,
      body: { weightLbs: 170 },
      alcohol: { drinks: [{ name: 'Example beer', oz: 12, abv: 5, count: 1 }] },
    }],
    custom: true,
  });

  const remote = {
    'daily-log.json': {
      entries: [{
        date,
        body: { fatPct: 20 },
        alcohol: { drinks: [{ name: 'Example wine', oz: 5, abv: 12, count: 1 }] },
        nicotine: { items: [{ product: 'Example gum', mgPerUnit: 2, count: 2 }] },
      }],
    },
  };
  const first = await dataSync.applyRemote('meatspace', remote);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  const entry = saved.entries[0];

  expect(first).toEqual({ applied: true, count: 1 });
  expect(entry.body).toEqual({ weightLbs: 170, fatPct: 20 });
  expect(entry.alcohol.drinks).toHaveLength(2);
  expect(entry.alcohol.standardDrinks).toBe(2);
  expect(entry.nicotine.items).toHaveLength(1);
  expect(entry.nicotine.totalMg).toBe(4);
  expect(saved.lastEntryDate).toBe(date);
  expect(saved.custom).toBe(true);

  const replay = await dataSync.applyRemote('meatspace', remote);
  const replayed = JSON.parse(await readFile(path, 'utf8'));
  expect(replay).toEqual({ applied: false, count: 0 });
  expect(replayed.entries[0]).toEqual(entry);
});

// Identified alcohol/nicotine events (#8143): identical rows logged on two peers
// are two events, a replay adds nothing, and legacy/v0 payloads stay safe.
describe('daily-log event identity (#8143)', () => {
  const date = '2026-01-03';
  const path = () => join(PATHS.meatspace, 'daily-log.json');
  const stamp = '2026-01-03T20:00:00.000Z';
  const lager = (id, extra = {}) => ({ id, name: 'Example Lager', oz: 12, abv: 5, count: 1, createdAt: stamp, updatedAt: stamp, ...extra });
  const day = (drinks) => ({ date, alcohol: { drinks, standardDrinks: 0 } });
  const snapshot = (...entries) => ({ 'daily-log.json': { entries } });
  afterEach(() => vi.useRealTimers());
  const savedDay = async () => JSON.parse(await readFile(path(), 'utf8')).entries.find((e) => e.date === date);

  // Each "peer" logs through the real services onto an empty log at the same
  // instant, so the rows are identical apart from their event identity.
  const logOnFreshPeer = async () => {
    await rm(path(), { force: true });
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(stamp) });
    await alcohol.logDrink({ name: 'Example Lager', oz: 12, abv: 5, count: 1, date });
    await nicotine.logNicotine({ product: 'Example Pouch', mgPerUnit: 3, count: 1, date });
    return JSON.parse(await readFile(path(), 'utf8'));
  };

  it('keeps identical independent events from both peers in either sync order', async () => {
    const peers = [await logOnFreshPeer(), await logOnFreshPeer()];
    vi.useRealTimers();
    for (const [local, remote] of [peers, [...peers].reverse()]) {
      await seed(path(), local);
      const peer = { 'daily-log.json': remote };
      expect(await dataSync.applyRemote('meatspace', peer)).toEqual({ applied: true, count: 1 });
      const merged = await savedDay();
      expect(merged.alcohol.drinks).toHaveLength(2);
      expect(merged.alcohol.standardDrinks).toBe(2);
      expect(merged.nicotine.items).toHaveLength(2);
      expect(merged.nicotine.totalMg).toBe(6);

      expect(await dataSync.applyRemote('meatspace', peer)).toEqual({ applied: false, count: 0 });
      expect(await savedDay()).toEqual(merged);
    }
  });

  it('resolves copies of one event the same way whichever side holds which', async () => {
    const legacy = { name: 'Example Stout', oz: 12, abv: 5, count: 1 };
    const newerEdit = lager('drink-x', { count: 1, abv: 10, updatedAt: '2026-01-04T08:00:00.000Z' });
    // A pre-#8143 peer folds a second log into the row in place, without restamping.
    const bumpedInPlace = lager('drink-x', { count: 2 });
    const cases = [
      // Equal stamps: the in-place increment is a real drink, so the larger count wins.
      [[lager('drink-x'), legacy], [legacy, lager('drink-x'), bumpedInPlace], 2, 3],
      [[bumpedInPlace, legacy], [legacy, lager('drink-x')], 2, 3],
      // A restamped edit wins over a stale copy regardless of its count.
      [[bumpedInPlace, legacy], [newerEdit, legacy], 1, 3],
      [[newerEdit, legacy], [bumpedInPlace, legacy], 1, 3],
    ];
    for (const [localDrinks, remoteDrinks, count, total] of cases) {
      await seed(path(), { entries: [day(localDrinks)] });
      await dataSync.applyRemote('meatspace', snapshot(day(remoteDrinks)));
      const merged = await savedDay();
      // The legacy row keeps content dedupe; the identified event is one row.
      expect(merged.alcohol.drinks).toHaveLength(2);
      expect(merged.alcohol.drinks.find((d) => d.id === 'drink-x').count).toBe(count);
      expect(merged.alcohol.standardDrinks).toBe(total);
    }
  });

  it('does not merge a legacy row back in after one peer edits it', async () => {
    const legacyLog = { entries: [day([{ name: 'Example Stout', oz: 12, abv: 5, count: 1 }])] };
    await seed(path(), legacyLog);
    await alcohol.updateDrink(date, 0, { count: 2 });
    const edited = JSON.parse(await readFile(path(), 'utf8'));

    // Pulling the unedited peer's copy leaves the edit as the only row...
    await dataSync.applyRemote('meatspace', { 'daily-log.json': legacyLog });
    expect((await savedDay()).alcohol.drinks).toEqual(edited.entries[0].alcohol.drinks);
    // ...and the unedited peer drops its legacy copy when it pulls the edit.
    await seed(path(), legacyLog);
    await dataSync.applyRemote('meatspace', { 'daily-log.json': edited });
    const merged = await savedDay();
    expect(merged.alcohol.drinks).toEqual(edited.entries[0].alcohol.drinks);
    expect(merged.alcohol.standardDrinks).toBe(2);
  });

  it('refuses a daily log from a peer on a newer meatspace schema', async () => {
    await seed(path(), { entries: [day([lager('drink-a')])] });
    const before = await readFile(path(), 'utf8');
    const result = await dataSync.applyRemote('meatspace', snapshot(day([lager('drink-b')])), {
      portosMeta: { portosVersion: '99.0.0', schemaVersions: { meatspace: 2 } },
    });
    expect(result.applied).toBe(false);
    expect(result.blockedBySchema.ahead).toEqual([{ category: 'meatspace', senderV: 2, receiverV: 1 }]);
    expect(await readFile(path(), 'utf8')).toBe(before);
  });
});

// Deletes and date moves of identified events converge across peers (#8154).
// Peer A acts through the real services on a log both peers share; peer B
// still holds the original rows, as an offline (or pre-#8154) peer would.
describe('daily-log deletes and date moves (#8154)', () => {
  const date = '2026-01-03';
  const nextDate = '2026-01-04';
  const stamp = '2026-01-03T20:00:00.000Z';
  const path = () => join(PATHS.meatspace, 'daily-log.json');
  const lager = (id, extra = {}) => ({ id, name: 'Example Lager', oz: 12, abv: 5, count: 1, createdAt: stamp, updatedAt: stamp, ...extra });
  const pouch = { id: 'pouch-1', product: 'Example Pouch', mgPerUnit: 3, count: 1, createdAt: stamp, updatedAt: stamp };
  const shared = () => ({
    entries: [{
      date,
      alcohol: { drinks: [lager('drink-1'), lager('drink-2', { oz: 24 })], standardDrinks: 3 },
      nicotine: { items: [{ ...pouch }], totalMg: 3 },
    }],
  });
  const read = async () => JSON.parse(await readFile(path(), 'utf8'));
  const drinkIdsByDate = (log) => Object.fromEntries(
    log.entries.filter((e) => e.alcohol).map((e) => [e.date, e.alcohol.drinks.map((d) => d.id)]),
  );
  afterEach(() => vi.useRealTimers());

  const actOnPeerA = async (action, at = '2026-01-05T09:00:00.000Z') => {
    await seed(path(), shared());
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(at) });
    await action();
    vi.useRealTimers();
    return read();
  };

  // Row order within a day follows whichever side is local; identity does not.
  const byId = (a, b) => (a.id < b.id ? -1 : 1);
  const unordered = (log) => log.entries.map((e) => ({
    ...e,
    ...(e.alcohol && { alcohol: { ...e.alcohol, drinks: [...e.alcohol.drinks].sort(byId) } }),
    ...(e.nicotine && { nicotine: { ...e.nicotine, items: [...e.nicotine.items].sort(byId) } }),
  }));

  // Merge in both directions; each side must reach the same log, and a replay
  // of the same snapshot must be a no-op.
  const syncBothWays = async (peerA, peerB) => {
    const results = [];
    for (const [local, remote] of [[peerA, peerB], [peerB, peerA]]) {
      await seed(path(), local);
      await dataSync.applyRemote('meatspace', { 'daily-log.json': remote });
      const merged = await read();
      expect(await dataSync.applyRemote('meatspace', { 'daily-log.json': remote })).toEqual({ applied: false, count: 0 });
      results.push(merged);
    }
    expect(unordered(results[1])).toEqual(unordered(results[0]));
    expect(results[1].eventTombstones).toEqual(results[0].eventTombstones);
    return results[0];
  };

  it('keeps a deleted drink and nicotine item deleted on both peers', async () => {
    const peerA = await actOnPeerA(async () => {
      await alcohol.removeDrink(date, 0);
      await nicotine.removeNicotine(date, 0);
    });
    const merged = await syncBothWays(peerA, shared());
    const day = merged.entries.find((e) => e.date === date);
    expect(day.alcohol.drinks.map((d) => d.id)).toEqual(['drink-2']);
    expect(day.alcohol.standardDrinks).toBe(2);
    expect(day.nicotine).toBeUndefined();
    // The receiving peer keeps the tombstones so it can pass the delete on.
    expect(merged.eventTombstones.map((t) => t.id).sort()).toEqual(['drink-1', 'pouch-1']);
  });

  it('leaves exactly one copy of a moved drink, on the new date', async () => {
    const peerA = await actOnPeerA(() => alcohol.updateDrink(date, 0, { date: nextDate }));
    const merged = await syncBothWays(peerA, shared());
    expect(drinkIdsByDate(merged)).toEqual({ [date]: ['drink-2'], [nextDate]: ['drink-1'] });
    expect(merged.entries.find((e) => e.date === date).alcohol.standardDrinks).toBe(2);
    expect(merged.entries.find((e) => e.date === nextDate).alcohol.standardDrinks).toBe(1);
  });

  it('does not suppress an identical drink logged again after the delete', async () => {
    const peerA = await actOnPeerA(async () => {
      await alcohol.removeDrink(date, 0);
      await alcohol.logDrink({ name: 'Example Lager', oz: 12, abv: 5, count: 1, date });
    });
    const merged = await syncBothWays(peerA, shared());
    const drinks = merged.entries.find((e) => e.date === date).alcohol.drinks;
    expect(drinks.map((d) => d.id)).not.toContain('drink-1');
    expect(drinks).toHaveLength(2);
    expect(merged.entries.find((e) => e.date === date).alcohol.standardDrinks).toBe(3);
  });

  it('keeps a drink a peer edited after the delete, and retires the tombstone', async () => {
    const peerA = await actOnPeerA(() => alcohol.removeDrink(date, 0));
    const peerB = shared();
    peerB.entries[0].alcohol.drinks[0].count = 2;
    peerB.entries[0].alcohol.drinks[0].updatedAt = '2026-01-06T09:00:00.000Z';
    const merged = await syncBothWays(peerA, peerB);
    const drinks = merged.entries.find((e) => e.date === date).alcohol.drinks;
    expect(drinks.find((d) => d.id === 'drink-1').count).toBe(2);
    expect(merged.eventTombstones).toBeUndefined();
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
