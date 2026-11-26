import { EventEmitter } from 'node:events';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { callRoute, hostControlApp, REMOTE_ADDRESS } from './hostControlTestHarness.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';
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
const peer = vi.hoisted(() => ({
  id: 'example-peer',
  instanceId: 'example-instance',
  syncSecret: 'example-pair-secret-0123456789-abcdef',
}));
const effects = vi.hoisted(() => ({
  getLogs: vi.fn(async (name, lines) => `${name}:${lines}`),
  spawnPm2: vi.fn(),
  getBrowserLogs: vi.fn(async (lines) => ({ stdout: `browser:${lines}`, stderr: '' })),
  getHomebrewStatus: vi.fn(async ({ fresh }) => ({ available: true, fresh, packages: [] })),
  getSubmoduleOverview: vi.fn(async () => ({})),
  getGitInfo: vi.fn(async () => ({})),
  listDevices: vi.fn(async () => ({ video: [], audio: [] })),
  getRiggingReadiness: vi.fn(async () => ({})),
  diagnoseMossRuntime: vi.fn(async () => ({})),
  checkFaceTimeSetup: vi.fn(async () => ({})),
  getSoftwareInventory: vi.fn(async () => ({})),
  getNodeRuntimeStatus: vi.fn(async () => ({})),
  getDockerContainmentStatus: vi.fn(async () => ({})),
  listHarnesses: vi.fn(async () => []),
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
  loadData: vi.fn(async () => ({ peers: [peer] })),
}));
vi.mock('../services/apps.js', () => ({
  getAllApps: vi.fn(async () => [{ id: 'app-001', pm2ProcessNames: ['example-api'] }]),
  getAppById: vi.fn(async (id) => (id === 'app-001' ? { id: 'app-001', repoPath: '/example/repo', pm2ProcessNames: ['example-api'] } : null)),
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
  getNodeRuntimeStatus: effects.getNodeRuntimeStatus,
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

vi.mock('../services/gitSubmodules.js', () => ({ getSubmoduleOverview: effects.getSubmoduleOverview }));
vi.mock('../services/git/status.js', () => ({ getGitInfo: effects.getGitInfo }));
vi.mock('../services/git/sync.js', () => ({}));
vi.mock('../services/git/cleanup.js', () => ({}));
vi.mock('../services/cos/cosAgentLifecycle.js', () => ({}));
vi.mock('../services/mediaService.js', () => ({ default: { listDevices: effects.listDevices } }));
vi.mock('../services/rigging/readiness.js', () => ({ getRiggingReadiness: effects.getRiggingReadiness }));
vi.mock('../services/rigging/autoSkin.js', () => ({}));
vi.mock('../services/rigging/retarget.js', () => ({}));
vi.mock('../services/imageGen/mossRuntime.js', () => ({ diagnoseMossRuntime: effects.diagnoseMossRuntime }));
vi.mock('../services/imageGen/mossInstall.js', () => ({}));
vi.mock('../services/voice/facetimeBridge.js', () => ({ checkSetup: effects.checkFaceTimeSetup }));
vi.mock('../services/voice/callSession.js', () => ({}));
vi.mock('../services/voice/bootstrap.js', () => ({}));
vi.mock('../services/voice/profileBenchmarks.js', () => ({}));
vi.mock('../services/voice/fineTuning.js', () => ({}));
vi.mock('../services/modelObservation.js', () => ({
  observeModelMutations: () => (_req, _res, next) => next(),
  observeModelResource: (_key, read) => ({ read }),
}));
vi.mock('../services/softwareInventory.js', () => ({ getSoftwareInventory: effects.getSoftwareInventory }));
vi.mock('../services/dockerContainment.js', () => ({ getDockerContainmentStatus: effects.getDockerContainmentStatus }));
vi.mock('../services/instanceFeatures.js', () => ({ isInstanceFeatureEnabled: vi.fn(async () => true) }));
vi.mock('../services/harnesses.js', () => ({ listHarnesses: effects.listHarnesses }));
vi.mock('../services/harnessActionStream.js', () => ({}));

const mounts = [
  ['/api/logs', (await import('./logs.js')).default],
  ['/api/browser', (await import('./browser.js')).default],
  ['/api/apps', (await import('./apps/lifecycle.js')).default],
  ['/api/update', (await import('./update.js')).default],
  ['/api/git', (await import('./git.js')).default],
  ['/api/media', (await import('./media.js')).default],
  ['/api/rigging', (await import('./rigging.js')).default],
  ['/api/image-gen/setup', (await import('./imageGenSetup.js')).default],
  ['/api/voice', (await import('./voice.js')).default],
  ['/api/docker-containment', (await import('./dockerContainment.js')).default],
  ['/api/harnesses', (await import('./harnesses.js')).default],
];

const routes = [
  ['/api/logs/portos-server', effects.getLogs],
  ['/api/logs/portos-server?follow=true', effects.spawnPm2],
  ['/api/browser/logs', effects.getBrowserLogs],
  ['/api/apps/app-001/logs', effects.getLogs],
  ['/api/update/software/homebrew?fresh=1', effects.getHomebrewStatus],
  ['/api/git/submodules/status', effects.getSubmoduleOverview],
  ['/api/git/app-001', effects.getGitInfo],
  ['/api/media/devices', effects.listDevices],
  ['/api/rigging/readiness', effects.getRiggingReadiness],
  ['/api/rigging/readiness?refresh=1', effects.getRiggingReadiness],
  ['/api/image-gen/setup/moss-install', effects.diagnoseMossRuntime],
  ['/api/voice/facetime/status', effects.checkFaceTimeSetup],
  ['/api/update/software', effects.getSoftwareInventory],
  ['/api/update/software?fresh=1', effects.getSoftwareInventory],
  ['/api/update/node-runtime', effects.getNodeRuntimeStatus],
  ['/api/docker-containment/status', effects.getDockerContainmentStatus],
  ['/api/harnesses?fresh=1', effects.listHarnesses],
];

const expectNoSideEffects = () => {
  for (const [name, effect] of Object.entries(effects)) {
    expect(effect, name).not.toHaveBeenCalled();
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
  effects.spawnPm2.mockImplementation(makeLogProcess);
});

describe('process-spawning and host-mutating GET routes', () => {
  it('refuses remote password-free callers before probing the host', async () => {
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

  it.each([false, true])('refuses paired peers before probing the host (auth enabled: %s)', async (enabled) => {
    auth.enabled = enabled;
    const headers = {
      [PEER_INSTANCE_HEADER]: peer.instanceId,
      [PEER_AUTH_HEADER]: derivePeerAuthToken(peer.syncSecret, peer.instanceId),
    };
    // On protected installs, the federation scope check rejects the peer before host control runs.
    const code = enabled ? 'PEER_SCOPE_FORBIDDEN' : 'HOST_CONTROL_FORBIDDEN';
    const app = await hostControlApp(REMOTE_ADDRESS, mounts);
    for (const [path] of routes) {
      const response = await callRoute(app, ['get', path], headers);
      expect([response.status, response.body.code], path).toEqual([403, code]);
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
