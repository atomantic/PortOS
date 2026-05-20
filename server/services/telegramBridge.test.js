import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';

const ENV_FILE = join(homedir(), '.claude', 'channels', 'telegram', '.env');
const ACCESS_FILE = join(homedir(), '.claude', 'channels', 'telegram', 'access.json');

// Files the bridge reads at init/reload time.
const fileStore = new Map();

vi.mock('../lib/fileUtils.js', () => ({
  tryReadFile: vi.fn(async (path) => (fileStore.has(path) ? fileStore.get(path) : null)),
  // Stubs to satisfy notifications.js (the real module imports these at load).
  PATHS: { data: '/mock/data' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  readJSONFile: vi.fn(async (_path, defaultValue = null) => defaultValue),
  atomicWrite: vi.fn().mockResolvedValue(undefined)
}));

// We import the real notifications module so the bridge can subscribe to the
// event emitter — that's the spot where forwardNotification is exercised
// without poking at any private internal.
const { notificationEvents, NOTIFICATION_TYPES, PRIORITY_LEVELS } = await import('./notifications.js');

const {
  init,
  cleanup,
  sendMessage,
  getStatus,
  reload,
  updateCachedForwardTypes
} = await import('./telegramBridge.js');

const BOT_TOKEN = '123:ABC';
const CHAT_ID = 12345;

// Multi-tick flush so the EventEmitter handler → sendMessage → apiCall →
// res.json() microtask chain settles before we assert on fetch calls.
async function flush() {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function mockTelegramFetch({ getMeOk = true, sendOk = true } = {}) {
  const fetchSpy = vi.fn(async (url) => {
    if (url.endsWith('/getMe')) {
      return {
        ok: true,
        json: async () => (getMeOk
          ? { ok: true, result: { username: 'portos_test_bot' } }
          : { ok: false, description: 'Unauthorized' })
      };
    }
    if (url.endsWith('/sendMessage')) {
      return {
        ok: true,
        json: async () => (sendOk
          ? { ok: true, result: { message_id: 1 } }
          : { ok: false, description: 'Bad Request' })
      };
    }
    throw new Error(`unexpected telegram URL ${url}`);
  });
  return fetchSpy;
}

function seedCredentials(chatId = CHAT_ID) {
  fileStore.set(ENV_FILE, `TELEGRAM_BOT_TOKEN=${BOT_TOKEN}\n`);
  fileStore.set(ACCESS_FILE, JSON.stringify({ allowFrom: [chatId] }));
}

describe('telegramBridge service', () => {
  // The rate-limit token bucket is module-level state with no public reset;
  // bumping the virtual clock by 5 minutes between tests guarantees the next
  // consumeToken() call triggers a bucket refill before any assertions.
  let virtualNow = Date.now();

  beforeEach(() => {
    fileStore.clear();
    virtualNow += 5 * 60_000;
    vi.useFakeTimers({ now: virtualNow, toFake: ['Date'] });
  });

  afterEach(async () => {
    // Reset module-level state and unsubscribe from the EventEmitter.
    await cleanup();
    updateCachedForwardTypes(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('init', () => {
    it('returns false when no bot token file is present', async () => {
      expect(await init()).toBe(false);
      expect(getStatus()).toMatchObject({ connected: false, hasBotToken: false });
    });

    it('returns false when the access.json has no allowFrom entries', async () => {
      fileStore.set(ENV_FILE, `TELEGRAM_BOT_TOKEN=${BOT_TOKEN}\n`);
      fileStore.set(ACCESS_FILE, JSON.stringify({ allowFrom: [] }));
      expect(await init()).toBe(false);
      expect(getStatus().connected).toBe(false);
    });

    it('returns false and clears the token when getMe rejects the token', async () => {
      seedCredentials();
      vi.stubGlobal('fetch', mockTelegramFetch({ getMeOk: false }));
      expect(await init()).toBe(false);
      expect(getStatus()).toMatchObject({
        connected: false,
        botUsername: null,
        hasBotToken: false,
        hasChatId: true
      });
    });

    it('returns true and records the bot username on a valid handshake', async () => {
      seedCredentials();
      vi.stubGlobal('fetch', mockTelegramFetch());
      expect(await init()).toBe(true);
      expect(getStatus()).toMatchObject({
        connected: true,
        botUsername: 'portos_test_bot',
        chatId: CHAT_ID,
        hasBotToken: true,
        hasChatId: true
      });
    });

    it('parses TELEGRAM_BOT_TOKEN from a multi-line .env file', async () => {
      fileStore.set(ENV_FILE, `OTHER=ignored\nTELEGRAM_BOT_TOKEN=${BOT_TOKEN}\nTRAILING=value\n`);
      fileStore.set(ACCESS_FILE, JSON.stringify({ allowFrom: [CHAT_ID] }));
      vi.stubGlobal('fetch', mockTelegramFetch());
      expect(await init()).toBe(true);
      expect(getStatus().connected).toBe(true);
    });
  });

  describe('sendMessage', () => {
    it('refuses to send before init (no bot token)', async () => {
      const result = await sendMessage('hello');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/no bot token/i);
    });

    it('posts to the Telegram API with HTML parse mode', async () => {
      seedCredentials();
      const fetchSpy = mockTelegramFetch();
      vi.stubGlobal('fetch', fetchSpy);
      await init();

      const result = await sendMessage('<b>hi</b>');
      expect(result).toEqual({ success: true });

      const sendCall = fetchSpy.mock.calls.find(([url]) => url.endsWith('/sendMessage'));
      expect(sendCall).toBeDefined();
      const [, opts] = sendCall;
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual({
        chat_id: CHAT_ID,
        text: '<b>hi</b>',
        parse_mode: 'HTML'
      });
    });

    it('surfaces an error when the API replies ok:false', async () => {
      seedCredentials();
      vi.stubGlobal('fetch', mockTelegramFetch({ sendOk: false }));
      await init();
      const result = await sendMessage('boom');
      expect(result).toEqual({ success: false, error: 'Send failed' });
    });

    it('returns a rate-limit error once the 30-message bucket drains', async () => {
      seedCredentials();
      const fetchSpy = mockTelegramFetch();
      vi.stubGlobal('fetch', fetchSpy);
      await init();
      // init() consumes one call against /getMe; reset before counting sends.
      fetchSpy.mockClear();

      // Drain 30 successes, then the 31st must hit the rate-limit branch.
      for (let i = 0; i < 30; i++) await sendMessage(`msg ${i}`);
      const sent = fetchSpy.mock.calls.filter(([url]) => url.endsWith('/sendMessage'));
      expect(sent).toHaveLength(30);

      const blocked = await sendMessage('one too many');
      expect(blocked).toEqual({ success: false, error: 'Rate limit exceeded' });
    });
  });

  describe('reload', () => {
    it('no-ops when the bridge is not active', async () => {
      // Seed a different chat id but don't init — reload should silently do nothing.
      fileStore.set(ACCESS_FILE, JSON.stringify({ allowFrom: [999] }));
      await reload();
      expect(getStatus().chatId).toBeNull();
    });

    it('swaps the chat id when access.json changes while active', async () => {
      seedCredentials();
      vi.stubGlobal('fetch', mockTelegramFetch());
      await init();
      expect(getStatus().chatId).toBe(CHAT_ID);

      fileStore.set(ACCESS_FILE, JSON.stringify({ allowFrom: [987] }));
      await reload();
      expect(getStatus().chatId).toBe(987);
    });
  });

  describe('cleanup', () => {
    it('clears module state and unsubscribes from notification events', async () => {
      // Capture baseline listener count; the assertion is relative so any
      // unrelated listeners attached at module-import time don't false-fail us.
      const baselineListeners = notificationEvents.listenerCount('added');
      seedCredentials();
      const fetchSpy = mockTelegramFetch();
      vi.stubGlobal('fetch', fetchSpy);
      await init();
      expect(notificationEvents.listenerCount('added')).toBe(baselineListeners + 1);

      await cleanup();
      expect(getStatus()).toMatchObject({
        connected: false,
        botUsername: null,
        chatId: null,
        hasBotToken: false,
        hasChatId: false
      });
      expect(notificationEvents.listenerCount('added')).toBe(baselineListeners);
    });
  });

  describe('notification forwarding', () => {
    it('forwards a notification by emitting an "added" event after init', async () => {
      seedCredentials();
      const fetchSpy = mockTelegramFetch();
      vi.stubGlobal('fetch', fetchSpy);
      await init();
      fetchSpy.mockClear();

      notificationEvents.emit('added', {
        type: NOTIFICATION_TYPES.HEALTH_ISSUE,
        title: 'High & rising',
        description: '<script>',
        priority: PRIORITY_LEVELS.HIGH
      });
      await flush();

      const sendCall = fetchSpy.mock.calls.find(([url]) => url.endsWith('/sendMessage'));
      expect(sendCall).toBeDefined();
      const body = JSON.parse(sendCall[1].body);
      expect(body.text).toContain('⚠️');
      expect(body.text).toContain('<b>High &amp; rising</b>');
      expect(body.text).toContain('&lt;script&gt;');
      expect(body.text).toContain('Priority: 🟠 high');
    });

    it('filters by updateCachedForwardTypes when the whitelist is non-empty', async () => {
      seedCredentials();
      const fetchSpy = mockTelegramFetch();
      vi.stubGlobal('fetch', fetchSpy);
      await init();
      fetchSpy.mockClear();

      updateCachedForwardTypes([NOTIFICATION_TYPES.HEALTH_ISSUE]);
      notificationEvents.emit('added', {
        type: NOTIFICATION_TYPES.CODE_REVIEW, // not in whitelist
        title: 'PR ready',
        priority: PRIORITY_LEVELS.LOW
      });
      await flush();
      expect(fetchSpy.mock.calls.filter(([url]) => url.endsWith('/sendMessage'))).toHaveLength(0);

      fetchSpy.mockClear();
      notificationEvents.emit('added', {
        type: NOTIFICATION_TYPES.HEALTH_ISSUE,
        title: 'Glucose',
        priority: PRIORITY_LEVELS.MEDIUM
      });
      await flush();
      expect(fetchSpy.mock.calls.filter(([url]) => url.endsWith('/sendMessage'))).toHaveLength(1);
    });
  });
});
