import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';

// Real routers and authority middleware; provider, queue and record effects are
// doubled. Pins the operator-authority boundary for the auxiliary media entry
// points that reach tool-capable agents (#9672).
const auth = vi.hoisted(() => ({ enabled: false }));
const SHUTTING_DOWN = vi.hoisted(() => 'MEDIA_QUEUE_SHUTTING_DOWN');
const effects = vi.hoisted(() => ({
  refine: vi.fn(async () => ({ prompt: 'Example refined' })),
  fromMedia: vi.fn(async () => ({ image: 'Example prompt' })),
  saveExam: vi.fn(async () => ({ id: 'example-exam' })),
  enqueue: vi.fn(async () => ({ jobId: 'example-new-job' })),
  removeArchived: vi.fn(() => true),
  runNow: vi.fn(() => ({ ok: true })),
  generate: vi.fn(async () => ({ queued: 1 })),
  slice: vi.fn(async () => ({ sliced: 1 })),
  caption: vi.fn(async () => ({ runId: 'example-run' })),
}));
vi.mock('../services/auth.js', () => ({
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyRequestSession: vi.fn(async req => req.headers.authorization === 'Bearer example-session'),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(), getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/mediaJobQueue/index.js', () => ({
  listJobs: vi.fn(() => []), listQueueJobs: vi.fn(() => []),
  getJob: vi.fn(id => (id === 'example-job'
    ? { id, kind: 'image', status: 'failed', owner: 'example', params: { mode: 'grok', prompt: 'Original' } }
    : null)),
  cancelJob: vi.fn(() => ({ ok: true })), cancelQueuedJobs: vi.fn(() => ({ canceled: 0 })),
  enqueueJob: effects.enqueue, removeArchivedJob: effects.removeArchived, runJobNow: effects.runNow,
  listVideoHolds: vi.fn(() => []), resumeVideoHold: vi.fn(),
  JOB_KINDS: ['image', 'video'], JOB_STATUSES: ['queued', 'running', 'completed', 'failed', 'canceled'],
  MEDIA_QUEUE_SHUTTING_DOWN: SHUTTING_DOWN,
}));
vi.mock('../services/mediaPromptRefiner.js', () => ({ refineMediaPrompt: effects.refine }));
vi.mock('../services/mediaPromptFromMedia.js', () => ({ promptFromMedia: effects.fromMedia }));
vi.mock('../services/mediaPromptHistory.js', () => ({
  saveMediaPromptExamination: effects.saveExam,
  listMediaPromptExaminations: vi.fn(async () => []), getMediaPromptExamination: vi.fn(),
}));
vi.mock('../services/videoGen/prepareParams.js', () => ({ validateVideoRetryParams: vi.fn() }));
vi.mock('../services/loraDatasets.js', () => ({
  addUploadedImage: vi.fn(), createDataset: vi.fn(), deleteDataset: vi.fn(), deleteImage: vi.fn(),
  getDataset: vi.fn(async () => ({ id: 'example-dataset', images: [] })),
  importGalleryImages: vi.fn(), listDatasets: vi.fn(async () => []), patchDataset: vi.fn(),
  reconcileRenderingImages: vi.fn(), stripSharedCaptionFragments: vi.fn(), updateImageCaption: vi.fn(),
}));
vi.mock('../services/loraDatasetGenerate.js', () => ({
  generateDatasetImages: effects.generate, sliceReferenceSheet: effects.slice,
  getDatasetVariationAxes: vi.fn(async () => ({})),
}));
vi.mock('../services/loraDatasetCaption.js', () => ({
  startCaptionRun: effects.caption, attachCaptionSseClient: vi.fn(),
}));

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import mediaJobRoutes from './mediaJobs.js';
import loraDatasetRoutes from './loraDatasets.js';

const retryBody = { params: { prompt: 'Example caller instruction' } };
// [method, path, body, effect observed on success, success status]
const operations = [
  ['post', '/api/media-jobs/refine-prompt',
    { prompt: 'Example scene', kind: 'image', providerId: 'example-cli' }, effects.refine, 200],
  ['post', '/api/media-jobs/prompt-from-media',
    { sourceKind: 'upload', filename: 'example.png', targets: ['image'], providerId: 'example-vision-cli' }, effects.fromMedia, 200],
  ['post', '/api/media-jobs/example-job/retry', retryBody, effects.enqueue, 200],
  ['post', '/api/media-jobs/example-job/run-now', {}, effects.runNow, 200],
  ['post', '/api/lora-datasets/example-dataset/generate',
    { count: 1, poses: ['Example pose'], outfits: ['Example outfit'] }, effects.generate, 202],
  ['post', '/api/lora-datasets/example-dataset/slice-reference-sheet',
    { captionProviderId: 'example-vision-cli' }, effects.slice, 201],
  ['post', '/api/lora-datasets/example-dataset/caption',
    { providerId: 'example-vision-cli' }, effects.caption, 202],
];
const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use('/api/media-jobs', mediaJobRoutes);
  app.use('/api/lora-datasets', loraDatasetRoutes);
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

describe('auxiliary media agent dispatch authority (#9672)', () => {
  it('refuses remote, proxy-marked and legacy Basic callers before any effect', async () => {
    for (const operation of operations) {
      for (const [enabled, address, headers] of [
        [false, '192.0.2.10', {}],
        [false, '127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }],
        [true, '192.0.2.10', { Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') }],
      ]) {
        auth.enabled = enabled;
        for (const path of [operation[1], operation[1].toUpperCase() + '/']) {
          const response = await call(appFor(address), [operation[0], path, operation[2]], headers);
          expect([response.status, response.body.code], path).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
        }
      }
    }
    // Retry refusal neither enqueues the Grok job nor prunes the original row.
    expectNoEffects();
  });

  it('keeps anonymous callers on 401 when a password is enabled', async () => {
    auth.enabled = true;
    for (const operation of operations) {
      const response = await call(appFor(), operation);
      expect([response.status, response.body.code], operation[1]).toEqual([401, 'AUTH_REQUIRED']);
    }
    expectNoEffects();
  });

  it('retains local and operator-session workflows', async () => {
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Authorization: 'Bearer example-session' }],
    ]) {
      auth.enabled = enabled;
      for (const operation of operations) {
        const before = operation[3].mock.calls.length;
        const response = await call(appFor(address), operation, headers);
        expect(response.status, `${operation[1]}: ${JSON.stringify(response.body)}`).toBe(operation[4]);
        expect(operation[3]).toHaveBeenCalledTimes(before + 1);
      }
    }
    // Retry keeps the original agent backend while taking the new prompt.
    expect(effects.enqueue).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'image', params: expect.objectContaining({ mode: 'grok', prompt: 'Example caller instruction' }),
    }));
  });

  it('lets an authorized run-now still report queue shutdown', async () => {
    effects.runNow.mockReturnValueOnce({ ok: false, code: SHUTTING_DOWN, error: 'shutting down' });
    const local = await call(appFor('127.0.0.1'), operations[3]);
    expect([local.status, local.body.code]).toEqual([503, SHUTTING_DOWN]);
  });

  it('retains remote reads, cancellation and dataset reads', async () => {
    expect((await request(appFor()).get('/api/media-jobs')).status).toBe(200);
    expect((await call(appFor(), ['post', '/api/media-jobs/example-job/cancel', {}])).status).toBeLessThan(500);
    expect((await request(appFor()).get('/api/lora-datasets')).status).toBe(200);
    expectNoEffects();
  });
});
