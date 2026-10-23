import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import sharp from 'sharp';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/paths.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-pre-guard-media-') }));
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-pre-guard-media-') }));
afterAll(cleanupTempDataRoots);

// ffmpeg/ffprobe over caller or peer media, the headless composition browser,
// re-armed local video dispatch, the signed-in Pinterest browser and the GPU
// image clean need operator authority (#13055). Real routers behind the real
// gates; every host-process service is doubled. The standalone image clean is
// gated in its handler only for the GPU mode, so its in-process sharp passes
// stay open to a remote caller.
const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => ({
  codeExport: vi.fn(async () => ({ status: 'queued' })),
  codePoster: vi.fn(async () => ({ posterVersion: 1 })),
  enqueue: vi.fn(async () => ({ jobId: 'example-job' })),
  resumeHold: vi.fn(async () => true),
  pull: vi.fn(async () => ({})),
  collage: vi.fn(async () => ({ filename: 'example-collage.png' })),
  frames: vi.fn(async () => ({ added: 3 })),
  pinterest: vi.fn(async () => ({ imported: 1 })),
  postprocess: vi.fn(async () => ({ ok: true })),
  sourceFrames: vi.fn(async () => ({ frames: [] })),
  trim: vi.fn(async () => ({ id: 'example-trim' })),
  videoPoster: vi.fn(async () => ({ id: 'example-video' })),
  upload: vi.fn(async () => ({ filename: 'example.mp4' })),
  uploadFile: vi.fn(async () => ({ filename: 'example.mp4' })),
  gpuClean: vi.fn(async () => ({ jobId: '22222222-2222-4222-8222-222222222222', modelId: 'example-model', strength: 0.3 })),
}));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(), getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/instanceIdentity.js', () => ({
  ensureInstanceId: vi.fn(async () => 'example-self'),
  loadData: vi.fn(async () => ({ peers: [{
    id: 'example-peer', instanceId: 'example-instance', enabled: true, syncSecret: 'a'.repeat(32),
  }] })),
}));
vi.mock('../services/codeAnimation/index.js', () => ({ captureCodeAnimationJobPoster: effects.codePoster }));
vi.mock('../services/codeAnimation/export.js', () => ({ startCodeAnimationExport: effects.codeExport }));
vi.mock('../services/mediaJobQueue/index.js', () => ({
  enqueueJob: effects.enqueue, resumeVideoHold: effects.resumeHold,
  attachSseClient: vi.fn(), cancelJob: vi.fn(), listJobs: vi.fn(() => []), listQueueJobs: vi.fn(() => []),
  getJob: vi.fn(() => null), cancelQueuedJobs: vi.fn(), removeArchivedJob: vi.fn(), runJobNow: vi.fn(),
  listVideoHolds: vi.fn(() => []),
  JOB_KINDS: ['image', 'video'], JOB_STATUSES: ['queued', 'running', 'completed', 'failed', 'canceled'],
  MEDIA_QUEUE_SHUTTING_DOWN: 'MEDIA_QUEUE_SHUTTING_DOWN',
}));
vi.mock('../services/mediaCollections.js', async (importOriginal) => ({
  ...await importOriginal(),
  getCollection: vi.fn(async (id) => ({ id, items: [{ kind: 'video', ref: 'example-video' }] })),
}));
vi.mock('../services/peerHostedMedia.js', () => ({
  resolveMediaLocations: vi.fn(async (items) => items.map(() => ({ location: 'remote', hostPeerId: 'example-peer' }))),
  findHostPeer: vi.fn(async (id) => ({ id })),
  unmarkHosted: vi.fn(),
}));
vi.mock('../services/sharing/peerSyncAssets.js', () => ({
  pullMissingAssetsFromPeer: effects.pull,
  collectionVideoRefToFilename: (ref) => `${ref}.mp4`,
}));
vi.mock('../services/moodBoard/index.js', () => ({
  composeBoardCollage: effects.collage,
  extractItemFrames: effects.frames,
  importPrivatePinterestBoard: effects.pinterest,
}));
vi.mock('../services/sprites/walk.js', () => ({
  rerunWalkPostprocess: effects.postprocess, getWalkSourceFrames: effects.sourceFrames,
}));
vi.mock('../services/sprites/walkTrims.js', () => ({ saveLoopTrim: effects.trim }));
vi.mock('../services/videoGen/poster.js', () => ({ updateVideoPoster: effects.videoPoster }));
vi.mock('../services/videoUpload.js', () => ({
  saveUploadedGalleryVideo: effects.upload, saveUploadedGalleryVideoFile: effects.uploadFile,
}));
vi.mock('../services/imageGen/cleanGpu.js', () => ({
  enqueueGpuClean: effects.gpuClean,
  readGpuCleanResult: vi.fn(), getGpuCleanStatus: vi.fn(), saveGpuCleanToGallery: vi.fn(),
}));
// Observed, not doubled: the remote-open image clean runs the real sharp pass.
vi.mock('../lib/imageClean.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, cleanImageBuffer: vi.fn(actual.cleanImageBuffer) };
});
// Unrelated service effects remain unreachable when mounting target handlers.
vi.mock('../services/codeAnimation/stages.js', () => ({}));
vi.mock('../services/codeAnimation/soundtrack.js', () => ({}));
vi.mock('../services/codeAnimation/soundAssets.js', () => ({}));
vi.mock('../services/codeAnimation/preflight.js', () => ({}));
vi.mock('../services/codeAnimation/package.js', () => ({}));
vi.mock('../services/codeAnimation/projects.js', () => ({}));
vi.mock('../services/mediaPromptRefiner.js', () => ({}));
vi.mock('../services/mediaPromptHistory.js', () => ({}));
vi.mock('../services/mediaPromptFromMedia.js', () => ({}));
vi.mock('../services/moodBoardStyleSynthesis.js', () => ({}));
vi.mock('../services/moodBoardCompositeStyle.js', () => ({}));
vi.mock('../services/moodBoard/analyzeJob.js', () => ({}));
vi.mock('../services/moodBoard/generateMore.js', () => ({}));
vi.mock('../services/sprites/records.js', () => ({}));
vi.mock('../services/sprites/importer.js', () => ({}));
vi.mock('../services/sprites/reference.js', () => ({}));
vi.mock('../services/sprites/assetPrompt.js', () => ({}));
vi.mock('../services/sprites/localAnimationRender.js', () => ({}));
vi.mock('../services/sprites/animationTrackWorkflow.js', () => ({}));
vi.mock('../services/sprites/animationTrackCrud.js', () => ({}));
vi.mock('../services/sprites/atlas.js', () => ({}));
vi.mock('../services/sprites/publish.js', () => ({}));
vi.mock('../services/sprites/assets.js', () => ({}));
vi.mock('../services/videoGen/local.js', () => ({ BYOV_RUNTIME_INFO: {}, getHistoryItem: vi.fn() }));
vi.mock('../services/videoGen/batch.js', () => ({ MAX_VIDEO_BATCH_SIZE: 8 }));
vi.mock('../services/videoGen/prepareParams.js', () => ({ cleanupMultipartTemp: vi.fn(), validateVideoRetryParams: vi.fn() }));
vi.mock('../services/videoGen/runtimeInstaller.js', () => ({}));
vi.mock('../services/videoGen/upscaleJob.js', () => ({}));
vi.mock('../services/videoGen/trimStart.js', () => ({}));
vi.mock('../services/videoGen/submitJob.js', () => ({}));
vi.mock('../services/videoGen/reactor.js', () => ({}));
vi.mock('../services/videoGen/modelCache.js', () => ({}));
vi.mock('../services/videoGen/displayPower.js', () => ({}));
vi.mock('../services/hfDownloadStream.js', () => ({}));
vi.mock('../services/userActions.js', () => ({ recordUserAction: vi.fn() }));

import { authGate, hostControlBodyGate, hostControlRouteGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import { cleanImageBuffer } from '../lib/imageClean.js';
import codeAnimationRoutes from './codeAnimation.js';
import htmlCompositionRoutes from './htmlComposition.js';
import imageCleanRoutes from './imageClean.js';
import mediaJobRoutes from './mediaJobs.js';
import mediaCollectionRoutes from './mediaCollections.js';
import moodBoardRoutes from './moodBoard.js';
import spriteRoutes from './sprites.js';
import videoGenRoutes from './videoGen.js';

const id = '00000000-0000-4000-8000-000000000001';
const runId = 'walk-south-0123abcd';
// [method, path, body, effect observed on success, success status]
const operations = [
  ['post', `/api/code-animation/${id}/export`, {}, effects.codeExport, 202],
  ['post', `/api/code-animation/jobs/${id}/poster`, {}, effects.codePoster, 200],
  ['post', '/api/html-composition/render', { directory: 'compositions/example' }, effects.enqueue, 202],
  ['post', `/api/media-jobs/holds/${id}/resume`, {}, effects.resumeHold, 200],
  ['post', '/api/media/collections/example-collection/localize', {}, effects.pull, 202],
  ['post', '/api/mood-boards/example-board/collage', {}, effects.collage, 200],
  ['post', '/api/mood-boards/example-board/items/example-item/extract-frames', { count: 3 }, effects.frames, 200],
  ['post', '/api/mood-boards/example-board/pinterest/import', { url: 'https://www.pinterest.com/example/example-board/' }, effects.pinterest, 200],
  ['post', '/api/sprites/example-sprite/walk/postprocess', { runId }, effects.postprocess, 200],
  ['post', `/api/sprites/example-sprite/walk/runs/${runId}/source-frames/extract`, {}, effects.sourceFrames, 200],
  ['post', '/api/sprites/example-sprite/walk/trim', { runId, enabledColumns: [0, 1] }, effects.trim, 201],
  ['patch', `/api/video-gen/history/${id}/poster`, { atSec: 1.5 }, effects.videoPoster, 200],
  ['post', '/api/video-gen/upload', { data: 'AAAA', filename: 'clip.mp4' }, effects.upload, 200],
];
const peerHeaders = {
  [PEER_AUTH_HEADER]: derivePeerAuthToken('a'.repeat(32), 'example-instance'),
  [PEER_INSTANCE_HEADER]: 'example-instance',
};
const basicHeaders = { Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') };
const spoofedProxies = [
  ['192.0.2.10', {}],
  ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }],
  ['192.0.2.10', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '127.0.0.1' }],
];
const credentialRefusals = [
  [{}, 401, 'AUTH_REQUIRED'],
  [basicHeaders, 403, 'HOST_CONTROL_FORBIDDEN'],
  [peerHeaders, 403, 'PEER_SCOPE_FORBIDDEN'],
];
const authorizedCallers = async () => [
  [false, '127.0.0.1', {}],
  [true, '192.0.2.10', { Authorization: `Bearer ${(await createSession()).token}` }],
  [true, '192.0.2.10', { Authorization: `Bearer ${(await createSession({ label: 'agent' })).token}` }],
];

const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json(), hostControlBodyGate);
  app.use('/api/code-animation', codeAnimationRoutes);
  app.use('/api/html-composition', htmlCompositionRoutes);
  app.use('/api/image-clean', imageCleanRoutes);
  app.use('/api/media-jobs', mediaJobRoutes);
  app.use('/api/media/collections', mediaCollectionRoutes);
  app.use('/api/mood-boards', moodBoardRoutes);
  app.use('/api/sprites', spriteRoutes);
  app.use('/api/video-gen', videoGenRoutes);
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
});

describe('media pre-guard host-process authority (#13055)', () => {
  it('refuses remote password-free callers, spoofed-proxy and case variants before any host process', async () => {
    for (const operation of operations) {
      for (const [address, headers] of spoofedProxies) {
        for (const path of [operation[1], operation[1].toUpperCase() + '/']) {
          const response = await call(appFor(address), [operation[0], path, operation[2]], headers);
          expect([response.status, response.body.code], path).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
        }
      }
    }
    const multipart = await request(appFor()).post('/api/video-gen/upload')
      .set('Content-Type', 'multipart/form-data; boundary=example-boundary')
      .send('--example-boundary--');
    expect([multipart.status, multipart.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    expectNoEffects();
  });

  it('requires authentication with a password and denies legacy Basic and scoped-peer credentials', async () => {
    auth.enabled = true;
    for (const operation of operations) {
      for (const [headers, status, code] of credentialRefusals) {
        const response = await call(appFor(), operation, headers);
        expect([response.status, response.body.code], operation[1]).toEqual([status, code]);
      }
    }
    expectNoEffects();
  });

  it('keeps working for local callers, operator sessions and delegated agent sessions', async () => {
    for (const [enabled, address, headers] of await authorizedCallers()) {
      auth.enabled = enabled;
      for (const operation of operations) {
        const effect = operation[3];
        const previousCalls = effect.mock.calls.length;
        const response = await call(appFor(address), operation, headers);
        expect(response.status, `${operation[1]}: ${JSON.stringify(response.body)}`).toBe(operation[4]);
        // Localize answers 202 and pulls in the background.
        await vi.waitFor(() => expect(effect).toHaveBeenCalledTimes(previousCalls + 1));
      }
    }
    expect(effects.enqueue).toHaveBeenLastCalledWith({ kind: 'html-composition', params: { directory: 'compositions/example' } });
    expect(effects.resumeHold).toHaveBeenLastCalledWith(id);
    expect(effects.pull).toHaveBeenLastCalledWith('example-peer', [{ kind: 'video', filename: 'example-video.mp4' }], { includeMismatched: false });
    expect(effects.videoPoster).toHaveBeenLastCalledWith(id, 1.5);
    expect(effects.upload).toHaveBeenLastCalledWith('AAAA', 'clip.mp4');
  });
});

// The mode rides in the query, so the handler (not the route list) gates the
// GPU pass; the in-process sharp passes must stay open to a remote caller.
describe('standalone image clean GPU authority (#13055)', () => {
  let png;
  const clean = (app, query, headers = {}) => {
    const pending = request(app).post(`/api/image-clean${query}`).set('Content-Type', 'application/octet-stream');
    for (const [name, value] of Object.entries(headers)) pending.set(name, value);
    return pending.send(png);
  };

  beforeAll(async () => {
    png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 100, b: 50 } } }).png().toBuffer();
  });

  it('refuses a remote GPU clean before any image work or queueing', async () => {
    for (const query of ['?diffusion=gpu', '?diffusion=flux']) {
      for (const [address, headers] of spoofedProxies) {
        const response = await clean(appFor(address), query, headers);
        expect([response.status, response.body.code], query).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      }
    }
    auth.enabled = true;
    for (const [headers, status, code] of credentialRefusals) {
      const response = await clean(appFor(), '?diffusion=gpu', headers);
      expect([response.status, response.body.code]).toEqual([status, code]);
    }
    expect(cleanImageBuffer).not.toHaveBeenCalled();
    expect(effects.gpuClean).not.toHaveBeenCalled();
  });

  it('queues the GPU clean for local callers, operator sessions and delegated agent sessions', async () => {
    for (const [enabled, address, headers] of await authorizedCallers()) {
      auth.enabled = enabled;
      const response = await clean(appFor(address), '?diffusion=gpu', headers);
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      expect(response.body).toMatchObject({ mode: 'gpu', jobId: '22222222-2222-4222-8222-222222222222' });
    }
    expect(effects.gpuClean).toHaveBeenCalledTimes(3);
  });

  it('keeps the in-process sharp clean open to a remote password-free caller', async () => {
    for (const query of ['', '?diffusion=light']) {
      const response = await clean(appFor(), query);
      expect(response.status, `${query}: ${response.text}`).toBe(200);
      expect(response.headers['content-type']).toBe('image/png');
      expect(JSON.parse(response.headers['x-clean-report']).steps.some(({ step }) => step === 'diffusion')).toBe(query !== '');
    }
    expect(cleanImageBuffer).toHaveBeenCalledTimes(2);
    expect(effects.gpuClean).not.toHaveBeenCalled();
  });
});
