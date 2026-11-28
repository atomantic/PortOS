import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';

// The real authGate + hostControlRouteGate, pinned to a password-free install
// so the developer's own settings cannot change what these cases observe.
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyRequestSession: vi.fn(async ({ headers }) => auth.enabled && headers?.authorization === 'Bearer example-agent-session'),
  verifyRequestSessionIdentity: vi.fn(async ({ headers }) => (auth.enabled && headers?.authorization === 'Bearer example-agent-session'
    ? { kind: 'session', sessionId: 'example-agent-session', label: 'agent' }
    : null)),
}));

const auth = vi.hoisted(() => ({ enabled: false }));

const obsidian = vi.hoisted(() => ({
  addVault: vi.fn(),
  getVaults: vi.fn(),
  detectVaults: vi.fn(),
  scanVault: vi.fn(),
  getNote: vi.fn(),
  searchNotes: vi.fn(),
  getVaultTags: vi.fn(),
  getVaultFolders: vi.fn(),
  getVaultGraph: vi.fn(),
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
  if (method === 'get' || method === 'head') return pending;
  return pending.send(body);
};

const readRoutes = [
  ['get', '/api/notes/detect'],
  ['get', '/api/notes/vaults'],
  ['get', '/api/notes/vaults/example-vault/scan'],
  ['get', '/api/notes/vaults/example-vault/note?path=example.md'],
  ['get', '/api/notes/vaults/example-vault/search?q=example'],
  ['get', '/api/notes/vaults/example-vault/tags'],
  ['get', '/api/notes/vaults/example-vault/folders'],
  ['get', '/api/notes/vaults/example-vault/graph'],
];

const configureNoteReads = () => {
  obsidian.detectVaults.mockResolvedValue([]);
  obsidian.getVaults.mockResolvedValue([]);
  obsidian.scanVault.mockResolvedValue({ notes: [] });
  obsidian.getNote.mockResolvedValue({ content: 'example' });
  obsidian.searchNotes.mockResolvedValue({ results: [] });
  obsidian.getVaultTags.mockResolvedValue([]);
  obsidian.getVaultFolders.mockResolvedValue([]);
  obsidian.getVaultGraph.mockResolvedValue({});
};

const expectRefused = (response) => {
  expect(response.status).toBe(403);
  expect(response.body.code).toBe('HOST_CONTROL_FORBIDDEN');
};

describe('host-control gate on notes vault registration (#9007)', () => {
  beforeEach(() => {
    auth.enabled = false;
    vi.clearAllMocks();
    obsidian.addVault.mockResolvedValue({ id: 'v1', name: 'x', path: '/tmp/example-vault' });
  });

  it('refuses a remote password-free caller registering a vault, direct or proxied, with no vault persisted', async () => {
    const write = ['post', '/api/notes/vaults', { path: '/tmp/example-vault' }];
    expectRefused(await call(remote(), write));
    expectRefused(await call(local(), write, '192.0.2.10'));
    expect(obsidian.addVault).not.toHaveBeenCalled();
  });

  it('keeps a local caller, direct or through the dev proxy, able to add vaults', async () => {
    for (const proxyClient of [undefined, '::ffff:127.0.0.1']) {
      const app = local();
      const add = await call(app, ['post', '/api/notes/vaults', { path: '/tmp/example-vault' }], proxyClient);
      expect(add.status).toBe(201);
    }
    expect(obsidian.addVault).toHaveBeenCalledTimes(2);
  });

  it('refuses every host vault read to a remote password-free caller before scanning', async () => {
    configureNoteReads();
    for (const route of readRoutes) expectRefused(await call(remote(), route));
    expect(obsidian.detectVaults).not.toHaveBeenCalled();
    expect(obsidian.getVaults).not.toHaveBeenCalled();
    expect(obsidian.scanVault).not.toHaveBeenCalled();
    expect(obsidian.getNote).not.toHaveBeenCalled();
    expect(obsidian.searchNotes).not.toHaveBeenCalled();
    expect(obsidian.getVaultTags).not.toHaveBeenCalled();
    expect(obsidian.getVaultFolders).not.toHaveBeenCalled();
    expect(obsidian.getVaultGraph).not.toHaveBeenCalled();
  });

  it('keeps local operators and delegated PORTOS_API_TOKEN sessions able to read vaults', async () => {
    configureNoteReads();
    for (const route of readRoutes) {
      expect((await call(local(), route)).status, route[1]).toBe(200);
    }
    auth.enabled = true;
    for (const route of readRoutes) {
      const pending = request(remote())[route[0]](route[1]).set('Authorization', 'Bearer example-agent-session');
      expect((await pending).status, route[1]).toBe(200);
    }
  });
});
