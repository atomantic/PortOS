import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { EventEmitter } from 'node:events';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';

vi.mock('../lib/fileUtils.js', async (original) => makePathsProxy(await original(), {
  dataRoot: () => lazyTempDataRoot('portos-moltworld-authority-'),
}));
afterAll(cleanupTempDataRoots);
const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (original) => ({
  ...await original(), isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({ settingsEvents: new EventEmitter(), getSettings: async () => ({}) }));
const effects = vi.hoisted(() => ({
  getAccountWithCredentials: vi.fn(async () => ({ status: 'active', platform: 'moltworld', credentials: { apiKey: 'example-key' } })),
  recordActivity: vi.fn(), joinWorld: vi.fn(async () => ({})), build: vi.fn(async () => ({})), think: vi.fn(async () => ({})),
  getProfile: vi.fn(async () => ({})), getBalance: vi.fn(async () => ({})), getRateLimitStatus: vi.fn(() => ({})),
  connect: vi.fn(), disconnect: vi.fn(), getStatus: vi.fn(() => ({})),
  sendMove: vi.fn(), sendThink: vi.fn(), sendNearby: vi.fn(), sendInteract: vi.fn(),
  addAction: vi.fn(() => ({})), removeAction: vi.fn(() => ({})), markCompleted: vi.fn(() => ({})), markFailed: vi.fn(() => ({})), getQueue: vi.fn(() => []),
}));
vi.mock('../services/platformAccounts.js', () => effects);
vi.mock('../services/agentPersonalities.js', () => ({ getAgentById: vi.fn() }));
vi.mock('../services/agentActivity.js', () => ({ logActivity: vi.fn() }));
vi.mock('../integrations/moltworld/index.js', () => ({ createMoltworldClient: () => effects }));
vi.mock('../services/moltworldWs.js', () => effects);
vi.mock('../services/moltworldQueue.js', () => effects);

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import tools from './moltworldTools.js';
import ws from './moltworldWs.js';
const base = '/api/agents/tools/moltworld';
const operations = [
  ['join', { accountId: 'example-account' }, 'joinWorld'],
  ['build', { accountId: 'example-account', x: 0, y: 0, z: 0 }, 'build'],
  ['explore', { accountId: 'example-account', x: 0, y: 0 }, 'joinWorld'],
  ['think', { accountId: 'example-account', thought: 'Example thought' }, 'think'],
  ['say', { accountId: 'example-account', message: 'Example message' }, 'joinWorld'],
  ['queue', { agentId: 'example-agent', actionType: 'mw_think' }, 'addAction'],
  ['ws/connect', { accountId: 'example-account' }, 'connect'],
  ['ws/move', { x: 0, y: 0 }, 'sendMove'],
  ['ws/think', { thought: 'Example thought' }, 'sendThink'],
  ['ws/nearby', {}, 'sendNearby'],
  ['ws/interact', { to: 'example-agent' }, 'sendInteract'],
];
const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => { Object.defineProperty(req.socket, 'remoteAddress', { value: address }); next(); });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use(base + '/ws', ws);
  app.use(base, tools);
  app.use(errorMiddleware);
  return app;
};
const call = (app, path, body, headers = {}) => {
  const pending = request(app).post(`${base}/${path}`);
  for (const [key, value] of Object.entries(headers)) pending.set(key, value);
  return pending.send(body);
};
beforeEach(() => { vi.clearAllMocks(); auth.enabled = false; });

describe('Moltworld host authority', () => {
  it('refuses remote and forwarded callers before credentials, queue or socket effects', async () => {
    for (const [path, body] of operations) {
      for (const [address, headers] of [['192.0.2.10', {}], ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }]]) {
        const res = await call(appFor(address), path.toUpperCase() + '/', body, headers);
        expect([res.status, res.body.code], path).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      }
    }
    for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
  });

  it('preserves local, operator and delegated-agent execution on every protected action', async () => {
    const operator = await createSession();
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Cookie: `portos_auth=${operator.token}` }],
      [true, '127.0.0.1', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const [path, body, effect] of operations) {
        effects[effect].mockClear();
        const res = await call(appFor(address), path, body, headers);
        expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(200);
        expect(effects[effect]).toHaveBeenCalledOnce();
      }
    }
  });

  it('leaves reads, disconnect and queue cancellation/annotations reachable remotely', async () => {
    const app = appFor();
    for (const path of ['status?accountId=example-account', 'balance?accountId=example-account', 'rate-limits?accountId=example-account', 'queue/example-agent', 'ws/status']) {
      expect((await request(app).get(`${base}/${path}`)).status, path).toBe(200);
    }
    for (const path of ['ws/disconnect', 'queue/example-item/complete', 'queue/example-item/fail']) {
      expect((await call(app, path, {})).status, path).toBe(200);
    }
    expect((await request(app).delete(`${base}/queue/example-item`)).status).toBe(200);
    for (const name of ['joinWorld', 'build', 'think', 'connect', 'sendMove', 'sendThink', 'sendNearby', 'sendInteract', 'addAction']) {
      expect(effects[name]).not.toHaveBeenCalled();
    }
  });
});
