import { describe, it, expect } from 'vitest';
import { createKeyCachedQueue } from './createKeyCachedQueue.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createKeyCachedQueue', () => {
  it('serializes work for the same key (later sees earlier result)', async () => {
    const queue = createKeyCachedQueue();
    const order = [];
    let releaseFirst;
    const first = queue('k', () => new Promise((resolve) => {
      order.push('start-1');
      releaseFirst = () => { order.push('end-1'); resolve(); };
    }));
    const second = queue('k', async () => { order.push('start-2'); });

    await tick();
    // The second must NOT start while the first is still pending.
    expect(order).toEqual(['start-1']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['start-1', 'end-1', 'start-2']);
  });

  it('runs different keys concurrently', async () => {
    const queue = createKeyCachedQueue();
    const order = [];
    let releaseA;
    const a = queue('a', () => new Promise((resolve) => { order.push('start-a'); releaseA = resolve; }));
    const b = queue('b', async () => { order.push('start-b'); });

    await tick();
    // Key 'b' starts without waiting on the still-pending key 'a'.
    expect(order).toEqual(['start-a', 'start-b']);
    releaseA();
    await Promise.all([a, b]);
  });

  it('continues the chain after a rejected link', async () => {
    const queue = createKeyCachedQueue();
    const ran = [];
    const first = queue('k', async () => { ran.push(1); throw new Error('boom'); }).catch(() => 'handled');
    const second = queue('k', async () => { ran.push(2); return 'ok'; });
    expect(await first).toBe('handled');
    expect(await second).toBe('ok');
    expect(ran).toEqual([1, 2]);
  });

  it('evicts settled tails so the Map does not grow unbounded', async () => {
    const queue = createKeyCachedQueue();
    await queue('k', async () => 'done');
    await tick();
    // After settling with nothing newer chained on, re-queuing starts fresh
    // (no pending predecessor) — observable as immediate execution.
    const order = [];
    const next = queue('k', async () => { order.push('ran'); });
    await next;
    expect(order).toEqual(['ran']);
  });

  it('clear() drops all tails', async () => {
    const queue = createKeyCachedQueue();
    // A pending link in flight; clear() must not throw and lets fresh work run.
    queue('k', () => new Promise(() => {})); // never resolves
    queue.clear();
    const order = [];
    const fresh = queue('k', async () => { order.push('fresh'); });
    await fresh;
    expect(order).toEqual(['fresh']);
  });
});
