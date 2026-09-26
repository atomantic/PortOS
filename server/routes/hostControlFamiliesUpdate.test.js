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

const updateChecker = vi.hoisted(() => ({
  getRemoteInfo: vi.fn(),
}));
vi.mock('../services/updateChecker.js', () => updateChecker);

const selfUpdate = vi.hoisted(() => ({
  startPortosSelfUpdate: vi.fn(),
}));
vi.mock('../services/portosSelfUpdate.js', () => selfUpdate);

const brainService = vi.hoisted(() => ({
  getLinkById: vi.fn(),
}));
vi.mock('../services/brain.js', () => brainService);

const repoCloner = vi.hoisted(() => ({
  pullRepo: vi.fn(),
}));
vi.mock('../services/repoCloner.js', () => repoCloner);

const askPromote = vi.hoisted(() => ({
  promoteTurnById: vi.fn(),
}));
vi.mock('../services/askPromote.js', () => askPromote);

const askConversations = vi.hoisted(() => ({
  ID_RE: /^[a-z0-9-]+$/,
  VALID_MODES: ['ask'],
  listConversations: vi.fn().mockResolvedValue([]),
  getConversation: vi.fn(),
  deleteConversation: vi.fn(),
  setPromoted: vi.fn(),
}));
vi.mock('../services/askConversations.js', () => askConversations);
vi.mock('../services/askService.js', () => ({
  runAsk: vi.fn(),
  VALID_MODES: askConversations.VALID_MODES,
}));

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import updateRoutes from './update.js';
import brainLinksRoutes from './brainLinks.js';
import askRoutes from './ask.js';

// Mirrors the mount order server/index.js uses for these families.
const buildGatedApp = (remoteAddress) => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: remoteAddress });
    next();
  });
  app.use(authGate);
  app.use(hostControlRouteGate);
  app.use(express.json());
  app.use('/api/update', updateRoutes);
  app.use('/api/brain', brainLinksRoutes);
  app.use('/api/ask', askRoutes);
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

describe('host-control gate on update, brain-link and ask promote writes (#8742)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    brainService.getLinkById.mockResolvedValue({
      id: 'link-1', isRepo: true, localPath: '/tmp/example-link', cloneStatus: 'idle',
    });
    repoCloner.pullRepo.mockResolvedValue({ updated: true });
    askConversations.getConversation.mockResolvedValue({ id: 'conv-1' });
    askPromote.promoteTurnById.mockResolvedValue({ target: 'task', taskId: 'task-1' });
  });

  it('refuses a remote password-free caller, direct or proxied, with no side effects', async () => {
    const writes = [
      ['post', '/api/update/execute', {}],
      ['post', '/api/update/sync-fork', {}],
      ['post', '/api/brain/links/link-1/pull', {}],
      ['post', '/api/ask/conv-1/turns/turn-1/promote', { target: 'task' }],
    ];
    for (const write of writes) {
      expectRefused(await call(remote(), write));
      expectRefused(await call(local(), write, '192.0.2.10'));
    }
    expect(selfUpdate.startPortosSelfUpdate).not.toHaveBeenCalled();
    expect(updateChecker.getRemoteInfo).not.toHaveBeenCalled();
    expect(repoCloner.pullRepo).not.toHaveBeenCalled();
    expect(askPromote.promoteTurnById).not.toHaveBeenCalled();
  });

  it('keeps a local caller, direct or through the dev proxy, able to run all three', async () => {
    for (const proxyClient of [undefined, '::ffff:127.0.0.1']) {
      const app = local();
      const pull = await call(app, ['post', '/api/brain/links/link-1/pull', {}], proxyClient);
      const promote = await call(app, ['post', '/api/ask/conv-1/turns/turn-1/promote', { target: 'task' }], proxyClient);
      expect(pull.status).toBe(200);
      expect(promote.status).toBe(200);
    }
    expect(repoCloner.pullRepo).toHaveBeenCalledTimes(2);
    expect(askPromote.promoteTurnById).toHaveBeenCalledTimes(2);
  });

  it('leaves the conversation-level promote (no execution) open to a remote caller', async () => {
    askConversations.setPromoted.mockResolvedValue({ id: 'conv-1', promoted: true });
    const res = await call(remote(), ['post', '/api/ask/conv-1/promote', {}]);
    expect(res.status).toBe(200);
    expect(askConversations.setPromoted).toHaveBeenCalledTimes(1);
  });
});
