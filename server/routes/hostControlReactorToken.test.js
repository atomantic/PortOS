import { EventEmitter } from 'node:events';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { callRoute, hostControlApp, REMOTE_ADDRESS } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-reactor-token-authority-') }));
afterAll(cleanupTempDataRoots);

const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => ({
  mintReactorToken: vi.fn(async () => ({ jwt: 'example-reactor-jwt', expiresAt: '2026-12-01T00:00:00Z' })),
}));

vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async (password) => password === 'example-password'),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({ videoGen: { reactor: { apiKey: 'example-reactor-key' } } })),
  updateSettingsWith: vi.fn(async (mutate) => mutate({})),
}));
vi.mock('../services/instanceIdentity.js', () => ({
  loadData: vi.fn(async () => ({ peers: [] })),
}));
vi.mock('../services/videoGen/reactor.js', () => ({
  resolveReactorApiKey: vi.fn(() => 'example-reactor-key'),
  mintReactorToken: effects.mintReactorToken,
}));

const mounts = [['/api/video-gen', (await import('./videoGen.js')).default]];
const PATH = '/api/video-gen/reactor/token';

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('GET /api/video-gen/reactor/token host control (#18240)', () => {
  it('refuses remote password-free callers with 403 HOST_CONTROL_FORBIDDEN before minting', async () => {
    const app = await hostControlApp(REMOTE_ADDRESS, mounts);
    const response = await callRoute(app, ['get', PATH, undefined]);
    expect([response.status, response.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    expect(effects.mintReactorToken).not.toHaveBeenCalled();
  });

  it('refuses legacy Basic-auth peers with 403 HOST_CONTROL_FORBIDDEN when auth is enabled', async () => {
    auth.enabled = true;
    const basic = `Basic ${Buffer.from(':example-password').toString('base64')}`;
    const app = await hostControlApp(REMOTE_ADDRESS, mounts);
    const response = await callRoute(app, ['get', PATH, undefined], { Authorization: basic });
    expect([response.status, response.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    expect(effects.mintReactorToken).not.toHaveBeenCalled();
  });

  it.each([false, true])('refuses originless cross-site browser requests (auth enabled: %s)', async (enabled) => {
    auth.enabled = enabled;
    const { createSession } = await import('../services/auth.js');
    const human = enabled ? await createSession({ label: null }) : null;
    const headers = {
      'Sec-Fetch-Site': 'cross-site',
      ...(human ? { Cookie: `portos_auth=${human.token}` } : {}),
    };
    const app = await hostControlApp('127.0.0.1', mounts);
    const response = await callRoute(app, ['get', PATH, undefined], headers);
    expect([response.status, response.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    expect(effects.mintReactorToken).not.toHaveBeenCalled();
  });

  it('allows loopback password-free, human cookie, and PORTOS_API_TOKEN Bearer sessions', async () => {
    const { createSession } = await import('../services/auth.js');
    const human = await createSession({ label: null });
    const agent = await createSession({ label: 'agent' });

    const callers = [
      { label: 'loopback password-free', enabled: false, address: '127.0.0.1', headers: {} },
      { label: 'human cookie session', enabled: true, address: REMOTE_ADDRESS, headers: { Cookie: `portos_auth=${human.token}` } },
      { label: 'PORTOS_API_TOKEN Bearer', enabled: true, address: REMOTE_ADDRESS, headers: { Authorization: `Bearer ${agent.token}` } },
    ];

    for (const caller of callers) {
      auth.enabled = caller.enabled;
      const before = effects.mintReactorToken.mock.calls.length;
      const app = await hostControlApp(caller.address, mounts);
      const response = await callRoute(app, ['get', PATH, undefined], caller.headers);
      expect(response.status, caller.label).toBe(200);
      expect(response.body, caller.label).toEqual({ jwt: 'example-reactor-jwt', expires_at: '2026-12-01T00:00:00Z' });
      expect(effects.mintReactorToken.mock.calls.length, caller.label).toBe(before + 1);
    }
  });
});
