import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Allocate the temp dir lazily on first PATHS read — brainStorage's module
// graph (brainSyncLog) reads PATHS.brain at import time, before any top-level
// test assignment would run, so the dataRoot getter must self-initialize.
// `var` + a function declaration are both hoisted (no TDZ), so they're safe to
// reference from the hoisted vi.mock factory / import side-effects.
var tempRoot; // eslint-disable-line no-var
function getTempRoot() {
  if (!tempRoot) tempRoot = mkdtempSync(join(tmpdir(), 'brainstorage-test-'));
  return tempRoot;
}

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makePathsProxy({ ...actual, readJSONFile: vi.fn(actual.readJSONFile) }, { dataRoot: () => getTempRoot() });
});

// getInstanceId is used by create()/backfill; stub to a stable id.
vi.mock('./instances.js', () => ({
  getInstanceId: () => Promise.resolve('local-instance'),
}));

vi.mock('./brainSyncLog.js', async () => {
  const actual = await vi.importActual('./brainSyncLog.js');
  return {
    ...actual,
    appendChanges: vi.fn(actual.appendChanges),
  };
});

import * as brainStorage from './brainStorage.js';
import * as brainSyncLog from './brainSyncLog.js';
import { readJSONFile } from '../lib/fileUtils.js';

afterAll(() => { if (tempRoot) rmSync(tempRoot, { recursive: true, force: true }); });

// Each test uses a fresh entity type slice by resetting caches; use distinct
// ids to avoid cross-test bleed within the shared temp store files.
beforeEach(() => {
  brainStorage.invalidateAllCaches();
});

const ISO = (s) => new Date(s).toISOString();

describe('brainStorage tombstones', () => {
  it('remove() writes a tombstone instead of hard-deleting, and hides it from reads', async () => {
    const created = await brainStorage.create('people', { name: 'Alice' });
    expect(await brainStorage.getById('people', created.id)).toMatchObject({ name: 'Alice' });

    const ok = await brainStorage.remove('people', created.id);
    expect(ok).toBe(true);

    // Hidden from reads
    expect(await brainStorage.getById('people', created.id)).toBeNull();
    const all = await brainStorage.getAll('people');
    expect(all.find((r) => r.id === created.id)).toBeUndefined();

    // But the tombstone is physically present in the store (not hard-deleted)
    brainStorage.invalidateAllCaches();
    const second = await brainStorage.remove('people', created.id);
    expect(second).toBe(false); // already tombstoned → no-op, no extra sync entry
  });

  it('serializes a local write against a concurrent remote apply on the same store (no lost update)', async () => {
    // A local create and a peer apply both do whole-file read-modify-write on
    // buckets.json. The shared withStoreWriteLock must serialize them so neither
    // overwrites the other's record. Fire both without awaiting in between.
    const localP = brainStorage.create('buckets', { name: 'LocalBucket' });
    const remoteP = brainStorage.applyRemoteRecord(
      'buckets', 'remote-bucket-1',
      { name: 'RemoteBucket', updatedAt: ISO('2026-06-09'), originInstanceId: 'peer-x' },
      'create',
    );
    const [local] = await Promise.all([localP, remoteP]);

    brainStorage.invalidateAllCaches();
    const all = await brainStorage.getAll('buckets');
    // Both records must survive — a lost update would drop one.
    expect(all.find((r) => r.id === local.id)?.name).toBe('LocalBucket');
    expect(all.find((r) => r.id === 'remote-bucket-1')?.name).toBe('RemoteBucket');
  });

  it('getRawRecords surfaces tombstones that getAll hides (sync reconcile path #1077)', async () => {
    const created = await brainStorage.create('ideas', { title: 'RawIdea', oneLiner: 'x' });
    await brainStorage.remove('ideas', created.id);

    // getAll strips the tombstone…
    const visible = await brainStorage.getAll('ideas');
    expect(visible.find((r) => r.id === created.id)).toBeUndefined();

    // …but getRawRecords keeps it (with its LWW clock) for snapshot reconcile.
    const raw = await brainStorage.getRawRecords('ideas');
    expect(raw[created.id]).toBeDefined();
    expect(raw[created.id]._deleted).toBe(true);
    expect(raw[created.id].updatedAt).toBeTruthy();
  });

  it('applyRemoteRecord delete tombstones an unknown id (delete-before-create)', async () => {
    const res = await brainStorage.applyRemoteRecord(
      'projects', 'ghost-1', { updatedAt: ISO('2026-01-02') }, 'delete'
    );
    expect(res.applied).toBe(true);

    // A stale create (older updatedAt) must be rejected by the tombstone guard
    const stale = await brainStorage.applyRemoteRecord(
      'projects', 'ghost-1', { name: 'X', updatedAt: ISO('2026-01-01') }, 'create'
    );
    expect(stale.applied).toBe(false);
    expect(stale.reason).toBe('local_newer');
    expect(await brainStorage.getById('projects', 'ghost-1')).toBeNull();
  });

  it('rejects a stale create against an existing tombstone (the loop-breaker)', async () => {
    const created = await brainStorage.create('ideas', { title: 'T' });
    // Local delete at a known time
    await brainStorage.remove('ideas', created.id);
    const tombstoneTime = (await rawRecord('ideas', created.id)).updatedAt;

    // Peer echoes the original create with an OLDER updatedAt → must be rejected
    const echo = await brainStorage.applyRemoteRecord(
      'ideas', created.id, { title: 'T', updatedAt: ISO('2000-01-01') }, 'create'
    );
    expect(echo.applied).toBe(false);
    expect(echo.reason).toBe('local_newer');
    // Still a tombstone, unchanged
    const rec = await rawRecord('ideas', created.id);
    expect(rec._deleted).toBe(true);
    expect(rec.updatedAt).toBe(tombstoneTime);
  });

  it('rejects a create with no updatedAt (cannot defeat the tombstone guard)', async () => {
    await brainStorage.applyRemoteRecord('people', 'no-ts', { updatedAt: ISO('2026-01-01') }, 'delete');
    const res = await brainStorage.applyRemoteRecord('people', 'no-ts', { name: 'X' }, 'create');
    expect(res.applied).toBe(false);
    expect(res.reason).toBe('missing_timestamp');
    expect(await brainStorage.getById('people', 'no-ts')).toBeNull();
  });

  it('persists a _deleted create as a proper tombstone (defense-in-depth)', async () => {
    const res = await brainStorage.applyRemoteRecord(
      'projects', 'fwd-1',
      { _deleted: true, updatedAt: ISO('2026-04-01'), originInstanceId: 'peer-z' },
      'create'
    );
    expect(res.applied).toBe(true);
    const rec = await rawRecord('projects', 'fwd-1');
    expect(rec._deleted).toBe(true);
    expect(rec.deletedAt).toBe(ISO('2026-04-01')); // not a malformed live record
    expect(await brainStorage.getById('projects', 'fwd-1')).toBeNull();
  });

  it('allows a genuinely newer create to resurrect a tombstone', async () => {
    await brainStorage.applyRemoteRecord(
      'admin', 'r1', { updatedAt: ISO('2026-01-01') }, 'delete'
    );
    const revive = await brainStorage.applyRemoteRecord(
      'admin', 'r1', { task: 'revived', updatedAt: ISO('2026-02-01') }, 'create'
    );
    expect(revive.applied).toBe(true);
    expect(await brainStorage.getById('admin', 'r1')).toMatchObject({ task: 'revived' });
  });

  it('delete is idempotent: re-applying the same delete is rejected (no relay)', async () => {
    const first = await brainStorage.applyRemoteRecord(
      'links', 'l1', { updatedAt: ISO('2026-01-01') }, 'delete'
    );
    expect(first.applied).toBe(true);
    const again = await brainStorage.applyRemoteRecord(
      'links', 'l1', { updatedAt: ISO('2026-01-01') }, 'delete'
    );
    expect(again.applied).toBe(false);
    expect(again.reason).toBe('local_newer');
  });

  it('update() treats a tombstone as not-found', async () => {
    const created = await brainStorage.create('buckets', { label: 'B' });
    await brainStorage.remove('buckets', created.id);
    const updated = await brainStorage.update('buckets', created.id, { label: 'B2' });
    expect(updated).toBeNull();
  });

  it('pruneTombstones removes only tombstones older than the cutoff', async () => {
    // Old tombstone
    await brainStorage.applyRemoteRecord('memories', 'old', { updatedAt: ISO('2020-01-01') }, 'delete');
    // Fresh tombstone (now)
    const freshCreated = await brainStorage.create('memories', { content: 'keep' });
    await brainStorage.remove('memories', freshCreated.id);
    // A live record that must survive
    const live = await brainStorage.create('memories', { content: 'alive' });

    const cutoff = Date.parse(ISO('2021-01-01'));
    const changed = vi.fn();
    brainStorage.brainEvents.on('record:changed', changed);
    const pruned = await brainStorage.pruneTombstones('memories', cutoff);
    brainStorage.brainEvents.off('record:changed', changed);
    expect(pruned).toBe(1); // only the 2020 tombstone
    expect(changed).toHaveBeenCalledWith({ type: 'memories', id: 'old' });

    expect(await rawRecord('memories', 'old')).toBeUndefined();
    expect((await rawRecord('memories', freshCreated.id))._deleted).toBe(true);
    expect(await brainStorage.getById('memories', live.id)).toMatchObject({ content: 'alive' });
  });
});

describe('memory recency ordering', () => {
  it('memoryRecencyMs prefers source clocks over storage clocks', () => {
    // sourceUpdatedAt wins
    expect(brainStorage.memoryRecencyMs({
      sourceUpdatedAt: ISO('2024-07-14'), sourceCreatedAt: ISO('2024-01-01'),
      updatedAt: ISO('2026-06-16'),
    })).toBe(Date.parse(ISO('2024-07-14')));
    // falls back to sourceCreatedAt, then updatedAt, then createdAt
    expect(brainStorage.memoryRecencyMs({ sourceCreatedAt: ISO('2023-03-03'), updatedAt: ISO('2026-01-01') }))
      .toBe(Date.parse(ISO('2023-03-03')));
    expect(brainStorage.memoryRecencyMs({ updatedAt: ISO('2025-05-05') }))
      .toBe(Date.parse(ISO('2025-05-05')));
    expect(brainStorage.memoryRecencyMs({ createdAt: ISO('2025-02-02') }))
      .toBe(Date.parse(ISO('2025-02-02')));
    // missing/unparseable → 0 (sorts last)
    expect(brainStorage.memoryRecencyMs({})).toBe(0);
    expect(brainStorage.memoryRecencyMs({ sourceUpdatedAt: 'not-a-date', updatedAt: null })).toBe(0);
  });

  it('getMemoryEntries returns imports newest-first by source recency, not export/insertion order', async () => {
    // Imported in non-chronological export order (the ChatGPT-export bug): the
    // bulk import stamps every record's createdAt/updatedAt with ~the same time,
    // so only the source clock distinguishes them.
    await brainStorage.create('memories', {
      title: 'oldest', source: 'chatgpt-import',
      sourceCreatedAt: ISO('2024-07-14'), sourceUpdatedAt: ISO('2024-07-14'),
    });
    await brainStorage.create('memories', {
      title: 'newest', source: 'chatgpt-import',
      sourceCreatedAt: ISO('2026-01-10'), sourceUpdatedAt: ISO('2026-02-01'),
    });
    await brainStorage.create('memories', {
      title: 'middle', source: 'chatgpt-import',
      sourceCreatedAt: ISO('2025-05-05'), sourceUpdatedAt: ISO('2025-05-06'),
    });

    const entries = await brainStorage.getMemoryEntries();
    const imported = entries.filter((e) => e.source === 'chatgpt-import');
    expect(imported.map((e) => e.title)).toEqual(['newest', 'middle', 'oldest']);
  });
});

describe('updateWith (locked read-modify-write)', () => {
  it('applies fn against the fresh record — two sequential array appends both land', async () => {
    const created = await brainStorage.create('songs', { title: 'RMW Song', attachments: [] });
    const append = (meta) => brainStorage.updateWith('songs', created.id, (fresh) => ({
      attachments: [...fresh.attachments, meta],
    }));

    await append({ filename: 'a.pdf' });
    const second = await append({ filename: 'b.pdf' });
    expect(second.attachments.map((a) => a.filename)).toEqual(['a.pdf', 'b.pdf']);

    brainStorage.invalidateAllCaches();
    const stored = await brainStorage.getById('songs', created.id);
    expect(stored.attachments.map((a) => a.filename)).toEqual(['a.pdf', 'b.pdf']);
  });

  it('serializes concurrent updateWith calls so neither clobbers the other', async () => {
    const created = await brainStorage.create('songs', { title: 'Concurrent Song', attachments: [] });
    const append = (meta) => brainStorage.updateWith('songs', created.id, (fresh) => ({
      attachments: [...fresh.attachments, meta],
    }));

    // Fire both without awaiting in between — the store write lock must make
    // the second fn see the first's write (the race the snapshot+update()
    // pattern loses).
    await Promise.all([append({ filename: 'x.pdf' }), append({ filename: 'y.pdf' })]);

    brainStorage.invalidateAllCaches();
    const stored = await brainStorage.getById('songs', created.id);
    expect(stored.attachments.map((a) => a.filename).sort()).toEqual(['x.pdf', 'y.pdf']);
  });

  it('mirrors update() semantics: immutable fields preserved, updatedAt stamped', async () => {
    const created = await brainStorage.create('songs', { title: 'Stamp Song' });
    const updated = await brainStorage.updateWith('songs', created.id, () => ({ title: 'Renamed' }));
    expect(updated.title).toBe('Renamed');
    expect(updated.originInstanceId).toBe(created.originInstanceId);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt >= created.updatedAt).toBe(true);
  });

  it('returns null for a missing or tombstoned record without calling through', async () => {
    expect(await brainStorage.updateWith('songs', 'no-such-id', () => ({ title: 'x' }))).toBeNull();
    const created = await brainStorage.create('songs', { title: 'Gone Song' });
    await brainStorage.remove('songs', created.id);
    expect(await brainStorage.updateWith('songs', created.id, () => ({ title: 'x' }))).toBeNull();
  });

  it('aborts without writing when fn returns null', async () => {
    const created = await brainStorage.create('songs', { title: 'Abort Song' });
    expect(await brainStorage.updateWith('songs', created.id, () => null)).toBeNull();
    brainStorage.invalidateAllCaches();
    const stored = await brainStorage.getById('songs', created.id);
    expect(stored.title).toBe('Abort Song');
    expect(stored.updatedAt).toBe(created.updatedAt); // no write happened
  });
});

describe('reorderBuckets (batched sync log)', () => {
  it('writes all bucket orders and appends one sync-log batch', async () => {
    const first = await brainStorage.create('buckets', { name: 'First', order: 0 });
    const second = await brainStorage.create('buckets', { name: 'Second', order: 1 });
    brainSyncLog.appendChanges.mockClear();

    const reordered = await brainStorage.reorderBuckets([
      { id: second.id, order: 0 },
      { id: first.id, order: 1 },
    ]);

    expect(reordered.map(({ id, order }) => ({ id, order }))).toEqual([
      { id: second.id, order: 0 },
      { id: first.id, order: 1 },
    ]);
    expect(await brainStorage.getBucketById(first.id)).toMatchObject({ name: 'First', order: 1 });
    expect(await brainStorage.getBucketById(second.id)).toMatchObject({ name: 'Second', order: 0 });
    expect(brainSyncLog.appendChanges).toHaveBeenCalledTimes(1);
    expect(brainSyncLog.appendChanges).toHaveBeenCalledWith([
      expect.objectContaining({
        op: 'update',
        type: 'buckets',
        id: second.id,
        record: expect.objectContaining({ order: 0 }),
        originInstanceId: 'local-instance',
      }),
      expect.objectContaining({
        op: 'update',
        type: 'buckets',
        id: first.id,
        record: expect.objectContaining({ order: 1 }),
        originInstanceId: 'local-instance',
      }),
    ]);
  });
});

describe('songs entity enrollment (SongBook)', () => {
  it('lists songs in BRAIN_ENTITY_TYPES so sync/GC/backfill all cover it', () => {
    expect(brainStorage.BRAIN_ENTITY_TYPES).toContain('songs');
  });

  it('round-trips create/getAll/getById/remove through the generic entity API', async () => {
    const created = await brainStorage.create('songs', {
      title: 'Example Song',
      artist: 'The Placeholders',
      stage: 'new',
      attachments: [],
    });
    expect(created.id).toBeDefined();
    expect(created.originInstanceId).toBe('local-instance');

    const all = await brainStorage.getAll('songs');
    expect(all.find((s) => s.id === created.id)).toMatchObject({ title: 'Example Song' });

    expect(await brainStorage.remove('songs', created.id)).toBe(true);
    expect(await brainStorage.getById('songs', created.id)).toBeNull();
    // Tombstone retained in place (not hard-deleted) for LWW convergence.
    const raw = await rawRecord('songs', created.id);
    expect(raw._deleted).toBe(true);
  });
});

describe('listLiveIds (embedding-coverage id index, issue #3508)', () => {
  it('returns only live ids — archived and tombstoned records are excluded', async () => {
    const live = await brainStorage.create('ideas', { title: 'Live Idea' });
    const archived = await brainStorage.create('ideas', { title: 'Archived Idea' });
    const removed = await brainStorage.create('ideas', { title: 'Removed Idea' });
    await brainStorage.update('ideas', archived.id, { archived: true });
    await brainStorage.remove('ideas', removed.id);

    const ids = await brainStorage.listLiveIds('ideas');
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(archived.id);
    expect(ids).not.toContain(removed.id);
  });

  it('serves a repeat call from the index instead of re-parsing record bodies', async () => {
    const created = await brainStorage.create('projects', { name: 'Indexed Project' });
    expect(await brainStorage.listLiveIds('projects')).toContain(created.id);

    // Flip `archived` on disk BEHIND the store — no write path, so no event.
    // A re-read would see it; the index (correctly) does not, which is exactly
    // how we prove the second call did no body read.
    await writeRawRecord('projects', created.id, { name: 'Indexed Project', archived: true });
    expect(await brainStorage.listLiveIds('projects')).toContain(created.id);

    // …and the cache is droppable.
    brainStorage.invalidateAllCaches();
    expect(await brainStorage.listLiveIds('projects')).not.toContain(created.id);
  });

  it('re-reads a single record after a local write event', async () => {
    const created = await brainStorage.create('admin', { title: 'Admin Task' });
    expect(await brainStorage.listLiveIds('admin')).toContain(created.id);

    await brainStorage.update('admin', created.id, { archived: true });
    expect(await brainStorage.listLiveIds('admin')).not.toContain(created.id);
  });

  it('re-reads after an event-SILENT peer apply (record:changed)', async () => {
    // applyRemoteRecord never emits `${type}:upserted` (that would echo back to
    // the peer, #1077) — only the local-only `record:changed` signal, so the
    // index has to be listening for it or an inbound archive goes unnoticed.
    await brainStorage.applyRemoteRecord(
      'memories', 'peer-mem-1',
      { title: 'From Peer', updatedAt: ISO('2026-06-09'), originInstanceId: 'peer-x' },
      'create',
    );
    expect(await brainStorage.listLiveIds('memories')).toContain('peer-mem-1');

    await brainStorage.applyRemoteRecord(
      'memories', 'peer-mem-1',
      { title: 'From Peer', archived: true, updatedAt: ISO('2026-06-10'), originInstanceId: 'peer-x' },
      'update',
    );
    expect(await brainStorage.listLiveIds('memories')).not.toContain('peer-mem-1');
  });

  it('picks up creates and hard-prunes from the directory listing alone', async () => {
    const first = await brainStorage.create('buckets', { name: 'Bucket One' });
    expect(await brainStorage.listLiveIds('buckets')).toContain(first.id);

    const second = await brainStorage.create('buckets', { name: 'Bucket Two' });
    const both = await brainStorage.listLiveIds('buckets');
    expect(both).toEqual(expect.arrayContaining([first.id, second.id]));
  });
});

describe('Brain summary projection index (issue #5438)', () => {
  const recordBodyReads = () => readJSONFile.mock.calls.filter(([path]) =>
    /[/\\]brain[/\\][^/\\]+[/\\][^/\\]+[/\\]index\.json$/.test(path)
  ).length;

  it('preserves summary predicates while excluding tombstones and unreadable records', async () => {
    const before = await brainStorage.getSummary();
    const fixtures = {
      people: { name: 'Summary Person' },
      projects: { name: 'Summary Project', status: 'active' },
      ideas: { title: 'Summary Idea' },
      admin: { title: 'Summary Admin', status: 'open' },
      memories: { title: 'Summary Memory' },
      links: { url: 'https://example.com/summary-repo', isGitHubRepo: true },
      buckets: { name: 'Summary Bucket' },
    };

    for (const [type, record] of Object.entries(fixtures)) {
      await brainStorage.create(type, record);
      const archived = await brainStorage.create(type, { ...record, archived: true });
      expect(archived.id).toBeTruthy();
      const removed = await brainStorage.create(type, record);
      await brainStorage.remove(type, removed.id);
      writeCorruptRecord(type, `corrupt-summary-${type}`);
    }
    await brainStorage.createInboxLog({ text: 'Visible summary inbox', status: 'filed' });
    await brainStorage.createInboxLog({ text: 'Archived summary inbox', status: 'filed', archived: true });
    const removedInbox = await brainStorage.createInboxLog({ text: 'Removed summary inbox', status: 'filed' });
    await brainStorage.remove('inbox', removedInbox.id);
    writeCorruptRecord('inbox', 'corrupt-summary-inbox');
    brainStorage.invalidateAllCaches();

    const summary = await brainStorage.getSummary();
    expect(Object.keys(summary)).toEqual(Object.keys(before));
    expect(Object.keys(summary.counts)).toEqual(Object.keys(before.counts));
    for (const type of Object.keys(fixtures)) {
      expect(summary.counts[type]).toBe(before.counts[type] + 2);
    }
    expect(summary.counts.inbox.total).toBe(before.counts.inbox.total + 2);
    expect(summary.counts.inbox.filed).toBe(before.counts.inbox.filed + 2);
    expect(summary.activeProjects).toBe(before.activeProjects + 2);
    expect(summary.activeIdeas).toBe(before.activeIdeas + 2);
    expect(summary.openAdmin).toBe(before.openAdmin + 2);
    expect(summary.gitHubRepos).toBe(before.gitHubRepos + 2);
    expect(summary).toEqual(expect.objectContaining({
      needsReview: summary.counts.inbox.needs_review,
      lastDailyDigest: before.lastDailyDigest,
      lastWeeklyReview: before.lastWeeklyReview,
    }));
  });

  it('serves repeated summary and inbox counts without re-reading record bodies', async () => {
    await brainStorage.createInboxLog({ text: 'Summary cache', status: 'needs_review' });
    await brainStorage.getSummary();
    await brainStorage.getInboxLogCounts();
    const readsAfterPrime = recordBodyReads();

    await brainStorage.getSummary();
    await brainStorage.getInboxLogCounts();
    expect(recordBodyReads()).toBe(readsAfterPrime);
  });

  it('reflects local create, status update, delete, and peer-applied changes', async () => {
    const before = await brainStorage.getSummary();
    const project = await brainStorage.create('projects', { name: 'Mutable Summary', status: 'active' });
    expect((await brainStorage.getSummary()).activeProjects).toBe(before.activeProjects + 1);

    await brainStorage.update('projects', project.id, { status: 'done' });
    expect((await brainStorage.getSummary()).activeProjects).toBe(before.activeProjects);

    const inbox = await brainStorage.createInboxLog({ text: 'Remove me', status: 'needs_review' });
    const withInbox = await brainStorage.getInboxLogCounts();
    await brainStorage.remove('inbox', inbox.id);
    const withoutInbox = await brainStorage.getInboxLogCounts();
    expect(withoutInbox.total).toBe(withInbox.total - 1);
    expect(withoutInbox.needs_review).toBe(withInbox.needs_review - 1);

    await brainStorage.applyRemoteRecord('ideas', 'peer-summary-idea', {
      title: 'Peer Summary Idea', status: 'active', updatedAt: ISO('2099-01-01'), originInstanceId: 'peer-example',
    }, 'create');
    expect((await brainStorage.getSummary()).activeIdeas).toBe(before.activeIdeas + 1);
    await brainStorage.applyRemoteRecord('ideas', 'peer-summary-idea', {
      title: 'Peer Summary Idea', status: 'done', updatedAt: ISO('2099-01-02'), originInstanceId: 'peer-example',
    }, 'update');
    expect((await brainStorage.getSummary()).activeIdeas).toBe(before.activeIdeas);
  });
});

describe('getLinksPage (paginated link reads, issue #3509)', () => {
  // The temp store is shared by every test in this file, so assertions filter
  // the page down to the ids the test itself created rather than assuming the
  // links collection is empty.
  const mine = (page, ids) => page.links.map((l) => l.id).filter((id) => ids.includes(id));
  const linkCount = async () => (await brainStorage.getAll('links')).length;

  // Overwrite createdAt behind the store (create() stamps its own) and drop the
  // caches so the summary index picks the new sort key up.
  const stampCreatedAt = async (id, createdAt) => {
    await writeRawRecord('links', id, { ...(await rawRecord('links', id)), createdAt });
    brainStorage.invalidateAllCaches();
  };

  it('orders newest-first and returns only the requested window plus a full total', async () => {
    const older = await brainStorage.create('links', { url: 'https://example.com/older', linkType: 'article' });
    const newer = await brainStorage.create('links', { url: 'https://example.com/newer', linkType: 'article' });
    const newest = await brainStorage.create('links', { url: 'https://example.com/newest', linkType: 'article' });
    // Far-future stamps so these three are unambiguously the newest three links
    // in the shared store, whatever else the file has created.
    await stampCreatedAt(older.id, ISO('2099-01-01'));
    await stampCreatedAt(newer.id, ISO('2099-02-01'));
    await stampCreatedAt(newest.id, ISO('2099-03-01'));

    const first = await brainStorage.getLinksPage({ limit: 2, offset: 0 });
    expect(first.links.map((l) => l.id)).toEqual([newest.id, newer.id]);
    // `total` counts everything matching the filters, not the page.
    expect(first.total).toBe(await linkCount());
    // The page carries FULL records, not just the indexed summary fields.
    expect(first.links[0]).toMatchObject({ url: 'https://example.com/newest', linkType: 'article' });

    const second = await brainStorage.getLinksPage({ limit: 2, offset: 2 });
    expect(second.links[0].id).toBe(older.id);
    expect(second.total).toBe(first.total);
  });

  it('answers filtering and counting from the index, reading only the page bodies', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const l = await brainStorage.create('links', { url: `https://example.com/slice-${i}`, linkType: 'tool' });
      ids.push(l.id);
    }
    // Prime the summary index.
    expect(mine(await brainStorage.getLinksPage({ linkType: 'tool', limit: 50 }), ids)).toHaveLength(5);

    // Retype every one of them BEHIND the store — no write path, so no event and
    // no invalidation. Filtering/counting that still re-read bodies would now
    // return zero matches.
    for (const id of ids) {
      await writeRawRecord('links', id, { ...(await rawRecord('links', id)), linkType: 'other' });
    }

    const page = await brainStorage.getLinksPage({ linkType: 'tool', limit: 1, offset: 0 });
    expect(page.total).toBe(5);
    expect(page.links).toHaveLength(1);
    // …and the one body the page DID read is the fresh on-disk record — proof the
    // stale filter/count above came from the index, not from a whole-store re-read.
    expect(page.links[0].linkType).toBe('other');

    // The cache is droppable: a full re-read sees the retype and matches nothing.
    brainStorage.invalidateAllCaches();
    expect(mine(await brainStorage.getLinksPage({ linkType: 'tool', limit: 50 }), ids)).toHaveLength(0);
  });

  it('filters strictly on linkType and isGitHubRepo, matching the old in-memory filter', async () => {
    const repo = await brainStorage.create('links', { url: 'https://example.com/gh', linkType: 'github', isGitHubRepo: true });
    const plain = await brainStorage.create('links', { url: 'https://example.com/plain', linkType: 'documentation', isGitHubRepo: false });
    // No isGitHubRepo field at all — must NOT match `false`, exactly as the old
    // `l.isGitHubRepo === isGitHubRepo` filter behaved.
    const untyped = await brainStorage.create('links', { url: 'https://example.com/untyped', linkType: 'documentation' });
    const ids = [repo.id, plain.id, untyped.id];

    expect(mine(await brainStorage.getLinksPage({ isGitHubRepo: true, limit: 50 }), ids)).toEqual([repo.id]);
    expect(mine(await brainStorage.getLinksPage({ isGitHubRepo: false, limit: 50 }), ids)).toEqual([plain.id]);
    expect(mine(await brainStorage.getLinksPage({ linkType: 'documentation', limit: 50 }), ids).sort())
      .toEqual([plain.id, untyped.id].sort());
    expect(mine(await brainStorage.getLinksPage({ linkType: 'github', isGitHubRepo: true, limit: 50 }), ids))
      .toEqual([repo.id]);
    // An empty linkType means "no filter" (the route's old truthiness check), and
    // is NOT the same as omitting isGitHubRepo — `false` there is a real filter.
    expect(mine(await brainStorage.getLinksPage({ linkType: '', limit: 50 }), ids).sort())
      .toEqual(ids.slice().sort());
  });

  it('drops a link from the page as soon as it is deleted', async () => {
    const kept = await brainStorage.create('links', { url: 'https://example.com/kept', linkType: 'reference' });
    const gone = await brainStorage.create('links', { url: 'https://example.com/gone', linkType: 'reference' });
    const ids = [kept.id, gone.id];

    expect(mine(await brainStorage.getLinksPage({ linkType: 'reference', limit: 50 }), ids).sort())
      .toEqual(ids.slice().sort());

    // remove() tombstones in place — the id survives `listIds()`, so the index
    // has to drop it off the `links:deleted` event rather than the id diff.
    await brainStorage.remove('links', gone.id);

    expect(mine(await brainStorage.getLinksPage({ linkType: 'reference', limit: 50 }), ids)).toEqual([kept.id]);
  });

  it('orders createdAt ties by id so a page boundary never drops or duplicates a link', async () => {
    const shared = ISO('2098-04-01');
    const created = [];
    for (const n of ['a', 'b', 'c']) {
      created.push(await brainStorage.create('links', { url: `https://example.com/tie-${n}`, linkType: 'other' }));
    }
    const ids = created.map((l) => l.id);
    for (const id of ids) await stampCreatedAt(id, shared);

    const p1 = await brainStorage.getLinksPage({ linkType: 'other', limit: 2, offset: 0 });
    const p2 = await brainStorage.getLinksPage({ linkType: 'other', limit: 2, offset: 2 });
    const seen = [...mine(p1, ids), ...mine(p2, ids)];
    expect(new Set(seen).size).toBe(3);
    expect(seen.slice().sort()).toEqual(ids.slice().sort());
  });

  it('listLinkIds reports live ids and skips tombstones', async () => {
    const alive = await brainStorage.create('links', { url: 'https://example.com/alive' });
    const dead = await brainStorage.create('links', { url: 'https://example.com/dead' });
    await brainStorage.remove('links', dead.id);

    const ids = await brainStorage.listLinkIds();
    expect(ids).toContain(alive.id);
    expect(ids).not.toContain(dead.id);
  });

  it('getLinkByUrl resolves through the index and returns the full record', async () => {
    const created = await brainStorage.create('links', {
      url: 'https://example.com/by-url', linkType: 'documentation', title: 'Docs',
    });

    expect(await brainStorage.getLinkByUrl('https://example.com/by-url'))
      .toMatchObject({ id: created.id, title: 'Docs' });
    expect(await brainStorage.getLinkByUrl('https://example.com/never-saved')).toBeNull();

    // A deleted link's url must stop resolving.
    await brainStorage.remove('links', created.id);
    expect(await brainStorage.getLinkByUrl('https://example.com/by-url')).toBeNull();
  });
});

describe('getInboxLog (paginated inbox reads, issue #5440)', () => {
  const stampCapturedAt = async (id, capturedAt) => {
    const record = { ...(await rawRecord('inbox', id)) };
    if (capturedAt === undefined) delete record.capturedAt;
    else record.capturedAt = capturedAt;
    await writeRawRecord('inbox', id, record);
    brainStorage.invalidateAllCaches();
  };

  it('orders and filters deterministically, excluding tombstones and putting missing dates last', async () => {
    const oldest = await brainStorage.createInboxLog({ capturedText: 'oldest', status: 'done' });
    const tieA = await brainStorage.createInboxLog({ capturedText: 'tie-a', status: 'needs_review' });
    const tieB = await brainStorage.createInboxLog({ capturedText: 'tie-b', status: 'needs_review' });
    const newest = await brainStorage.createInboxLog({ capturedText: 'newest', status: 'filed' });
    const missing = await brainStorage.createInboxLog({ capturedText: 'missing', status: 'needs_review' });
    const removed = await brainStorage.createInboxLog({ capturedText: 'removed', status: 'needs_review' });

    await stampCapturedAt(oldest.id, ISO('2098-01-01'));
    await stampCapturedAt(tieA.id, ISO('2098-02-01'));
    await stampCapturedAt(tieB.id, ISO('2098-02-01'));
    await stampCapturedAt(newest.id, ISO('2098-03-01'));
    await stampCapturedAt(missing.id, undefined);
    await brainStorage.deleteInboxLog(removed.id);

    const tieIds = [tieA.id, tieB.id].sort();
    const expected = [newest.id, ...tieIds, oldest.id, missing.id];
    const seededIds = new Set(expected);
    const all = await brainStorage.getInboxLog({ limit: 100 });
    expect(all.filter(({ id }) => seededIds.has(id)).map(({ id }) => id)).toEqual(expected);

    const split = Math.ceil(all.length / 2);
    const pageOne = await brainStorage.getInboxLog({ limit: split, offset: 0 });
    const pageTwo = await brainStorage.getInboxLog({ limit: 100, offset: split });
    const pagedIds = [...pageOne, ...pageTwo].map(({ id }) => id);
    expect(pagedIds).toEqual(all.map(({ id }) => id));
    expect(new Set(pagedIds).size).toBe(all.length);
    expect((await brainStorage.getInboxLog({ status: 'needs_review' }))
      .filter(({ id }) => seededIds.has(id)).map(({ id }) => id))
      .toEqual([...tieIds, missing.id]);
  });

  it('reads only the requested page bodies once the summary index is warm', async () => {
    for (let i = 0; i < 8; i++) {
      await brainStorage.createInboxLog({ capturedText: `page-${i}`, status: 'needs_review' });
    }
    await brainStorage.getInboxLog({ status: 'needs_review', limit: 1 });

    readJSONFile.mockClear();
    const page = await brainStorage.getInboxLog({ status: 'needs_review', limit: 1 });

    expect(page).toHaveLength(1);
    await brainStorage.getInboxLogCounts();
    expect(readJSONFile).toHaveBeenCalledTimes(1);
  });

  it('invalidates the projection after status updates and deletes', async () => {
    const moved = await brainStorage.createInboxLog({ capturedText: 'move me', status: 'needs_review' });
    const removed = await brainStorage.createInboxLog({ capturedText: 'delete me', status: 'needs_review' });
    await brainStorage.getInboxLog({ status: 'needs_review' });
    const before = await brainStorage.getInboxLogCounts();

    await brainStorage.updateInboxLog(moved.id, { status: 'done' });
    await brainStorage.deleteInboxLog(removed.id);

    expect((await brainStorage.getInboxLog({ status: 'needs_review' })).map(({ id }) => id))
      .not.toEqual(expect.arrayContaining([moved.id, removed.id]));
    expect((await brainStorage.getInboxLog({ status: 'done' })).map(({ id }) => id)).toContain(moved.id);
    expect(await brainStorage.getInboxLogCounts()).toMatchObject({
      total: before.total - 1,
      needs_review: before.needs_review - 2,
      done: before.done + 1,
    });
  });
});

// Overwrite a record's stored JSON directly, bypassing every brainStorage write
// path (and therefore every brainEvents signal). Used to prove the live-id index
// is answering from memory rather than re-reading the file.
async function writeRawRecord(type, id, record) {
  const { PATHS, atomicWrite } = await import('../lib/fileUtils.js');
  await atomicWrite(join(PATHS.brain, type, id, 'index.json'), record);
}

function writeCorruptRecord(type, id) {
  const dir = join(getTempRoot(), 'brain', type, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.json'), '{not-json');
}

// Read the raw stored record (including tombstones) by bypassing the read
// filter. getRawRecords returns the per-record map with tombstones, so this is
// layout-agnostic (works against the collectionStore per-record files).
async function rawRecord(type, id) {
  const map = await brainStorage.getRawRecords(type);
  return map[id];
}

/**
 * Strict-read regression (#4115).
 *
 * `updateMeta` is `loadMeta → spread updates → saveMeta`. While the loader
 * swallowed unreadable files, a corrupt meta.json read as DEFAULT_META, so the
 * next settings update atomicWrote the shipped defaults over the user's
 * configured provider, model, digest times and review schedule. The result was
 * also cached for CACHE_TTL_MS, so the fabricated default outlived the read
 * that produced it.
 *
 * Corrupt JSON is the portable way to produce "present but unreadable" — it
 * fails the parse identically on every platform and needs no privileges.
 */
describe('brainStorage meta strict reads (#4115)', () => {
  const CORRUPT = '{"defaultProvider": "ollama",';
  const metaPath = () => join(getTempRoot(), 'brain', 'meta.json');

  beforeEach(() => {
    mkdirSync(join(getTempRoot(), 'brain'), { recursive: true });
    writeFileSync(metaPath(), CORRUPT);
    brainStorage.invalidateAllCaches();
  });

  afterEach(() => {
    rmSync(metaPath(), { force: true });
    brainStorage.invalidateAllCaches();
  });

  it('loadMeta rejects instead of fabricating the shipped defaults', async () => {
    await expect(brainStorage.loadMeta()).rejects.toThrow(/Unreadable JSON file/);
  });

  it('updateMeta leaves the unreadable file byte-for-byte intact', async () => {
    await expect(brainStorage.updateMeta({ confidenceThreshold: 0.9 })).rejects.toThrow(/Unreadable JSON file/);
    expect(
      readFileSync(metaPath(), 'utf8'),
      'overwriting the user settings we failed to read is the data loss this fixes'
    ).toBe(CORRUPT);
  });

  it('does not cache a fabricated default for later readers', async () => {
    await expect(brainStorage.loadMeta()).rejects.toThrow();
    // A cached default would make this second call resolve with DEFAULT_META.
    await expect(brainStorage.loadMeta()).rejects.toThrow(/Unreadable JSON file/);
  });

  it('still treats a genuinely absent meta.json as first-run defaults', async () => {
    rmSync(metaPath(), { force: true });
    brainStorage.invalidateAllCaches();
    const meta = await brainStorage.loadMeta();
    expect(meta.confidenceThreshold, 'ENOENT is the one errno that proves absence').toBe(0.6);
  });
});
