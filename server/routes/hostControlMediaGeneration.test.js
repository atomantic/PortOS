import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { callRoute, expectAuthorizedWorkflows, expectRemoteRefusal, hostControlApp } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/paths.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-media-authority-') }));
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-media-authority-') }));
afterAll(cleanupTempDataRoots);

// Writes are gated by the default-deny policy (#16018); the principal matrix lives
// in services/authGate.test.js. Upload, store, queue and provider effects are doubled.
const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => ({
  upload: vi.fn(), prepare: vi.fn(), enqueue: vi.fn(async () => ({ jobId: 'example-job' })),
  image: vi.fn(async () => ({ filename: 'example.png' })),
  avatar: vi.fn(async () => ({ path: '/data/images/example.png' })),
  video: vi.fn(async () => ({ jobId: 'example-job' })),
  trim: vi.fn(async () => ({ id: 'example-trim', trimmedFrom: '22222222-2222-4222-8222-222222222222', trimStartSec: 1.25 })),
  clearMetal: vi.fn(async () => ({ cleared: true })),
  reference: vi.fn(async () => ({})), fork: vi.fn(async () => ({})),
  walk: vi.fn(async () => ({})), track: vi.fn(async () => ({})),
  binding: vi.fn(async () => ({})), publish: vi.fn(async () => ({})),
  create: vi.fn(async () => ({})), refine: vi.fn(async () => ({})),
  filmLook: vi.fn(async () => ({ filename: 'example_look.png' })),
  lastFrame: vi.fn(async () => ({ filename: 'example-frame.png' })),
  lightRegen: vi.fn(async () => ({ filename: 'example_regen-light.png' })),
  topazQuote: vi.fn(async () => ({ token: 'example' })),
  topazStart: vi.fn(async () => ({ jobId: 'example-job' })),
  topazStatus: vi.fn(async () => ({ status: 'processing' })),
  topazRecover: vi.fn(async () => ({ jobId: 'example-job' })),
}));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(), isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/videoGen/trim.js', () => ({ trimHistoryItem: effects.trim }));
vi.mock('../services/videoGen/metalBufferProfiles.js', () => ({ clearMetalBufferProfiles: effects.clearMetal }));
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
  ...await import('../services/imageGen/modes.js'),
  local: { assertGalleryFilename: vi.fn(), readImageSidecar: vi.fn(async () => ({ metadata: {} })) },
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
  BYOV_RUNTIME_INFO: {}, getHistoryItem: vi.fn(async id => ({ id, filename: 'example.mp4' })),
  extractLastFrame: effects.lastFrame,
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
vi.mock('../services/videoGen/topazQuote.js', () => ({ quoteTopaz: effects.topazQuote }));
vi.mock('../services/videoGen/topazJob.js', () => ({ assertNoPendingTopaz: () => {}, enqueueTopazUpscale: effects.topazStart, reconcileTopazStatus: effects.topazStatus, recoverTopazResult: effects.topazRecover }));
vi.mock('../services/videoGen/prepareParams.js', () => ({ cleanupMultipartTemp: vi.fn() }));
vi.mock('../services/videoGen/reactor.js', () => ({}));
vi.mock('../services/videoGen/modelCache.js', () => ({}));
vi.mock('../services/videoGen/displayPower.js', () => ({}));
vi.mock('../services/videoUpload.js', () => ({}));
vi.mock('../services/hfDownloadStream.js', () => ({}));
vi.mock('../services/mediaSketches.js', () => ({}));
vi.mock('../services/universeCanon.js', () => ({}));
vi.mock('../services/imageGen/variants.js', () => ({ applyLightRegenVariant: effects.lightRegen }));
vi.mock('../services/imageGen/filmLookBake.js', () => ({ applyFilmLookBake: effects.filmLook }));
vi.mock('../services/imageGen/regen.js', async (importOriginal) => ({
  ...await importOriginal(),
  resolveRegenBackend: vi.fn(async () => ({ available: true, model: { id: 'example-model' }, pythonPath: null })),
  readImageDimensions: vi.fn(async () => ({ width: 64, height: 64 })),
}));
vi.mock('../services/fableLoom/records.js', () => ({}));
vi.mock('../services/fableLoom/visualConditioning.js', () => ({}));
vi.mock('../services/federatedMedia/remoteSubmission.js', () => ({}));
vi.mock('../services/federatedMedia/inputAssets.js', () => ({}));

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from '../lib/fileUtils.js';
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
  ['post', '/api/video-gen/metal-buffer-profiles/clear', {}, effects.clearMetal, 200],
  ['post', `/api/sprites/${id}/reference/generate`, { target: 'turnaround', mode: 'grok' }, effects.reference, 200],
  ['post', `/api/sprites/${id}/fork`, { name: 'Example fork', designPrompt: 'Example variation' }, effects.fork, 201],
  ['post', `/api/sprites/${id}/walk/generate`, { direction: 'south', correctionPrompt: 'Example correction' }, effects.walk, 200],
  ['post', `/api/sprites/${id}/tracks/scanner/generate`, { direction: 'south', correctionPrompt: 'Example correction' }, effects.track, 200],
  ['post', '/api/threejs-models', { name: 'Example model', filename: 'example.png', providerId: 'example-api', prompt: 'Example shape' }, effects.create, 202],
  ['post', '/api/threejs-models/example-model/generate', { providerId: 'example-api', feedback: 'Example refinement' }, effects.refine, 202],
  // Film-look bake (headless browser), SynthID flux regen (local Python job)
  // and last-frame extraction (ffmpeg) run host processes (#13055).
  ['post', '/api/image-gen/example.png/film-look', { look: { grain: 0.5 } }, effects.filmLook, 200],
  ['post', '/api/image-gen/example.png/regenerate', {}, effects.enqueue, 200],
  ['post', '/api/video-gen/last-frame/22222222-2222-4222-8222-222222222222', {}, effects.lastFrame, 200],
  ['post', '/api/video-gen/upscale/22222222-2222-4222-8222-222222222222/topaz/quote', {}, effects.topazQuote, 200],
  ['post', '/api/video-gen/upscale/22222222-2222-4222-8222-222222222222/topaz', { token: '33333333-3333-4333-8333-333333333333' }, effects.topazStart, 200],
  ['get', '/api/video-gen/upscale/topaz/jobs/33333333-3333-4333-8333-333333333333/status', undefined, effects.topazStatus, 200],
  ['post', '/api/video-gen/upscale/topaz/jobs/33333333-3333-4333-8333-333333333333/cancel', {}, effects.topazStatus, 200],
  ['post', '/api/video-gen/upscale/topaz/jobs/33333333-3333-4333-8333-333333333333/recover', {}, effects.topazRecover, 200],
  ['put', `/api/sprites/${id}/publish-binding`, { binding: null }, effects.binding, 200],
  ['post', `/api/sprites/${id}/atlas/publish`, {}, effects.publish, 200],
];
const mounts = [
  ['/api/image-gen', imageRoutes],
  ['/api/video-gen', videoRoutes],
  ['/api/sprites', spriteRoutes],
  ['/api/threejs-models', modelRoutes],
];
const trimId = '22222222-2222-4222-8222-222222222222';

beforeAll(async () => {
  // The regenerate route resolves its source in the gallery before queueing.
  await mkdir(PATHS.images, { recursive: true });
  await writeFile(join(PATHS.images, 'example.png'), 'example');
});

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
  effects.prepare.mockImplementation(async ({ data }) => ({
    data: { ...data }, mode: data.mode || 'external',
    settings: { imageGen: { grok: { enabled: true } } }, uploadedTempPaths: [],
  }));
});

describe('media generation behind the default-deny gate (#9667, #11418, #16114)', () => {
  it('still runs every generation and publication route for a local operator and a delegated agent session, including defaults and API-first Three.js', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows: operations.map(([method, path, body, effect, status]) => [method, path, body, effect, status]) });
    expect(effects.create).toHaveBeenLastCalledWith(expect.objectContaining({ providerId: 'example-api' }));
    expect(effects.refine).toHaveBeenLastCalledWith('example-model', expect.objectContaining({ providerId: 'example-api' }));
    expect(effects.enqueue).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ mode: 'grok' }) }));
    expect(effects.enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ params: expect.objectContaining({ mode: 'local', regenOf: 'example.png' }) }));
  });

  it('refuses a remote caller on the Topaz status read (a HOST_CONTROL_GET_ROUTES surface)', async () => {
    const status = operations.find(([method]) => method === 'get');
    await expectRemoteRefusal(mounts, status.slice(0, 4));
  });

  it('refuses multipart uploads before the upload middleware can stage files', async () => {
    const app = await hostControlApp('192.0.2.10', mounts);
    const response = await request(app).post('/api/image-gen/generate')
      .set('Content-Type', 'multipart/form-data; boundary=example-boundary')
      .send('--example-boundary--');
    expect([response.status, response.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    expect(effects.upload).not.toHaveBeenCalled();
  });

  it('runs the light SynthID regen in-process without queueing, and refuses every method remotely (#13055)', async () => {
    const regen = ['post', '/api/image-gen/example.png/regenerate'];
    await expectRemoteRefusal(mounts, [...regen, { method: 'light' }, effects.lightRegen]);
    await expectRemoteRefusal(mounts, [...regen, { method: 'flux' }, effects.enqueue]);
    effects.enqueue.mockClear();
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [[...regen, { method: 'light' }, effects.lightRegen, 200]] });
    expect(effects.enqueue).not.toHaveBeenCalled();
  });

  it('refuses a remote video trim before validation, and runs it with validated arguments for operators and agents (#11418)', async () => {
    const path = `/api/video-gen/history/${trimId}/trim`;
    const body = { startSec: 1.25 };
    await expectRemoteRefusal(mounts, ['post', path, { startSec: -1 }, effects.trim]);
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [['post', path, body, effects.trim, 200]] });
    expect(effects.trim).toHaveBeenLastCalledWith(trimId, body);
    auth.enabled = false;
    const invalid = await callRoute(await hostControlApp('127.0.0.1', mounts), ['post', path, { startSec: -1 }]);
    expect(invalid.status).toBe(400);
    expect(effects.trim).toHaveBeenCalledTimes(2);
  });
});
