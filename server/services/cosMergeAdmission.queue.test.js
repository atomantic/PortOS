import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';

const fixture = vi.hoisted(() => ({ state: null, disk: null, queue: null, enqueued: null, read: null, origin: null, save: null }));
vi.mock('./cosState.js', () => ({
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
vi.mock('./externalMergeTarget.js', () => {
  const proof = (input) => ({ repository: 'github.com/example/repo', target: { appId: 'repo', repoPath: '/repos/repo',
    worktreePath: '/worktrees/repo', gitDir: '/git/dir', commonDir: '/git/common', checkoutIdentity: 'identity', branch: 'feature',
    prUrl: input.prUrl, baseBranch: input.baseBranch, headSha: input.headSha, baseSha: input.baseSha } });
  // The in-transaction recheck is the phase the 'origin' hook stalls.
  return { inspectExternalMergeTarget: async input => proof(input),
    inspectExternalMergeCheckout: async (input) => { await fixture.origin?.(); return proof(input); } };
});
import { ADMISSION_QUEUE_TIMEOUT_MS, externalMergeAdmission } from './cosMergeAdmission.js';

const repository = 'github.com/example/repo';
const session = 'a'.repeat(64);
const target = { appId: 'repo', worktreePath: '/worktrees/repo', baseBranch: 'main',
  prUrl: 'https://github.com/example/repo/pull/7', headSha: 'c'.repeat(40), baseSha: 'd'.repeat(40) };
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const input = (action, token) => ({ action, ...(['acquire', 'prepare'].includes(action) ? target : { token }),
  ...(action === 'release' && { outcome: 'merged' }) });
const call = (action, token) => externalMergeAdmission(input(action, token), async () => session);

beforeEach(() => {
  fixture.queue = createFileWriteQueue();
  fixture.enqueued = fixture.read = fixture.origin = fixture.save = null;
  fixture.state = { agents: {}, mergeAdmissions: {} };
  fixture.disk = structuredClone(fixture.state);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('merge admission state queue deadline', () => {
  it.each(['acquire', 'check', 'release'])('returns a bounded refusal and fences a queued %s', async (action) => {
    const holder = action === 'acquire' ? null : await call('acquire');
    const before = structuredClone(fixture.disk);
    const gate = deferred();
    const blocked = fixture.queue(() => gate.promise);
    const enqueued = deferred();
    fixture.enqueued = enqueued.resolve;
    const response = call(action, holder?.token);
    await enqueued.promise;
    await vi.advanceTimersByTimeAsync(ADMISSION_QUEUE_TIMEOUT_MS);
    expect(await response).toEqual({ admitted: false, reason: 'state-queue-timeout', retryAfterMs: 5000 });
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
      expect(line).toMatch(/^🚦 Merge admission operation=external-acquire status=(pending|settled) phase=(trustedState|stateLoad|origin|persistence) phaseMs=\d+ totalMs=\d+ queueMs=\d+ trustedStateMs=\d+ stateLoadMs=\d+ originMs=\d+ persistenceMs=\d+ readMs=\d+ parseMs=\d+ prepareMs=\d+ agentsMs=\d+ serializeMs=\d+ writeMs=\d+ replaceMs=\d+ dirSyncMs=\d+ loopLagMs=\d+ loopLagMaxMs=\d+ queueLagMs=\d+ trustedStateLagMs=\d+ persistenceLagMs=\d+ timerLateMs=\d+( cpuMs=\d+ load1=\d+(\.\d+)? cpus=\d+ gcMs=\d+ invCtx=\d+)?$/);
      expect(line).not.toContain(admission.token);
      expect(line).not.toContain(session);
      expect(line).not.toContain('/repos');
    }
  });
});

// #12738: the stored agent rows come back in insertion order, which a cached map
// that deleted and re-added an id does not keep. Ownership compares per record.
describe('merge admission ownership comparison', () => {
  const running = { id: 'synthetic-running', taskId: 'synthetic-task', status: 'running' };
  const other = { id: 'synthetic-other', taskId: 'synthetic-task-2', status: 'completed' };

  it('admits when the stored records match the cache in a different order', async () => {
    fixture.state.agents = { [running.id]: running, [other.id]: other };
    fixture.disk = { agents: { [other.id]: other, [running.id]: running }, mergeAdmissions: {} };
    expect(await call('acquire')).toMatchObject({ admitted: true });
  });

  it('refuses when a stored record differs from the cached one', async () => {
    fixture.state.agents = { [running.id]: running, [other.id]: other };
    fixture.disk = { agents: { [running.id]: running, [other.id]: { ...other, status: 'running' } }, mergeAdmissions: {} };
    expect(await call('acquire')).toMatchObject({ admitted: false, reason: 'ownership-stale' });
  });
});
