import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTelegramBot } from './telegramClient.js';

// Build a minimal fetch-Response stand-in that readResponseJson can consume
// (it only calls .text()).
function jsonRes(payload) {
  return { text: async () => JSON.stringify(payload) };
}

// A poll response carrying a single text message so the client dispatches it to
// registered onText / 'message' handlers.
const messageUpdate = {
  ok: true,
  result: [{ update_id: 1, message: { chat: { id: 42 }, text: '/boom' } }]
};

// Drive the poll loop exactly once (one batch of updates), then park every
// subsequent getUpdates on a promise that only settles when the request is
// aborted by stopPolling(). Keeps the test from busy-looping.
function makeFetchMock() {
  let calls = 0;
  return vi.fn((_url, opts = {}) => {
    calls++;
    if (calls === 1) return Promise.resolve(jsonRes(messageUpdate));
    return new Promise((_resolve, reject) => {
      opts.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
  });
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 10));
  }
}

describe('createTelegramBot — async handler rejections', () => {
  let unhandled;
  let onUnhandled;
  let originalFetch;
  let errorSpy;

  beforeEach(() => {
    unhandled = null;
    onUnhandled = (reason) => { unhandled = reason; };
    process.on('unhandledRejection', onUnhandled);
    originalFetch = global.fetch;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    global.fetch = originalFetch;
    errorSpy.mockRestore();
  });

  it('does not leak an unhandled rejection when an onText handler rejects', async () => {
    global.fetch = makeFetchMock();
    const bot = createTelegramBot('test-token', { polling: true });

    let called = false;
    bot.onText(/\/boom/, async () => {
      called = true;
      throw new Error('handler exploded');
    });

    await waitFor(() => called);
    // Give the rejected handler promise a few microtask/macrotask turns to
    // surface as an unhandled rejection if it were going to.
    await new Promise(r => setTimeout(r, 50));
    await bot.stopPolling();

    expect(called).toBe(true);
    expect(unhandled).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("does not leak an unhandled rejection when an 'message' listener rejects", async () => {
    global.fetch = makeFetchMock();
    const bot = createTelegramBot('test-token', { polling: true });

    let called = false;
    bot.on('message', async () => {
      called = true;
      throw new Error('listener exploded');
    });

    await waitFor(() => called);
    await new Promise(r => setTimeout(r, 50));
    await bot.stopPolling();

    expect(called).toBe(true);
    expect(unhandled).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });
});
