import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFixtureStartup } from './collectionFixtureStartup.js';

afterEach(() => vi.useRealTimers());

describe('fixture startup IPC and deadlines', () => {
  it('does not let repeated or invalid IPC keep a stalled child alive or leak payloads', async () => {
    vi.useFakeTimers();
    const child = new EventEmitter();
    const startup = createFixtureStartup();
    const ready = startup.wait(child);
    const failure = expect(ready).rejects.toMatchObject({ fixtureFailure: 'startup-stalled' });
    child.emit('message', { type: 'progress', phase: 'image-seed', counts: { images: 100 }, private: 'secret' });
    await vi.advanceTimersByTimeAsync(9000);
    child.emit('message', { type: 'progress', phase: 'image-seed', counts: { images: 100 }, workMs: { files: 9999 } });
    child.emit('message', { type: 'progress', phase: 'secret', counts: { images: 200 } });
    child.emit('message', { type: 'progress', phase: 'image-seed', counts: { images: 2401 } });
    await vi.advanceTimersByTimeAsync(1000);
    await failure;
    expect(startup.snapshot().phases).toEqual([{ phase: 'image-seed', startedMs: expect.any(Number), elapsedMs: expect.any(Number), durationMs: expect.any(Number),
      counts: { images: 100, videos: 0, accounts: 0, messages: 0 }, workMs: { files: 0, index: 0 } }]);
    expect(JSON.stringify(startup.snapshot())).not.toContain('secret');
    expect(child.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enforces the total budget even while counts advance', async () => {
    vi.useFakeTimers();
    const child = new EventEmitter();
    const startup = createFixtureStartup();
    const ready = startup.wait(child);
    const failure = expect(ready).rejects.toMatchObject({ fixtureFailure: 'startup-timeout' });
    for (let images = 100; images <= 400; images += 100) {
      child.emit('message', { type: 'progress', phase: 'image-seed', counts: { images } });
      await vi.advanceTimersByTimeAsync(images === 400 ? 3000 : 9000);
    }
    await failure;
    expect(child.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('extends only the inactivity deadline for real progress, then disposes listeners on ready or exit', async () => {
    vi.useFakeTimers();
    const child = new EventEmitter();
    const startup = createFixtureStartup();
    const ready = startup.wait(child);
    child.emit('message', { type: 'progress', phase: 'image-seed', counts: { images: 100 } });
    await vi.advanceTimersByTimeAsync(9000);
    child.emit('message', { type: 'progress', phase: 'image-seed', counts: { images: 200 } });
    await vi.advanceTimersByTimeAsync(9000);
    child.emit('message', { type: 'ready' });
    await expect(ready).resolves.toMatchObject({ type: 'ready' });
    expect(child.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    const exited = startup.wait(child);
    child.emit('exit', 1);
    await expect(exited).rejects.toMatchObject({ fixtureFailure: 'child-exited' });
    expect(child.eventNames()).toEqual([]);
  });

  it('rejects invalid limits before resource creation', () => {
    for (const startupLimits of [{ overallTimeoutMs: 120001 }, { overallTimeoutMs: NaN },
      { noProgressTimeoutMs: 0 }, { overallTimeoutMs: 1000, noProgressTimeoutMs: 1001 }]) {
      expect(() => createFixtureStartup(startupLimits)).toThrow('Invalid collection fixture startup limits');
    }
  });
});
