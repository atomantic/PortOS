import { describe, it, expect } from 'vitest';
import { createConcurrencyGate } from './concurrencyGate.js';

// A deferred promise plus the observable "did it start yet" flag, so a test can
// assert on what the gate ADMITTED rather than on timing.
function deferredTask() {
  let resolve;
  let reject;
  const settled = new Promise((res, rej) => { resolve = res; reject = rej; });
  const task = { started: false, resolve, reject };
  task.fn = () => {
    task.started = true;
    return settled;
  };
  return task;
}

// Yield a macrotask so any `run()` that could start has started.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createConcurrencyGate', () => {
  it('admits only `limit` tasks at once and releases the rest FIFO', async () => {
    const gate = createConcurrencyGate(2);
    const tasks = [deferredTask(), deferredTask(), deferredTask(), deferredTask()];
    const runs = tasks.map((t) => gate.run(t.fn));
    await tick();

    expect(tasks.map((t) => t.started)).toEqual([true, true, false, false]);
    // Releasing the FIRST slot must admit the OLDEST waiter, not the newest.
    tasks[0].resolve('a');
    await tick();
    expect(tasks.map((t) => t.started)).toEqual([true, true, true, false]);

    tasks[1].resolve('b');
    tasks[2].resolve('c');
    await tick();
    expect(tasks[3].started).toBe(true);

    tasks[3].resolve('d');
    await expect(Promise.all(runs)).resolves.toEqual(['a', 'b', 'c', 'd']);
    expect(gate.active()).toBe(0);
  });

  it('releases the slot when a task rejects, so a failure cannot wedge the gate', async () => {
    const gate = createConcurrencyGate(1);
    const first = deferredTask();
    const second = deferredTask();
    const firstRun = gate.run(first.fn);
    const secondRun = gate.run(second.fn);
    await tick();
    expect(second.started).toBe(false);

    first.reject(new Error('boom'));
    await expect(firstRun).rejects.toThrow('boom');
    await tick();
    expect(second.started).toBe(true);

    second.resolve('ok');
    await expect(secondRun).resolves.toBe('ok');
    expect(gate.active()).toBe(0);
  });

  it('never exceeds the cap under a burst larger than the queue drain rate', async () => {
    const gate = createConcurrencyGate(3);
    let inFlight = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 25 }, () => gate.run(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
    })));
    expect(peak).toBe(3);
    expect(gate.active()).toBe(0);
  });

  it('floors a non-positive or non-numeric limit at 1 rather than admitting everything', async () => {
    for (const limit of [0, undefined]) {
      const gate = createConcurrencyGate(limit);
      const tasks = [deferredTask(), deferredTask()];
      tasks.forEach((t) => { gate.run(t.fn); });
      await tick();
      expect(tasks.map((t) => t.started)).toEqual([true, false]);
      tasks.forEach((t) => t.resolve(null));
    }
  });
});
