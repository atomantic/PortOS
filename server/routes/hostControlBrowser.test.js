import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-browser-authority-') }));
afterAll(cleanupTempDataRoots);

const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
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

const svc = vi.hoisted(() => ({
  navigateToUrlPinned: vi.fn(async (url) => ({ id: 'tab-1', url })),
  getOpenPages: vi.fn(async () => [{ id: 'p1', title: 'Inbox', url: 'https://example.com/inbox' }]),
  getDownloads: vi.fn(async () => ({ downloadDir: '/d', files: [{ name: 'secret.json' }] })),
  resolveDownload: vi.fn(async () => null),
}));
vi.mock('../services/browserService.js', () => ({ browserEvents: new EventEmitter(), ...svc }));

const snapshot = {
  connected: true,
  pages: [{ id: 'p1', title: 'Inbox', url: 'https://example.com/inbox' }],
  pageCount: 1,
  downloads: { downloadDir: '/d', files: [{ name: 'secret.json' }] },
};
vi.mock('../services/browserStatus.js', () => ({ getBrowserStatusSnapshot: vi.fn(async () => snapshot) }));

vi.mock('../lib/safeUrlFetch.js', () => ({ assertPublicHttpUrl: vi.fn(async () => {}) }));

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import browserRoutes from './browser.js';

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

const appFor = (address) => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use('/api/browser', browserRoutes);
  app.use(errorMiddleware);
  return app;
};

const withHeaders = (pending, headers) => {
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending;
};

const calls = (app, headers) => [
  ['navigate', () => withHeaders(request(app).post('/api/browser/navigate'), headers).send({ url: 'https://example.com/' })],
  ['pages', () => withHeaders(request(app).get('/api/browser/pages'), headers)],
  ['downloads list', () => withHeaders(request(app).get('/api/browser/downloads'), headers)],
  ['download file', () => withHeaders(request(app).get('/api/browser/downloads/secret.json'), headers)],
];

describe('managed browser profile authority (#12488)', () => {
  it.each([
    ['remote without auth', false, {}, 403, 'HOST_CONTROL_FORBIDDEN'],
    ['scoped peer', true, {
      [PEER_AUTH_HEADER]: derivePeerAuthToken('a'.repeat(32), 'example-instance'), [PEER_INSTANCE_HEADER]: 'example-instance',
    }, 403, 'PEER_SCOPE_FORBIDDEN'],
  ])('refuses %s and never touches the browser', async (_name, enabled, headers, status, code) => {
    auth.enabled = enabled;
    const app = appFor('192.0.2.10');
    for (const [label, send] of calls(app, headers)) {
      const res = await send();
      expect(res.status, label).toBe(status);
      expect(res.body.code, label).toBe(code);
    }
    expect(svc.navigateToUrlPinned).not.toHaveBeenCalled();
    expect(svc.getOpenPages).not.toHaveBeenCalled();
    expect(svc.getDownloads).not.toHaveBeenCalled();
    expect(svc.resolveDownload).not.toHaveBeenCalled();
  });

  it('keeps the routes for a local caller and an operator session', async () => {
    const local = appFor('127.0.0.1');
    expect((await request(local).post('/api/browser/navigate').send({ url: 'https://example.com/' })).status).toBe(200);
    expect((await request(local).get('/api/browser/pages')).status).toBe(200);

    const session = await createSession({ label: 'operator' });
    auth.enabled = true;
    const remote = appFor('192.0.2.10');
    const headers = { Cookie: `portos_auth=${session.token}` };
    expect((await withHeaders(request(remote).get('/api/browser/downloads'), headers)).status).toBe(200);
    expect((await withHeaders(request(remote).get('/api/browser/downloads/secret.json'), headers)).status).toBe(404);
  });

  it('status read stays open but omits page and download listings without host control', async () => {
    const remote = await request(appFor('192.0.2.10')).get('/api/browser');
    expect(remote.status).toBe(200);
    expect(remote.body).toMatchObject({ pages: [], pageCount: 1, contentRedacted: true, downloads: { files: [] } });

    const local = await request(appFor('127.0.0.1')).get('/api/browser');
    expect(local.body.pages).toHaveLength(1);
    expect(local.body.downloads.files).toHaveLength(1);
    expect(local.body.contentRedacted).toBeUndefined();
  });
});
