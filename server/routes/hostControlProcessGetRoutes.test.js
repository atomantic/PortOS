import { EventEmitter } from 'node:events';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { callRoute, hostControlApp, REMOTE_ADDRESS } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-process-get-authority-') }));
afterAll(cleanupTempDataRoots);

const makeLogProcess = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  queueMicrotask(() => child.emit('close', 0));
  return child;
};

const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => ({
  getLogs: vi.fn(async (name, lines) => `${name}:${lines}`),
  spawnPm2: vi.fn(),
  getBrowserLogs: vi.fn(async (lines) => ({ stdout: `browser:${lines}`, stderr: '' })),
  getHomebrewStatus: vi.fn(async ({ fresh }) => ({ available: true, fresh, packages: [] })),
}));

vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async (password) => password === 'example-password'),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/instanceIdentity.js', () => ({
  loadData: vi.fn(async () => ({ peers: [] })),
}));
vi.mock('../services/apps.js', () => ({
  getAllApps: vi.fn(async () => [{ id: 'app-001', pm2ProcessNames: ['example-api'] }]),
  getAppById: vi.fn(async (id) => (id === 'app-001' ? { id: 'app-001', pm2ProcessNames: ['example-api'] } : null)),
  notifyAppsChanged: vi.fn(),
  PORTOS_APP_ID: 'portos-default',
}));
vi.mock('../services/pm2.js', () => ({
  buildEnv: vi.fn(() => ({})),
  getLogs: effects.getLogs,
  spawnPm2: effects.spawnPm2,
  listProcesses: vi.fn(async () => []),
  getAppStatus: vi.fn(),
  getAppStatusStrict: vi.fn(),
  startFromEcosystem: vi.fn(),
  startWithCommand: vi.fn(),
  deleteApp: vi.fn(),
  stopApp: vi.fn(),
  restartApp: vi.fn(),
}));
vi.mock('../services/browserService.js', () => ({
  browserEvents: new EventEmitter(),
  getRecentLogs: effects.getBrowserLogs,
  navigateToUrlPinned: vi.fn(),
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  launchBrowser: vi.fn(),
  stopBrowser: vi.fn(),
  restartBrowser: vi.fn(),
  getHealthStatus: vi.fn(),
  getProcessStatus: vi.fn(),
  getOpenPages: vi.fn(),
  getCdpVersion: vi.fn(),
  getDownloads: vi.fn(),
  resolveDownload: vi.fn(),
  deleteDownload: vi.fn(),
}));
vi.mock('../services/browserStatus.js', () => ({ getBrowserStatusSnapshot: vi.fn(async () => ({})) }));
vi.mock('../services/browserVaultFill.js', () => ({}));
vi.mock('../services/homebrewUpgrades.js', () => ({ getHomebrewStatus: effects.getHomebrewStatus }));
vi.mock('../services/appBuilder.js', () => ({}));
vi.mock('../services/history.js', () => ({ logAction: vi.fn() }));
vi.mock('../services/streamingDetect.js', () => ({ parseEcosystemFromPath: vi.fn() }));
vi.mock('../services/appProcessTypes.js', () => ({
  usesPm2: vi.fn(() => true),
  isDesktopType: vi.fn(() => false),
}));
vi.mock('../services/appIconDetect.js', () => ({
  detectAppIcon: vi.fn(),
  isUsableSvg: vi.fn(),
  resolveContainedIcon: vi.fn(),
}));
vi.mock('../services/eidoverseLaunch.js', () => ({
  launchEidoverseProcess: vi.fn(),
  restartEidoverseProcess: vi.fn(),
}));
vi.mock('../services/appListEnrichment.js', () => ({
  deriveUiPort: vi.fn(),
  deriveAppPorts: vi.fn(),
  computeOverallStatus: vi.fn(),
}));
vi.mock('../services/updateChecker.js', () => ({}));
vi.mock('../services/nodeRuntime.js', () => ({
  getNodeRuntimeStatus: vi.fn(),
  repairStartup: vi.fn(),
  startNodeUpdate: vi.fn(),
  startPm2Update: vi.fn(),
}));
vi.mock('../services/runtimeUpdateEvents.js', () => ({ runtimeUpdateEvents: new EventEmitter() }));
vi.mock('../services/portosSelfUpdate.js', () => ({ startPortosSelfUpdate: vi.fn() }));
vi.mock('../services/updatePreflight.js', () => ({
  countActiveCosAgents: vi.fn(),
  getPersistentMindImageWorkGuard: vi.fn(),
}));

const mounts = [
  ['/api/logs', (await import('./logs.js')).default],
  ['/api/browser', (await import('./browser.js')).default],
  ['/api/apps', (await import('./apps/lifecycle.js')).default],
  ['/api/update', (await import('./update.js')).default],
];

const routes = [
  ['/api/logs/portos-server', effects.getLogs],
  ['/api/logs/portos-server?follow=true', effects.spawnPm2],
  ['/api/browser/logs', effects.getBrowserLogs],
  ['/api/apps/app-001/logs', effects.getLogs],
  ['/api/update/software/homebrew?fresh=1', effects.getHomebrewStatus],
];

const expectNoSideEffects = () => {
  expect(effects.getLogs).not.toHaveBeenCalled();
  expect(effects.spawnPm2).not.toHaveBeenCalled();
  expect(effects.getBrowserLogs).not.toHaveBeenCalled();
  expect(effects.getHomebrewStatus).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
  effects.spawnPm2.mockImplementation(makeLogProcess);
});

describe('process-spawning and host-mutating GET routes (#18224)', () => {
  it('refuses remote password-free callers with 403 HOST_CONTROL_FORBIDDEN before spawning pm2 or brew', async () => {
    const app = await hostControlApp(REMOTE_ADDRESS, mounts);
    for (const [path] of routes) {
      const response = await callRoute(app, ['get', path, undefined]);
      expect([response.status, response.body.code], path).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    expectNoSideEffects();
  });

  it('refuses legacy Basic-auth peers with 403 HOST_CONTROL_FORBIDDEN when auth is enabled', async () => {
    auth.enabled = true;
    const basic = `Basic ${Buffer.from(':example-password').toString('base64')}`;
    const app = await hostControlApp(REMOTE_ADDRESS, mounts);
    for (const [path] of routes) {
      const response = await callRoute(app, ['get', path, undefined], { Authorization: basic });
      expect([response.status, response.body.code], path).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    expectNoSideEffects();
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
    for (const [path] of routes) {
      const response = await callRoute(app, ['get', path, undefined], headers);
      expect([response.status, response.body.code], path).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    expectNoSideEffects();
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
      const app = await hostControlApp(caller.address, mounts);
      for (const [path, effect] of routes) {
        const before = effect.mock.calls.length;
        const response = await callRoute(app, ['get', path, undefined], caller.headers);
        expect(response.status, `${caller.label} ${path}`).toBe(200);
        expect(effect.mock.calls.length, `${caller.label} ${path}`).toBe(before + 1);
      }
    }
  });

  it('scopes GET /api/logs/:processName to registered apps and PortOS daemons while refusing "all" and unknown names', async () => {
    const app = await hostControlApp('127.0.0.1', mounts);

    for (const unknown of ['all', 'unregistered-host-daemon']) {
      for (const suffix of ['', '?follow=true']) {
        const response = await callRoute(app, ['get', `/api/logs/${unknown}${suffix}`, undefined]);
        expect([response.status, response.body.code], `${unknown}${suffix}`).toEqual([400, 'UNKNOWN_PROCESS']);
      }
    }
    expect(effects.getLogs).not.toHaveBeenCalled();
    expect(effects.spawnPm2).not.toHaveBeenCalled();

    const appLog = await callRoute(app, ['get', '/api/logs/example-api', undefined]);
    expect(appLog.status).toBe(200);
    expect(effects.getLogs).toHaveBeenCalledWith('example-api', 100, null);
  });
});
