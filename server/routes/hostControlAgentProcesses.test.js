import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Real router and auth/host-control gates; only the process service (whose
// killProcess sends SIGKILL to the named host PID) is replaced.
const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => ({
  getRunningAgents: vi.fn(async () => []),
  getProcessInfo: vi.fn(async (pid) => ({ pid })),
  killProcess: vi.fn(async () => true),
}));
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-agent-process-authority-') }));
afterAll(cleanupTempDataRoots);
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(), isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(), getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/instanceIdentity.js', () => ({ loadData: vi.fn(async () => ({ peers: [] })) }));
vi.mock('../services/agents.js', () => effects);

import { authGate, hostControlRouteGate, hostControlBodyGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import agentsRoutes from './agents.js';

const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json(), hostControlBodyGate);
  app.use('/api/agents', agentsRoutes);
  app.use(errorMiddleware);
  return app;
};
const kill = (app, path, headers = {}) => {
  const pending = request(app).delete(path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending;
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('agent process kill authority', () => {
  it('refuses a remote password-free caller before any host process is signalled', async () => {
    for (const path of ['/api/agents/4242', '/API/Agents/4242/']) {
      const response = await kill(appFor(), path);
      expect([response.status, response.body.code], path).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    const proxied = await kill(appFor('127.0.0.1'), '/api/agents/4242', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' });
    expect([proxied.status, proxied.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    expect(effects.killProcess).not.toHaveBeenCalled();
  });

  it('preserves local password-free, operator and delegated-agent kills', async () => {
    const operator = await createSession();
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Cookie: `portos_auth=${operator.token}` }],
      [true, '127.0.0.1', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      const response = await kill(appFor(address), '/api/agents/4242', headers);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    }
    expect(effects.killProcess).toHaveBeenCalledTimes(3);
    expect(effects.killProcess).toHaveBeenCalledWith(4242);
  });

  it('keeps the process list and per-process reads open to remote password-free callers', async () => {
    expect((await request(appFor()).get('/api/agents')).status).toBe(200);
    expect((await request(appFor()).get('/api/agents/4242')).status).toBe(200);
    expect(effects.getProcessInfo).toHaveBeenCalledWith(4242);
  });
});
