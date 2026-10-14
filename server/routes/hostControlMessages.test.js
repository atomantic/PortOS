import { EventEmitter } from 'node:events';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-messages-authority-') }));
afterAll(cleanupTempDataRoots);

const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));

vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({})),
}));

vi.mock('../services/instanceIdentity.js', () => ({
  loadData: vi.fn(async () => ({ peers: [{
    id: 'example-peer', instanceId: 'example-instance', enabled: true, syncSecret: 'a'.repeat(32),
  }] })),
}));

const account = { id: '00000000-0000-4000-8000-000000000001', type: 'outlook', name: 'Example Mail' };
const messageAccountEffects = vi.hoisted(() => ({ getAccount: vi.fn(async () => null) }));
vi.mock('../services/messageAccounts.js', async (importOriginal) => ({
  ...await importOriginal(),
  getAccount: messageAccountEffects.getAccount,
}));

const playwrightEffects = vi.hoisted(() => ({ launchProvider: vi.fn(async () => ({ success: true })) }));
vi.mock('../services/messagePlaywrightSync.js', async (importOriginal) => ({
  ...await importOriginal(),
  launchProvider: playwrightEffects.launchProvider,
}));

const browserEffects = vi.hoisted(() => ({ navigateToUrl: vi.fn(async () => true) }));
vi.mock('../services/browserService.js', async (importOriginal) => ({
  ...await importOriginal(),
  navigateToUrl: browserEffects.navigateToUrl,
}));

const googleEffects = vi.hoisted(() => ({
  getCredentials: vi.fn(async () => ({ clientId: '123456-example.apps.googleusercontent.com' })),
}));
vi.mock('../services/googleAuth.js', async (importOriginal) => ({
  ...await importOriginal(),
  getCredentials: googleEffects.getCredentials,
}));

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import messagesRoutes from './messages.js';

const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use('/api/messages', messagesRoutes);
  app.use(errorMiddleware);
  return app;
};

const mutatingOperations = [
  ['POST', `/launch/${account.id}`],
  ['POST', '/gmail/enable-api'],
];

const send = (app, method, path, headers = {}) => {
  const pending = request(app)[method.toLowerCase()](`/api/messages${path}`);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send({});
};

const expectNoBrowserEffects = () => {
  expect(playwrightEffects.launchProvider).not.toHaveBeenCalled();
  expect(browserEffects.navigateToUrl).not.toHaveBeenCalled();
};

describe('Messages browser launch host-control authority (#11433)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.enabled = false;
    messageAccountEffects.getAccount.mockImplementation(async () => account);
  });

  it.each([
    ['remote without auth', false, '192.0.2.10', {}, 403, 'HOST_CONTROL_FORBIDDEN'],
    ['forwarded remote without auth', false, '127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }, 403, 'HOST_CONTROL_FORBIDDEN'],
    ['anonymous with auth', true, '192.0.2.10', {}, 401, 'AUTH_REQUIRED'],
    ['Basic password', true, '192.0.2.10', { Authorization: `Basic ${Buffer.from(':example-password').toString('base64')}` }, 403, 'HOST_CONTROL_FORBIDDEN'],
    ['scoped peer', true, '192.0.2.10', {
      [PEER_AUTH_HEADER]: derivePeerAuthToken('a'.repeat(32), 'example-instance'),
      [PEER_INSTANCE_HEADER]: 'example-instance',
    }, 403, 'PEER_SCOPE_FORBIDDEN'],
  ])('refuses %s before launching any browser tab', async (_name, enabled, address, headers, status, code) => {
    auth.enabled = enabled;
    const app = appFor(address);

    for (const [method, path] of mutatingOperations) {
      const response = await send(app, method, path, headers);
      expect(response.status, `${method} ${path}: ${JSON.stringify(response.body)}`).toBe(status);
      expect(response.body.code).toBe(code);
    }

    expectNoBrowserEffects();
  });

  it.each([
    ['local', '127.0.0.1'],
    ['operator session', '192.0.2.10'],
    ['delegated agent', '127.0.0.1'],
  ])('preserves %s browser launch and Gmail API enable', async (principal, address) => {
    const headers = {};
    if (principal !== 'local') {
      const session = await createSession({ label: principal === 'delegated agent' ? 'agent' : 'operator' });
      auth.enabled = true;
      if (principal === 'delegated agent') headers.Authorization = `Bearer ${session.token}`;
      else headers.Cookie = `portos_auth=${session.token}`;
    }
    const app = appFor(address);

    const launch = await send(app, 'POST', `/launch/${account.id}`, headers);
    expect(launch.status).toBe(200);
    expect(playwrightEffects.launchProvider).toHaveBeenCalledWith('outlook');

    const enable = await send(app, 'POST', '/gmail/enable-api', headers);
    expect(enable.status).toBe(200);
    expect(browserEffects.navigateToUrl).toHaveBeenCalledWith(expect.stringContaining('gmail.googleapis.com'));
  });
});
