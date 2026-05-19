import { describe, it, expect, vi, beforeEach } from 'vitest';
import { imageGenEvents } from './imageGenEvents.js';
import { createImageGenWaiter } from './imageGenWaiter.js';

// Each test starts with a clean emitter so a stray listener from a prior
// case can't be observed by the next.
beforeEach(() => {
  imageGenEvents.removeAllListeners();
});

describe('createImageGenWaiter', () => {
  it('resolves with the completed event when generationId matches the registered id', async () => {
    const waiter = createImageGenWaiter({ timeoutMs: 1000 });
    waiter.register('gen-123');
    queueMicrotask(() => {
      imageGenEvents.emit('completed', { generationId: 'gen-123', filename: 'a.png' });
    });
    const ev = await waiter.promise;
    expect(ev).toEqual({ generationId: 'gen-123', filename: 'a.png' });
  });

  it('ignores completed events for a different generationId', async () => {
    const waiter = createImageGenWaiter({ timeoutMs: 200, onTimeout: () => new Error('timed out') });
    waiter.register('gen-123');
    imageGenEvents.emit('completed', { generationId: 'gen-other', filename: 'wrong.png' });
    await expect(waiter.promise).rejects.toThrow(/timed out/);
  });

  it('rejects with the failed event mapped through onFailed', async () => {
    class TypedError extends Error { constructor(m, code) { super(m); this.code = code; } }
    const waiter = createImageGenWaiter({
      timeoutMs: 1000,
      onFailed: (ev) => new TypedError(ev.error, 'GEN_FAILED'),
    });
    waiter.register('gen-fail');
    queueMicrotask(() => {
      imageGenEvents.emit('failed', { generationId: 'gen-fail', error: 'codex died' });
    });
    let caught;
    try { await waiter.promise; } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(TypedError);
    expect(caught.code).toBe('GEN_FAILED');
    expect(caught.message).toBe('codex died');
  });

  it('rejects with the onTimeout factory result when no event arrives', async () => {
    const waiter = createImageGenWaiter({
      timeoutMs: 30,
      onTimeout: () => new Error('explicit timeout'),
    });
    waiter.register('gen-slow');
    await expect(waiter.promise).rejects.toThrow(/explicit timeout/);
  });

  it('cleanup() detaches both completed and failed listeners + clears the timer', async () => {
    const before = imageGenEvents.listenerCount('completed') + imageGenEvents.listenerCount('failed');
    const waiter = createImageGenWaiter({ timeoutMs: 60_000 });
    expect(imageGenEvents.listenerCount('completed')).toBe(before / 2 + 1);
    expect(imageGenEvents.listenerCount('failed')).toBe(before / 2 + 1);
    waiter.cleanup();
    expect(imageGenEvents.listenerCount('completed')).toBe(before / 2);
    expect(imageGenEvents.listenerCount('failed')).toBe(before / 2);
    // Suppress the unhandled rejection from the never-resolved promise.
    waiter.promise.catch(() => {});
  });

  it('detaches listeners on the completion path so back-to-back waiters do not leak', async () => {
    const start = imageGenEvents.listenerCount('completed');
    const w1 = createImageGenWaiter({ timeoutMs: 1000 });
    w1.register('a');
    imageGenEvents.emit('completed', { generationId: 'a' });
    await w1.promise;
    const w2 = createImageGenWaiter({ timeoutMs: 1000 });
    w2.register('b');
    imageGenEvents.emit('completed', { generationId: 'b' });
    await w2.promise;
    expect(imageGenEvents.listenerCount('completed')).toBe(start);
  });

  it('does not match when registered id is the default null', async () => {
    const waiter = createImageGenWaiter({ timeoutMs: 30, onTimeout: () => new Error('timeout') });
    // never register
    imageGenEvents.emit('completed', { generationId: null });
    imageGenEvents.emit('completed', { generationId: undefined });
    await expect(waiter.promise).rejects.toThrow(/timeout/);
  });
});
