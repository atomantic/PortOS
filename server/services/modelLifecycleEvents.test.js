import { beforeEach, describe, expect, it, vi } from 'vitest';
import { modelLifecycleEvents } from './modelLifecycleEvents.js';
import * as imageModels from './imageTo3d/db.js';
import * as proceduralModels from './threejsModels/db.js';

const db = vi.hoisted(() => ({ current: null, committed: false, failCommit: false, events: [] }));
vi.mock('../lib/db.js', () => ({
  query: vi.fn(async () => ({ rows: [] })),
  withTransaction: vi.fn(async callback => {
    const result = await callback({ query: async sql => sql.startsWith('SELECT')
      ? { rows: [{ data: db.current }] } : { rows: [] } });
    if (db.failCommit) throw new Error('Example commit failure');
    db.committed = true;
    return result;
  }),
}));

describe.each([
  ['image-to-3d:changed', imageModels],
  ['threejs-model:changed', proceduralModels],
])('%s persistence boundary', (event, store) => {
  beforeEach(() => {
    db.current = { id: 'example-model', status: 'generating', runs: [] };
    db.committed = false;
    db.failCommit = false;
    db.events = [];
  });

  it('emits identity only after progress/terminal/delete commits, never for rollback or no-op', async () => {
    const listener = payload => db.events.push({ payload, committed: db.committed });
    modelLifecycleEvents.on(event, listener);
    try {
      await store.mutateModel('example-model', current => ({ ...current, runs: [{ percent: 50 }] }));
      expect(db.events).toEqual([{ payload: { id: 'example-model' }, committed: true }]);
      db.events = [];
      db.committed = false;
      db.failCommit = true;
      await expect(store.mutateModel('example-model', current => ({ ...current, status: 'ready' }))).rejects.toThrow('commit failure');
      expect(db.events).toEqual([]);
      db.failCommit = false;
      await store.mutateModel('example-model', () => null);
      expect(db.events).toEqual([]);
      await store.mutateModel('example-model', current => ({ ...current, status: 'failed' }));
      await store.deleteModel('example-model');
      expect(db.events).toEqual([
        { payload: { id: 'example-model' }, committed: true },
        { payload: { id: 'example-model' }, committed: true },
      ]);
    } finally {
      modelLifecycleEvents.off(event, listener);
    }
  });
});
