import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { Router } from 'express';
import { errorMiddleware } from '../lib/errorHandler.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';
import { request } from '../lib/testHelper.js';
import { isAuthEnabled } from '../services/auth.js';
import { authGate, hostControlRouteGate } from '../services/authGate.js';
import { revealFleetLlmKey } from '../services/fleetLlmHost.js';
import { createPortOSProviderRoutes } from './providers.js';

const FIXTURE_KEY = 'synthetic-fleet-host-key-for-tests';
const PEER = { id: 'peer-fixture', instanceId: 'instance-fixture', enabled: true, syncSecret: 'synthetic-peer-secret-for-tests-only' };
const OPERATOR = 'Bearer synthetic-operator-session';
const PASSWORD = 'synthetic-instance-password';
const BASIC = `Basic ${Buffer.from(`:${PASSWORD}`).toString('base64')}`;
const PAIRED_PEER = {
  [PEER_INSTANCE_HEADER]: PEER.instanceId,
  [PEER_AUTH_HEADER]: derivePeerAuthToken(PEER.syncSecret, PEER.instanceId),
};

vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(),
  verifyRequestSession: async (req) => req.headers.authorization === OPERATOR,
  verifyRequestSessionIdentity: async (req) => (req.headers.authorization === OPERATOR
    ? { kind: 'session', sessionId: 'example-operator-session', label: null }
    : null),
  verifyPassword: async (password) => password === PASSWORD,
}));
vi.mock('../services/settings.js', async (importOriginal) => ({
  ...await importOriginal(),
  getSettings: async () => ({}),
}));
vi.mock('../services/instanceIdentity.js', async (importOriginal) => ({
  ...await importOriginal(),
  loadData: async () => ({ peers: [PEER] }),
}));
vi.mock('../services/instances.js', async (importOriginal) => ({
  ...await importOriginal(),
  wakePeerProbe: vi.fn(),
}));
vi.mock('../services/fleetLlmHost.js', () => ({
  revealFleetLlmKey: vi.fn(async () => FIXTURE_KEY),
}));

const reveal = (remoteAddress, headers = {}) => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: remoteAddress });
    next();
  });
  app.use(authGate, hostControlRouteGate);
  app.use('/api/providers', createPortOSProviderRoutes({
    services: { providers: {} }, routes: { providers: Router() },
  }));
  app.use(errorMiddleware);
  const pending = request(app).post('/api/providers/fleet-host/key');
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending;
};

const remote = '192.0.2.10';
const local = '127.0.0.1';

describe('fleet host key authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAuthEnabled.mockResolvedValue(false);
  });

  it.each([
    ['anonymous', {}],
    ['asserted peer identity', { [PEER_INSTANCE_HEADER]: PEER.instanceId }],
  ])('refuses a remote password-free caller with %s authorization before reading the key', async (_name, headers) => {
    const res = await reveal(remote, headers);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FLEET_HOST_KEY_FORBIDDEN');
    expect(res.body).not.toHaveProperty('apiKey');
    expect(revealFleetLlmKey).not.toHaveBeenCalled();
  });

  it('requires a credential when the instance password is set', async () => {
    isAuthEnabled.mockResolvedValue(true);
    const res = await reveal(remote);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
    expect(res.body).not.toHaveProperty('apiKey');
    expect(revealFleetLlmKey).not.toHaveBeenCalled();
  });

  it.each([
    ['a password-free local connection', false, local, {}],
    ['a paired peer on a password-free instance', false, remote, PAIRED_PEER],
    ['a paired peer on a password-protected instance', true, remote, PAIRED_PEER],
    ['an operator session', true, remote, { Authorization: OPERATOR }],
    ['a legacy Basic credential', true, remote, { Authorization: BASIC }],
  ])('returns the uncached key for %s', async (_name, enabled, address, headers) => {
    isAuthEnabled.mockResolvedValue(enabled);
    const res = await reveal(address, headers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ apiKey: FIXTURE_KEY });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(revealFleetLlmKey).toHaveBeenCalledOnce();
  });
});
