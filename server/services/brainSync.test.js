import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./brainStorage.js', () => ({
  applyRemoteRecord: vi.fn()
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
