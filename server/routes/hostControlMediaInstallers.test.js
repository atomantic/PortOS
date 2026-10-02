import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';

// Real mounted routers, auth policy, SSE and Music/Video installer state
// machines. Only runtime probes, processes, Docker and store effects are doubled.
const state = vi.hoisted(() => ({ enabled: false, installed: new Set(), onSpawn: null }));
vi.mock('../services/auth.js', () => ({
  isAuthEnabled: vi.fn(async () => state.enabled),
  verifyRequestSession: vi.fn(async req => req.headers.authorization === 'Bearer example-session'),
  verifyPassword: vi.fn(async () => true),
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
vi.mock('../services/pipeline/musicGen.js', () => ({
  ENGINES: { example: {
    id: 'example', name: 'Example Music', installEnv: 'INSTALL_EXAMPLE_MUSIC',
    venvDefault: '/example/music', resolvePython: () => '/example/music/bin/python',
  } },
  isEnginePlatformSupported: vi.fn(() => true),
  isEngineHealthy: vi.fn(async () => state.installed.has('music')),
}));
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

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import musicRoutes from './music.js';
import videoRoutes from './videoGen.js';
import superColliderRoutes from './superCollider.js';
import { spawnSetupScript } from '../lib/setupScriptRunner.js';
import { isEngineHealthy, isEnginePlatformSupported } from '../services/pipeline/musicGen.js';
import { isByovRuntimeInstalled, isByovRuntimeCurrent, isByovRuntimeReady,
  invalidateByovReadyCache, invalidateByovLoraCapabilityCache, invalidateRuntimeFingerprintCache,
} from '../services/videoGen/runtimes.js';
import { getSuperColliderStatus, setupSuperColliderRuntime } from '../services/superColliderRuntime.js';
import { enqueueJob } from '../services/mediaJobQueue/index.js';

const installers = [
  ['/api/music/setup/runtime-install?runtime=example', {}],
  ['/api/video-gen/setup/runtime-install?runtime=example', {}],
  ['/api/music/supercollider/setup', { rebuild: true }],
];
const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use('/api/video-gen', videoRoutes);
  app.use('/api/music/supercollider', superColliderRoutes);
  app.use('/api/music', musicRoutes);
  app.use(errorMiddleware);
  return app;
};
const call = (app, [path, body], headers = {}) => {
  const pending = request(app).post(path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};
const expectNoSetup = () => {
  for (const effect of [spawnSetupScript, setupSuperColliderRuntime,
    invalidateByovReadyCache, invalidateByovLoraCapabilityCache, invalidateRuntimeFingerprintCache]) {
    expect(effect).not.toHaveBeenCalled();
  }
};
const expectNoProbes = () => {
  for (const probe of [isEngineHealthy, isEnginePlatformSupported,
    isByovRuntimeInstalled, isByovRuntimeCurrent, isByovRuntimeReady, getSuperColliderStatus]) {
    expect(probe).not.toHaveBeenCalled();
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  state.enabled = false;
  state.installed.clear();
  state.onSpawn = null;
});

describe('media installer operator authority (#9513)', () => {
  it('refuses remote and dev-proxied setup before SSE, readiness probes or installation', async () => {
    for (const installer of installers) {
      for (const [address, headers] of [
        ['192.0.2.10', {}],
        ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }],
        ['192.0.2.10', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '127.0.0.1' }],
      ]) {
        const response = await call(appFor(address), installer, headers);
        expect([response.status, response.body.code], installer[0]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
        expect(response.headers['content-type']).toMatch(/^application\/json/);
      }
    }
    expectNoProbes();
    expectNoSetup();
  });

  it('rejects password-enabled anonymous and legacy Basic setup before opening SSE', async () => {
    state.enabled = true;
    for (const installer of installers) {
      for (const [headers, status, code] of [
        [{}, 401, 'AUTH_REQUIRED'],
        [{ Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') }, 403, 'HOST_CONTROL_FORBIDDEN'],
      ]) {
        const response = await call(appFor(), installer, headers);
        expect([response.status, response.body.code], installer[0]).toEqual([status, code]);
        expect(response.headers['content-type']).toMatch(/^application\/json/);
      }
    }
    expectNoProbes();
    expectNoSetup();
  });

  it('preserves local and operator streamed installs, including explicit rebuilds', async () => {
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [false, '127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '::ffff:127.0.0.1' }],
      [true, '192.0.2.10', { Authorization: 'Bearer example-session' }],
    ]) {
      state.enabled = enabled;
      state.installed.clear();
      for (const installer of installers) {
        const response = await call(appFor(address), installer, headers);
        expect(response.status, installer[0]).toBe(200);
        expect(response.headers['content-type']).toMatch(/^text\/event-stream/);
        expect(response.text, installer[0]).toContain('"type":"complete"');
      }
    }
    expect(spawnSetupScript).toHaveBeenCalledTimes(6);
    expect(spawnSetupScript).toHaveBeenCalledWith({ INSTALL_EXAMPLE_MUSIC: '1' });
    expect(spawnSetupScript).toHaveBeenCalledWith({ INSTALL_EXAMPLE_VIDEO: '1' });
    expect(setupSuperColliderRuntime).toHaveBeenCalledTimes(3);
    expect(setupSuperColliderRuntime).toHaveBeenLastCalledWith({ rebuild: true, onLine: expect.any(Function) });
  });

  it.each(installers.slice(0, 2))('retains single-flight installation for %s', async (path, body) => {
    const spawned = Promise.withResolvers();
    state.onSpawn = spawned.resolve;
    const app = appFor('127.0.0.1');
    const first = Promise.resolve(call(app, [path, body]));
    const complete = await spawned.promise;
    try {
      const second = await call(app, [path, body]);
      expect(second.status).toBe(200);
      expect(second.text).toContain('already running');
      expect(spawnSetupScript).toHaveBeenCalledTimes(1);
    } finally {
      complete();
      await first;
    }
    expect((await first).text).toContain('"type":"complete"');
  });

  it('keeps status aliases read-only and contained rendering separate from installation', async () => {
    const app = appFor();
    for (const path of [
      '/api/music/setup/runtime-status?runtime=example',
      '/api/music/setup/runtime-install?runtime=example',
      '/api/video-gen/setup/runtime-status?runtime=example',
      '/api/video-gen/setup/runtime-install?runtime=example',
      '/api/music/supercollider/status',
    ]) {
      const response = await request(app).get(path);
      expect(response.status, path).toBe(200);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
    }
    const render = await request(app).post('/api/music/supercollider/render')
      .send({ code: 'Pbind()', durationSec: 4, seed: 1 });
    expect(render.status).toBe(202);
    expect(enqueueJob).toHaveBeenCalledWith({ kind: 'supercollider', params: {
      source: 'Pbind()', sourceHash: 'example-source-hash', durationSec: 4, seed: 1,
    } });
    expectNoSetup();
  });
});
