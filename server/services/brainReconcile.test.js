import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so the vi.mock factory (also hoisted) can reference it without a TDZ error.
const { brainEvents } = vi.hoisted(() => {
  const { EventEmitter } = require('events');
  return { brainEvents: new EventEmitter() };
});

// brainStorage is the data layer; mock it so the reconcile logic is tested in
// isolation (matching the inline-copy / mock style used across sync tests).
vi.mock('./brainStorage.js', () => ({
  BRAIN_ENTITY_TYPES: ['people', 'projects', 'ideas', 'admin', 'memories', 'links', 'buckets', 'journals', 'inbox'],
  getRawRecords: vi.fn(),
  applyRemoteRecord: vi.fn(),
  brainEvents,
}));
vi.mock('./brainSyncLog.js', () => ({
  appendChanges: vi.fn().mockResolvedValue([]),
}));

import * as brainStorage from './brainStorage.js';
import * as brainSyncLog from './brainSyncLog.js';
import { getBrainChecksum, getBrainSnapshot, applyBrainSnapshot } from './brainReconcile.js';

// Default: every store empty unless a test overrides a specific type.
function emptyStores(overrides = {}) {
  brainStorage.getRawRecords.mockImplementation(async (type) => overrides[type] ?? {});
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('brainReconcile checksum', () => {
  it('is deterministic regardless of record/type key order', async () => {
    emptyStores({
      links: {
        b: { id: 'b', updatedAt: '2026-01-02T00:00:00.000Z', title: 'B' },
        a: { id: 'a', updatedAt: '2026-01-01T00:00:00.000Z', title: 'A' },
      },
    });
    const c1 = await getBrainChecksum();

    // Same data, opposite insertion order → identical checksum.
    emptyStores({
      links: {
        a: { id: 'a', updatedAt: '2026-01-01T00:00:00.000Z', title: 'A' },
        b: { id: 'b', updatedAt: '2026-01-02T00:00:00.000Z', title: 'B' },
      },
    });
    const c2 = await getBrainChecksum();

    expect(c1).toBe(c2);
  });

  it('changes when a record changes', async () => {
    emptyStores({ links: { a: { id: 'a', updatedAt: '2026-01-01T00:00:00.000Z', title: 'A' } } });
    const before = await getBrainChecksum();
    emptyStores({ links: { a: { id: 'a', updatedAt: '2026-01-03T00:00:00.000Z', title: 'A2' } } });
    const after = await getBrainChecksum();
    expect(before).not.toBe(after);
  });

  it('includes tombstones in the checksum (a delete changes converged state)', async () => {
    emptyStores({ links: { a: { id: 'a', updatedAt: '2026-01-01T00:00:00.000Z', title: 'A' } } });
    const live = await getBrainChecksum();
    emptyStores({ links: { a: { _deleted: true, updatedAt: '2026-01-05T00:00:00.000Z', deletedAt: '2026-01-05T00:00:00.000Z', originInstanceId: 'x' } } });
    const tomb = await getBrainChecksum();
    expect(live).not.toBe(tomb);
  });

  // Release review finding: `deletedAt` is a machine-local GC clock — two peers
  // stamp it at different instants for the same logical delete (and migration 080
  // sets it to its own run time). Hashing it would make two converged peers
  // mismatch forever and re-pull the snapshot every cycle. It must be EXCLUDED
  // from the checksum; `updatedAt` (the LWW clock) still distinguishes deletes.
  it('ignores deletedAt (the local GC clock) so two peers converge on a delete', async () => {
    emptyStores({ links: { a: { _deleted: true, updatedAt: '2026-01-05T00:00:00.000Z', deletedAt: '2026-01-05T00:00:00.000Z', originInstanceId: 'x' } } });
    const peerA = await getBrainChecksum();
    // Same logical tombstone, different deletedAt (saw the delete a day later).
    emptyStores({ links: { a: { _deleted: true, updatedAt: '2026-01-05T00:00:00.000Z', deletedAt: '2026-01-06T12:34:56.000Z', originInstanceId: 'x' } } });
    const peerB = await getBrainChecksum();
    expect(peerA).toBe(peerB);
  });

  it('still distinguishes two tombstones with different updatedAt (LWW clock)', async () => {
    emptyStores({ links: { a: { _deleted: true, updatedAt: '2026-01-05T00:00:00.000Z', deletedAt: '2026-01-05T00:00:00.000Z', originInstanceId: 'x' } } });
    const older = await getBrainChecksum();
    emptyStores({ links: { a: { _deleted: true, updatedAt: '2026-01-09T00:00:00.000Z', deletedAt: '2026-01-05T00:00:00.000Z', originInstanceId: 'x' } } });
    const newer = await getBrainChecksum();
    expect(older).not.toBe(newer);
  });

  // #1077 review finding: plain JSON.stringify preserves field-insertion order,
  // so two installs holding the SAME logical record (e.g. one migrated by
  // backfillOriginInstanceId, which appends originInstanceId LAST) would hash
  // differently and re-pull the snapshot every cycle for no reason.
  it('is independent of per-record FIELD order (stable stringify)', async () => {
    emptyStores({ links: { a: { id: 'a', title: 'A', updatedAt: '2026-01-01T00:00:00.000Z', originInstanceId: 'inst-1' } } });
    const c1 = await getBrainChecksum();

    // Identical record, fields in a different order (as a migrated record would be).
    emptyStores({ links: { a: { originInstanceId: 'inst-1', updatedAt: '2026-01-01T00:00:00.000Z', id: 'a', title: 'A' } } });
    const c2 = await getBrainChecksum();

    expect(c1).toBe(c2);
  });
});

describe('brainReconcile snapshot', () => {
  it('returns the raw record map + matching checksum', async () => {
    emptyStores({ projects: { p1: { id: 'p1', updatedAt: '2026-01-01T00:00:00.000Z', name: 'P' } } });
    const snap = await getBrainSnapshot();
    expect(snap.records.projects.p1.name).toBe('P');
    expect(snap.checksum).toBe(await getBrainChecksum());
  });
});

describe('applyBrainSnapshot', () => {
  it('upserts live records and tombstones deletes via applyRemoteRecord (LWW)', async () => {
    brainStorage.applyRemoteRecord.mockResolvedValue({ applied: true });
    const snapshot = {
      records: {
        links: {
          live1: { id: 'live1', updatedAt: '2026-01-02T00:00:00.000Z', title: 'L' },
          dead1: { _deleted: true, updatedAt: '2026-01-03T00:00:00.000Z', originInstanceId: 'peer' },
        },
      },
    };
    const res = await applyBrainSnapshot(snapshot);

    expect(brainStorage.applyRemoteRecord).toHaveBeenCalledWith(
      'links', 'live1', snapshot.records.links.live1, 'update');
    expect(brainStorage.applyRemoteRecord).toHaveBeenCalledWith(
      'links', 'dead1', { updatedAt: '2026-01-03T00:00:00.000Z', originInstanceId: 'peer' }, 'delete');
    expect(res).toEqual({ inserted: 0, updated: 1, deleted: 1, skipped: 0 });
  });

  it('relays ONLY applied changes to the sync log (no echo amplification)', async () => {
    // First record applies, second is rejected (local_newer) — only the first relays.
    brainStorage.applyRemoteRecord
      .mockResolvedValueOnce({ applied: true })
      .mockResolvedValueOnce({ applied: false, reason: 'local_newer' });
    await applyBrainSnapshot({
      records: { links: {
        x: { id: 'x', updatedAt: '2026-01-02T00:00:00.000Z', title: 'X' },
        y: { id: 'y', updatedAt: '2026-01-01T00:00:00.000Z', title: 'Y' },
      } },
    });
    expect(brainSyncLog.appendChanges).toHaveBeenCalledTimes(1);
    const relayed = brainSyncLog.appendChanges.mock.calls[0][0];
    expect(relayed.map(r => r.id)).toEqual(['x']);
  });

  it('emits a local-only sync:applied signal for reconciled records (issue #1080)', async () => {
    brainStorage.applyRemoteRecord
      .mockResolvedValueOnce({ applied: true })
      .mockResolvedValueOnce({ applied: false, reason: 'local_newer' });
    const seen = [];
    const listener = (payload) => seen.push(payload);
    brainEvents.on('sync:applied', listener);

    await applyBrainSnapshot({
      records: { links: {
        x: { id: 'x', updatedAt: '2026-01-02T00:00:00.000Z', title: 'X' },
        y: { id: 'y', updatedAt: '2026-01-01T00:00:00.000Z', title: 'Y' },
      } },
    });

    brainEvents.off('sync:applied', listener);
    expect(seen).toHaveLength(1);
    // Only the APPLIED record is signalled (the rejected LWW op is not).
    expect(seen[0].records).toEqual([{ type: 'links', id: 'x' }]);
  });

  it('does NOT emit sync:applied when nothing applies', async () => {
    brainStorage.applyRemoteRecord.mockResolvedValue({ applied: false, reason: 'local_newer' });
    const seen = [];
    const listener = (payload) => seen.push(payload);
    brainEvents.on('sync:applied', listener);

    await applyBrainSnapshot({
      records: { links: { y: { id: 'y', updatedAt: '2020-01-01T00:00:00.000Z', title: 'Y' } } },
    });

    brainEvents.off('sync:applied', listener);
    expect(seen).toHaveLength(0);
  });

  it('skips records missing updatedAt (no LWW clock) and unknown types', async () => {
    brainStorage.applyRemoteRecord.mockResolvedValue({ applied: true });
    const res = await applyBrainSnapshot({
      records: {
        links: { noClock: { id: 'noClock', title: 'no ts' } },
        bogusType: { z: { id: 'z', updatedAt: '2026-01-02T00:00:00.000Z' } },
      },
    });
    expect(brainStorage.applyRemoteRecord).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1); // only the known-type no-clock record counts as skipped
  });

  it('tolerates a missing/!object records payload', async () => {
    const res = await applyBrainSnapshot({});
    expect(res).toEqual({ inserted: 0, updated: 0, deleted: 0, skipped: 0 });
    expect(brainStorage.applyRemoteRecord).not.toHaveBeenCalled();
  });

  // #1077 review finding: a peer record under a dangerous prototype id can
  // never persist/converge (dropped on write) but would still report applied
  // and emit a phantom relay. Reject those ids up front.
  it('skips dangerous prototype ids without applying or relaying', async () => {
    brainStorage.applyRemoteRecord.mockResolvedValue({ applied: true });
    // Build via JSON.parse to match the production path (res.json()): a JSON
    // `"__proto__"` key becomes a real OWN enumerable property, unlike an object
    // literal where `__proto__:` would set the prototype and never reach the loop.
    const snapshot = JSON.parse(JSON.stringify({ records: { links: {} } }));
    snapshot.records.links = JSON.parse(`{
      "__proto__": { "updatedAt": "2026-01-02T00:00:00.000Z", "title": "evil" },
      "constructor": { "updatedAt": "2026-01-02T00:00:00.000Z", "title": "evil" },
      "prototype": { "updatedAt": "2026-01-02T00:00:00.000Z", "title": "evil" },
      "ok": { "id": "ok", "updatedAt": "2026-01-02T00:00:00.000Z", "title": "good" }
    }`);
    const res = await applyBrainSnapshot(snapshot);
    // Only the legitimate id is applied; the three prototype keys are skipped.
    expect(brainStorage.applyRemoteRecord).toHaveBeenCalledTimes(1);
    expect(brainStorage.applyRemoteRecord).toHaveBeenCalledWith(
      'links', 'ok', expect.objectContaining({ id: 'ok' }), 'update');
    expect(res.updated).toBe(1);
  });
});
