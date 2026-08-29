import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { PATHS } from '../lib/fileUtils.js';

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
let originalInbox;

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'portos-federated-media-route-'));
  provider.resultPath = join(tempRoot, 'result.wav');
  writeFileSync(provider.resultPath, 'RIFF');
  // The asset routes use the REAL store (only the provider service is mocked),
  // so give it a temp inbox rather than the install's data dir.
  originalInbox = PATHS.federatedMediaInbox;
  PATHS.federatedMediaInbox = join(tempRoot, 'inbox');
});

afterAll(() => {
  PATHS.federatedMediaInbox = originalInbox;
  rmSync(tempRoot, { recursive: true, force: true });
});

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

  it('rejects a free-form style prompt at the provider boundary', async () => {
    const freeform = await request(buildApp()).post('/api/federation/media/v1/jobs')
      .set('Idempotency-Key', 'commission-private').send({
        engine: 'minimax-music3', modelId: 'minimax-music3', prompt: 'Write about alice@example.com',
      });

    expect(freeform.status).toBe(400);
    expect(provider.submit).not.toHaveBeenCalled();
  });

  // The style prompt and the lyrics are governed by opposite halves of the same
  // rule (ADR docs/decisions/2026-08-22-federated-media-input-assets.md rule 2):
  // a fixed profile renders the prompt at no expressive cost, so it is required
  // there; lyrics ARE the words, so no alphabet encodes them without discarding
  // them. Whether the model may sing is the PROVIDER's call at admission, not
  // this schema's — so the route must hand them through untouched.
  it('passes lyrics through to the provider for its own capability check', async () => {
    const response = await request(buildApp()).post('/api/federation/media/v1/jobs')
      .set('Idempotency-Key', 'commission-lyrics').send({
        engine: 'minimax-music3', modelId: 'minimax-music3', prompt: safePrompt, lyrics: '[verse]\nPrivate words',
      });

    expect(response.status).toBe(202);
    expect(provider.submit).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ kind: 'audio', lyrics: '[verse]\nPrivate words' }),
    }));
  });

  // Conditioning-image upload (ADR
  // docs/decisions/2026-08-22-federated-media-input-assets.md rule 1). The store
  // itself is covered by services/federatedMedia/assetStore.test.js; what these
  // guard is the ROUTE's own contract — that raw bytes reach the store at all
  // (the app-wide express.json() must not swallow them), and that the peer
  // authorization gate fires before any byte is written.
  describe('conditioning-image upload', () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('portos-test-conditioning-image'),
    ]);
    const digest = createHash('sha256').update(png).digest('hex');

    it('stages verified bytes and returns a content-addressed receipt', async () => {
      const response = await request(buildApp()).post('/api/federation/media/v1/assets')
        .set('Content-Type', 'image/png')
        .set('X-Content-SHA256', digest)
        .send(png);

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        wireVersion: 1, sha256: digest, sizeBytes: png.length, mimeType: 'image/png',
      });
      expect(response.body.assetId.endsWith(`-${digest}`)).toBe(true);

      // The same peer can then read it back and skip a re-upload after a restart.
      const described = await request(buildApp())
        .get(`/api/federation/media/v1/assets/${response.body.assetId}`);
      expect(described.status).toBe(200);
      expect(described.body.sha256).toBe(digest);
    });

    it('refuses an unauthorized peer before writing anything', async () => {
      provider.authorize.mockRejectedValueOnce(Object.assign(
        new Error('Verified peer Basic authentication is required'),
        { status: 403, code: 'MEDIA_PROVIDER_PEER_AUTH_REQUIRED' },
      ));
      const response = await request(buildApp()).post('/api/federation/media/v1/assets')
        .set('Content-Type', 'image/png')
        .set('X-Content-SHA256', digest)
        .send(png);
      expect(response.status).toBe(403);
    });

    it('refuses a malformed asset id rather than letting it reach the filesystem', async () => {
      const response = await request(buildApp())
        .get('/api/federation/media/v1/assets/..%2F..%2Fetc%2Fpasswd');
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });
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
    expect(provider.authorize).toHaveBeenCalledWith(expect.anything(), { statusProbe: true });
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
