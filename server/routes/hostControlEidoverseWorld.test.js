import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-eidoverse-world-authority-') }));
afterAll(cleanupTempDataRoots);

// Eidoverse augment and say act in the private world as the owner-granted CoS
// identity (#13055), the authority a riddle round already requires. Real router
// behind the real gates; the world service is doubled so no connection opens.
const auth = vi.hoisted(() => ({ enabled: false }));
const world = vi.hoisted(() => ({
  augment: vi.fn(async () => ({ success: true, applied: 1 })),
  say: vi.fn(async () => ({ success: true })),
  status: vi.fn(async () => ({ installed: true })),
}));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/instanceIdentity.js', () => ({
  ensureInstanceId: vi.fn(async () => 'example-self'),
  loadData: vi.fn(async () => ({ peers: [{
    id: 'example-peer', instanceId: 'example-instance', enabled: true, syncSecret: 'a'.repeat(32),
  }] })),
}));
vi.mock('../services/eidoverseWorld.js', () => ({
  augmentEidoverseWorld: world.augment,
  sayInEidoverseWorld: world.say,
  getEidoverseWorldStatus: world.status,
}));
vi.mock('../services/eidoverseFoundationLedger.js', () => ({}));
vi.mock('../services/eidoverseControllerRuntime.js', () => ({}));
vi.mock('../services/eidoverseControllerRegistry.js', () => ({}));

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import worldRoutes from './eidoverseWorldRoutes.js';

const operations = [
  ['/api/eidoverse/world/augment', { operations: [{ verb: 'grant', args: { id: 'example-visitor', role: 'owner' } }] }, world.augment],
  ['/api/eidoverse/world/say', { text: 'Example message' }, world.say],
];

const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use('/api/eidoverse/world', worldRoutes);
  app.use(errorMiddleware);
  return app;
};
const post = (app, [path, body], headers = {}) => {
  const pending = request(app).post(path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};
const expectNoEffects = () => {
  expect(world.augment).not.toHaveBeenCalled();
  expect(world.say).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('Eidoverse world augment/say operator authority (#13055)', () => {
  it('refuses remote password-free callers, spoofed-proxy and case variants before the world is touched', async () => {
    for (const [path, body] of operations) {
      for (const [address, headers, target] of [
        ['192.0.2.10', {}, path],
        ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }, path],
        ['192.0.2.10', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '127.0.0.1' }, path],
        ['192.0.2.10', {}, path.toUpperCase() + '/'],
      ]) {
        const response = await post(appFor(address), [target, body], headers);
        expect([response.status, response.body.code], target).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      }
    }
    expectNoEffects();
  });

  it('requires authentication with a password and denies legacy Basic and scoped-peer credentials', async () => {
    auth.enabled = true;
    for (const operation of operations) {
      for (const [headers, status, code] of [
        [{}, 401, 'AUTH_REQUIRED'],
        [{ Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') }, 403, 'HOST_CONTROL_FORBIDDEN'],
        [{
          [PEER_AUTH_HEADER]: derivePeerAuthToken('a'.repeat(32), 'example-instance'),
          [PEER_INSTANCE_HEADER]: 'example-instance',
        }, 403, 'PEER_SCOPE_FORBIDDEN'],
      ]) {
        const response = await post(appFor(), operation, headers);
        expect([response.status, response.body.code], operation[0]).toEqual([status, code]);
      }
    }
    expectNoEffects();
  });

  it('keeps working for local callers, operator sessions and delegated agent sessions', async () => {
    const operator = await createSession();
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Authorization: `Bearer ${operator.token}` }],
      [true, '192.0.2.10', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const operation of operations) {
        const response = await post(appFor(address), operation, headers);
        expect(response.status, `${operation[0]}: ${JSON.stringify(response.body)}`).toBe(200);
      }
    }
    expect(world.augment).toHaveBeenCalledTimes(3);
    expect(world.augment).toHaveBeenLastCalledWith(operations[0][1].operations);
    expect(world.say).toHaveBeenLastCalledWith('Example message');
  });

  it('leaves the world status read open to a remote caller', async () => {
    expect((await request(appFor()).get('/api/eidoverse/world/status')).status).toBe(200);
    expectNoEffects();
  });
});
