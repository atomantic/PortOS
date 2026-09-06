/**
 * Exactly-once burn accounting across an ASYNCHRONOUS acceptance.
 *
 * A workflow test against the real `data/cos/` stores (re-rooted at a temp
 * tree), not a mock-called-a-mock check: the whole point of the reservation is
 * that it survives a persistence round trip and a process restart, which only a
 * suite that actually writes the files can observe. The two things a reservation
 * is settled AGAINST — whether the request is still queued, and whether it
 * produced a task — are the only doubles here, because they are the parts of the
 * world this module reads rather than owns.
 *
 * Each case names the double-accounting it uniquely catches; between them they
 * cover the ledger half of #6379's acceptance criteria (the runner's own
 * reserve-vs-charge contract, and the duplicate-invocation skip, are pinned in
 * `quotaBurnRunner.test.js`).
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'quota-burn-acceptance-'));

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: TEST_DATA_ROOT }));

// The async world this module reads: what is still waiting on the schedule, and
// what the on-demand engines actually produced.
const world = { requests: [], tasks: [], requestsThrow: false, tasksThrow: false };

vi.mock('./taskSchedule.js', () => ({
  getOnDemandRequests: vi.fn(async () => {
    if (world.requestsThrow) throw new Error('schedule unreadable');
    return world.requests;
  }),
}));

vi.mock('./cosTaskStore.js', () => ({
  getAllTasks: vi.fn(async () => {
    if (world.tasksThrow) throw new Error('COS-TASKS.md unreadable');
    return { cos: { tasks: world.tasks }, user: { tasks: [] } };
  }),
}));

const { getQuotaBurnDispatches } = await import('./quotaBurn.js');
const { getQuotaBurnCompletions } = await import('./quotaBurnCompletions.js');
const {
  getQuotaBurnReservations,
  getQuotaBurnRuns,
  quotaBurnReservationKey,
  recordQuotaBurnRun,
} = await import('./quotaBurnStore.js');
const { reconcileQuotaBurnReservations, reserveQuotaBurnDispatch } = await import('./quotaBurnAcceptance.js');

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

// A LIVE window key. The dispatch ledger prunes keys older than its 30-day
// retention on every write, so a hardcoded past epoch would silently re-collapse
// to 1 on a second charge and make every 'exactly once' assertion here vacuous.
const DISPATCH_KEY = `grok:${Math.round(Date.now() / 3600_000) * 3600_000}`;
const REQUEST_ID = 'demand-1';

const reservation = (overrides = {}) => ({
  familyId: 'grok',
  stepId: 'step-a',
  dispatchKey: DISPATCH_KEY,
  charge: true,
  runOnce: false,
  requestId: REQUEST_ID,
  ...overrides,
});

/** The step's row as the runner writes it at dispatch, before acceptance. */
const pendingRunRow = async (requestId = REQUEST_ID) => recordQuotaBurnRun({
  dispatched: true, familyId: 'grok', jobId: 'step-a', requestId, pending: true, taskId: null, charged: false,
});

const burnTask = (id, requestId = REQUEST_ID) => ({
  id,
  metadata: { quotaBurnFamily: 'grok', quotaBurnStepId: 'step-a', quotaBurnRequestId: requestId },
});

beforeEach(async () => {
  rmSync(join(TEST_DATA_ROOT, 'cos'), { recursive: true, force: true });
  world.requests = [];
  world.tasks = [];
  world.requestsThrow = false;
  world.tasksThrow = false;
  vi.clearAllMocks();
});

describe('reserving a burn whose acceptance is asynchronous', () => {
  it('holds the step without charging, so a request that may still be refused costs nothing', async () => {
    expect(await reserveQuotaBurnDispatch(reservation())).toBe(true);

    expect(await getQuotaBurnReservations()).toHaveProperty(quotaBurnReservationKey('grok', 'step-a'));
    // The whole regression: charging here is what #3179 fixed in the dispatch
    // ledger, and the reference path reintroduced it one hop earlier.
    expect(await getQuotaBurnDispatches()).toEqual({});
    expect(await getQuotaBurnCompletions()).toEqual({});
  });

  it('refuses a second reservation for the same step', async () => {
    await reserveQuotaBurnDispatch(reservation());
    expect(await reserveQuotaBurnDispatch(reservation({ requestId: 'demand-2' }))).toBe(false);
    expect(Object.keys(await getQuotaBurnReservations())).toHaveLength(1);
  });
});

describe('settling a reservation against what the request produced', () => {
  it('charges an accepted burn exactly once and records the task id on its run-log row', async () => {
    await pendingRunRow();
    await reserveQuotaBurnDispatch(reservation({ runOnce: true }));
    world.tasks = [burnTask('cos-42')];

    expect(await reconcileQuotaBurnReservations()).toMatchObject({ accepted: 1, refused: 0 });

    expect(await getQuotaBurnDispatches()).toEqual({ [DISPATCH_KEY]: 1 });
    expect(await getQuotaBurnCompletions()).toHaveProperty('grok:step-a');
    expect(await getQuotaBurnReservations()).toEqual({});
    // #6379's run-log criterion: the accepted TASK, not just the request.
    expect((await getQuotaBurnRuns())[0]).toMatchObject({
      requestId: REQUEST_ID, pending: false, accepted: true, taskId: 'cos-42', charged: true,
    });
  });

  it('releases a refused request without touching the cap or the run-once ledger', async () => {
    await pendingRunRow();
    await reserveQuotaBurnDispatch(reservation({ runOnce: true }));
    // The request drained and the engine refused it (improvement off, task type
    // disabled since queuing, app gone, generator produced nothing…): the
    // request is no longer queued and no task carries its id.
    world.requests = [];
    world.tasks = [];

    expect(await reconcileQuotaBurnReservations()).toMatchObject({ accepted: 0, refused: 1 });

    expect(await getQuotaBurnDispatches()).toEqual({});
    expect(await getQuotaBurnCompletions()).toEqual({});
    expect(await getQuotaBurnReservations()).toEqual({});
    expect((await getQuotaBurnRuns())[0]).toMatchObject({ pending: false, accepted: false });
  });

  it('leaves a still-queued request alone, so the step stays held across a restart', async () => {
    await reserveQuotaBurnDispatch(reservation());
    world.requests = [{ id: REQUEST_ID, taskType: 'ux', origin: 'quota-burn' }];

    expect(await reconcileQuotaBurnReservations()).toMatchObject({ accepted: 0, refused: 0 });
    expect(await getQuotaBurnReservations()).toHaveProperty(quotaBurnReservationKey('grok', 'step-a'));
    expect(await getQuotaBurnDispatches()).toEqual({});

    // The engine drains it after the restart; the reservation read back off disk
    // still carries the terms the dispatch was made under.
    world.requests = [];
    world.tasks = [burnTask('cos-77')];
    await reconcileQuotaBurnReservations();
    expect(await getQuotaBurnDispatches()).toEqual({ [DISPATCH_KEY]: 1 });
  });

  it('marks a forced burn spent without charging the automatic budget', async () => {
    await reserveQuotaBurnDispatch(reservation({ charge: false, runOnce: true }));
    world.tasks = [burnTask('cos-9')];

    await reconcileQuotaBurnReservations();

    // `charge` and `runOnce` answer different questions — the window's budget
    // versus "this work only needed doing once".
    expect(await getQuotaBurnDispatches()).toEqual({});
    expect(await getQuotaBurnCompletions()).toHaveProperty('grok:step-a');
  });

  it('does not credit a burn to an ordinary clock-driven run of the same task', async () => {
    await reserveQuotaBurnDispatch(reservation({ runOnce: true }));
    // Same task type, fired by its own schedule: no burn provenance, so nothing
    // joins it to the reservation and it must leave both ledgers untouched.
    world.tasks = [{ id: 'cos-cron', metadata: { onDemand: true, onDemandOrigin: 'user' } }];

    await reconcileQuotaBurnReservations();

    expect(await getQuotaBurnDispatches()).toEqual({});
    expect(await getQuotaBurnCompletions()).toEqual({});
  });

  it('honors a charge already claimed before a crash instead of charging twice', async () => {
    await reserveQuotaBurnDispatch(reservation());
    // What a process killed between the ledger write and the release leaves
    // behind: the claim is on disk, and the ledger it authorized already landed.
    const { markQuotaBurnReservationCharged } = await import('./quotaBurnStore.js');
    const { recordQuotaBurnDispatch } = await import('./quotaBurn.js');
    await markQuotaBurnReservationCharged(quotaBurnReservationKey('grok', 'step-a'), Date.now());
    await recordQuotaBurnDispatch(DISPATCH_KEY);
    world.tasks = [burnTask('cos-11')];

    await reconcileQuotaBurnReservations();

    expect(await getQuotaBurnDispatches()).toEqual({ [DISPATCH_KEY]: 1 });
    expect(await getQuotaBurnReservations()).toEqual({});
  });
});

describe('reads it cannot trust', () => {
  it('defers every reservation when the schedule cannot be read', async () => {
    await reserveQuotaBurnDispatch(reservation());
    world.requestsThrow = true;

    expect(await reconcileQuotaBurnReservations()).toMatchObject({ deferred: expect.any(String) });
    expect(await getQuotaBurnReservations()).toHaveProperty(quotaBurnReservationKey('grok', 'step-a'));
  });

  it('defers rather than calling a burn refused when the task queue cannot be read', async () => {
    await reserveQuotaBurnDispatch(reservation());
    world.tasksThrow = true;

    // Reading "no task" out of a failed read would release the reservation,
    // re-open the cap, and lose the charge for work that IS running.
    expect(await reconcileQuotaBurnReservations()).toMatchObject({ deferred: expect.any(String) });
    expect(await getQuotaBurnReservations()).toHaveProperty(quotaBurnReservationKey('grok', 'step-a'));
    expect(await getQuotaBurnDispatches()).toEqual({});
  });
});
