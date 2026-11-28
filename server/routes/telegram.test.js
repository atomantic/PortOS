import { beforeEach, describe, it, expect, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { AVAILABLE_FORWARD_TYPES, NOTIFICATION_TYPES } from '../lib/notificationTypes.js';

vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(),
  updateSettingsWith: vi.fn()
}));
vi.mock('../services/telegram.js', () => ({
  getStatus: vi.fn(() => ({ connected: true })),
  updateCachedForwardTypes: vi.fn(),
  init: vi.fn(async () => {}),
  cleanup: vi.fn(async () => {}),
  sendMessage: vi.fn(async () => ({ success: true }))
}));
vi.mock('../services/telegramBridge.js', () => ({
  getStatus: vi.fn(() => ({ connected: true, hasBotToken: true, hasChatId: true })),
  updateCachedForwardTypes: vi.fn(),
  init: vi.fn(async () => true),
  cleanup: vi.fn(async () => {}),
  sendMessage: vi.fn(async () => ({ success: true }))
}));

const { getSettings, updateSettingsWith } = await import('../services/settings.js');
const telegram = await import('../services/telegram.js');
const telegramBridge = await import('../services/telegramBridge.js');
const { default: router } = await import('./telegram.js');
const app = express();
app.use(express.json());
app.use('/api/telegram', router);
app.use(errorMiddleware);

beforeEach(() => {
  vi.clearAllMocks();
  telegram.sendMessage.mockResolvedValue({ success: true });
  telegramBridge.sendMessage.mockResolvedValue({ success: true });
  telegramBridge.init.mockResolvedValue(true);
});

describe('Telegram forwarding catalog contract', () => {
  it.each(['manual', 'mcp-bridge'])('advertises the complete vocabulary and preserves selections for %s', async method => {
    let settings = { telegram: { method, forwardTypes: ['health_issue', 'unknown_saved_type'] } };
    getSettings.mockImplementation(async () => settings);
    updateSettingsWith.mockImplementation(async update => { settings = update(settings); return settings; });
    const status = await request(app).get('/api/telegram/status');
    expect(status.status).toBe(200);
    expect(status.body.availableForwardTypes).toEqual(AVAILABLE_FORWARD_TYPES);
    expect(status.body.availableForwardTypes.map(({ key }) => key).sort()).toEqual(Object.values(NOTIFICATION_TYPES).sort());
    expect(status.body.availableForwardTypes).toEqual(expect.arrayContaining([
      { key: 'agent_warning', label: 'Agent Warnings' },
      { key: 'autopilot_paused', label: 'Autopilot Paused' },
      { key: 'creative_commission', label: 'Creative Commissions' }
    ]));
    expect(status.body.forwardTypes).toEqual(settings.telegram.forwardTypes);
    const forwardTypes = [...status.body.forwardTypes, 'autopilot_paused'];
    const saved = await request(app).put('/api/telegram/forward-types').send({ forwardTypes });
    expect(saved.status).toBe(200);
    expect(settings.telegram).toEqual({ method, forwardTypes });
    const cleared = await request(app).put('/api/telegram/forward-types').send({ forwardTypes: [] });
    expect(cleared.status).toBe(200);
    expect(settings.telegram.forwardTypes).toEqual([]);
  });

  it.each(['manual', 'mcp-bridge'])('returns the status forwarding payload when switching to %s', async method => {
    const forwardTypes = ['health_issue', 'unknown_saved_type'];
    let settings = {
      telegram: { method: method === 'manual' ? 'mcp-bridge' : 'manual', forwardTypes },
      secrets: { telegram: { token: 'test-token' } }
    };
    getSettings.mockImplementation(async () => settings);
    updateSettingsWith.mockImplementation(async update => { settings = update(settings); return settings; });

    const status = await request(app).get('/api/telegram/status');
    const switched = await request(app).put('/api/telegram/method').send({ method });

    expect(switched.status).toBe(200);
    expect(switched.body.forwardTypes).toEqual(status.body.forwardTypes);
    expect(switched.body.availableForwardTypes).toEqual(status.body.availableForwardTypes);
  });

  it('rejects manual bot configuration while the MCP bridge is active', async () => {
    getSettings.mockResolvedValue({ telegram: { method: 'mcp-bridge' } });

    const response = await request(app).put('/api/telegram/config').send({ token: 'test-token', chatId: '12345678' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('TELEGRAM_METHOD_MISMATCH');
  });
});

describe('Telegram bot lifecycle, credentials, and test messaging', () => {
  // Catches regressions that clobber unrelated secrets or wipe an existing bot token/chatId on partial updates.
  it('stores token and chatId, preserves omitted credentials against the freshest snapshot, and passes hasChatId to init', async () => {
    let settings = {
      secrets: { unrelated: { key: 'keep-me' } },
      telegram: { method: 'manual' }
    };
    getSettings.mockImplementation(async () => settings);
    updateSettingsWith.mockImplementation(async (update) => {
      settings = update(settings);
      return settings;
    });

    const initial = await request(app).put('/api/telegram/config').send({ token: 'bot-token-1', chatId: '' });
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ connected: true, hasToken: true, hasChatId: false });
    expect(settings.secrets).toEqual({ unrelated: { key: 'keep-me' }, telegram: { token: 'bot-token-1' } });
    expect(telegram.init).toHaveBeenCalledWith(false);

    // Omitting token preserves the stored token; supplying chatId triggers init(true).
    const withChat = await request(app).put('/api/telegram/config').send({ chatId: '123456' });
    expect(withChat.status).toBe(200);
    expect(withChat.body).toMatchObject({ hasToken: true, hasChatId: true });
    expect(settings.secrets.telegram.token).toBe('bot-token-1');
    expect(settings.telegram.chatId).toBe('123456');
    expect(telegram.init).toHaveBeenLastCalledWith(true);

    // Concurrent chatId written before the queued update must survive an omitted chatId.
    const staleSnapshot = { ...settings, telegram: { method: 'manual', chatId: '' } };
    getSettings.mockResolvedValueOnce(staleSnapshot);
    const keepChat = await request(app).put('/api/telegram/config').send({ token: 'bot-token-2' });
    expect(keepChat.status).toBe(200);
    expect(keepChat.body).toMatchObject({ hasToken: true, hasChatId: true });
    expect(settings.secrets.telegram.token).toBe('bot-token-2');
    expect(settings.telegram.chatId).toBe('123456');
  });

  it('refuses PUT /config with 400 VALIDATION_ERROR when no token is provided and none is stored', async () => {
    getSettings.mockResolvedValue({ telegram: { method: 'manual' }, secrets: {} });

    const response = await request(app).put('/api/telegram/config').send({ chatId: '123456' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(updateSettingsWith).not.toHaveBeenCalled();
    expect(telegram.init).not.toHaveBeenCalled();
  });

  // Catches leaving the old polling bot/bridge running or clobbering unrelated secrets during DELETE /config.
  it.each([
    { method: 'manual', activeCleanup: () => telegram.cleanup, inactiveCleanup: () => telegramBridge.cleanup },
    { method: 'mcp-bridge', activeCleanup: () => telegramBridge.cleanup, inactiveCleanup: () => telegram.cleanup },
  ])('cleans up the active $method service and clears telegram config without clobbering other secrets', async ({ method, activeCleanup, inactiveCleanup }) => {
    let settings = {
      telegram: { method, chatId: '42', forwardTypes: ['health_issue'] },
      secrets: { telegram: { token: 'bot-token' }, other: { apiKey: 'keep' } }
    };
    getSettings.mockImplementation(async () => settings);
    updateSettingsWith.mockImplementation(async (update) => {
      settings = update(settings);
      return settings;
    });

    const response = await request(app).delete('/api/telegram/config');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(activeCleanup()).toHaveBeenCalledOnce();
    expect(inactiveCleanup()).not.toHaveBeenCalled();
    expect(settings.telegram).toBeNull();
    expect(settings.secrets.telegram).toBeUndefined();
    expect(settings.secrets.other).toEqual({ apiKey: 'keep' });
  });

  it('stops the outgoing service, initializes the incoming service, and syncs forwardTypes on PUT /method', async () => {
    let settings = {
      telegram: { method: 'manual', chatId: '42', forwardTypes: ['health_issue'] },
      secrets: { telegram: { token: 'bot-token' } }
    };
    getSettings.mockImplementation(async () => settings);
    updateSettingsWith.mockImplementation(async (update) => {
      settings = update(settings);
      return settings;
    });

    const toBridge = await request(app).put('/api/telegram/method').send({ method: 'mcp-bridge' });
    expect(toBridge.status).toBe(200);
    expect(toBridge.body).toMatchObject({ method: 'mcp-bridge', initialized: true, hasToken: true, hasChatId: true });
    expect(telegram.cleanup).toHaveBeenCalledOnce();
    expect(telegramBridge.init).toHaveBeenCalledOnce();
    expect(telegramBridge.updateCachedForwardTypes).toHaveBeenCalledWith(['health_issue']);

    vi.clearAllMocks();
    const toManual = await request(app).put('/api/telegram/method').send({ method: 'manual' });
    expect(toManual.status).toBe(200);
    expect(toManual.body).toMatchObject({ method: 'manual', hasToken: true, hasChatId: true });
    expect(telegramBridge.cleanup).toHaveBeenCalledOnce();
    expect(telegram.init).toHaveBeenCalledWith(false);
    expect(telegram.updateCachedForwardTypes).toHaveBeenCalledWith(['health_issue']);

    const invalid = await request(app).put('/api/telegram/method').send({ method: 'webhook' });
    expect(invalid.status).toBe(400);
  });

  it('dispatches POST /test to the active service with default or custom text and maps send failures to 502', async () => {
    getSettings.mockResolvedValue({ telegram: { method: 'manual' } });
    const defaultSend = await request(app).post('/api/telegram/test').send({});
    expect(defaultSend.status).toBe(200);
    expect(defaultSend.body).toEqual({ success: true });
    expect(telegram.sendMessage).toHaveBeenCalledWith('🧪 Test message from PortOS');
    expect(telegramBridge.sendMessage).not.toHaveBeenCalled();

    getSettings.mockResolvedValue({ telegram: { method: 'mcp-bridge' } });
    const customSend = await request(app).post('/api/telegram/test').send({ message: 'Ping bridge' });
    expect(customSend.status).toBe(200);
    expect(telegramBridge.sendMessage).toHaveBeenCalledWith('Ping bridge');

    telegramBridge.sendMessage.mockResolvedValueOnce({ success: false, error: 'Bot blocked' });
    const failed = await request(app).post('/api/telegram/test').send({ message: 'Fail' });
    expect(failed.status).toBe(502);
    expect(failed.body).toMatchObject({ code: 'TELEGRAM_SEND_FAILED', error: 'Bot blocked' });
  });
});
