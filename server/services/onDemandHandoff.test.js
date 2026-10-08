import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'on-demand-handoff-' });
vi.mock('../lib/fileUtils.js', async () => makeProxy(await vi.importActual('../lib/fileUtils.js')));
const world = vi.hoisted(() => ({ tasks: [], fail: false }));
vi.mock('./cosTaskStore.js', () => ({ getAllTasks: async () => {
  if (world.fail) throw new Error('unreadable tasks');
  return { cos: { tasks: world.tasks }, user: { tasks: [] } };
} }));
const { updateSchedule, loadSchedule } = await import('./taskScheduleStore.js');
const { claimOnDemandRequest, settleOnDemandRequest, getOnDemandHandoffs } = await import('./onDemandHandoff.js');
const request = { id: 'demand-one', taskType: 'security', burn: { maintenanceRunId: 'maint-one', stepId: 'step-one' } };
beforeEach(async () => {
  world.tasks = []; world.fail = false;
  await updateSchedule(async schedule => {
    schedule.onDemandRequests = [request]; schedule.onDemandHandoffs = {};
    return { changed: true };
  });
});
afterAll(cleanup);
afterEach(() => vi.restoreAllMocks());

it('durably claims once across competing engines and keeps a slow live claim pending until exact-owner settlement', async () => {
  const claims = await Promise.all([claimOnDemandRequest(request.id), claimOnDemandRequest(request.id)]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  const claim = claims.find(Boolean);
  expect((await loadSchedule()).onDemandRequests).toEqual([]);
  await updateSchedule(async schedule => { schedule.onDemandHandoffs[request.id].claimedAt = '2000-01-01T00:00:00Z'; return { changed: true }; });
  expect((await getOnDemandHandoffs())[request.id].status).toBe('preparing');
  expect(await settleOnDemandRequest({ ...claim, token: 'stale' })).toBe(false);
  expect(await settleOnDemandRequest(claim, { taskId: 'task-one' })).toBe(true);
  expect(await settleOnDemandRequest(claim)).toBe(false);
  expect((await getOnDemandHandoffs())[request.id]).toMatchObject({ status: 'accepted', taskId: 'task-one' });
});

it('reconciles restart after task persistence and parks interrupted preparation without requeueing', async () => {
  await claimOnDemandRequest(request.id);
  await updateSchedule(async schedule => {
    schedule.onDemandHandoffs[request.id].owner = 'previous-process';
    schedule.onDemandHandoffs[request.id].ownerPid = 2147483647;
    schedule.onDemandHandoffs['demand-two'] = { ...schedule.onDemandHandoffs[request.id], request: { ...request, id: 'demand-two' } };
    return { changed: true };
  });
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  world.tasks = [{ id: 'task-one', metadata: { quotaBurnRequestId: request.id, quotaBurnMaintenanceRunId: 'maint-one', quotaBurnStepId: 'step-one' } }];
  world.fail = true;
  await expect(getOnDemandHandoffs()).rejects.toThrow('unreadable tasks');
  expect((await loadSchedule()).onDemandHandoffs[request.id].status).toBe('preparing');
  world.fail = false;
  const outcomes = await getOnDemandHandoffs();
  expect(outcomes[request.id]).toMatchObject({ status: 'accepted', taskId: 'task-one' });
  expect(outcomes['demand-two'].status).toBe('interrupted');
  expect((await loadSchedule()).onDemandRequests).toEqual([]);
  expect(await getOnDemandHandoffs()).toEqual(outcomes);
});


it('preserves another live owner, ambiguous liveness and missing identity despite a different nonce', async () => {
  await claimOnDemandRequest(request.id);
  await updateSchedule(async schedule => {
    schedule.onDemandHandoffs[request.id].owner = 'another-live-process';
    return { changed: true };
  });
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  expect((await getOnDemandHandoffs())[request.id].status).toBe('preparing');
  expect(kill).toHaveBeenCalledWith(process.pid, 0);
  kill.mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
  expect((await getOnDemandHandoffs())[request.id].status).toBe('preparing');
  await updateSchedule(async schedule => { delete schedule.onDemandHandoffs[request.id].ownerPid; return { changed: true }; });
  kill.mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  expect((await getOnDemandHandoffs())[request.id].status).toBe('preparing');
});

it('never overwrites an existing receipt even if the same request is queued again', async () => {
  const claim = await claimOnDemandRequest(request.id);
  await settleOnDemandRequest(claim, { taskId: 'accepted-task' });
  const receipt = (await getOnDemandHandoffs())[request.id];
  await updateSchedule(async schedule => { schedule.onDemandRequests.push(request); return { changed: true }; });
  expect(await claimOnDemandRequest(request.id)).toBeNull();
  expect((await getOnDemandHandoffs())[request.id]).toEqual(receipt);
  expect((await loadSchedule()).onDemandRequests).toEqual([request]);
});
