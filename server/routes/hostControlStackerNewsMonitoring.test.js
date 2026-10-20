import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { EventEmitter } from 'node:events';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (original) => makePathsProxy(await original(), {
  dataRoot: () => lazyTempDataRoot('portos-stacker-monitoring-authority-'),
}));
afterAll(cleanupTempDataRoots);
const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (original) => ({
  ...await original(), isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({ settingsEvents: new EventEmitter(), getSettings: async () => ({}) }));
const state = vi.hoisted(() => ({ account: {}, territory: {} }));
const effects = vi.hoisted(() => ({
  createAccount: vi.fn(async data => ({ ...state.account, ...data })),
  updateAccount: vi.fn(async (_id, data) => ({ ...state.account, ...data })),
  createTerritory: vi.fn(async data => ({ ...state.territory, ...data })),
  updateTerritory: vi.fn(async (_id, data) => ({ ...state.territory, ...data })),
  syncAccount: vi.fn(async () => ({ synced: true })),
  verifyConnection: vi.fn(async () => ({ connected: true })),
  getBrowserIdentity: vi.fn(async () => ({ connected: true })),
  reconcileStackerNewsSchedulers: vi.fn(),
  deleteAccount: vi.fn(async () => true), deleteTerritory: vi.fn(async () => state.account.id),
}));
vi.mock('../services/stackerNews.js', () => ({
  ...effects, getAccount: async () => state.account, getTerritory: async () => state.territory,
  listTerritories: async () => [state.territory],
}));
vi.mock('../services/stackerNewsScheduler.js', () => effects);
import { authGate, hostControlRouteGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import routes from './stackerNews.js';
const accountId = '00000000-0000-4000-8000-000000000001';
const territoryId = '00000000-0000-4000-8000-000000000002';
const base = '/api/stacker-news';
const mutations = [
  ['post', '/accounts', { label: 'Example account', username: 'example_user' }, 'createAccount'],
  ['patch', `/accounts/${accountId}`, {}, 'updateAccount'],
  ['post', '/territories', { accountId, slug: 'example' }, 'createTerritory'],
  ['patch', `/territories/${territoryId}`, {}, 'updateTerritory'],
];
const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => { Object.defineProperty(req.socket, 'remoteAddress', { value: address }); next(); });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use(base, routes); app.use(errorMiddleware);
  return app;
};
const call = (app, [method, path, body], headers = {}) => {
  const pending = request(app)[method](base + path);
  for (const [key, value] of Object.entries(headers)) pending.set(key, value);
  return pending.send(body);
};
beforeEach(() => {
  vi.clearAllMocks(); auth.enabled = false;
  state.account = { id: accountId, enabled: true, monitoringEnabled: false };
  state.territory = { id: territoryId, accountId, monitoringEnabled: false };
});

describe('Stacker News browser and monitoring authority', () => {
  it('refuses remote browser operations and explicit monitoring opt-ins before effects', async () => {
    for (const suffix of ['sync', 'browser-identity', 'verify']) {
      const res = await call(appFor(), ['post', `/accounts/${accountId}/${suffix}`, {}]);
      expect([res.status, res.body.code], suffix).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    for (const [method, path, body] of mutations) {
      const res = await call(appFor(), [method, path, { ...body, monitoringEnabled: true }]);
      expect([res.status, res.body.code], path).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
  });

  it('preserves local, operator-session and delegated-agent browser operations and monitoring opt-ins', async () => {
    const operator = await createSession();
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Cookie: `portos_auth=${operator.token}` }],
      [true, '127.0.0.1', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const suffix of ['sync', 'browser-identity', 'verify']) {
        const res = await call(appFor(address), ['post', `/accounts/${accountId}/${suffix}`, {}], headers);
        expect(res.status, suffix).toBe(200);
      }
      for (const [method, path, body, effect] of mutations) {
        effects[effect].mockClear();
        const res = await call(appFor(address), [method, path, { ...body, monitoringEnabled: true }], headers);
        expect(res.status, path).toBe(method === 'post' ? 201 : 200);
        expect(effects[effect]).toHaveBeenCalledOnce();
      }
    }
    expect(effects.syncAccount).toHaveBeenCalledTimes(3);
    expect(effects.verifyConnection).toHaveBeenCalledTimes(3);
    expect(effects.getBrowserIdentity).toHaveBeenCalledTimes(3);
    expect(effects.reconcileStackerNewsSchedulers).toHaveBeenCalledTimes(12);
  });

  it('keeps unchanged monitoring, labels, disabling and deletes open', async () => {
    state.account.monitoringEnabled = true;
    state.territory.monitoringEnabled = true;
    for (const [method, path, body] of mutations) {
      for (const addition of [{ monitoringEnabled: false }, { label: 'Changed label' }]) {
        // Creating an inherited territory under an enabled account is an opt-in.
        if (path === '/territories' && addition.monitoringEnabled === undefined) continue;
        const res = await call(appFor(), [method, path, { ...body, ...addition }]);
        expect(res.status, path).toBe(method === 'post' ? 201 : 200);
      }
    }
    for (const path of [`/accounts/${accountId}`, `/territories/${territoryId}`]) {
      expect((await call(appFor(), ['delete', path, {}])).status).toBe(204);
    }
  });

  it('refuses inherited monitoring and re-enabling a disabled monitored account', async () => {
    state.account.monitoringEnabled = true;
    for (const data of [{}, { monitoringEnabled: null }]) {
      const res = await call(appFor(), ['post', '/territories', { accountId, slug: 'example', ...data }]);
      expect([res.status, res.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    const inherited = await call(appFor(), ['patch', `/territories/${territoryId}`, { monitoringEnabled: null }]);
    expect([inherited.status, inherited.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    state.account.enabled = false;
    for (const monitoringEnabled of [null, true]) {
      state.territory.monitoringEnabled = monitoringEnabled;
      const res = await call(appFor(), ['patch', `/accounts/${accountId}`, { enabled: true }]);
      expect([res.status, res.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
  });

  it('allows dormant inheritance and re-enabling with all monitoring disabled', async () => {
    for (const operation of [
      ['post', '/territories', { accountId, slug: 'example' }],
      ['patch', `/territories/${territoryId}`, { monitoringEnabled: null }],
    ]) expect((await call(appFor(), operation)).status).toBe(operation[0] === 'post' ? 201 : 200);
    state.account.enabled = false;
    expect((await call(appFor(), ['patch', `/accounts/${accountId}`, { enabled: true, monitoringEnabled: false }])).status).toBe(200);
    // Re-saving an already inherited opt-in does not arm anything new.
    state.account.enabled = true; state.account.monitoringEnabled = true; state.territory.monitoringEnabled = null;
    expect((await call(appFor(), ['patch', `/territories/${territoryId}`, { monitoringEnabled: null }])).status).toBe(200);
  });
});
