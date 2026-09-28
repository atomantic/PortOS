import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';

// The real authGate + hostControlRouteGate, pinned to a password-free install
// so the developer's own settings cannot change what these cases observe.
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn().mockResolvedValue(false),
}));

const obsidian = vi.hoisted(() => ({
  addVault: vi.fn(),
  updateVault: vi.fn(),
  getVaults: vi.fn(),
  detectVaults: vi.fn(),
}));
vi.mock('../services/obsidian.js', () => obsidian);

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import notesRoutes from './notes.js';

// Mirrors the mount order server/index.js uses for this family.
const buildGatedApp = (remoteAddress) => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: remoteAddress });
    next();
  });
  app.use(authGate);
  app.use(hostControlRouteGate);
  app.use(express.json());
  app.use('/api/notes', notesRoutes);
  app.use(errorMiddleware);
  return app;
};

const remote = () => buildGatedApp('192.0.2.10');
const local = () => buildGatedApp('127.0.0.1');

const call = (app, [method, path, body = {}], proxyClient) => {
  const pending = request(app)[method](path);
  if (proxyClient) pending.set(DEV_PROXY_CLIENT_ADDRESS_HEADER, proxyClient);
  return pending.send(body);
};

const expectRefused = (response) => {
  expect(response.status).toBe(403);
  expect(response.body.code).toBe('HOST_CONTROL_FORBIDDEN');
};

describe('host-control gate on notes vault add/repoint (#9007)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    obsidian.addVault.mockResolvedValue({ id: 'v1', name: 'x', path: '/tmp/example-vault' });
    obsidian.updateVault.mockResolvedValue({ id: 'v1', name: 'x', path: '/tmp/example-vault' });
  });

  it('refuses a remote password-free caller registering or repointing a vault, direct or proxied, with no vault persisted', async () => {
    const writes = [
      ['post', '/api/notes/vaults', { path: '/tmp/example-vault' }],
      ['put', '/api/notes/vaults/v1', { path: '/tmp/other-vault' }],
    ];
    for (const write of writes) {
      expectRefused(await call(remote(), write));
      expectRefused(await call(local(), write, '192.0.2.10'));
    }
    expect(obsidian.addVault).not.toHaveBeenCalled();
    expect(obsidian.updateVault).not.toHaveBeenCalled();
  });

  it('keeps a local caller, direct or through the dev proxy, able to add and repoint vaults', async () => {
    for (const proxyClient of [undefined, '::ffff:127.0.0.1']) {
      const app = local();
      const add = await call(app, ['post', '/api/notes/vaults', { path: '/tmp/example-vault' }], proxyClient);
      const update = await call(app, ['put', '/api/notes/vaults/v1', { path: '/tmp/other-vault' }], proxyClient);
      expect(add.status).toBe(201);
      expect(update.status).toBe(200);
    }
    expect(obsidian.addVault).toHaveBeenCalledTimes(2);
    expect(obsidian.updateVault).toHaveBeenCalledTimes(2);
  });

  it('leaves read-only vault listing and detection open to a remote caller', async () => {
    obsidian.getVaults.mockResolvedValue([]);
    obsidian.detectVaults.mockResolvedValue([]);
    const list = await request(remote()).get('/api/notes/vaults');
    const detect = await request(remote()).get('/api/notes/detect');
    expect(list.status).toBe(200);
    expect(detect.status).toBe(200);
  });
});
