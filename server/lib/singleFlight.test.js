import { describe, it, expect } from 'vitest';
import { createSingleFlight } from './singleFlight.js';

const tick = () => new Promise(r => setTimeout(r, 0));

describe('createSingleFlight', () => {
  it('coalesces concurrent calls for the same key onto one fn execution', async () => {
    const sf = createSingleFlight();
    let calls = 0;
    let release;
    const fn = () => {
      calls += 1;
      return new Promise(r => { release = r; });
    };

    const a = sf.run('k', fn);
    const b = sf.run('k', fn);
    expect(calls).toBe(1);
    expect(a).toBe(b); // same shared promise

    release('value');
    expect(await a).toBe('value');
    expect(await b).toBe('value');
  });

  it('runs separate fns for distinct keys', async () => {
    const sf = createSingleFlight();
    const calls = [];
    const make = (label) => () => { calls.push(label); return Promise.resolve(label); };

    const [a, b] = await Promise.all([sf.run('x', make('x')), sf.run('y', make('y'))]);
    expect(a).toBe('x');
    expect(b).toBe('y');
    expect(calls.sort()).toEqual(['x', 'y']);
  });

  it('clears the slot on resolve so a later call starts fresh work', async () => {
    const sf = createSingleFlight();
    let calls = 0;
    const fn = () => { calls += 1; return Promise.resolve(calls); };

    expect(await sf.run('k', fn)).toBe(1);
    await tick();
    expect(await sf.run('k', fn)).toBe(2); // slot cleared, fn ran again
    expect(calls).toBe(2);
  });

  it('clears the slot on reject and propagates the original error to all callers', async () => {
    const sf = createSingleFlight();
    const err = new Error('boom');
    let calls = 0;
    const fn = () => { calls += 1; return Promise.reject(err); };

    const a = sf.run('k', fn);
    const b = sf.run('k', fn);
    expect(calls).toBe(1);
    await expect(a).rejects.toBe(err);
    await expect(b).rejects.toBe(err);

    await tick();
    // Slot cleared after the rejection settled — a fresh call re-runs.
    const c = sf.run('k', fn);
    await expect(c).rejects.toBe(err);
    expect(calls).toBe(2);
  });

  it('does not emit an unhandledRejection when no one awaits a rejecting slot', async () => {
    const sf = createSingleFlight();
    const seen = [];
    const onUnhandled = (e) => seen.push(e);
    process.on('unhandledRejection', onUnhandled);

    // Fire-and-forget a rejecting run; attach no awaiter to the returned promise
    // beyond a swallowing catch so Node's own bookkeeping stays quiet, then make
    // sure the helper's internal cleanup arm didn't itself surface a rejection.
    sf.run('k', () => Promise.reject(new Error('ignored'))).catch(() => {});
    await tick();
    await tick();

    process.off('unhandledRejection', onUnhandled);
    expect(seen).toEqual([]);
  });
});
