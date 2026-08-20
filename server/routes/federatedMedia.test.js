import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const provider = vi.hoisted(() => ({
  replayed: false,
  resultPath: '',
  authorize: vi.fn(async () => ({
    callerId: 'peer-example',
    config: { enabled: true, maxQueuedJobs: 2, audioModels: [] },
  })),
  status: vi.fn(async () => ({ wireVersion: 1, status: 'ready' })),
  submit: vi.fn(async () => ({
    replayed: provider.replayed,
    job: { wireVersion: 1, id: '00000000-0000-4000-8000-000000000001', status: 'queued' },
  })),
  describe: vi.fn(async (_caller, id) => ({ wireVersion: 1, id, status: 'queued' })),
  cancel: vi.fn(async (_caller, id) => ({ wireVersion: 1, id, status: 'canceled' })),
  result: vi.fn(async () => ({
    path: provider.resultPath,
    metadata: { mimeType: 'audio/wav', sizeBytes: 4, sha256: 'a'.repeat(64) },
  })),
}));

vi.mock('../services/federatedMediaProvider.js', () => ({
  authorizeFederatedMediaPeer: (...args) => provider.authorize(...args),
  getFederatedMediaProviderStatus: (...args) => provider.status(...args),
  submitFederatedMediaJob: (...args) => provider.submit(...args),
  describeFederatedMediaJob: (...args) => provider.describe(...args),
  cancelFederatedMediaJob: (...args) => provider.cancel(...args),
  getFederatedMediaResult: (...args) => provider.result(...args),
}));

import federatedMediaRoutes from './federatedMedia.js';

let tempRoot;

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'portos-federated-media-route-'));
  provider.resultPath = join(tempRoot, 'result.wav');
  writeFileSync(provider.resultPath, 'RIFF');
});

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

beforeEach(() => {
  vi.clearAllMocks();
  provider.replayed = false;
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/federation/media/v1', federatedMediaRoutes);
  app.use(errorMiddleware);
  return app;
}

const jobId = '00000000-0000-4000-8000-000000000001';
const safePrompt = 'Instrumental synthwave music with a dreamy mood, moderate tempo, medium energy. No vocals or spoken words.';

describe('federated media routes', () => {
  it('requires an Idempotency-Key before submitting work', async () => {
    const response = await request(buildApp()).post('/api/federation/media/v1/jobs').send({
      engine: 'minimax-music3', modelId: 'minimax-music3', prompt: safePrompt,
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(provider.submit).not.toHaveBeenCalled();
  });

  it('returns 202 for a new job and 200 for an idempotent replay', async () => {
    const body = { engine: 'minimax-music3', modelId: 'minimax-music3', prompt: safePrompt };
    const created = await request(buildApp()).post('/api/federation/media/v1/jobs')
      .set('Idempotency-Key', 'commission-1').send(body);
    expect(created.status).toBe(202);
    expect(provider.submit).toHaveBeenCalledWith(expect.objectContaining({
      callerId: 'peer-example', idempotencyKey: 'commission-1', input: { ...body, kind: 'audio' },
    }));

    provider.replayed = true;
    const replay = await request(buildApp()).post('/api/federation/media/v1/jobs')
      .set('Idempotency-Key', 'commission-1').send(body);
    expect(replay.status).toBe(200);
  });

  it('rejects unknown request fields so paths and URLs cannot become an implicit proxy', async () => {
    const response = await request(buildApp()).post('/api/federation/media/v1/jobs')
      .set('Idempotency-Key', 'commission-1').send({
        engine: 'minimax-music3', modelId: 'minimax-music3', prompt: safePrompt,
        sourcePath: '/tmp/private.wav',
      });
    expect(response.status).toBe(400);
    expect(provider.submit).not.toHaveBeenCalled();
  });

  it('rejects free-form prompts and lyrics at the provider boundary', async () => {
    const freeform = await request(buildApp()).post('/api/federation/media/v1/jobs')
      .set('Idempotency-Key', 'commission-private').send({
        engine: 'minimax-music3', modelId: 'minimax-music3', prompt: 'Write about alice@example.com',
      });
    const lyrics = await request(buildApp()).post('/api/federation/media/v1/jobs')
      .set('Idempotency-Key', 'commission-private-lyrics').send({
        engine: 'minimax-music3', modelId: 'minimax-music3', prompt: safePrompt, lyrics: 'Private words',
      });

    expect(freeform.status).toBe(400);
    expect(lyrics.status).toBe(400);
    expect(provider.submit).not.toHaveBeenCalled();
  });

  it('serves completed bytes with an integrity header and no source path', async () => {
    const response = await request(buildApp()).get(`/api/federation/media/v1/jobs/${jobId}/result`);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('audio/wav');
    expect(response.headers['x-content-sha256']).toBe('a'.repeat(64));
    expect(response.headers['content-disposition']).toContain(`${jobId}.wav`);
  });

  it('serves an image result under its own filename extension', async () => {
    provider.result.mockResolvedValueOnce({
      path: provider.resultPath,
      metadata: { mimeType: 'image/png', sizeBytes: 4, sha256: 'b'.repeat(64) },
    });
    const response = await request(buildApp()).get(`/api/federation/media/v1/jobs/${jobId}/result`);
    expect(response.headers['content-type']).toContain('image/png');
    expect(response.headers['content-disposition']).toContain(`${jobId}.png`);
  });

  it('defaults GET /status to the audio-only kinds an unopted-in caller understands', async () => {
    await request(buildApp()).get('/api/federation/media/v1/status');
    expect(provider.status).toHaveBeenCalledWith(expect.anything(), { kinds: ['audio'] });
  });

  it('parses an explicit ?kinds= request into the known-kind subset', async () => {
    await request(buildApp()).get('/api/federation/media/v1/status?kinds=audio,image,holo');
    expect(provider.status).toHaveBeenCalledWith(expect.anything(), { kinds: ['audio', 'image'] });
  });

  it('defaults a kind-less submission to audio so an older consumer body keeps working', async () => {
    const body = { engine: 'minimax-music3', modelId: 'minimax-music3', prompt: safePrompt };
    await request(buildApp()).post('/api/federation/media/v1/jobs')
      .set('Idempotency-Key', 'commission-legacy').send(body);
    expect(provider.submit).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ kind: 'audio' }),
    }));
  });

  it('accepts an explicit image job submission', async () => {
    const body = { kind: 'image', engine: 'local', modelId: 'flux-dev', prompt: 'a lighthouse at dawn' };
    const response = await request(buildApp()).post('/api/federation/media/v1/jobs')
      .set('Idempotency-Key', 'commission-image').send(body);
    expect(response.status).toBe(202);
    expect(provider.submit).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ kind: 'image', prompt: 'a lighthouse at dawn' }),
    }));
  });

  it('rejects an image submission carrying audio-only fields', async () => {
    const response = await request(buildApp()).post('/api/federation/media/v1/jobs')
      .set('Idempotency-Key', 'commission-image-bad').send({
        kind: 'image', engine: 'local', modelId: 'flux-dev', prompt: 'a lighthouse at dawn', lyrics: 'nope',
      });
    expect(response.status).toBe(400);
    expect(provider.submit).not.toHaveBeenCalled();
  });

  it('rejects an image submission over the shared pixel ceiling', async () => {
    const response = await request(buildApp()).post('/api/federation/media/v1/jobs')
      .set('Idempotency-Key', 'commission-image-too-large').send({
        kind: 'image', engine: 'local', modelId: 'flux-dev', prompt: 'a lighthouse at dawn',
        width: 4096, height: 4096,
      });
    expect(response.status).toBe(400);
    expect(provider.submit).not.toHaveBeenCalled();
  });
});
