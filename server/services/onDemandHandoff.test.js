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
    schedule.onDemandRequests = [request]; schedule.onDemandHandoffs = {}; schedule.swarmCleanupRefillPending = {};
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

it('requeues an interrupted cleanup refill and keeps its source fence until admission', async () => {
  const refill = { id: 'refill-one', taskType: 'claim-issue', appId: 'app-one', origin: 'refill', cleanupSourceAgentId: 'agent-one' };
  await updateSchedule(async schedule => {
    schedule.onDemandRequests = [refill]; schedule.swarmCleanupRefillPending = { 'agent-one': { ...refill, sourceMarked: true } };
    return { changed: true };
  });
  await claimOnDemandRequest(refill.id);
  await updateSchedule(async schedule => {
    schedule.onDemandHandoffs[refill.id].owner = 'previous-process';
    schedule.onDemandHandoffs[refill.id].ownerPid = 2147483647;
    return { changed: true };
  });
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  expect((await getOnDemandHandoffs())[refill.id]).toBeUndefined();
  let schedule = await loadSchedule();
  expect(schedule.onDemandRequests).toEqual([refill]);
  expect(schedule.swarmCleanupRefillPending['agent-one']).toMatchObject({ id: refill.id, sourceMarked: true });
  const retry = await claimOnDemandRequest(refill.id);
  await settleOnDemandRequest(retry, { taskId: 'sys-swarm-refill-agent-one' });
  schedule = await loadSchedule();
  expect(schedule.onDemandHandoffs[refill.id]).toMatchObject({ status: 'accepted', taskId: 'sys-swarm-refill-agent-one' });
  expect(schedule.swarmCleanupRefillPending['agent-one']).toBeUndefined();
});

it('recognizes a persisted cleanup successor after an interrupted admission', async () => {
  const refill = { id: 'refill-two', taskType: 'claim-issue', appId: 'app-one', origin: 'refill', cleanupSourceAgentId: 'agent-two' };
  await updateSchedule(async schedule => {
    schedule.onDemandRequests = [refill]; schedule.swarmCleanupRefillPending = { 'agent-two': refill };
    return { changed: true };
  });
  await claimOnDemandRequest(refill.id);
  await updateSchedule(async schedule => {
    schedule.onDemandHandoffs[refill.id].owner = 'previous-process';
    schedule.onDemandHandoffs[refill.id].ownerPid = 2147483647;
    return { changed: true };
  });
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  world.tasks = [{ id: 'sys-swarm-refill-agent-two', metadata: { cleanupRefillSource: 'agent-two', idempotencyKey: 'swarm-cleanup-refill:agent-two' } }];
  expect((await getOnDemandHandoffs())[refill.id]).toMatchObject({ status: 'accepted', taskId: 'sys-swarm-refill-agent-two' });
  const schedule = await loadSchedule();
  expect(schedule.onDemandRequests).toEqual([]);
  // The source has not been marked yet, so replay must retain this receipt.
  expect(schedule.swarmCleanupRefillPending['agent-two']).toMatchObject({ id: refill.id });
});

it('requeues a transient admission failure without losing its cleanup source', async () => {
  const refill = { id: 'refill-three', taskType: 'claim-issue', appId: 'app-one', origin: 'refill', cleanupSourceAgentId: 'agent-three' };
  await updateSchedule(async schedule => {
    schedule.onDemandRequests = [refill]; schedule.swarmCleanupRefillPending = { 'agent-three': refill };
    return { changed: true };
  });
  const claim = await claimOnDemandRequest(refill.id);
  expect(await settleOnDemandRequest(claim, { reason: 'temporarily busy', retry: true })).toBe(true);
  const schedule = await loadSchedule();
  expect(schedule.onDemandRequests).toEqual([refill]);
  expect(schedule.onDemandHandoffs[refill.id]).toBeUndefined();
  expect(schedule.swarmCleanupRefillPending['agent-three']).toMatchObject({ id: refill.id });
});
