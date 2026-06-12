import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so the vi.mock factory (also hoisted) can reference it without a TDZ error.
const { brainEvents } = vi.hoisted(() => {
  const { EventEmitter } = require('events');
  return { brainEvents: new EventEmitter() };
});

vi.mock('./brainStorage.js', () => ({
  applyRemoteRecord: vi.fn(),
  brainEvents,
  BRAIN_ENTITY_TYPES: ['people', 'projects', 'ideas', 'admin', 'memories', 'links', 'buckets', 'journals', 'inbox'],
}));

vi.mock('./brainSyncLog.js', () => ({
  appendChanges: vi.fn().mockResolvedValue([])
}));

import { applyRemoteRecord } from './brainStorage.js';
import { appendChanges } from './brainSyncLog.js';
import { applyRemoteChanges } from './brainSync.js';

describe('brainSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies create via applyRemoteRecord and counts as inserted', async () => {
    applyRemoteRecord.mockResolvedValue({ applied: true });

    const result = await applyRemoteChanges([
      { op: 'create', type: 'people', id: 'p1', record: { name: 'Alice', updatedAt: '2026-01-01T00:00:00.000Z' } }
    ]);

    expect(applyRemoteRecord).toHaveBeenCalledWith('people', 'p1', { name: 'Alice', updatedAt: '2026-01-01T00:00:00.000Z' }, 'create');
    expect(result.inserted).toBe(1);
  });

  it('applies update via applyRemoteRecord and counts as updated', async () => {
    applyRemoteRecord.mockResolvedValue({ applied: true, reason: undefined });

    const result = await applyRemoteChanges([
      { op: 'update', type: 'ideas', id: 'i1', record: { title: 'Updated', updatedAt: '2026-01-01T00:00:00.000Z' } }
    ]);

    expect(result.updated).toBe(1);
  });

  it('applies delete via applyRemoteRecord with timestamp for LWW', async () => {
    applyRemoteRecord.mockResolvedValue({ applied: true });
    const deleteRecord = { updatedAt: '2026-01-01T00:00:00.000Z' };

    const result = await applyRemoteChanges([
      { op: 'delete', type: 'projects', id: 'proj-1', record: deleteRecord }
    ]);

    expect(applyRemoteRecord).toHaveBeenCalledWith('projects', 'proj-1', deleteRecord, 'delete');
    expect(result.deleted).toBe(1);
  });

  it('skips unsupported types like digests and reviews', async () => {
    const result = await applyRemoteChanges([
      { op: 'create', type: 'digests', id: 'd1', record: { digestText: 'Today...' } },
      { op: 'update', type: 'reviews', id: 'r1', record: {} }
    ]);

    expect(applyRemoteRecord).not.toHaveBeenCalled();
    expect(result.skipped).toBe(2);
  });

  it('skips unknown entity types', async () => {
    const result = await applyRemoteChanges([
      { op: 'create', type: 'unknown_type', id: 'x1', record: { foo: 'bar' } }
    ]);

    expect(applyRemoteRecord).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('skips create/update when record is missing', async () => {
    const result = await applyRemoteChanges([
      { op: 'create', type: 'people', id: 'p2', record: null }
    ]);

    expect(applyRemoteRecord).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('counts as skipped when applyRemoteRecord returns applied:false', async () => {
    applyRemoteRecord.mockResolvedValue({ applied: false, reason: 'local_newer' });

    const result = await applyRemoteChanges([
      { op: 'update', type: 'admin', id: 'a1', record: { title: 'Old', updatedAt: '2020-01-01T00:00:00.000Z' } }
    ]);

    expect(result.skipped).toBe(1);
    expect(result.updated).toBe(0);
  });

  it('logs applied changes to sync log for relay to other peers', async () => {
    applyRemoteRecord.mockResolvedValue({ applied: true });

    await applyRemoteChanges([
      { op: 'create', type: 'people', id: 'p1', record: { name: 'A' }, originInstanceId: 'peer-1' }
    ]);

    expect(appendChanges).toHaveBeenCalledWith([
      { op: 'create', type: 'people', id: 'p1', record: { name: 'A' }, originInstanceId: 'peer-1' }
    ]);
  });

  it('does not log skipped changes to sync log', async () => {
    applyRemoteRecord.mockResolvedValue({ applied: false, reason: 'local_newer' });

    await applyRemoteChanges([
      { op: 'update', type: 'people', id: 'p1', record: { name: 'Old' }, originInstanceId: 'peer-1' }
    ]);

    expect(appendChanges).not.toHaveBeenCalled();
  });

  it('routes a forward-compat create carrying a tombstone (_deleted) through the delete path', async () => {
    applyRemoteRecord.mockResolvedValue({ applied: true });

    const result = await applyRemoteChanges([
      {
        op: 'create',
        type: 'people',
        id: 'p9',
        record: { _deleted: true, updatedAt: '2026-03-01T00:00:00.000Z', originInstanceId: 'peer-2' },
        originInstanceId: 'peer-2',
      },
    ]);

    // Applied as a DELETE with the wire-shape delete record (no _deleted leaks
    // into a live store write).
    expect(applyRemoteRecord).toHaveBeenCalledWith(
      'people', 'p9',
      { updatedAt: '2026-03-01T00:00:00.000Z', originInstanceId: 'peer-2' },
      'delete'
    );
    expect(result.deleted).toBe(1);
    expect(result.inserted).toBe(0);
  });

  it('emits a local-only sync:applied signal carrying applied {type,id}s (issue #1080)', async () => {
    applyRemoteRecord.mockResolvedValue({ applied: true });
    const seen = [];
    const listener = (payload) => seen.push(payload);
    brainEvents.on('sync:applied', listener);

    await applyRemoteChanges([
      { op: 'create', type: 'people', id: 'p1', record: { name: 'A', updatedAt: '2026-01-01T00:00:00.000Z' } },
      { op: 'update', type: 'ideas', id: 'i1', record: { title: 'B', updatedAt: '2026-01-01T00:00:00.000Z' } },
    ]);

    brainEvents.off('sync:applied', listener);
    expect(seen).toHaveLength(1);
    // Carries only {type,id} — the bridge re-reads canonical state itself.
    expect(seen[0].records).toEqual([
      { type: 'people', id: 'p1' },
      { type: 'ideas', id: 'i1' },
    ]);
  });

  it('does NOT emit sync:applied when every change is rejected (no relay batch)', async () => {
    applyRemoteRecord.mockResolvedValue({ applied: false, reason: 'local_newer' });
    const seen = [];
    const listener = (payload) => seen.push(payload);
    brainEvents.on('sync:applied', listener);

    await applyRemoteChanges([
      { op: 'update', type: 'people', id: 'p1', record: { name: 'Old', updatedAt: '2020-01-01T00:00:00.000Z' } },
    ]);

    brainEvents.off('sync:applied', listener);
    expect(seen).toHaveLength(0);
  });

  it('handles mixed operations correctly', async () => {
    applyRemoteRecord
      .mockResolvedValueOnce({ applied: true }) // create people
      .mockResolvedValueOnce({ applied: true }) // delete projects
      .mockResolvedValueOnce({ applied: false, reason: 'local_newer' }); // update ideas

    const result = await applyRemoteChanges([
      { op: 'create', type: 'people', id: 'p1', record: { name: 'A' } },
      { op: 'delete', type: 'projects', id: 'pr1', record: { updatedAt: '2026-01-01T00:00:00.000Z' } },
      { op: 'update', type: 'ideas', id: 'i1', record: { title: 'B', updatedAt: '2020-01-01T00:00:00.000Z' } },
      { op: 'create', type: 'digests', id: 'd1', record: { text: 'C' } },
      { op: 'create', type: 'bogus', id: 'x1', record: { foo: 1 } }
    ]);

    expect(result.inserted).toBe(1); // people
    expect(result.deleted).toBe(1);
    expect(result.skipped).toBe(3); // local_newer + digests + unknown type
  });
});
