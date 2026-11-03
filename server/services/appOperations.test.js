import { afterAll, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/paths.js', async original => makePathsProxy(await original(), {
  dataRoot: () => join(lazyTempDataRoot('observed-app-ops-'), 'data'),
}));

import { claimAppOperation, endAppOperation, listActiveAppOperations, runAppOperation } from './appOperations.js';
import { maintenance } from '../lib/maintenanceAdmission.js';

afterAll(cleanupTempDataRoots);

describe('observed app work', () => {
  it('distinguishes an execution promise from a retained claim or finished handoff', async () => {
    const io = { emit: vi.fn() };
    const { operation } = claimAppOperation(io, { id: 'example', name: 'Example', repoPath: '/example/app' }, 'update');
    expect(listActiveAppOperations()).toHaveLength(1);
    expect(listActiveAppOperations({ onlyRunning: true })).toEqual([]);
    let finish;
    const work = runAppOperation(operation, () => new Promise(resolve => { finish = resolve; }));
    try {
      expect(listActiveAppOperations({ onlyRunning: true })).toHaveLength(1);
      finish(); await work;
      expect(listActiveAppOperations({ onlyRunning: true })).toEqual([]);
      expect(listActiveAppOperations()).toHaveLength(1);
    } finally { finish?.(); await work; endAppOperation(io, 'example'); }
    await vi.waitFor(() => expect(maintenance.operations()).toEqual([]));
  });
});
