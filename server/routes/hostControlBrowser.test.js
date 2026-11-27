import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { request } from '../lib/testHelper.js';
import { expectAuthorizedWorkflows, expectRemoteRefusal, hostControlApp, REMOTE_ADDRESS } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-browser-authority-') }));
afterAll(cleanupTempDataRoots);

// Managed browser profile authority (#12488). Navigate is gated by the default-deny
// write policy (#16018), whose principal matrix lives in services/authGate.test.js.
// This suite keeps what the gate contract cannot see: the HOST_CONTROL_GET_ROUTES
// page and download listings, and the per-request split on GET /api/browser.
const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({})),
}));

const svc = vi.hoisted(() => ({
  navigateToUrlPinned: vi.fn(async (url) => ({ id: 'tab-1', url })),
  getRecentLogs: vi.fn(async () => ({ stdout: 'browser ok', stderr: '' })),
  resolveDownload: vi.fn(async () => null),
}));
vi.mock('../services/browserService.js', () => ({ browserEvents: new EventEmitter(), ...svc }));
const browserSnapshot = {
  connected: true,
  processRunning: true,
  status: 'healthy',
  headless: false,
  process: { status: 'online', pid: 1234, memory: 2048, uptime: 1000 },
  version: { Browser: 'Chrome/example', webSocketDebuggerUrl: 'ws://example.test/devtools/browser/example' },
  config: { userDataDir: '/example/browser-profile' },
  pages: [{ id: 'p1', title: 'Inbox', url: 'https://example.com/inbox' }],
  pageCount: 1,
  downloads: { downloadDir: '/example/downloads', files: [{ name: 'secret.json' }] },
};
vi.mock('../services/browserStatus.js', () => ({
  getBrowserStatusSnapshot: vi.fn(async () => browserSnapshot),
}));
vi.mock('../lib/safeUrlFetch.js', async (importOriginal) => ({ ...(await importOriginal()), assertPublicHttpUrl: vi.fn(async () => {}) }));

const mounts = [['/api/browser', (await import('./browser.js')).default]];
// The gated reads: [method, path, body, effect, success status].
const listings = [
  ['get', '/api/browser/downloads/secret.json', undefined, svc.resolveDownload, 404],
  ['get', '/api/browser/logs', undefined, svc.getRecentLogs, 200],
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('managed browser profile authority (#12488)', () => {
  it.each(listings)('refuses %s %s to a remote password-free caller before the browser is read', async (...listing) => {
    await expectRemoteRefusal(mounts, listing);
  });

  it('still navigates and lists for a local operator and a delegated agent session', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ['post', '/api/browser/navigate', { url: 'https://example.com/' }, svc.navigateToUrlPinned, 200],
      ...listings,
    ] });
    expect(svc.navigateToUrlPinned).toHaveBeenLastCalledWith('https://example.com/', expect.anything());
  });

  it('keeps basic status open and returns the full snapshot only with host control', async () => {
    const remote = await request(await hostControlApp(REMOTE_ADDRESS, mounts)).get('/api/browser');
    expect(remote.status).toBe(200);
    expect(remote.body).toEqual({
      connected: true,
      processRunning: true,
      status: 'healthy',
      headless: false,
      process: { status: 'online' },
      pages: [],
      pageCount: 1,
      downloads: { files: [] },
      contentRedacted: true,
    });

    const local = await request(await hostControlApp('127.0.0.1', mounts)).get('/api/browser');
    expect(local.status).toBe(200);
    expect(local.body).toEqual(browserSnapshot);
  });
});
