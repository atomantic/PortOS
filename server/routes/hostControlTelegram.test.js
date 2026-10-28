import { EventEmitter } from 'node:events';
import { afterAll, beforeEach, describe, expect, it as vitestIt, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy, ownTestBodies } from '../lib/mockPathsDataRoot.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-telegram-authority-') }));
const owned = ownTestBodies(vitestIt);
const it = owned.it;
afterAll(async () => {
  try { await owned.drain(); } finally { cleanupTempDataRoots(); }
});

const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));

let currentSettings = {
  telegram: { method: 'manual', chatId: '12345678', forwardTypes: ['health_issue'] },
  secrets: { telegram: { token: 'existing-secret-token' } },
};

vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => currentSettings),
  updateSettingsWith: vi.fn(async (updater) => {
    currentSettings = updater(currentSettings);
    return currentSettings;
  }),
}));

vi.mock('../services/instanceIdentity.js', () => ({
  loadData: vi.fn(async () => ({ peers: [{
    id: 'example-peer', instanceId: 'example-instance', enabled: true, syncSecret: 'a'.repeat(32),
  }] })),
}));

const telegramEffects = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  getStatus: vi.fn(() => ({ connected: true, botUsername: 'PortOS_bot' })),
  cleanup: vi.fn(async () => {}),
  sendMessage: vi.fn(async () => ({ success: true })),
  updateCachedForwardTypes: vi.fn(),
}));
vi.mock('../services/telegram.js', () => telegramEffects);

const bridgeEffects = vi.hoisted(() => ({
  init: vi.fn(async () => true),
  getStatus: vi.fn(() => ({ connected: true, hasBotToken: true, hasChatId: true, bridgeStatus: 'connected' })),
  cleanup: vi.fn(async () => {}),
  sendMessage: vi.fn(async () => ({ success: true })),
  updateCachedForwardTypes: vi.fn(),
  reload: vi.fn(async () => {}),
}));
vi.mock('../services/telegramBridge.js', () => bridgeEffects);

import { authGate, hostControlRouteGate, hostControlBodyGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import telegramRoutes from './telegram.js';

const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json(), hostControlBodyGate);
  app.use('/api/telegram', telegramRoutes);
  const settingsRouter = express.Router();
  settingsRouter.put('/', (req, res) => {
    currentSettings = { ...currentSettings, ...req.body };
    res.json({ saved: true });
  });
  settingsRouter.patch('/slice', (req, res) => {
    if (req.body?.slicePath) {
      currentSettings = { ...currentSettings, [req.body.slicePath]: req.body.partial };
    }
    res.json({ saved: true });
  });
  app.use('/api/settings', settingsRouter);
  app.use(errorMiddleware);
  return app;
};

const call = (app, [method, path, body = {}], headers = {}) => {
  const pending = request(app)[method.toLowerCase()](`/api/telegram${path}`);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};

const mutatingOperations = [
  ['PUT', '/config', { token: 'new-token', chatId: '87654321' }],
  ['DELETE', '/config', {}],
  ['PUT', '/method', { method: 'mcp-bridge' }],
  ['POST', '/test', { message: 'Test message' }],
  ['PUT', '/forward-types', { forwardTypes: ['agent_warning'] }],
  ['POST', '/bridge/reload', {}],
];

describe('Telegram bot, bridge and settings operator authority (#11431)', () => {
  beforeEach(async () => {
    await owned.drain();
    vi.clearAllMocks();
    auth.enabled = false;
    currentSettings = {
      telegram: { method: 'manual', chatId: '12345678', forwardTypes: ['health_issue'] },
      secrets: { telegram: { token: 'existing-secret-token' } },
    };
  });

  for (const [name, enabled, address, headers, status, code] of [
    ['remote without auth', false, '192.0.2.10', {}, 403, 'HOST_CONTROL_FORBIDDEN'],
    ['forwarded remote without auth', false, '127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }, 403, 'HOST_CONTROL_FORBIDDEN'],
    ['anonymous with auth', true, '192.0.2.10', {}, 401, 'AUTH_REQUIRED'],
    ['Basic password', true, '192.0.2.10', { Authorization: `Basic ${Buffer.from(':example-password').toString('base64')}` }, 403, 'HOST_CONTROL_FORBIDDEN'],
    ['scoped peer', true, '192.0.2.10', {
      [PEER_AUTH_HEADER]: derivePeerAuthToken('a'.repeat(32), 'example-instance'),
      [PEER_INSTANCE_HEADER]: 'example-instance',
    }, 403, 'PEER_SCOPE_FORBIDDEN'],
  ]) it(`refuses ${name} for all mutating Telegram routes`, async () => {
    auth.enabled = enabled;
    const app = appFor(address);

    for (const op of mutatingOperations) {
      const response = await call(app, op, headers);
      expect(response.status, `${op[0]} ${op[1]}: ${JSON.stringify(response.body)}`).toBe(status);
      expect(response.body.code).toBe(code);
    }

    expect(telegramEffects.init).not.toHaveBeenCalled();
    expect(telegramEffects.cleanup).not.toHaveBeenCalled();
    expect(telegramEffects.sendMessage).not.toHaveBeenCalled();
    expect(bridgeEffects.init).not.toHaveBeenCalled();
    expect(bridgeEffects.cleanup).not.toHaveBeenCalled();
    expect(bridgeEffects.sendMessage).not.toHaveBeenCalled();
    expect(bridgeEffects.reload).not.toHaveBeenCalled();
  });

  it('protects Express case and trailing-slash aliases', async () => {
    const app = appFor();

    const config = await request(app).put('/API/TELEGRAM/CONFIG/').send({ token: 'new-token', chatId: '87654321' });
    const del = await request(app).delete('/API/TELEGRAM/CONFIG/');
    const method = await request(app).put('/API/TELEGRAM/METHOD/').send({ method: 'mcp-bridge' });
    const test = await request(app).post('/API/TELEGRAM/TEST/').send({ message: 'test' });
    const forward = await request(app).put('/API/TELEGRAM/FORWARD-TYPES/').send({ forwardTypes: ['agent_warning'] });
    const reload = await request(app).post('/API/TELEGRAM/BRIDGE/RELOAD/');

    expect(config.status).toBe(403);
    expect(del.status).toBe(403);
    expect(method.status).toBe(403);
    expect(test.status).toBe(403);
    expect(forward.status).toBe(403);
    expect(reload.status).toBe(403);

    expect(telegramEffects.init).not.toHaveBeenCalled();
    expect(telegramEffects.sendMessage).not.toHaveBeenCalled();
  });

  for (const [principal, address] of [
    ['local', '127.0.0.1'],
    ['operator session', '192.0.2.10'],
    ['delegated agent', '127.0.0.1'],
  ]) it(`preserves ${principal} Telegram operations`, async () => {
    const headers = {};
    if (principal !== 'local') {
      const session = await createSession({ label: principal === 'delegated agent' ? 'agent' : 'operator' });
      auth.enabled = true;
      if (principal === 'delegated agent') headers.Authorization = `Bearer ${session.token}`;
      else headers.Cookie = `portos_auth=${session.token}`;
    }
    const app = appFor(address);

    const configRes = await call(app, ['PUT', '/config', { token: 'new-token', chatId: '87654321' }], headers);
    expect(configRes.status).toBe(200);
    expect(telegramEffects.init).toHaveBeenCalled();

    const testRes = await call(app, ['POST', '/test', { message: 'Hello from test' }], headers);
    expect(testRes.status).toBe(200);
    expect(telegramEffects.sendMessage).toHaveBeenCalledWith('Hello from test');

    const forwardRes = await call(app, ['PUT', '/forward-types', { forwardTypes: ['agent_warning'] }], headers);
    expect(forwardRes.status).toBe(200);

    const methodRes = await call(app, ['PUT', '/method', { method: 'mcp-bridge' }], headers);
    expect(methodRes.status).toBe(200);
    expect(bridgeEffects.init).toHaveBeenCalled();

    const reloadRes = await call(app, ['POST', '/bridge/reload', {}], headers);
    expect(reloadRes.status).toBe(200);
    expect(bridgeEffects.reload).toHaveBeenCalled();

    const deleteRes = await call(app, ['DELETE', '/config', {}], headers);
    expect(deleteRes.status).toBe(200);
    expect(bridgeEffects.cleanup).toHaveBeenCalled();
  });

  it('keeps remote reads available without granting execution or config mutation', async () => {
    const app = appFor();

    const status = await request(app).get('/api/telegram/status');
    expect(status.status).toBe(200);
    expect(status.body.hasToken).toBe(true);
    expect(status.body.hasChatId).toBe(true);
    expect(status.body.method).toBe('manual');

    expect(telegramEffects.init).not.toHaveBeenCalled();
    expect(telegramEffects.sendMessage).not.toHaveBeenCalled();
  });

  it('gates the telegram slice on PUT /api/settings and PATCH /api/settings/slice', async () => {
    const remoteApp = appFor('192.0.2.10');

    const putRemote = await request(remoteApp).put('/api/settings').send({ telegram: { chatId: 'attacker-chat' } });
    expect(putRemote.status).toBe(403);
    expect(putRemote.body.code).toBe('HOST_CONTROL_FORBIDDEN');

    const patchRemote = await request(remoteApp).patch('/api/settings/slice').send({
      slicePath: 'telegram',
      partial: { chatId: 'attacker-chat' },
    });
    expect(patchRemote.status).toBe(403);
    expect(patchRemote.body.code).toBe('HOST_CONTROL_FORBIDDEN');

    // Safe / non-host-control slice stays open to remote callers
    const safePut = await request(remoteApp).put('/api/settings').send({ location: { city: 'Test' } });
    expect(safePut.status).toBe(200);

    const localApp = appFor('127.0.0.1');
    const putLocal = await request(localApp).put('/api/settings').send({ telegram: { chatId: 'local-chat' } });
    expect(putLocal.status).toBe(200);

    const patchLocal = await request(localApp).patch('/api/settings/slice').send({
      slicePath: 'telegram',
      partial: { chatId: 'local-chat-2' },
    });
    expect(patchLocal.status).toBe(200);
  });
});
