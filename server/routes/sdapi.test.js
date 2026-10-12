import { afterAll, describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import express from 'express';
import { request } from '../lib/testHelper.js';

vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(), settingsEvents: new EventEmitter(),
}));
const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', () => ({
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyRequestSession: vi.fn(async (req) => ['Bearer example-session', 'Bearer example-agent-session'].includes(req.headers.authorization)),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/instanceIdentity.js', () => ({ loadData: vi.fn(async () => ({ peers: [] })) }));
vi.mock('../lib/paths.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-sdapi-') }));
afterAll(cleanupTempDataRoots);

vi.mock('../services/imageGen/index.js', () => ({
  generateImage: vi.fn(),
  getMode: vi.fn(),
  getActiveJob: vi.fn(),
  IMAGE_GEN_MODE: { EXTERNAL: 'external', LOCAL: 'local', CODEX: 'codex', GROK: 'grok', AGY: 'agy', FAL: 'fal' },
  CLOUD_IMAGE_GEN_MODES: ['codex', 'grok', 'agy', 'fal'],
  local: { listImageModels: vi.fn(() => [{ id: 'dev', name: 'Flux 1 Dev' }]) },
}));

// Use a real EventEmitter so listeners attached by the route actually fire
// when the test calls `imageGenEvents.emit(...)`. The factory body is hoisted,
// so the EventEmitter has to be created INSIDE the factory.
vi.mock('../services/imageGenEvents.js', async () => {
  const { EventEmitter } = await import('events');
  return { imageGenEvents: new EventEmitter() };
});

vi.mock('../services/videoGen/local.js', () => ({
  listVideoModels: vi.fn(() => []),
  defaultVideoModelId: vi.fn(() => 'ltx_video'),
  warmByovLoraCapabilities: vi.fn(async () => {}),
}));

vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const proxy = makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-sdapi-') });
  return { ...proxy, tryReadFile: vi.fn() };
});

import { getSettings } from '../services/settings.js';
import * as imageGen from '../services/imageGen/index.js';
import { imageGenEvents as realEmitter } from '../services/imageGenEvents.js';
import { tryReadFile } from '../lib/fileUtils.js';
import * as videoGenService from '../services/videoGen/local.js';
import sdapiRoutes from './sdapi.js';
import { authGate, hostControlRouteGate } from '../services/authGate.js';
import * as waiter from '../services/imageGenWaiter.js';

const enabled = () => getSettings.mockResolvedValue({ imageGen: { expose: { a1111: true } } });
const disabled = () => getSettings.mockResolvedValue({ imageGen: { expose: { a1111: false } } });

describe('sdapi routes — A1111-compatible surface', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/sdapi/v1', sdapiRoutes);
    vi.clearAllMocks();
  });

  describe('gating', () => {
    it('returns 403 on every endpoint when expose.a1111 is false', async () => {
      disabled();
      const r1 = await request(app).get('/sdapi/v1/options');
      const r2 = await request(app).get('/sdapi/v1/sd-models');
      const r3 = await request(app).get('/sdapi/v1/progress');
      expect(r1.status).toBe(403);
      expect(r2.status).toBe(403);
      expect(r3.status).toBe(403);
      expect(r1.body.error).toMatch(/disabled/i);
    });

    it('lets through when expose.a1111 is true', async () => {
      enabled();
      imageGen.getMode.mockResolvedValue('local');
      const r = await request(app).get('/sdapi/v1/options');
      expect(r.status).toBe(200);
    });
  });

  describe('GET /options', () => {
    it('returns local model name when mode is local', async () => {
      enabled();
      imageGen.getMode.mockResolvedValue('local');
      const r = await request(app).get('/sdapi/v1/options');
      expect(r.status).toBe(200);
      expect(r.body.sd_model_checkpoint).toBe('portos-local-dev');
      expect(r.body.portos.mode).toBe('local');
    });

    it('returns external stub when mode is external', async () => {
      enabled();
      imageGen.getMode.mockResolvedValue('external');
      const r = await request(app).get('/sdapi/v1/options');
      expect(r.status).toBe(200);
      expect(r.body.sd_model_checkpoint).toBe('portos-external');
    });
  });

  describe('GET /portos/video-models', () => {
    // Every entry's `runtimeLoraCapable` is stamped from a sync accessor that
    // reads an unprobed runtime as "not capable" (see warmByovLoraCapabilities
    // in services/videoGen/runtimes.js). This surface has no second endpoint an
    // external client could reconcile against, so the list must not be built
    // until the warm has settled.
    it('builds the model list only after the LoRA warm has settled', async () => {
      enabled();
      let probed = false;
      videoGenService.warmByovLoraCapabilities.mockImplementationOnce(async () => {
        await new Promise((resolve) => { setImmediate(resolve); });
        probed = true;
      });
      videoGenService.listVideoModels.mockImplementationOnce(() => [{
        id: 'minimax_h3_8bit', runtime: 'minimax_h3', runtimeLoraCapable: probed,
      }]);

      const r = await request(app).get('/sdapi/v1/portos/video-models');
      expect(r.status).toBe(200);
      expect(r.body.models[0].runtimeLoraCapable).toBe(true);
      expect(r.body.defaultModel).toBe('ltx_video');
    });
  });

  describe('GET /progress', () => {
    it('returns idle payload when no active job', async () => {
      enabled();
      imageGen.getActiveJob.mockResolvedValue(null);
      const r = await request(app).get('/sdapi/v1/progress');
      expect(r.status).toBe(200);
      expect(r.body.progress).toBe(0);
      expect(r.body.current_image).toBeNull();
      expect(r.body.textinfo).toMatch(/no active/i);
    });

    it('passes through active job progress + step + currentImage', async () => {
      enabled();
      imageGen.getActiveJob.mockResolvedValue({
        progress: 0.42,
        step: 5,
        totalSteps: 12,
        currentImage: 'BASE64DATA',
        mode: 'local',
        modelId: 'dev',
      });
      const r = await request(app).get('/sdapi/v1/progress');
      expect(r.status).toBe(200);
      expect(r.body.progress).toBe(0.42);
      expect(r.body.state.sampling_step).toBe(5);
      expect(r.body.state.sampling_steps).toBe(12);
      expect(r.body.current_image).toBe('BASE64DATA');
      expect(r.body.textinfo).toContain('local');
      expect(r.body.textinfo).toContain('dev');
    });
  });

  describe('POST /txt2img', () => {
    it('rejects missing prompt with VALIDATION_ERROR', async () => {
      enabled();
      const r = await request(app).post('/sdapi/v1/txt2img').send({ width: 512 });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/validation/i);
    });

    it('rejects out-of-range width', async () => {
      enabled();
      const r = await request(app).post('/sdapi/v1/txt2img').send({ prompt: 'a cat', width: 99999 });
      expect(r.status).toBe(400);
    });

    it('happy path — external mode reads file and returns base64', async () => {
      enabled();
      imageGen.getMode.mockResolvedValue('external');
      imageGen.generateImage.mockResolvedValue({
        generationId: 'g-1', filename: 'g-1.png', path: '/data/images/g-1.png',
        mode: 'external', model: 'sd-1.5', seed: 1234,
      });
      tryReadFile.mockResolvedValue(Buffer.from([1, 2, 3]));

      const r = await request(app).post('/sdapi/v1/txt2img').send({ prompt: 'a cat', width: 512, height: 512 });

      expect(r.status).toBe(200);
      expect(r.body.images).toHaveLength(1);
      expect(r.body.images[0]).toBe(Buffer.from([1, 2, 3]).toString('base64'));
      const info = JSON.parse(r.body.info);
      expect(info.seed).toBe(1234);
      expect(info.portos.mode).toBe('external');
    });

    it('500s when generation completes but file is missing', async () => {
      enabled();
      imageGen.getMode.mockResolvedValue('external');
      imageGen.generateImage.mockResolvedValue({
        generationId: 'g-2', filename: 'g-2.png', path: '/data/images/g-2.png',
        mode: 'external', model: 'sd-1.5', seed: 1,
      });
      tryReadFile.mockResolvedValue(null);

      const r = await request(app).post('/sdapi/v1/txt2img').send({ prompt: 'a cat' });
      expect(r.status).toBe(500);
      expect(r.body.error).toMatch(/could not be read/i);
    });

    it('local mode waits for completion event before reading file (uses event seed)', async () => {
      enabled();
      imageGen.getMode.mockResolvedValue('local');
      // generateImage in local mode resolves as soon as the python child is
      // spawned; fire the 'completed' event from within the mock to simulate
      // the python child finishing later. Real EventEmitter wired above
      // means the route's listener will actually receive it.
      imageGen.generateImage.mockImplementation(async () => {
        const result = {
          generationId: 'g-3', filename: 'g-3.png', path: '/data/images/g-3.png',
          mode: 'local', model: 'dev', seed: 99,
        };
        // Defer the emit so the route has a chance to register the id.
        setImmediate(() => realEmitter.emit('completed', { generationId: 'g-3', seed: 4242 }));
        return result;
      });
      tryReadFile.mockResolvedValue(Buffer.from('png'));

      const r = await request(app).post('/sdapi/v1/txt2img').send({ prompt: 'fire' });
      expect(r.status).toBe(200);
      const info = JSON.parse(r.body.info);
      // The completed event's seed wins over result.seed.
      expect(info.seed).toBe(4242);
    });

    it('settles on a completed event emitted before generateImage resolves (jobId registered pre-dispatch)', async () => {
      enabled();
      imageGen.getMode.mockResolvedValue('local');
      imageGen.generateImage.mockImplementation(async ({ jobId }) => {
        realEmitter.emit('completed', { generationId: 'foreign-job', seed: 1 });
        realEmitter.emit('completed', { generationId: jobId, seed: 777 });
        return { generationId: jobId, filename: 'e.png', path: '/data/images/e.png', mode: 'local', seed: 1 };
      });
      tryReadFile.mockResolvedValue(Buffer.from('png'));

      const r = await request(app).post('/sdapi/v1/txt2img').send({ prompt: 'early' });
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body.info).seed).toBe(777);
    });

    it('surfaces a failed event emitted before generateImage resolves as GEN_FAILED, not a timeout', async () => {
      enabled();
      imageGen.getMode.mockResolvedValue('local');
      imageGen.generateImage.mockImplementation(async ({ jobId }) => {
        realEmitter.emit('failed', { generationId: jobId, error: 'provider exited' });
        return { generationId: jobId, filename: 'f.png', path: '/data/images/f.png', mode: 'local' };
      });

      const r = await request(app).post('/sdapi/v1/txt2img').send({ prompt: 'early fail' });
      expect(r.status).toBe(500);
      expect(r.body.code).toBe('GEN_FAILED');
      expect(r.body.error).toMatch(/provider exited/);
    });

    it('detaches waiter listeners when dispatch rejects', async () => {
      enabled();
      imageGen.getMode.mockResolvedValue('local');
      const before = realEmitter.listenerCount('completed') + realEmitter.listenerCount('failed');
      imageGen.generateImage.mockRejectedValue(new Error('busy'));
      const r = await request(app).post('/sdapi/v1/txt2img').send({ prompt: 'x' });
      expect(r.status).toBe(500);
      expect(realEmitter.listenerCount('completed') + realEmitter.listenerCount('failed')).toBe(before);
    });
  });
});


// The mounted boundary uniquely catches the passwordless exposure exemption,
// dev-proxy address handling, and backend authorization/dispatch race together.
describe('A1111 generation caller authority (#11138)', () => {
  const appFor = (address = '192.0.2.10') => {
    const app = express();
    app.use((req, _res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: address });
      next();
    });
    app.use(authGate, hostControlRouteGate, express.json());
    app.use('/sdapi/v1', sdapiRoutes);
    app.use(errorMiddleware);
    return app;
  };
  const generate = (mode, { address, headers = {}, path = '/sdapi/v1/txt2img' } = {}) => {
    imageGen.getMode.mockResolvedValue(mode);
    const pending = request(appFor(address)).post(path);
    for (const [name, value] of Object.entries(headers)) pending.set(name, value);
    return pending.send({ prompt: 'Example scene' });
  };
  const useEarlyCompletion = () => {
    imageGen.generateImage.mockImplementation(async ({ mode, jobId }) => {
      if (jobId) realEmitter.emit('completed', { generationId: jobId, seed: 777 });
      return { generationId: jobId, filename: 'example.png', mode, seed: 1 };
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    auth.enabled = false;
    enabled();
    tryReadFile.mockResolvedValue(Buffer.from('png'));
    useEarlyCompletion();
  });

  it('refuses agent modes before waiter or generation effects for every non-operator', async () => {
    const waitSpy = vi.spyOn(waiter, 'createImageGenWaiter');
    try {
      for (const mode of ['codex', 'grok', 'agy']) {
        for (const [password, address, headers] of [
          [false, '192.0.2.10', {}],
          [false, '127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }],
          [false, '192.0.2.10', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '127.0.0.1' }],
          [true, '192.0.2.10', {}],
          [true, '192.0.2.10', { Authorization: 'Bearer invalid-session' }],
          [true, '192.0.2.10', { Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') }],
        ]) {
          auth.enabled = password;
          getSettings.mockResolvedValue({ imageGen: { expose: { a1111: true } }, apiAccess: { sdapi: { exposed: true, requireAuth: false } } });
          for (const path of ['/sdapi/v1/txt2img', '/SDAPI/V1/TXT2IMG/']) {
            const response = await generate(mode, { address, headers, path });
            expect([response.status, response.body.code], `${mode} ${path}`).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
          }
        }
      }
      expect(waitSpy).not.toHaveBeenCalled();
      expect(imageGen.generateImage).not.toHaveBeenCalled();
      expect(tryReadFile).not.toHaveBeenCalled();
    } finally {
      waitSpy.mockRestore();
    }
  });

  it('preserves operator, delegated-agent and genuine local generation with early completion', async () => {
    for (const mode of ['codex', 'grok', 'agy']) {
      for (const [password, address, headers] of [
        [false, '127.0.0.1', {}],
        [false, '127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '::ffff:127.0.0.1' }],
        [true, '192.0.2.10', { Authorization: 'Bearer example-session' }],
        [true, '127.0.0.1', { Authorization: 'Bearer example-agent-session' }],
      ]) {
        auth.enabled = password;
        getSettings.mockResolvedValue({ imageGen: { expose: { a1111: true } }, apiAccess: { sdapi: { exposed: true, requireAuth: false } } });
        const response = await generate(mode, { address, headers });
        expect(response.status, `${mode}: ${JSON.stringify(response.body)}`).toBe(200);
        expect(JSON.parse(response.body.info).seed).toBe(777);
        expect(imageGen.generateImage).toHaveBeenLastCalledWith(expect.objectContaining({ mode, jobId: expect.any(String) }));
        expect(realEmitter.listenerCount('completed') + realEmitter.listenerCount('failed')).toBe(0);
      }
    }
  });

  it('keeps remote inference and discovery/progress under existing exposure and auth policy', async () => {
    for (const password of [false, true]) {
      auth.enabled = password;
      getSettings.mockResolvedValue({ imageGen: { expose: { a1111: true } }, apiAccess: { sdapi: { exposed: true, requireAuth: false } } });
      for (const mode of ['external', 'local', 'fal']) {
        const response = await generate(mode);
        expect(response.status, mode).toBe(200);
        expect(imageGen.generateImage).toHaveBeenLastCalledWith(expect.objectContaining({ mode }));
      }
      imageGen.getMode.mockResolvedValue('grok');
      imageGen.getActiveJob.mockResolvedValue(null);
      for (const endpoint of ['options', 'sd-models', 'samplers', 'progress']) {
        expect((await request(appFor()).get(`/sdapi/v1/${endpoint}`)).status).toBe(200);
      }
    }
    auth.enabled = true;
    enabled(); // No passwordless registry exemption.
    const response = await generate('external');
    expect([response.status, response.body.code]).toEqual([401, 'AUTH_REQUIRED']);
  });

  it('pins the inference mode when saved settings change before dispatch', async () => {
    imageGen.generateImage.mockImplementation(async ({ mode, jobId }) => {
      // A fresh saved-mode lookup would now select a host agent.
      imageGen.getMode.mockResolvedValue('grok');
      expect(mode).toBe('local');
      realEmitter.emit('completed', { generationId: jobId });
      return { generationId: jobId, filename: 'example.png', mode };
    });
    const response = await generate('local');
    expect(response.status).toBe(200);
    expect(imageGen.getMode).toHaveBeenCalledTimes(1);
    expect(imageGen.generateImage).toHaveBeenCalledWith(expect.objectContaining({ mode: 'local' }));
  });

  it('refuses unclassified backends and disabled exposure without dispatch or waiters', async () => {
    const waitSpy = vi.spyOn(waiter, 'createImageGenWaiter');
    try {
      for (const mode of ['future-agent', undefined, null, '']) {
        const response = await generate(mode);
        expect([response.status, response.body.code]).toEqual([400, 'IMAGE_GEN_UNKNOWN_MODE']);
      }
      disabled();
      const response = await generate('grok');
      expect(response.status).toBe(403);
      expect(response.body.error).toMatch(/disabled/i);
      expect(waitSpy).not.toHaveBeenCalled();
      expect(imageGen.generateImage).not.toHaveBeenCalled();
    } finally {
      waitSpy.mockRestore();
    }
  });

  it('surfaces authorized agent failure and cleans up its completion listeners', async () => {
    imageGen.generateImage.mockImplementation(async ({ jobId }) => {
      realEmitter.emit('failed', { generationId: jobId, error: 'Example provider failure' });
      return { generationId: jobId, filename: 'example.png', mode: 'grok' };
    });
    const response = await generate('grok', { address: '127.0.0.1' });
    expect([response.status, response.body.code]).toEqual([500, 'GEN_FAILED']);
    expect(realEmitter.listenerCount('completed') + realEmitter.listenerCount('failed')).toBe(0);
    expect(tryReadFile).not.toHaveBeenCalled();
  });
});
