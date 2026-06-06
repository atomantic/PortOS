import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { awaitWritableDrain } from './streamBackpressure.js';

// A minimal `res` stand-in: an EventEmitter with the writable-state flags the
// helper reads. `once`/`off` come from EventEmitter.
const makeRes = (over = {}) => Object.assign(new EventEmitter(), {
  writableEnded: false,
  destroyed: false,
}, over);

describe('awaitWritableDrain', () => {
  it('resolves immediately when the response is already ended', async () => {
    await expect(awaitWritableDrain(makeRes({ writableEnded: true }))).resolves.toBeUndefined();
  });

  it('resolves immediately when the response is destroyed', async () => {
    await expect(awaitWritableDrain(makeRes({ destroyed: true }))).resolves.toBeUndefined();
  });

  it('waits for `drain` and tears down both listeners on settle', async () => {
    const res = makeRes();
    let settled = false;
    const p = awaitWritableDrain(res).then(() => { settled = true; });

    expect(res.listenerCount('drain')).toBe(1);
    expect(res.listenerCount('close')).toBe(1);
    expect(settled).toBe(false);

    res.emit('drain');
    await p;

    expect(settled).toBe(true);
    expect(res.listenerCount('drain')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
  });

  it('also settles (and cleans up) when the client disconnects mid-drain', async () => {
    const res = makeRes();
    const p = awaitWritableDrain(res);

    res.emit('close');
    await p;

    expect(res.listenerCount('drain')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
  });
});
