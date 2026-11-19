import { describe, it, expect, beforeEach, vi } from 'vitest';

// The record/lapse/pin rules are covered where they are used: the sweep in
// sharing/cosTasksSync.test.js, the spawn guard in agent/agentSpawnPreparation.test.js
// and the dequeue pass in cosTaskGenerator.test.js. This suite pins only the
// once-per-process wait, which needs a fresh module per case.
describe('behindPeersKnown: the first dispatch waits for the first peer sweep (#16871)', () => {
  let hold;
  beforeEach(async () => {
    vi.resetModules();
    hold = await import('./cosBehindPeerHold.js');
  });

  const deferred = () => {
    let resolve; let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
  const settled = async (promise) => {
    let done = false;
    promise.then(() => { done = true; });
    await new Promise((resolve) => setImmediate(resolve));
    return done;
  };

  it('does not wait when no sweep was handed over', async () => {
    expect(await settled(hold.behindPeersKnown())).toBe(true);
  });

  it('starts the sweep once and settles only when it finishes', async () => {
    const pass = deferred();
    const sweep = vi.fn(() => pass.promise);
    hold.trackBehindPeerSweep(sweep);

    const first = hold.behindPeersKnown();
    const second = hold.behindPeersKnown();
    expect(await settled(first)).toBe(false);
    expect(sweep).toHaveBeenCalledTimes(1);

    pass.resolve();
    expect(await settled(second)).toBe(true);
    await hold.behindPeersKnown();
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it('waits on a pass the timer already started instead of sweeping again', async () => {
    const pass = deferred();
    const sweep = vi.fn(() => pass.promise);
    const timerSweep = hold.trackBehindPeerSweep(sweep);
    const timerPass = timerSweep();

    const known = hold.behindPeersKnown();
    expect(await settled(known)).toBe(false);
    pass.resolve('swept');
    expect(await settled(known)).toBe(true);
    expect(sweep).toHaveBeenCalledTimes(1);
    // The caller of the sweep still gets the sweep's own result.
    expect(await timerPass).toBe('swept');
  });

  it('settles when the sweep fails, so a peer problem never stalls dispatch', async () => {
    const timerSweep = hold.trackBehindPeerSweep(() => Promise.reject(new Error('Synthetic sweep failure')));
    await expect(hold.behindPeersKnown()).resolves.toBeUndefined();
    // A later pass still reports its own failure to its caller.
    await expect(timerSweep()).rejects.toThrow('Synthetic sweep failure');
  });
});
