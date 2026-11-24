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
  getOpenPages: vi.fn(async () => [{ id: 'p1', title: 'Inbox', url: 'https://example.com/inbox' }]),
  getDownloads: vi.fn(async () => ({ downloadDir: '/d', files: [{ name: 'secret.json' }] })),
  getRecentLogs: vi.fn(async () => ({ stdout: 'browser ok', stderr: '' })),
  resolveDownload: vi.fn(async () => null),
}));
vi.mock('../services/browserService.js', () => ({ browserEvents: new EventEmitter(), ...svc }));
vi.mock('../services/browserStatus.js', () => ({
  getBrowserStatusSnapshot: vi.fn(async () => ({
    connected: true,
    pages: [{ id: 'p1', title: 'Inbox', url: 'https://example.com/inbox' }],
    pageCount: 1,
    downloads: { downloadDir: '/d', files: [{ name: 'secret.json' }] },
  })),
}));
const vaultFill = vi.hoisted(() => vi.fn(async ({ targetId, loginId }) => ({
  ok: true, loginId, targetId, origin: 'https://example.com', filledFields: ['identifier', 'password'],
})));
vi.mock('../services/browserVaultFill.js', () => ({ fillWebsiteLogin: vaultFill }));
vi.mock('../lib/safeUrlFetch.js', async (importOriginal) => ({ ...(await importOriginal()), assertPublicHttpUrl: vi.fn(async () => {}) }));

const mounts = [['/api/browser', (await import('./browser.js')).default]];
// The gated reads: [method, path, body, effect, success status].
const fill = ['post', '/api/browser/vault/fill', { targetId: 'tab-1', loginId: '00000000-0000-4000-8000-0000000000cc' }, vaultFill, 200];
const listings = [
  ['get', '/api/browser/pages', undefined, svc.getOpenPages, 200],
  ['get', '/api/browser/downloads', undefined, svc.getDownloads, 200],
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

  // The model-blind vault fill (#17397) types a stored credential into the
  // signed-in browser: a remote password-free peer must never trigger it.
  it('refuses the vault fill to a remote password-free caller before any login is read', async () => {
    await expectRemoteRefusal(mounts, fill);
  });

  it('still navigates, fills and lists for a local operator and a delegated agent session', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ['post', '/api/browser/navigate', { url: 'https://example.com/' }, svc.navigateToUrlPinned, 200],
      fill,
      ...listings,
    ] });
    expect(svc.navigateToUrlPinned).toHaveBeenLastCalledWith('https://example.com/', expect.anything());
  });

  it('status read stays open but omits page and download listings without host control', async () => {
    const remote = await request(await hostControlApp(REMOTE_ADDRESS, mounts)).get('/api/browser');
    expect(remote.status).toBe(200);
    expect(remote.body).toMatchObject({ pages: [], pageCount: 1, contentRedacted: true, downloads: { files: [] } });

    const local = await request(await hostControlApp('127.0.0.1', mounts)).get('/api/browser');
    expect(local.body.pages).toHaveLength(1);
    expect(local.body.downloads.files).toHaveLength(1);
    expect(local.body.contentRedacted).toBeUndefined();
  });
});
