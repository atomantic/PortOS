import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';

vi.mock('../lib/paths.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-media-authority-') }));
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-media-authority-') }));
afterAll(cleanupTempDataRoots);

// Real routers and authority middleware; upload, store, queue and provider
// effects are doubled. This catches caller authority failures before effects.
const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => ({
  upload: vi.fn(), prepare: vi.fn(), enqueue: vi.fn(async () => ({ jobId: 'example-job' })),
  image: vi.fn(async () => ({ filename: 'example.png' })),
  avatar: vi.fn(async () => ({ path: '/data/images/example.png' })),
  video: vi.fn(async () => ({ jobId: 'example-job' })),
  reference: vi.fn(async () => ({})), fork: vi.fn(async () => ({})),
  walk: vi.fn(async () => ({})), track: vi.fn(async () => ({})),
  binding: vi.fn(async () => ({})), publish: vi.fn(async () => ({})),
  create: vi.fn(async () => ({})), refine: vi.fn(async () => ({})),
}));
vi.mock('../services/auth.js', () => ({
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyRequestSession: vi.fn(async req => req.headers.authorization === 'Bearer example-session'),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(), getSettings: vi.fn(async () => ({})),
}));
vi.mock('../lib/multipart.js', () => {
  const upload = () => (req, _res, next) => {
    effects.upload();
    req.files = {};
    next();
  };
  return { optionalUploadFields: upload, optionalUpload: upload, uploadFields: upload };
});
vi.mock('./imageGenSetup.js', () => ({ default: express.Router() }));
vi.mock('../services/imageGen/index.js', async () => ({
  ...await import('../services/imageGen/modes.js'), local: {},
  generateImage: effects.image, generateAvatar: effects.avatar,
  checkConnection: vi.fn(async () => ({})), cancel: vi.fn(() => ({ cancelled: true })),
}));
vi.mock('../services/imageGen/prepareParams.js', () => ({
  prepareGenerateParams: effects.prepare,
  resolveLocalImageModel: vi.fn(), selectLocalImageModelFromSettings: vi.fn(),
}));
vi.mock('../services/mediaJobQueue/index.js', () => ({
  enqueueJob: effects.enqueue, attachSseClient: vi.fn(), cancelJob: vi.fn(),
  listJobs: vi.fn(() => []),
}));
vi.mock('../services/userActions.js', () => ({ recordUserAction: vi.fn() }));
vi.mock('../services/character.js', () => ({ setAvatar: vi.fn() }));
vi.mock('../services/videoGen/submitJob.js', () => ({ submitVideoGenJob: effects.video }));
vi.mock('../services/videoGen/local.js', () => ({
  BYOV_RUNTIME_INFO: {}, getHistoryItem: vi.fn(), checkConnection: vi.fn(async () => ({})),
}));
vi.mock('../services/videoGen/batch.js', () => ({ MAX_VIDEO_BATCH_SIZE: 8 }));
vi.mock('../services/sprites/records.js', () => ({
  listRecords: vi.fn(async () => []), getRecordWithAssets: vi.fn(async () => ({})),
}));
vi.mock('../services/sprites/reference.js', () => ({
  startReferenceGeneration: effects.reference, forkSprite: effects.fork,
}));
vi.mock('../services/sprites/walk.js', () => ({ startWalkGeneration: effects.walk }));
vi.mock('../services/sprites/animationTrackWorkflow.js', () => ({ startTrackGeneration: effects.track }));
vi.mock('../lib/spriteAnimationTrackStore.js', async () => {
  const { ANIMATION_TRACKS, deriveTrackFields } = await import('../lib/spriteAnimationTracks.js');
  const tracks = {
    ...ANIMATION_TRACKS,
    scanner: { ...ANIMATION_TRACKS.walk, ...deriveTrackFields('scanner'), id: 'scanner', minFrameCount: 2, defaultFrameCount: 4, maxFrameCount: 8 },
  };
  return { effectiveTrack: id => tracks[id], getEffectiveAnimationTracks: () => tracks, getEffectiveAnimationTrackIds: () => Object.keys(tracks) };
});
vi.mock('../services/sprites/animationTrackStore.js', async () => ({
  ...await import('../lib/spriteAnimationTrackStore.js'),
}));
vi.mock('../services/sprites/publish.js', () => ({
  setPublishBinding: effects.binding, publishAtlas: effects.publish,
}));
vi.mock('../services/threejsModels/index.js', () => ({
  createModel: effects.create, startGeneration: effects.refine, listModels: vi.fn(async () => []),
}));
// Unrelated service effects remain unreachable when mounting target handlers.
vi.mock('../services/sprites/importer.js', () => ({}));
vi.mock('../services/sprites/localAnimationRender.js', () => ({}));
vi.mock('../services/sprites/animationTrackCrud.js', () => ({}));
vi.mock('../services/sprites/walkTrims.js', () => ({}));
vi.mock('../services/sprites/atlas.js', () => ({}));
vi.mock('../services/sprites/assets.js', () => ({}));
vi.mock('../services/sprites/assetPrompt.js', () => ({}));
vi.mock('../services/videoGen/runtimeInstaller.js', () => ({}));
vi.mock('../services/videoGen/poster.js', () => ({}));
vi.mock('../services/videoGen/upscaleJob.js', () => ({}));
vi.mock('../services/videoGen/prepareParams.js', () => ({ cleanupMultipartTemp: vi.fn() }));
vi.mock('../services/videoGen/reactor.js', () => ({}));
vi.mock('../services/videoGen/modelCache.js', () => ({}));
vi.mock('../services/videoGen/displayPower.js', () => ({}));
vi.mock('../services/videoUpload.js', () => ({}));
vi.mock('../services/hfDownloadStream.js', () => ({}));
vi.mock('../services/mediaSketches.js', () => ({}));
vi.mock('../services/universeCanon.js', () => ({}));
vi.mock('../services/imageGen/variants.js', () => ({}));
vi.mock('../services/fableLoom/records.js', () => ({}));
vi.mock('../services/fableLoom/visualConditioning.js', () => ({}));
vi.mock('../services/federatedMedia/remoteSubmission.js', () => ({}));
vi.mock('../services/federatedMedia/inputAssets.js', () => ({}));

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import imageRoutes from './imageGen.js';
import videoRoutes from './videoGen.js';
import spriteRoutes from './sprites.js';
import modelRoutes from './threejsModels.js';

const id = 'example-sprite';
const imageBody = { prompt: 'Example scene', width: 512, height: 512 };
const operations = [
  ['post', '/api/image-gen/generate', imageBody, effects.image, 200],
  ['post', '/api/image-gen/generate', { ...imageBody, mode: 'grok' }, effects.enqueue, 200],
  ['post', '/api/image-gen/avatar', {}, effects.avatar, 200],
  ['post', '/api/video-gen', { prompt: 'Example scene', backend: 'grok' }, effects.video, 200],
  ['post', `/api/sprites/${id}/reference/generate`, { target: 'turnaround', mode: 'grok' }, effects.reference, 200],
  ['post', `/api/sprites/${id}/fork`, { name: 'Example fork', designPrompt: 'Example variation' }, effects.fork, 201],
  ['post', `/api/sprites/${id}/walk/generate`, { direction: 'south', correctionPrompt: 'Example correction' }, effects.walk, 200],
  ['post', `/api/sprites/${id}/tracks/scanner/generate`, { direction: 'south', correctionPrompt: 'Example correction' }, effects.track, 200],
  ['post', '/api/threejs-models', { name: 'Example model', filename: 'example.png', providerId: 'example-api', prompt: 'Example shape' }, effects.create, 202],
  ['post', '/api/threejs-models/example-model/generate', { providerId: 'example-api', feedback: 'Example refinement' }, effects.refine, 202],
  ['put', `/api/sprites/${id}/publish-binding`, { binding: null }, effects.binding, 200],
  ['post', `/api/sprites/${id}/atlas/publish`, {}, effects.publish, 200],
];
const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use('/api/image-gen', imageRoutes);
  app.use('/api/video-gen', videoRoutes);
  app.use('/api/sprites', spriteRoutes);
  app.use('/api/threejs-models', modelRoutes);
  app.use(errorMiddleware);
  return app;
};
const call = (app, [method, path, body], headers = {}) => {
  const pending = request(app)[method](path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};
const expectNoEffects = () => {
  for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
  effects.prepare.mockImplementation(async ({ data }) => ({
    data: { ...data }, mode: data.mode || 'external',
    settings: { imageGen: { grok: { enabled: true } } }, uploadedTempPaths: [],
  }));
});

describe('media generation and source publication authority (#9667)', () => {
  it('refuses remote, proxy-marked and legacy Basic callers before all effects', async () => {
    for (const operation of operations) {
      for (const [enabled, address, headers] of [
        [false, '192.0.2.10', {}],
        [false, '127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }],
        [false, '192.0.2.10', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '127.0.0.1' }],
        [true, '192.0.2.10', { Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') }],
      ]) {
        auth.enabled = enabled;
        for (const path of [operation[1], operation[1].toUpperCase() + '/']) {
          const response = await call(appFor(address), [operation[0], path, operation[2]], headers);
          expect([response.status, response.body.code], path).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
        }
      }
    }
    expectNoEffects();
  });

  it('requires authentication before media authority when a password is enabled', async () => {
    auth.enabled = true;
    for (const operation of operations) {
      const response = await call(appFor(), operation);
      expect([response.status, response.body.code], operation[1]).toEqual([401, 'AUTH_REQUIRED']);
    }
    expectNoEffects();
  });

  it('retains local and operator workflows, including defaults and API-first Three.js', async () => {
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [false, '127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '::ffff:127.0.0.1' }],
      [true, '192.0.2.10', { Authorization: 'Bearer example-session' }],
    ]) {
      auth.enabled = enabled;
      for (const operation of operations) {
        const previousCalls = operation[3].mock.calls.length;
        const response = await call(appFor(address), operation, headers);
        expect(response.status, `${operation[1]}: ${JSON.stringify(response.body)}`).toBe(operation[4]);
        expect(operation[3]).toHaveBeenCalledTimes(previousCalls + 1);
      }
    }
    expect(effects.create).toHaveBeenLastCalledWith(expect.objectContaining({ providerId: 'example-api' }));
    expect(effects.refine).toHaveBeenLastCalledWith('example-model', expect.objectContaining({ providerId: 'example-api' }));
    expect(effects.enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ params: expect.objectContaining({ mode: 'grok' }) }));
  });

  it('refuses multipart uploads before the upload middleware can stage files', async () => {
    for (const path of ['/api/image-gen/generate', '/api/video-gen', `/api/sprites/${id}/reference/generate`]) {
      const response = await request(appFor()).post(path)
        .set('Content-Type', 'multipart/form-data; boundary=example-boundary')
        .send('--example-boundary--');
      expect([response.status, response.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    expectNoEffects();
  });

  it('retains remote reads and cancellation', async () => {
    expect((await request(appFor()).get('/api/threejs-models')).status).toBe(200);
    expect((await request(appFor()).get('/api/sprites')).status).toBe(200);
    expect((await call(appFor(), ['post', '/api/image-gen/cancel', {}])).status).toBe(200);
    expectNoEffects();
  });
});
