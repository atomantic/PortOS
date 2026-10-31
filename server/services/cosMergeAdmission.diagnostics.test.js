import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { __createManualClock } from '../lib/eventLoopLagProbe.js';

// #12329: a slow admission phase must say whether its time went to waiting on
// the state queue, to asynchronous I/O, or to an event loop that could not run.
const fixture = vi.hoisted(() => ({ state: null, disk: null, queue: null, enqueued: null, save: null }));
vi.mock('./cosState.js', () => ({
  withStateLock: (fn) => { const result = fixture.queue(fn); fixture.enqueued?.(); return result; },
  loadState: async () => fixture.state,
  readMergeAdmissionStateForSafetyCheck: async ({ onStage } = {}) => {
    onStage?.('read');
    onStage?.('parse');
    return { trusted: true, ...structuredClone(fixture.disk) };
  },
  saveState: async (state, { onStage } = {}) => {
    await fixture.save?.(onStage);
    fixture.disk = structuredClone(state);
    fixture.state = state;
  },
}));
vi.mock('./externalMergeTarget.js', () => {
  const proof = (input) => ({ repository: 'github.com/example/repo', target: { appId: 'repo', repoPath: '/repos/repo',
    worktreePath: '/worktrees/repo', gitDir: '/git/dir', commonDir: '/git/common', checkoutIdentity: 'identity', branch: 'feature',
    prUrl: input.prUrl, baseBranch: input.baseBranch, headSha: input.headSha, baseSha: input.baseSha } });
  return { inspectExternalMergeTarget: async input => proof(input), inspectExternalMergeCheckout: async target => proof(target) };
});
import { __setMergeAdmissionClockForTests, externalMergeAdmission } from './cosMergeAdmission.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
};
const session = 'a'.repeat(64);
const input = { appId: 'repo', worktreePath: '/worktrees/repo', baseBranch: 'main',
  prUrl: 'https://github.com/example/repo/pull/7', headSha: 'c'.repeat(40), baseSha: 'd'.repeat(40) };
const acquire = () => externalMergeAdmission({ action: 'acquire', ...input }, async () => session);
const LINE = /^🚦 Merge admission operation=[a-z-]+ status=[a-z-]+ phase=[A-Za-z]+( [A-Za-z]+Ms=\d+)+( cpuMs=\d+ load1=\d+(\.\d+)? cpus=\d+ gcMs=\d+ invCtx=\d+)?$/;
const reported = () => [...console.log.mock.calls, ...console.warn.mock.calls, ...console.error.mock.calls].flat();
const fields = (line) => Object.fromEntries([...line.matchAll(/ ([A-Za-z]+)=(\S+)/g)]
  .map(([, key, value]) => [key, /^\d+$/.test(value) ? Number(value) : value]));
const onlyLine = () => {
  const lines = reported();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(LINE);
  return fields(lines[0]);
};
// The transaction imports cosState lazily; wait until it has actually enqueued.
// Wrapped so the async helper does not adopt (and wait on) the pending result.
const enqueue = async (start) => {
  const enqueued = deferred();
  fixture.enqueued = enqueued.resolve;
  const result = start();
  await enqueued.promise;
  fixture.enqueued = null;
  return { result };
};

let clock;
beforeEach(() => {
  clock = __createManualClock();
  __setMergeAdmissionClockForTests(clock);
  fixture.queue = createFileWriteQueue();
  fixture.save = null;
  fixture.state = { agents: {}, mergeAdmissions: {} };
  fixture.disk = structuredClone(fixture.state);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { __setMergeAdmissionClockForTests(null); vi.restoreAllMocks(); });

describe('merge admission slow-operation diagnostics', () => {
  it('stays silent for a fast settle and reports an ordinary blocked queue as lag-free queue wait', async () => {
    const fast = await acquire();
    expect(reported()).toEqual([]);
    await externalMergeAdmission({ action: 'release', token: fast.token, outcome: 'merged' }, async () => session);

    const gate = deferred();
    const holder = fixture.queue(() => gate.promise);
    const { result: pending } = await enqueue(acquire);
    clock.advance(5000);
    gate.resolve();
    await holder;
    expect((await pending).admitted).toBe(true);
    expect(onlyLine()).toMatchObject({ operation: 'external-acquire', status: 'settled', totalMs: 5000,
      queueMs: 5000, queueLagMs: 0, loopLagMs: 0, persistenceMs: 0, timerLateMs: 0 });
    expect(reported()[0]).not.toContain('cpuMs=');
  });

  it('attributes slow asynchronous persistence I/O to its stage without loop lag', async () => {
    const entered = deferred();
    const io = deferred();
    fixture.save = async (onStage) => {
      for (const stage of ['prepare', 'serialize', 'write']) onStage(stage);
      entered.resolve();
      await io.promise;
      onStage('replace');
      onStage('dirSync');
    };
    const pending = acquire();
    await entered.promise;
    clock.advance(8000);
    io.resolve();
    expect((await pending).admitted).toBe(true);
    expect(onlyLine()).toMatchObject({ status: 'settled', totalMs: 8000, queueMs: 0, persistenceMs: 8000,
      writeMs: 8000, serializeMs: 0, dirSyncMs: 0, persistenceLagMs: 0, loopLagMs: 0 });
  });

  it('attributes blocking work inside persistence to loop lag', async () => {
    fixture.save = async (onStage) => {
      onStage('serialize');
      clock.stall(6000);
      onStage('write');
    };
    expect((await acquire()).admitted).toBe(true);
    // The first tick interval of a stall is indistinguishable from waiting for
    // that tick, so lag is measured to within one 100 ms interval.
    expect(onlyLine()).toMatchObject({ totalMs: 6000, persistenceMs: 6000, serializeMs: 6000,
      persistenceLagMs: 5900, loopLagMs: 5900, loopLagMaxMs: 5900, cpuMs: expect.any(Number), invCtx: expect.any(Number) });
  });

  it('identifies a deadline delivered late by a blocked loop, and the expired acquire never mutates', async () => {
    const gate = deferred();
    const holder = fixture.queue(() => gate.promise);
    const before = structuredClone(fixture.disk);
    const { result: pending } = await enqueue(acquire);
    clock.advance(10_000);
    clock.stall(14_448);
    clock.advance(0);
    expect(await pending).toMatchObject({ admitted: false, reason: 'state-queue-timeout' });
    expect(onlyLine()).toMatchObject({ operation: 'external-acquire', status: 'queue-timeout', phase: 'queue',
      totalMs: 24_448, queueMs: 24_448, timerLateMs: 9448, queueLagMs: 14_348, loopLagMaxMs: 14_348 });
    gate.resolve();
    await holder;
    await fixture.queue(() => {});
    expect(fixture.disk).toEqual(before);
  });
});
