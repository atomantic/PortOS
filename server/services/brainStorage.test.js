import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
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
  return makePathsProxy(actual, {
    dataRoot: () => getTempRoot(),
    extraOverrides: (dataRoot) => ({ brain: join(dataRoot, 'brain') }),
  });
});

// getInstanceId is used by create()/backfill; stub to a stable id.
vi.mock('./instances.js', () => ({
  getInstanceId: () => Promise.resolve('local-instance'),
}));

import * as brainStorage from './brainStorage.js';

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
    const pruned = await brainStorage.pruneTombstones('memories', cutoff);
    expect(pruned).toBe(1); // only the 2020 tombstone

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

// Read the raw stored record (including tombstones) by bypassing the read filter.
async function rawRecord(type, id) {
  const { readFile } = await import('fs/promises');
  const file = join(getTempRoot(), 'brain', `${type}.json`);
  const data = JSON.parse(await readFile(file, 'utf-8'));
  return data.records[id];
}
