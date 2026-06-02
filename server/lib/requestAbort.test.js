import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { abortSignalFromResponse, anyAbortSignal } from './requestAbort.js';

// Minimal stand-in for an Express response: an EventEmitter carrying the
// `writableEnded` flag the helper keys off.
function fakeRes({ writableEnded = false, destroyed = false } = {}) {
  const res = new EventEmitter();
  res.writableEnded = writableEnded;
  res.destroyed = destroyed;
  return res;
}

describe('abortSignalFromResponse', () => {
  it('does NOT abort when the response closes after finishing normally', () => {
    const res = fakeRes();
    const signal = abortSignalFromResponse(res);
    res.writableEnded = true; // response fully written…
    res.emit('close'); // …then the connection closes normally
    expect(signal.aborted).toBe(false);
  });

  it('aborts when the client disconnects before the response finishes', () => {
    const res = fakeRes();
    const signal = abortSignalFromResponse(res);
    res.emit('close'); // connection dropped mid-response, writableEnded still false
    expect(signal.aborted).toBe(true);
  });

  it('returns an un-aborted signal when the response is already finished', () => {
    const signal = abortSignalFromResponse(fakeRes({ writableEnded: true }));
    expect(signal.aborted).toBe(false);
  });

  it('aborts up front when the response was already destroyed before finishing', () => {
    // Client hung up before the helper ran — the close listener would never fire,
    // so the signal must already be aborted.
    const signal = abortSignalFromResponse(fakeRes({ destroyed: true }));
    expect(signal.aborted).toBe(true);
  });

  it('tolerates a missing response object', () => {
    expect(abortSignalFromResponse(undefined).aborted).toBe(false);
  });
});

describe('anyAbortSignal', () => {
  it('returns undefined when no live signals are given', () => {
    expect(anyAbortSignal([])).toBeUndefined();
    expect(anyAbortSignal([null, undefined])).toBeUndefined();
  });

  it('returns the sole signal unchanged when only one is live', () => {
    const c = new AbortController();
    expect(anyAbortSignal([null, c.signal])).toBe(c.signal);
  });

  it('fires when any source signal aborts', () => {
    const a = new AbortController();
    const b = new AbortController();
    const combined = anyAbortSignal([a.signal, b.signal]);
    expect(combined.aborted).toBe(false);
    b.abort();
    expect(combined.aborted).toBe(true);
  });

  it('is already aborted when a source was aborted before combining', () => {
    const a = new AbortController();
    const b = new AbortController();
    a.abort();
    expect(anyAbortSignal([a.signal, b.signal]).aborted).toBe(true);
  });
});
