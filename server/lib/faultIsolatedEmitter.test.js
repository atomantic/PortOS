import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { makeEmitterFaultIsolating } from './faultIsolatedEmitter.js';

describe('makeEmitterFaultIsolating', () => {
  it('runs a later listener even after an earlier one throws, in registration order', () => {
    const emitter = makeEmitterFaultIsolating(new EventEmitter());
    const calls = [];
    emitter.on('completed', () => {
      calls.push('first');
      throw new Error('boom');
    });
    emitter.on('completed', () => calls.push('second'));

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    emitter.emit('completed', { ok: true });
    errorSpy.mockRestore();

    expect(calls).toEqual(['first', 'second']);
  });

  it('preserves once() self-removal even when the once listener throws', () => {
    const emitter = makeEmitterFaultIsolating(new EventEmitter());
    let onceCalls = 0;
    emitter.once('progress', () => {
      onceCalls += 1;
      throw new Error('boom');
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    emitter.emit('progress');
    emitter.emit('progress');
    errorSpy.mockRestore();

    expect(onceCalls).toBe(1);
    expect(emitter.listenerCount('progress')).toBe(0);
  });

  it('does not itself throw when a listener throws a non-Error value', () => {
    const emitter = makeEmitterFaultIsolating(new EventEmitter());
    const secondListener = vi.fn();
    emitter.on('completed', () => {
      // eslint-disable-next-line no-throw-literal
      throw 'plain string failure';
    });
    emitter.on('completed', secondListener);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => emitter.emit('completed')).not.toThrow();
    errorSpy.mockRestore();

    expect(secondListener).toHaveBeenCalled();
  });

  it('does not itself throw when formatting a thrown error explodes (hostile message getter)', () => {
    const emitter = makeEmitterFaultIsolating(new EventEmitter());
    const secondListener = vi.fn();
    const hostile = Object.create(Error.prototype);
    Object.defineProperty(hostile, 'message', {
      get() {
        throw new Error('cannot read message');
      },
    });
    emitter.on('completed', () => {
      throw hostile;
    });
    emitter.on('completed', secondListener);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => emitter.emit('completed')).not.toThrow();
    errorSpy.mockRestore();

    expect(secondListener).toHaveBeenCalled();
  });

  it('returns true when listeners existed, false otherwise', () => {
    const emitter = makeEmitterFaultIsolating(new EventEmitter());
    expect(emitter.emit('unheard')).toBe(false);
    emitter.on('heard', () => {});
    expect(emitter.emit('heard')).toBe(true);
  });

  it('leaves the "error" event on Node default semantics (throws with no listener)', () => {
    const emitter = makeEmitterFaultIsolating(new EventEmitter());
    expect(() => emitter.emit('error', new Error('unhandled'))).toThrow('unhandled');
  });

  it('does not swallow an "error" event handled by a real listener', () => {
    const emitter = makeEmitterFaultIsolating(new EventEmitter());
    const received = [];
    emitter.on('error', (err) => received.push(err.message));
    expect(() => emitter.emit('error', new Error('handled'))).not.toThrow();
    expect(received).toEqual(['handled']);
  });
});
