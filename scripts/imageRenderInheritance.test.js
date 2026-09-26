// Browser submission through the real route, with synthetic settings/catalogs
// and a mocked enqueue boundary. Cross-package contracts belong in scripts/.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { request } from '../server/lib/testHelper.js';
import { errorMiddleware } from '../server/lib/errorHandler.js';
import { resolveRenderCfg, pipelineImageCfgToRenderOpts } from '../client/src/lib/pipelineImageDefaults.js';
import * as mediaModels from '../server/lib/mediaModels.js';
import * as fileUtils from '../server/lib/fileUtils.js';
import * as mediaJobQueue from '../server/services/mediaJobQueue/index.js';
import { getSettings } from '../server/services/settings.js';
import imageGenRoutes from '../server/routes/imageGen.js';

const getUniverseRenderPin = vi.hoisted(() => vi.fn(async () => null));
vi.mock('../server/services/universeBuilder/crud.js', () => ({ getUniverseRenderPin }));
vi.mock('../server/services/fableLoom/records.js', () => ({ getLoom: vi.fn(), attachNodeImage: vi.fn() }));
vi.mock('../server/services/fableLoom/visualConditioning.js', () => ({
  compileFableLoomVisualRequest: vi.fn(), fableLoomImageCapabilities: vi.fn(),
}));
vi.mock('../server/services/musicVideo/projects.js', () => ({ getProject: vi.fn(async () => null) }));
vi.mock('../server/services/federatedMedia/remoteSubmission.js', () => ({ prepareRemoteMediaJob: vi.fn() }));
vi.mock('../server/services/character.js', () => ({ setAvatar: vi.fn() }));
vi.mock('../server/services/settings.js', () => ({ getSettings: vi.fn() }));
vi.mock('../server/services/imageGen/index.js', async () => ({
  ...await import('../server/lib/generationModes.js'),
  resolveImageCleaners: () => ({ cleanC2PA: false, denoise: false }),
  local: {},
}));
vi.mock('../server/services/mediaJobQueue/index.js', () => ({
  assertMediaQueueRoom: vi.fn(),
  enqueueJob: vi.fn(() => ({ jobId: 'example-job', position: 1, status: 'queued' })),
}));
vi.mock('../server/services/mediaCollections.js', () => ({
  findOrCreateUniverseCollection: vi.fn(async () => ({ id: 'example-collection' })),
}));
vi.mock('../server/services/userActions.js', () => ({ recordUserAction: vi.fn(async () => ({})) }));

let app;
beforeEach(() => {
  vi.clearAllMocks();
  app = express();
  app.use(express.json());
  app.use('/api/image-gen', imageGenRoutes);
  app.use(errorMiddleware);
});

describe('inherited browser render preferences', () => {
  const tag = { universeRun: { universeId: 'example-universe', universeName: 'Example Universe' } };
  const model = (id, state = 'available') => ({
    id, name: id, hardwareCompatibility: { state }, pipelineClass: 'QwenImage21Pipeline',
  });
  afterEach(() => {
    vi.restoreAllMocks();
    getUniverseRenderPin.mockResolvedValue(null);
    getSettings.mockResolvedValue({ imageGen: { mode: 'external' } });
  });
  const submit = async (settings, record, overrides = {}) => {
    getSettings.mockResolvedValue(settings);
    getUniverseRenderPin.mockResolvedValue(record);
    const cfg = resolveRenderCfg(settings, { record, target: 'universe-bible' });
    const opts = pipelineImageCfgToRenderOpts(cfg, tag);
    expect(opts).not.toHaveProperty('mode');
    expect(opts).not.toHaveProperty('modelId');
    expect(opts).not.toHaveProperty('cloudModel');
    return request(app).post('/api/image-gen/generate').send({
      ...opts, ...tag, prompt: 'A synthetic landscape', ...overrides,
    });
  };

  it.each(['example-retired', 'example-incompatible'])('falls back from inherited %s but rejects an explicit request', async (pin) => {
    vi.spyOn(mediaModels, 'getImageModels').mockReturnValue([
      model('example-incompatible', 'unavailable'), model('example-compatible'),
    ]);
    const settings = { imageGen: { mode: 'local', local: { modelId: pin, pythonPath: '/example/python' } } };
    const response = await submit(settings, { imageMode: 'local', imageModelId: pin });
    expect(response.status).toBe(200);
    expect(mediaJobQueue.enqueueJob).toHaveBeenLastCalledWith(expect.objectContaining({
      params: expect.objectContaining({ modelId: 'example-compatible' }),
    }));
    expect(getUniverseRenderPin).toHaveBeenCalledTimes(1);
    mediaJobQueue.enqueueJob.mockClear();
    const explicit = await submit(settings, {}, { mode: 'local', modelId: pin });
    expect(explicit.status).toBe(400);
    expect(explicit.body.code).toBe(pin === 'example-retired' ? 'IMAGE_GEN_UNKNOWN_MODEL' : 'MODEL_HARDWARE_UNAVAILABLE');
    expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
  });

  it('keeps local record and target preferences ahead of the install and uses the selected capability', async () => {
    vi.spyOn(mediaModels, 'getImageModels').mockReturnValue([
      { ...model('example-install'), pipelineClass: 'FluxPipeline' }, model('example-target'), model('example-record'),
    ]);
    const settings = {
      imageGen: { mode: 'local', local: { modelId: 'example-install', pythonPath: '/example/python' } },
      renderDefaults: { 'universe-bible': { imageMode: 'local', imageModel: 'example-target' } },
    };
    for (const [pin, expected] of [['example-record', 'example-record'], ['example-retired', 'example-target']]) {
      const response = await submit(settings, { imageMode: 'local', imageModelId: pin });
      expect(response.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenLastCalledWith(expect.objectContaining({
        params: expect.objectContaining({ modelId: expected }),
      }));
    }
    // Six references require the selected Qwen model; the install's Flux
    // fallback would reject them before enqueue if preparation resolved twice.
    vi.spyOn(fileUtils, 'resolveGalleryImage').mockReturnValue('/example/reference.png');
    const response = await submit(settings, { imageMode: 'local', imageModelId: 'example-record' }, {
      referenceImageFiles: Array.from({ length: 6 }, (_, index) => `example-ref-${index}.png`),
    });
    expect(response.status).toBe(200);
    expect(mediaJobQueue.enqueueJob).toHaveBeenLastCalledWith(expect.objectContaining({
      params: expect.objectContaining({ modelId: 'example-record', referenceImagePaths: Array(6).fill('/example/reference.png') }),
    }));
  });

  it('skips a disabled install preference without weakening explicit mode rejection', async () => {
    const settings = { imageGen: { mode: 'grok', grok: { enabled: false }, codex: { enabled: true } } };
    const cfg = resolveRenderCfg(settings);
    expect(cfg.mode).toBe('codex');
    const inherited = await submit(settings, {});
    expect(inherited.status).toBe(200);
    expect(inherited.body.mode).toBe('codex');
    const explicit = await submit(settings, {}, { mode: 'grok' });
    expect(explicit.status).toBe(400);
    expect(explicit.body.code).toBe('GROK_IMAGEGEN_DISABLED');
  });

  it('inherits same-backend cloud target models and keeps explicit overrides and backend isolation', async () => {
    const settings = {
      imageGen: { mode: 'codex', codex: { enabled: true, model: 'example-install-cloud' }, agy: { enabled: true } },
      renderDefaults: { 'universe-bible': { imageMode: 'codex', imageModel: 'example-target-cloud' } },
    };
    for (const [record, overrides, expectedMode, expectedModel] of [
      [{ imageMode: 'codex' }, {}, 'codex', 'example-target-cloud'],
      [{ imageMode: 'codex', imageModelId: 'example-record-cloud' }, {}, 'codex', 'example-record-cloud'],
      [{ imageMode: 'codex' }, { cloudModel: 'example-explicit' }, 'codex', 'example-explicit'],
      [{ imageMode: 'codex' }, { mode: 'agy', cloudModel: 'example-agy' }, 'agy', 'example-agy'],
      [{ imageMode: 'grok', imageModelId: 'example-disabled' }, {}, 'codex', 'example-target-cloud'],
    ]) {
      const response = await submit(settings, record, overrides);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ mode: expectedMode, model: expectedModel });
    }
  });
});
