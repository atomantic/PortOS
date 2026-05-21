import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reportClientError, buildPayload, _resetForTests } from './clientErrorReporter';

beforeEach(() => {
  _resetForTests();
  vi.restoreAllMocks();
  globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true }));
});

describe('buildPayload', () => {
  it('extracts message + stack from an unhandledrejection Error reason', () => {
    const err = new Error('rejected!');
    err.stack = 'Error: rejected!\n    at foo (foo.js:1:1)';
    const out = buildPayload({ type: 'unhandledrejection', reason: err });
    expect(out.type).toBe('unhandledrejection');
    expect(out.message).toBe('rejected!');
    expect(out.stack).toContain('foo.js');
  });

  it('handles unhandledrejection with a string reason', () => {
    const out = buildPayload({ type: 'unhandledrejection', reason: 'plain string' });
    expect(out.message).toBe('plain string');
    expect(out.stack).toBeUndefined();
  });

  it('does not throw when the rejection reason is a circular object', () => {
    const circular = { name: 'oops' };
    circular.self = circular;
    expect(() => buildPayload({ type: 'unhandledrejection', reason: circular })).not.toThrow();
  });

  it('does not throw when the rejection reason has a hostile toString', () => {
    const hostile = { toString() { throw new Error('nope'); } };
    expect(() => buildPayload({ type: 'unhandledrejection', reason: hostile })).not.toThrow();
  });

  it('does not throw when the reason has a throwing `message` or `stack` getter', () => {
    const hostile = {};
    Object.defineProperty(hostile, 'message', { get() { throw new Error('msg'); } });
    Object.defineProperty(hostile, 'stack', { get() { throw new Error('stk'); } });
    expect(() => buildPayload({ type: 'unhandledrejection', reason: hostile })).not.toThrow();
  });

  it('coerces a non-string `stack` field to a string', () => {
    const reason = new Error('oops');
    reason.stack = { weird: true };
    const out = buildPayload({ type: 'unhandledrejection', reason });
    expect(typeof out.stack).toBe('string');
  });

  it('extracts message + stack + filename/lineno/colno from an error event', () => {
    const err = new Error('boom');
    err.stack = 'Error: boom\n    at foo (foo.js:1:1)';
    const out = buildPayload({
      type: 'error',
      error: err,
      message: 'unhelpful',
      filename: 'foo.js',
      lineno: 1,
      colno: 1,
    });
    expect(out.message).toBe('boom');
    expect(out.source).toBe('foo.js');
    expect(out.line).toBe(1);
    expect(out.column).toBe(1);
  });

  it('does not throw on the global-error path when error.stack is a non-serializable value (BigInt)', () => {
    const err = new Error('boom');
    err.stack = 1n;
    expect(() => buildPayload({
      type: 'error',
      error: err,
      message: 'boom',
      filename: 'foo.js',
      lineno: 1,
      colno: 1,
    })).not.toThrow();
  });

  it('reportClientError resolves cleanly even when JSON.stringify would throw (BigInt stack)', async () => {
    const err = new Error('boom');
    err.stack = 1n;
    const result = await reportClientError({
      type: 'error',
      error: err,
      message: 'boom',
      filename: 'foo.js',
      lineno: 1,
      colno: 1,
    });
    // safeBody falls back to a degraded payload that is still POST-able, so
    // the request goes through. The point of the test is that this resolves
    // (no synchronous throw, no rejected promise) regardless of `sent`.
    expect(typeof result.sent).toBe('boolean');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.stack === '[unserializable]' || typeof body.stack === 'string').toBe(true);
  });
});

describe('reportClientError', () => {
  it('POSTs the payload to /api/client-errors and resolves with { sent: true }', async () => {
    const result = await reportClientError({ type: 'error', message: 'boom' });
    expect(result.sent).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('/api/client-errors');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body.type).toBe('error');
    expect(body.message).toBe('boom');
  });

  it('drops duplicate reports without re-sending', async () => {
    const payload = {
      type: 'error',
      message: 'same',
      error: Object.assign(new Error('same'), { stack: 'Error\n    at foo (foo.js:1:1)' }),
    };
    const first = await reportClientError(payload);
    expect(first.sent).toBe(true);

    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockReturnValue(realNow() + 2000);

    const second = await reportClientError(payload);
    expect(second.sent).toBe(false);
    expect(second.reason).toBe('duplicate');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    Date.now = realNow;
  });

  it('accepts the same error again once its dedup window has expired', async () => {
    const payload = {
      type: 'error',
      message: 'recurring',
      error: Object.assign(new Error('recurring'), { stack: 'Error\n    at foo (foo.js:1:1)' }),
    };
    const first = await reportClientError(payload);
    expect(first.sent).toBe(true);

    // Jump past the 60s dedup window (and well past the 1s throttle).
    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockReturnValue(realNow() + 90 * 1000);

    const second = await reportClientError(payload);
    expect(second.sent).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);

    Date.now = realNow;
  });

  it('rate-limits reports that arrive faster than once per second', async () => {
    const first = await reportClientError({ type: 'error', message: 'a' });
    expect(first.sent).toBe(true);

    const second = await reportClientError({ type: 'error', message: 'b' });
    expect(second.sent).toBe(false);
    expect(second.reason).toBe('rate-limited');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns transport-error when fetch rejects, never throws', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('offline')));
    const result = await reportClientError({ type: 'error', message: 'boom' });
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('transport-error');
  });

  it('returns transport-error when fetch resolves with !ok', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: false }));
    const result = await reportClientError({ type: 'error', message: 'boom' });
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('transport-error');
  });

  it('returns transport-error when fetch throws synchronously, never rejects', async () => {
    // CSP-blocked or stubbed-test fetch can throw before returning a promise.
    // Without an outer try/catch the `.then().catch()` chain is never attached
    // and the rejection escapes the global handler.
    globalThis.fetch = vi.fn(() => { throw new Error('sync fetch throw'); });
    let result;
    let rejected = false;
    try {
      result = await reportClientError({ type: 'error', message: 'boom' });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(false);
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('transport-error');
  });
});
