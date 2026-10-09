import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const fixture = vi.hoisted(() => ({ state: null, disk: null, queue: null, enqueued: null, read: null, origin: null, save: null }));
vi.mock('../services/cos.js', () => ({}));
vi.mock('../services/agentOrchestrator.js', () => ({}));
vi.mock('../services/cosState.js', () => ({
  withStateLock: (fn) => { const result = fixture.queue(fn); fixture.enqueued?.(); return result; },
  loadState: async () => fixture.state,
  readMergeAdmissionStateForSafetyCheck: async () => {
    await fixture.read?.();
    return { trusted: true, ...structuredClone(fixture.disk) };
  },
  saveState: async (state) => {
    await fixture.save?.();
    fixture.disk = structuredClone(state);
    fixture.state = state;
  },
}));
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: async () => {
  await fixture.origin?.();
  return { host: 'github.com', fullName: 'example/repo' };
} }));
import routes from './cosAgentRoutes.js';
import { ADMISSION_QUEUE_TIMEOUT_MS, claimMergeAdmission } from '../services/cosMergeAdmission.js';

const repository = 'github.com/example/repo';
const agentId = 'synthetic-parent';
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const input = (action, token) => ({ agentId, action, ...(token && { token }), ...(action === 'release' && { outcome: 'merged' }) });
const call = (action, token) => claimMergeAdmission(input(action, token));
const app = express();
app.use(express.json());
app.use('/api/cos', routes);
app.use(errorMiddleware);
const post = (action, token) => Promise.resolve(request(app).post('/api/cos/merge-admission').send(input(action, token)));

beforeEach(() => {
  fixture.queue = createFileWriteQueue();
  fixture.enqueued = fixture.read = fixture.origin = fixture.save = null;
  fixture.state = { agents: { [agentId]: { id: agentId, taskId: 'synthetic-task', status: 'running',
    startedAt: '2026-01-01T00:00:00Z', metadata: { sourceWorkspace: '/repos/example', claimPicksOwnBranch: true } } }, mergeAdmissions: {} };
  fixture.disk = structuredClone(fixture.state);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('merge admission state queue deadline', () => {
  it.each(['acquire', 'check', 'release'])('returns a bounded HTTP refusal and fences a queued %s', async (action) => {
    const holder = action === 'acquire' ? null : await call('acquire');
    const before = structuredClone(fixture.disk);
    const gate = deferred();
    const blocked = fixture.queue(() => gate.promise);
    const enqueued = deferred();
    fixture.enqueued = enqueued.resolve;
    const response = post(action, holder?.token);
    await enqueued.promise;
    await vi.advanceTimersByTimeAsync(ADMISSION_QUEUE_TIMEOUT_MS);
    const res = await response;
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ admitted: false, reason: 'state-queue-timeout', retryAfterMs: 5000 });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('phase=queue phaseMs=15000'));
    gate.resolve();
    await blocked;
    await fixture.queue(() => {});
    expect(fixture.disk).toEqual(before);
    // No timed-out check is authority: only this new successful check is.
    const fresh = holder ?? await call('acquire');
    expect(await call('check', fresh.token)).toMatchObject({ admitted: true, token: fresh.token });
    expect(await call('release', fresh.token)).toMatchObject({ released: true });
  });

  it('fences an expired callback even if the timer has not fired', async () => {
    const gate = deferred();
    fixture.queue(() => gate.promise);
    const enqueued = deferred();
    fixture.enqueued = enqueued.resolve;
    const response = call('acquire');
    await enqueued.promise;
    vi.spyOn(performance, 'now').mockReturnValue(ADMISSION_QUEUE_TIMEOUT_MS);
    gate.resolve();
    expect(await response).toMatchObject({ admitted: false, reason: 'state-queue-timeout' });
    expect(fixture.disk.mergeAdmissions).toEqual({});
  });

  it.each(['acquire', 'release', 'failed-release'])('retains queue ownership until started %s persistence actually settles', async (mode) => {
    const holder = mode === 'acquire' ? null : await call('acquire');
    const before = structuredClone(fixture.disk);
    const entered = deferred();
    const save = deferred();
    fixture.save = () => { entered.resolve(); return save.promise; };
    let settled = false;
    const response = call(mode === 'acquire' ? 'acquire' : 'release', holder?.token);
    const observed = response.then(result => { settled = true; return { result }; }, error => { settled = true; return { error }; });
    await entered.promise;
    const next = call('check', holder?.token);
    await vi.advanceTimersByTimeAsync(ADMISSION_QUEUE_TIMEOUT_MS);
    expect(settled).toBe(false);
    expect(fixture.disk).toEqual(before);
    expect(await next).toMatchObject({ admitted: false, reason: 'state-queue-timeout' });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('status=pending phase=persistence'));
    if (mode === 'failed-release') save.reject(new Error('synthetic persistence failure'));
    else save.resolve();
    const result = await observed;
    fixture.save = null;
    if (mode === 'failed-release') {
      expect(result.error.message).toBe('synthetic persistence failure');
      expect(fixture.disk).toEqual(before);
      expect(await call('check', holder.token)).toMatchObject({ admitted: true });
    } else if (mode === 'acquire') {
      expect(result.result.admitted).toBe(true);
      expect(await call('check', result.result.token)).toMatchObject({ admitted: true });
    } else {
      expect(result.result.released).toBe(true);
      expect(fixture.disk.mergeAdmissions[repository]).toBeUndefined();
    }
  });

  it.each([['read', 'trustedState'], ['origin', 'origin']])('diagnoses a stalled %s phase using only redacted names and numeric timings', async (hook, phase) => {
    const entered = deferred();
    const gate = deferred();
    fixture[hook] = () => { entered.resolve(); return gate.promise; };
    const response = call('acquire');
    await entered.promise;
    await vi.advanceTimersByTimeAsync(ADMISSION_QUEUE_TIMEOUT_MS);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`status=pending phase=${phase}`));
    gate.resolve();
    const admission = await response;
    const logs = [...console.log.mock.calls, ...console.warn.mock.calls].flat();
    for (const line of logs) {
      expect(line).toMatch(/^🚦 Merge admission operation=acquire status=(pending|settled) phase=(trustedState|origin|persistence) phaseMs=\d+ totalMs=\d+ queueMs=\d+ trustedStateMs=\d+ stateLoadMs=\d+ originMs=\d+ ownerRecoveryMs=\d+ persistenceMs=\d+$/);
      expect(line).not.toContain(admission.token);
      expect(line).not.toContain(agentId);
      expect(line).not.toContain('/repos');
    }
  });
});
