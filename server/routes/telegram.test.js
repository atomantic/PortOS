import { describe, it, expect, vi } from 'vitest';
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
  cleanup: vi.fn(async () => {})
}));
vi.mock('../services/telegramBridge.js', () => ({
  getStatus: vi.fn(() => ({ connected: true, hasBotToken: true, hasChatId: true })),
  updateCachedForwardTypes: vi.fn(),
  init: vi.fn(async () => true),
  cleanup: vi.fn(async () => {})
}));

const { getSettings, updateSettingsWith } = await import('../services/settings.js');
const { default: router } = await import('./telegram.js');
const app = express();
app.use(express.json());
app.use('/api/telegram', router);
app.use(errorMiddleware);

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
