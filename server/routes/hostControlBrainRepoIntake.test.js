import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Session minting writes auth-sessions.json; keep it out of the real data/ tree.
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-brain-repo-intake-') }));
afterAll(cleanupTempDataRoots);

// Automatic repository intake (#11037). Real Brain links + capture routers and
// the real Brain service sit behind the real auth + host-control gates; only
// storage (in memory), the git clone (a deferred promise) and the post-clone
// intake queue are doubled, so the assertions watch the three effects that
// must not happen for an unauthorized caller: a record, a clone, an agent.
const auth = vi.hoisted(() => ({ enabled: false }));
const store = vi.hoisted(() => ({ links: new Map(), inbox: [] }));
const clone = vi.hoisted(() => ({ cloneRepo: vi.fn(), runRepoIntake: vi.fn(async () => ({})) }));

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
  loadData: vi.fn(async () => ({ peers: [] })),
  getInstanceId: vi.fn(async () => 'example-instance'),
  ensureInstanceId: vi.fn(async () => 'example-instance'),
  UNKNOWN_INSTANCE_ID: 'unknown',
}));
vi.mock('../services/userActions.js', () => ({ recordUserAction: vi.fn(async () => {}) }));
vi.mock('../services/repoCloner.js', async () => ({
  isDerivedClonePath: (await vi.importActual('../services/repoCloner.js')).isDerivedClonePath,
  cloneRepo: clone.cloneRepo,
  pullRepo: vi.fn(),
  reapStaleCloneStaging: vi.fn(async () => 0),
}));
vi.mock('../services/repoIntake.js', () => ({
  runRepoIntake: clone.runRepoIntake,
  queueMalwareScan: vi.fn(),
  restudyRepoLink: vi.fn(),
}));
vi.mock('../services/malwareScanReports.js', () => ({ getScanReport: vi.fn() }));
vi.mock('../lib/openFolder.js', () => ({ openFolderInSystemExplorer: vi.fn() }));
vi.mock('../services/brainStorage.js', async (importOriginal) => ({
  ...await importOriginal(),
  getLinkByUrl: vi.fn(async (url) => [...store.links.values()].find((link) => link.url === url) ?? null),
  getLinkById: vi.fn(async (id) => store.links.get(id) ?? null),
  createLink: vi.fn(async (data) => {
    const link = { id: `link-${store.links.size + 1}`, ...data };
    store.links.set(link.id, link);
    return link;
  }),
  updateLink: vi.fn(async (id, patch) => {
    if (!store.links.has(id)) return null;
    const link = { ...store.links.get(id), ...patch };
    store.links.set(id, link);
    return link;
  }),
  createInboxLog: vi.fn(async (entry) => {
    const log = { id: `inbox-${store.inbox.length + 1}`, ...entry };
    store.inbox.push(log);
    return log;
  }),
}));

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import brainRoutes from './brain.js';

const REPO_URL = 'https://github.com/example-org/example-repo';
const intake = { malwareScan: true, learn: true, providerId: 'example-cli', model: 'example-model', effort: 'high' };
const operations = {
  'link create': ['/api/brain/links', { url: REPO_URL, repoIntake: intake }],
  'bare-URL capture': ['/api/brain/capture', { text: REPO_URL, repoIntake: intake }],
};

const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use('/api/brain', brainRoutes);
  app.use(errorMiddleware);
  return app;
};
const post = (app, [path, body], headers = {}) => {
  const pending = request(app).post(path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};
// Let the un-awaited clone chain settle, so a deferred side effect would show.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
  store.links.clear();
  store.inbox.length = 0;
  clone.cloneRepo.mockResolvedValue({ localPath: '/repos/example-org/example-repo' });
});

describe('automatic repository intake operator authority (#11037)', () => {
  it.each(Object.entries(operations))('refuses a remote password-free %s before any record, clone or agent', async (_name, operation) => {
    for (const [address, headers] of [
      ['192.0.2.10', {}],
      ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }],
      ['192.0.2.10', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '127.0.0.1' }],
    ]) {
      const response = await post(appFor(address), operation, headers);
      expect([response.status, response.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    await settle();
    expect(store.links.size).toBe(0);
    expect(store.inbox).toHaveLength(0);
    expect(clone.cloneRepo).not.toHaveBeenCalled();
    expect(clone.runRepoIntake).not.toHaveBeenCalled();
  });

  it('never lets a refused request leave a record that queues an agent when a clone later completes', async () => {
    let finishClone;
    clone.cloneRepo.mockReturnValue(new Promise((resolve) => { finishClone = resolve; }));

    // An authorized request is in flight; the refused one beside it must add nothing.
    expect((await post(appFor('127.0.0.1'), operations['link create'])).status).toBe(201);
    expect((await post(appFor('192.0.2.10'), ['/api/brain/links', { url: `${REPO_URL}-two`, repoIntake: intake }])).status).toBe(403);
    finishClone({ localPath: '/repos/example-org/example-repo' });
    await settle();

    expect(store.links.size).toBe(1);
    expect(clone.cloneRepo).toHaveBeenCalledTimes(1);
    expect(clone.runRepoIntake).toHaveBeenCalledTimes(1);
  });

  it('requires an operator session with a password and denies legacy Basic', async () => {
    auth.enabled = true;
    for (const operation of Object.values(operations)) {
      expect((await post(appFor(), operation)).status).toBe(401);
      const basic = { Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') };
      const response = await post(appFor(), operation, basic);
      expect([response.status, response.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    await settle();
    expect(store.links.size).toBe(0);
    expect(clone.cloneRepo).not.toHaveBeenCalled();
    expect(clone.runRepoIntake).not.toHaveBeenCalled();
  });

  it('keeps clone and post-clone intake working for local callers, operator sessions and delegated agent sessions', async () => {
    const operator = await createSession();
    const agent = await createSession({ label: 'agent' });
    let n = 0;
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Authorization: `Bearer ${operator.token}` }],
      [true, '192.0.2.10', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const [path, body] of Object.values(operations)) {
        n += 1;
        const unique = { ...body, ...(body.url ? { url: `${REPO_URL}-${n}` } : { text: `${REPO_URL}-${n}` }) };
        const response = await post(appFor(address), [path, unique], headers);
        expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBeLessThan(300);
      }
    }
    await settle();
    expect(clone.cloneRepo).toHaveBeenCalledTimes(n);
    expect(clone.runRepoIntake).toHaveBeenCalledTimes(n);
    // The provider/model/effort pins ride along on the persisted record.
    expect(clone.runRepoIntake.mock.calls[0][1]).toEqual(expect.objectContaining(intake));
  });

  it('keeps plain bookmarks and autoClone:false repository records open to a remote caller, data-only', async () => {
    for (const body of [
      { url: 'https://example.com/article' },
      { url: REPO_URL, autoClone: false, repoIntake: intake },
    ]) {
      const response = await post(appFor(), ['/api/brain/links', body]);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.cloneStatus).toBe('none');
      expect(response.body.repoIntake).toBeUndefined();
    }
    await settle();
    expect(store.links.size).toBe(2);
    expect(clone.cloneRepo).not.toHaveBeenCalled();
    expect(clone.runRepoIntake).not.toHaveBeenCalled();
  });

  // Capture is gated whole (#11036): even a plain note can dispatch the
  // classifier, so a remote password-free caller is refused before any record.
  it('refuses a plain capture from a remote password-free caller before any record or clone', async () => {
    const capture = await post(appFor(), ['/api/brain/capture', { text: 'https://example.com/article-two' }]);
    expect([capture.status, capture.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    await settle();
    expect(store.links.size).toBe(0);
    expect(clone.cloneRepo).not.toHaveBeenCalled();
  });
});
