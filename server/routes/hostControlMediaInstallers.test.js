import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { callRoute, expectAuthorizedWorkflows, expectRemoteRefusal, hostControlApp } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-media-installers-') }));
afterAll(cleanupTempDataRoots);

// Installer writes are plain writes under the default-deny gate (#16018, #9513);
// the principal matrix lives in services/authGate.test.js. Real mounted routers,
// SSE and Music/Video installer state machines; runtime probes, processes,
// Docker and store effects are doubled.
const state = vi.hoisted(() => ({ enabled: false, installed: new Set(), onSpawn: null }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(), isAuthEnabled: vi.fn(async () => state.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({})),
}));
vi.mock('../lib/setupScriptRunner.js', async (importOriginal) => ({
  ...await importOriginal(),
  stopSetupScript: vi.fn(),
  spawnSetupScript: vi.fn(env => {
    const runtime = env.INSTALL_EXAMPLE_MUSIC ? 'music' : 'video';
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const complete = () => {
      state.installed.add(runtime);
      child.emit('close', 0);
    };
    // Complete after the real installer has registered its process callbacks,
    // or let the concurrency test hold the process while a second request arrives.
    if (state.onSpawn) state.onSpawn(complete);
    else Promise.resolve().then(complete);
    return child;
  }),
}));
vi.mock('../services/pipeline/musicGen.js', () => {
  const ENGINES = { example: {
    id: 'example', name: 'Example Music', installEnv: 'INSTALL_EXAMPLE_MUSIC',
    venvDefault: '/example/music', resolvePython: () => '/example/music/bin/python',
  } };
  return {
    ENGINES,
    findEngine: (id) => (Object.hasOwn(ENGINES, id) ? ENGINES[id] : null),
    isEnginePlatformSupported: vi.fn(() => true),
    isEngineHealthy: vi.fn(async () => state.installed.has('music')),
  };
});
vi.mock('../services/videoGen/runtimes.js', () => ({
  BYOV_RUNTIME_INFO: { example: {
    id: 'example', label: 'Example Video', installEnvVar: 'INSTALL_EXAMPLE_VIDEO',
    venvPython: '/example/video/bin/python', repoDir: '/example/video',
  } },
  isByovRuntimeInstalled: vi.fn(() => state.installed.has('video')),
  isByovRuntimeCurrent: vi.fn(async () => true),
  isByovRuntimeReady: vi.fn(async () => true),
  invalidateByovReadyCache: vi.fn(),
  invalidateByovLoraCapabilityCache: vi.fn(),
  invalidateRuntimeFingerprintCache: vi.fn(),
}));
vi.mock('../services/superColliderRuntime.js', () => ({
  getSuperColliderStatus: vi.fn(async () => ({ ready: true, state: 'ready' })),
  setupSuperColliderRuntime: vi.fn(async ({ onLine }) => {
    onLine('Example build completed');
    return { outcome: 'ready', built: true, probed: true, status: { ready: true } };
  }),
}));
vi.mock('../services/superColliderRender.js', () => ({
  superColliderSourceHash: () => 'example-source-hash',
}));
vi.mock('../services/musicCode.js', () => ({
  MUSIC_CODE_LANGUAGES: ['strudel', 'tonejs', 'supercollider'], MUSIC_CODE_MAX: 20000,
}));
vi.mock('../services/mediaJobQueue/index.js', () => ({
  enqueueJob: vi.fn(async () => ({ jobId: 'example-render', status: 'queued' })),
}));
vi.mock('../services/audioModels.js', () => ({}));
vi.mock('../services/musicEngineCapabilities.js', () => ({}));
vi.mock('../services/musicDesigner.js', () => ({}));
vi.mock('../services/musicWaveform.js', () => ({}));
vi.mock('../services/hfDownloadStream.js', () => ({}));
vi.mock('../services/musicGeneration.js', () => ({}));
vi.mock('../services/videoGen/poster.js', () => ({}));
vi.mock('../services/userActions.js', () => ({}));
vi.mock('../services/videoGen/local.js', () => ({ getHistoryItem: vi.fn() }));
vi.mock('../services/videoGen/upscaleJob.js', () => ({}));
vi.mock('../services/videoGen/prepareParams.js', () => ({}));
vi.mock('../services/videoGen/submitJob.js', () => ({}));
vi.mock('../services/videoGen/reactor.js', () => ({}));
vi.mock('../services/videoGen/modelCache.js', () => ({}));
vi.mock('../services/videoUpload.js', () => ({}));
vi.mock('../services/mediaJobQueue/remoteMediaJob.js', () => ({}));
vi.mock('../services/videoGen/displayPower.js', () => ({}));

import musicRoutes from './music.js';
import videoRoutes from './videoGen.js';
import superColliderRoutes from './superCollider.js';
import { spawnSetupScript } from '../lib/setupScriptRunner.js';
import { isEngineHealthy, isEnginePlatformSupported } from '../services/pipeline/musicGen.js';
import { isByovRuntimeInstalled, isByovRuntimeCurrent, isByovRuntimeReady,
} from '../services/videoGen/runtimes.js';
import { getSuperColliderStatus, setupSuperColliderRuntime } from '../services/superColliderRuntime.js';
import { enqueueJob } from '../services/mediaJobQueue/index.js';

const installers = [
  ['/api/music/setup/runtime-install?runtime=example', {}],
  ['/api/video-gen/setup/runtime-install?runtime=example', {}],
  ['/api/music/supercollider/setup', { rebuild: true }],
];
const mounts = [
  ['/api/video-gen', videoRoutes],
  ['/api/music/supercollider', superColliderRoutes],
  ['/api/music', musicRoutes],
];

beforeEach(() => {
  vi.clearAllMocks();
  state.enabled = false;
  state.installed.clear();
  state.onSpawn = null;
});

describe('media installer operator authority (#9513)', () => {
  it('refuses a remote caller before SSE, readiness probes or installation', async () => {
    await expectRemoteRefusal(mounts, ['post', installers[0][0], installers[0][1], spawnSetupScript]);
    for (const probe of [isEngineHealthy, isEnginePlatformSupported,
      isByovRuntimeInstalled, isByovRuntimeCurrent, isByovRuntimeReady, getSuperColliderStatus]) {
      expect(probe).not.toHaveBeenCalled();
    }
  });

  it('preserves local and delegated-agent streamed installs, including explicit rebuilds', async () => {
    // The installer short-circuits an installed runtime, so each pass starts bare.
    await expectAuthorizedWorkflows({ auth: state, mounts, rearm: () => state.installed.clear(), workflows: [
      ['post', installers[0][0], installers[0][1], spawnSetupScript, 200],
      ['post', installers[1][0], installers[1][1], spawnSetupScript, 200],
      ['post', installers[2][0], installers[2][1], setupSuperColliderRuntime, 200],
    ] });
    expect(spawnSetupScript).toHaveBeenCalledWith({ INSTALL_EXAMPLE_MUSIC: '1' });
    expect(spawnSetupScript).toHaveBeenCalledWith({ INSTALL_EXAMPLE_VIDEO: '1' });
    expect(setupSuperColliderRuntime).toHaveBeenLastCalledWith({ rebuild: true, onLine: expect.any(Function) });
  });

  it.each(installers.slice(0, 2))('retains single-flight installation for %s', async (path, body) => {
    const spawned = Promise.withResolvers();
    state.onSpawn = spawned.resolve;
    const app = await hostControlApp('127.0.0.1', mounts);
    const first = Promise.resolve(callRoute(app, ['post', path, body]));
    const complete = await spawned.promise;
    try {
      const second = await callRoute(app, ['post', path, body]);
      expect(second.status).toBe(200);
      expect(second.text).toContain('already running');
      expect(spawnSetupScript).toHaveBeenCalledTimes(1);
    } finally {
      complete();
      await first;
    }
    expect((await first).text).toContain('"type":"complete"');
  });

  it('requires operator authority for the music runtime probe without starting installation', async () => {
    const workflow = ['get', installers[0][0], undefined, isEngineHealthy, 200];
    await expectRemoteRefusal(mounts, workflow);
    await expectAuthorizedWorkflows({ auth: state, mounts, workflows: [workflow] });
    expect(spawnSetupScript).not.toHaveBeenCalled();
  });

  it('keeps status aliases read-only and contained rendering separate from installation', async () => {
    const app = await hostControlApp('192.0.2.10', mounts);
    for (const path of [
      '/api/video-gen/setup/runtime-status?runtime=example',
      '/api/video-gen/setup/runtime-install?runtime=example',
      '/api/music/supercollider/status',
    ]) {
      const response = await callRoute(app, ['get', path]);
      expect(response.status, path).toBe(200);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
    }
    // Render runs caller SuperCollider source in a container, so it needs host
    // control (#13055); a local caller still renders without setup.
    const render = await callRoute(await hostControlApp('127.0.0.1', mounts),
      ['post', '/api/music/supercollider/render', { code: 'Pbind()', durationSec: 4, seed: 1 }]);
    expect(render.status).toBe(202);
    expect(enqueueJob).toHaveBeenCalledWith({ kind: 'supercollider', params: {
      source: 'Pbind()', sourceHash: 'example-source-hash', durationSec: 4, seed: 1,
    } });
    expect(setupSuperColliderRuntime).not.toHaveBeenCalled();
  });
});
