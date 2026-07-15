/**
 * Tests for the settings-backed Telegram bot service (server/services/telegram.js).
 *
 * The rate limiter (token bucket) and the "unauthorized chat" rejection are the
 * two behaviors called out in the issue. Neither helper is exported, so they are
 * exercised through the public surface: `init()` wires a fake bot (created via a
 * mocked `createTelegramBot`) and registers the message/callback handlers, and
 * `sendMessage()` drives the token bucket. All external modules are mocked so no
 * network, disk, or real timers are touched.
 *
 * Each test re-imports the module via `loadTelegram()` (resetModules) so the
 * module-level token bucket and `authorizedChatId` start fresh.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Shared, mutable holder for the fake bot's captured handlers + spies. Reset in
// beforeEach so each test sees a clean bot. `vi.hoisted` makes it available to
// the hoisted `vi.mock` factory below.
const h = vi.hoisted(() => ({
  textHandlers: [],
  eventHandlers: {},
  sendMessage: null,
  answerCallbackQuery: null,
  editMessageText: null,
  getMe: null,
  stopPolling: null,
}));

vi.mock('../lib/telegramClient.js', () => ({
  createTelegramBot: vi.fn(() => ({
    getMe: (...a) => h.getMe(...a),
    sendMessage: (...a) => h.sendMessage(...a),
    answerCallbackQuery: (...a) => h.answerCallbackQuery(...a),
    editMessageText: (...a) => h.editMessageText(...a),
    onText: (regex, fn) => h.textHandlers.push({ regex, fn }),
    on: (event, fn) => { (h.eventHandlers[event] ||= []).push(fn); },
    stopPolling: (...a) => h.stopPolling(...a),
  })),
}));

// Settings supply the token + authorized chat id init() caches.
vi.mock('./settings.js', () => ({
  getSettings: vi.fn(async () => ({
    secrets: { telegram: { token: 'test-token' } },
    telegram: { chatId: '42', forwardTypes: null },
    backup: { enabled: false },
  })),
}));

// A minimal EventEmitter stand-in so init()'s notification subscription works.
const notifEmitter = vi.hoisted(() => {
  const listeners = {};
  return {
    on(event, fn) { (listeners[event] ||= []).push(fn); },
    removeListener(event, fn) {
      listeners[event] = (listeners[event] || []).filter((f) => f !== fn);
    },
    emit(event, ...args) { (listeners[event] || []).forEach((fn) => fn(...args)); },
  };
});

vi.mock('./notifications.js', () => ({
  notificationEvents: notifEmitter,
  NOTIFICATION_TYPES: {
    MEMORY_APPROVAL: 'memory_approval',
    TASK_APPROVAL: 'task_approval',
    CODE_REVIEW: 'code_review',
    HEALTH_ISSUE: 'health_issue',
    BRIEFING_READY: 'briefing_ready',
    AUTOBIOGRAPHY_PROMPT: 'autobiography_prompt',
    PLAN_QUESTION: 'plan_question',
    DAILY_POST_REMINDER: 'daily_post_reminder',
  },
  getNotifications: vi.fn(async () => []),
}));

vi.mock('./cosState.js', () => ({
  getDomainAutonomyMode: vi.fn(async () => 'execute'),
}));

vi.mock('./domainUsage.js', () => ({
  getDomainBudgetStatus: vi.fn(async () => ({ withinBudget: true, exceeded: null })),
  recordDomainUsage: vi.fn(async () => {}),
}));

vi.mock('./memoryBackend.js', () => ({
  approveMemory: vi.fn(async () => ({ success: true })),
  rejectMemory: vi.fn(async () => ({ success: true })),
  peekMemory: vi.fn(async () => null),
}));

vi.mock('../lib/fileUtils.js', () => ({
  ensureDir: vi.fn(async () => {}),
  PATHS: { data: '/mock/data' },
  readJSONFile: vi.fn(async (_path, def) => def),
  formatDuration: vi.fn(() => '1m'),
  atomicWrite: vi.fn(async () => {}),
}));

vi.mock('./subAgentSpawner.js', () => ({ getActiveAgents: vi.fn(() => []) }));
vi.mock('./identity.js', () => ({ getGoals: vi.fn(async () => ({ goals: [] })) }));
vi.mock('../lib/uuid.js', () => ({ v4: vi.fn(() => 'test-uuid') }));

async function loadTelegram() {
  vi.resetModules();
  return import('./telegram.js');
}

describe('telegram service', () => {
  let logSpy;
  let errorSpy;

  beforeEach(() => {
    h.textHandlers = [];
    h.eventHandlers = {};
    h.sendMessage = vi.fn(async () => ({ message_id: 1 }));
    h.answerCallbackQuery = vi.fn(async () => {});
    h.editMessageText = vi.fn(async () => {});
    h.getMe = vi.fn(async () => ({ username: 'example_bot' }));
    h.stopPolling = vi.fn(async () => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('rate limiting (token bucket)', () => {
    it('sends up to the bucket max then rejects further messages until refill', async () => {
      const telegram = await loadTelegram();
      await telegram.init(false);

      const results = [];
      // BUCKET_MAX is 30 in telegram.js; the 31st send must be rate limited.
      for (let i = 0; i < 31; i++) {
        results.push(await telegram.sendMessage(`msg ${i}`));
      }

      await telegram.cleanup();

      const successes = results.filter((r) => r.success).length;
      expect(successes).toBe(30);
      expect(results[30]).toEqual({ success: false, error: 'Rate limit exceeded' });
      // The underlying bot.sendMessage is only called for the 30 that passed the gate.
      expect(h.sendMessage).toHaveBeenCalledTimes(30);
    });

    it('returns an error without calling the bot when no chatId is configured', async () => {
      const telegram = await loadTelegram();
      // Never init(): authorizedChatId stays null.
      const res = await telegram.sendMessage('hello');
      expect(res.success).toBe(false);
      expect(h.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('unauthorized chat rejection', () => {
    it('rejects a message from a non-authorized chat id and notifies that chat', async () => {
      const telegram = await loadTelegram();
      await telegram.init(false);

      const messageHandler = h.eventHandlers.message[0];
      expect(messageHandler).toBeTypeOf('function');

      // A message from chat id 999 (authorized is 42) must be rejected.
      await messageHandler({ chat: { id: 999 }, text: 'let me in' });

      // isAuthorized fires a "not configured for your chat ID" notice to the
      // sender's own chat, not the authorized one.
      expect(h.sendMessage).toHaveBeenCalledWith(
        '999',
        expect.stringContaining('not configured for your chat ID')
      );

      await telegram.cleanup();
    });

    it('does not run command handlers for an unauthorized chat', async () => {
      const telegram = await loadTelegram();
      await telegram.init(false);

      // /status is guarded by isAuthorized; find its handler.
      const statusEntry = h.textHandlers.find((t) => t.regex.source.includes('status'));
      expect(statusEntry).toBeDefined();

      h.sendMessage.mockClear();
      await statusEntry.fn({ chat: { id: 999 }, text: '/status' });

      // The only send is the rejection notice — the status report never runs, so
      // getMe/status content is never sent to the unauthorized chat.
      expect(h.sendMessage).toHaveBeenCalledTimes(1);
      expect(h.sendMessage).toHaveBeenCalledWith(
        '999',
        expect.stringContaining('not configured for your chat ID')
      );

      await telegram.cleanup();
    });

    it('rejects a callback_query from a non-authorized chat with an Unauthorized answer', async () => {
      const telegram = await loadTelegram();
      await telegram.init(false);

      const cbHandler = h.eventHandlers.callback_query[0];
      expect(cbHandler).toBeTypeOf('function');

      await cbHandler({ id: 'cb-1', message: { chat: { id: 999 } }, data: 'mem_approve:abc' });

      expect(h.answerCallbackQuery).toHaveBeenCalledWith('cb-1', { text: 'Unauthorized' });
      // The memory action must not run for an unauthorized chat.
      expect(h.editMessageText).not.toHaveBeenCalled();

      await telegram.cleanup();
    });
  });
});
