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
  let bots;

  // Track polling bots so afterEach stops them even if an assertion throws first.
  const track = (bot) => { bots.push(bot); return bot; };

  beforeEach(() => {
    unhandled = null;
    onUnhandled = (reason) => { unhandled = reason; };
    process.on('unhandledRejection', onUnhandled);
    originalFetch = global.fetch;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    bots = [];
  });

  afterEach(async () => {
    for (const bot of bots) await bot.stopPolling().catch(() => {});
    process.off('unhandledRejection', onUnhandled);
    global.fetch = originalFetch;
    errorSpy.mockRestore();
  });

  it('does not leak an unhandled rejection when an onText handler rejects', async () => {
    global.fetch = makeFetchMock();
    const bot = track(createTelegramBot('test-token', { polling: true }));

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
    const bot = track(createTelegramBot('test-token', { polling: true }));

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

describe('createTelegramBot — poll loop dispatch', () => {
  let originalFetch;
  let bots;

  // Track every polling bot so afterEach can stop it even if an assertion throws
  // before the in-body stopPolling() — otherwise a live poll loop (and, for the
  // retry test, enabled fake timers) would leak into sibling tests.
  const track = (bot) => { bots.push(bot); return bot; };

  beforeEach(() => {
    originalFetch = global.fetch;
    bots = [];
  });

  afterEach(async () => {
    for (const bot of bots) await bot.stopPolling().catch(() => {});
    if (vi.isFakeTimers()) vi.useRealTimers();
    global.fetch = originalFetch;
  });

  it('dispatches a getUpdates message to matching onText and message listeners', async () => {
    global.fetch = makeFetchMock();
    const bot = track(createTelegramBot('test-token', { polling: true }));

    let textMsg = null;
    let textMatch = null;
    let msgEvent = null;
    bot.onText(/\/(\w+)/, (msg, match) => { textMsg = msg; textMatch = match; });
    bot.on('message', (msg) => { msgEvent = msg; });

    await waitFor(() => textMsg && msgEvent);
    await bot.stopPolling();

    expect(textMsg.text).toBe('/boom');
    // The regex capture group is passed through as match[1].
    expect(textMatch[1]).toBe('boom');
    expect(msgEvent.chat.id).toBe(42);
  });

  it('does not dispatch onText when the regex does not match', async () => {
    global.fetch = makeFetchMock();
    const bot = track(createTelegramBot('test-token', { polling: true }));

    let matched = false;
    let sawMessage = false;
    bot.onText(/\/nope/, () => { matched = true; });
    bot.on('message', () => { sawMessage = true; });

    await waitFor(() => sawMessage);
    await bot.stopPolling();

    expect(sawMessage).toBe(true);
    expect(matched).toBe(false);
  });

  it('advances the offset past a consumed update on the next getUpdates', async () => {
    const bodies = [];
    let calls = 0;
    global.fetch = vi.fn((_url, opts = {}) => {
      calls++;
      if (opts.body) bodies.push(JSON.parse(opts.body));
      if (calls === 1) return Promise.resolve(jsonRes(messageUpdate));
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    });
    const bot = track(createTelegramBot('test-token', { polling: true }));

    await waitFor(() => calls >= 2);
    await bot.stopPolling();

    // First poll starts at offset 0; after consuming update_id 1 the next poll
    // must request offset 2 so the same update is never re-delivered.
    expect(bodies[0].offset).toBe(0);
    expect(bodies[1].offset).toBe(2);
  });

  it('emits callback_query updates to callback_query listeners', async () => {
    const callbackUpdate = {
      ok: true,
      result: [{ update_id: 5, callback_query: { id: 'cb-1', data: 'do:thing' } }]
    };
    let calls = 0;
    global.fetch = vi.fn((_url, opts = {}) => {
      calls++;
      if (calls === 1) return Promise.resolve(jsonRes(callbackUpdate));
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    });
    const bot = track(createTelegramBot('test-token', { polling: true }));

    let query = null;
    bot.on('callback_query', (q) => { query = q; });

    await waitFor(() => query);
    await bot.stopPolling();

    expect(query.id).toBe('cb-1');
  });

  it('stopPolling aborts the in-flight long-poll request', async () => {
    let capturedSignal = null;
    global.fetch = vi.fn((_url, opts = {}) => {
      capturedSignal = opts.signal;
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    });
    const bot = track(createTelegramBot('test-token', { polling: true }));

    await waitFor(() => capturedSignal !== null);
    expect(capturedSignal.aborted).toBe(false);

    await bot.stopPolling();
    expect(capturedSignal.aborted).toBe(true);
  });

  it('retries after a non-ok getUpdates response instead of dispatching', async () => {
    // RETRY_DELAY_API_ERROR_MS in telegramClient.js is 5000ms; drive it with
    // fake timers so the retry is instant rather than a real 5s wait.
    vi.useFakeTimers();
    let calls = 0;
    global.fetch = vi.fn((_url, opts = {}) => {
      calls++;
      if (calls === 1) return Promise.resolve(jsonRes({ ok: false, description: 'flood wait' }));
      if (calls === 2) return Promise.resolve(jsonRes(messageUpdate));
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    });
    const bot = track(createTelegramBot('test-token', { polling: true }));

    let matched = null;
    bot.onText(/\/boom/, (_msg, match) => { matched = match; });

    // Flush just the first (non-ok) fetch + parse without advancing the retry
    // timer: the loop must have consumed the non-ok response and scheduled a
    // retry, dispatching nothing.
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    expect(matched).toBeNull();

    // Advance past the 5s retry delay so the loop issues its second getUpdates,
    // which this time delivers the message and dispatches it.
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(20);

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(matched?.[0]).toBe('/boom');

    await bot.stopPolling();
    vi.useRealTimers();
  });
});

describe('createTelegramBot — apiCall methods', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('getMe posts to /getMe and returns the result on an ok response', async () => {
    const fetchMock = vi.fn(async (url, opts) => {
      expect(url).toContain('/getMe');
      expect(opts.method).toBe('POST');
      return jsonRes({ ok: true, result: { username: 'example_bot' } });
    });
    global.fetch = fetchMock;
    const bot = createTelegramBot('tok');

    const me = await bot.getMe();
    expect(me.username).toBe('example_bot');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sendMessage posts chat_id + text and returns the result', async () => {
    const fetchMock = vi.fn(async (url, opts) => {
      expect(url).toContain('/sendMessage');
      expect(opts.method).toBe('POST');
      const body = JSON.parse(opts.body);
      expect(body.chat_id).toBe(42);
      expect(body.text).toBe('hi there');
      return jsonRes({ ok: true, result: { message_id: 7 } });
    });
    global.fetch = fetchMock;
    const bot = createTelegramBot('tok');

    const res = await bot.sendMessage(42, 'hi there');
    expect(res.message_id).toBe(7);
  });

  it('parses a string reply_markup into an object before sending', async () => {
    let sentBody = null;
    global.fetch = vi.fn(async (_url, opts) => {
      sentBody = JSON.parse(opts.body);
      return jsonRes({ ok: true, result: {} });
    });
    const bot = createTelegramBot('tok');

    await bot.sendMessage(42, 'hi', { reply_markup: JSON.stringify({ inline_keyboard: [] }) });
    expect(sentBody.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it('throws with the Telegram description when the response is not ok', async () => {
    global.fetch = vi.fn(async () => jsonRes({ ok: false, description: 'Unauthorized: invalid token' }));
    const bot = createTelegramBot('tok');

    await expect(bot.getMe()).rejects.toThrow('Unauthorized: invalid token');
  });
});
