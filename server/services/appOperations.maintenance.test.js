import { afterEach, describe, expect, it, vi } from 'vitest';
import { maintenance } from '../lib/maintenanceAdmission.js';
import { __resetAppOperations, claimAppOperation, endAppOperation, handOffAppOperation,
  isSoleDeferredUpdateAppOperation, listActiveAppOperations } from './appOperations.js';

const io = { emit: vi.fn() };
const app = { id: 'portos-default', name: 'PortOS', repoPath: '/example/portos' };
afterEach(() => __resetAppOperations());

describe('app operations and deferred update admission', () => {
  it('fences a racing app operation on either side of the update hold', async () => {
    const claim = claimAppOperation(io, app, 'standardize');
    const update = maintenance.deferredUpdate.request();
    expect(maintenance.deferredUpdate.acquire(update.id)).toBe(false);
    endAppOperation(io, app.id);
    expect(maintenance.deferredUpdate.acquire(update.id)).toBe(true);
    expect(() => claimAppOperation(io, app, 'standardize')).toThrowError(expect.objectContaining({ code: 'MAINTENANCE_HELD' }));
    maintenance.deferredUpdate.finish(update.id, false);
    expect(claim.ok).toBe(true);
  });

  it('hands off only the matching self-update supervisor and keeps its UI operation visible', async () => {
    const { operation } = claimAppOperation(io, app, 'update');
    const snapshot = listActiveAppOperations();
    expect(isSoleDeferredUpdateAppOperation(snapshot, 12345)).toBe(false);
    await handOffAppOperation(operation, 12345);
    expect(isSoleDeferredUpdateAppOperation(snapshot, 12345)).toBe(true);
    expect(isSoleDeferredUpdateAppOperation(snapshot, 99999)).toBe(false);
    expect(isSoleDeferredUpdateAppOperation([{ ...snapshot[0], startedAt: -1 }], 12345)).toBe(false);
    expect(maintenance.operations()).toEqual([]);
    const second = claimAppOperation(io, { id: 'other', name: 'Other' }, 'update');
    expect(isSoleDeferredUpdateAppOperation(snapshot, 12345)).toBe(false);
    endAppOperation(io, 'other');
    expect(second.ok).toBe(true);
  });
});
