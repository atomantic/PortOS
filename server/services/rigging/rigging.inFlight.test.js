/**
 * The rig and retarget lanes share one in-flight slot per model (#18317): a failed
 * initial `rigging`/`retargeting` write must release it without clobbering the record,
 * and one lane running must refuse the other with 409 RIGGING_IN_FLIGHT.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../imageTo3d/db.js', () => ({ getModel: vi.fn(), mutateModel: vi.fn() }));
vi.mock('../../lib/databaseMaintenanceJournal.js', () => ({ assertDatabaseAdmission: () => {} }));

const store = await import('../imageTo3d/db.js');
const { rigImageTo3dModel } = await import('./autoSkin.js');
const { retargetImageTo3dModel } = await import('./retarget.js');
const { cancelRiggingForModel } = await import('./inFlight.js');
const { listActiveRenders } = await import('../renderActivity.js');

const MODEL_ID = 'image3d-example';
const rigResult = { rigId: 'rig-example', assetPath: '/rig.glb', sha256: 'a'.repeat(64), bytes: 1, summary: {} };
const retargetResult = { retargetId: 'rt-example', rigId: 'rig-example', clip: 'Walk', assetPath: '/rt.glb', sha256: 'b'.repeat(64), bytes: 1, summary: {} };

let current;
let writes;
const rig = (run = async () => rigResult) => rigImageTo3dModel(MODEL_ID, {}, { run, now: () => 't' });
const retarget = (run = async () => retargetResult) => retargetImageTo3dModel(MODEL_ID, { clip: 'walk.glb' }, {
  run, resolveClip: () => '/clips/walk.glb', now: () => 't',
});
const gate = () => {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
};

beforeEach(() => {
  vi.clearAllMocks();
  writes = [];
  current = {
    id: MODEL_ID,
    status: 'ready',
    assetPath: '/model.glb',
    rig: { status: 'ready', rigId: 'rig-example', skeletonHint: 'mixamo' },
  };
  store.getModel.mockImplementation(async () => current);
  store.mutateModel.mockImplementation(async (_id, mutate) => {
    current = mutate(current);
    writes.push(current);
    return current;
  });
});

describe.each([
  ['rig', rig, 'rig', (record) => record.rig],
  ['retarget', retarget, 'retarget', (record) => record.retarget],
])('%s lane initial transition failure', (_name, start, field) => {
  it('releases the slot and leaves the record untouched when the first write rejects', async () => {
    const before = structuredClone(current);
    store.mutateModel.mockRejectedValueOnce(new Error('connection reset'));

    await expect(start()).rejects.toThrow('connection reset');

    expect(store.mutateModel).toHaveBeenCalledTimes(1);
    expect(current).toEqual(before);
    // A follow-up request is accepted rather than refused with RIGGING_IN_FLIGHT.
    const updated = await start();
    expect(updated[field].status).toBe('ready');
  });
});

describe('a running retarget excludes a rig on the same model', () => {
  // The reverse (retarget during a rig) is already refused earlier by the record status
  // check, since a rig flips `rig.status` away from `ready` before the worker starts.
  it('refuses a rig while a retarget runs, then frees the slot', async () => {
    const held = gate();
    const retargeting = retarget(async () => { await held.promise; return retargetResult; });
    await vi.waitFor(() => expect(current.retarget?.status).toBe('retargeting'));

    await expect(rig()).rejects.toMatchObject({ status: 409, code: 'RIGGING_IN_FLIGHT' });

    held.release();
    await retargeting;
    expect((await rig()).rig.status).toBe('ready');
  });

  it('still records a failed run once the initial transition committed', async () => {
    await expect(rig(async () => { throw new Error('blender exploded'); })).rejects.toThrow('blender exploded');
    expect(current.rig.status).toBe('failed');
    expect((await rig()).rig.status).toBe('ready');
  });
});

describe.each([
  ['rig', rig, (record) => record.rig],
  ['retarget', retarget, (record) => record.retarget],
])('%s lane cancellation on model deletion', (_name, start, field) => {
  it('aborts the run signal, frees the lane and records the cancellation', async () => {
    let seen;
    const held = gate();
    const running = start(async ({ signal }) => {
      seen = signal;
      await held.promise;
      if (signal.aborted) {
        const { throwIfCancelled } = await import('./inFlight.js');
        throwIfCancelled(signal);
      }
      return rigResult;
    });
    await vi.waitFor(() => expect(seen).toBeDefined());
    expect(seen.aborted).toBe(false);

    expect(cancelRiggingForModel(MODEL_ID)).toBe(true);
    expect(seen.aborted).toBe(true);
    held.release();

    await expect(running).rejects.toMatchObject({ code: 'RIGGING_CANCELLED' });
    expect(field(current).status).toBe('failed');
    expect(cancelRiggingForModel(MODEL_ID)).toBe(false);
  });
});

describe.each([
  ['rig', rig, rigResult],
  ['retarget', retarget, retargetResult],
])('%s lane live activity registration', (_name, start, result) => {
  it('reports the run with its /3d link while running and clears it once settled', async () => {
    const held = gate();
    const running = start(async () => { await held.promise; return result; });
    await vi.waitFor(() => expect(listActiveRenders()).toEqual([
      expect.objectContaining({ kind: 'rigging', to: `/3d/${MODEL_ID}` }),
    ]));
    held.release();
    await running;
    expect(listActiveRenders()).toEqual([]);
  });

  it('clears the registration when the run fails', async () => {
    await expect(start(async () => { throw new Error('blender exploded'); })).rejects.toThrow('blender exploded');
    expect(listActiveRenders()).toEqual([]);
  });
});
