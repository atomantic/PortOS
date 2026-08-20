import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const state = vi.hoisted(() => ({
  settings: {},
  peer: null,
  jobs: [],
  nextId: 1,
  capabilities: { engines: [], defaultEngine: 'musicgen' },
  cancelResult: { ok: true, status: 'canceled' },
  imageModels: [],
  videoModels: [],
  cachedRepos: new Set(),
}));

vi.mock('./settings.js', () => ({
  getSettings: vi.fn(async () => state.settings),
}));

vi.mock('../lib/mediaModels.js', () => ({
  getImageModels: vi.fn(() => state.imageModels),
  getVideoModels: vi.fn(() => state.videoModels),
  repoForModel: (model) => model?.repo ?? null,
}));

vi.mock('../lib/hfCache.js', () => ({
  inspectModelCache: vi.fn(async (repo) => ({ cached: state.cachedRepos.has(repo) })),
}));

vi.mock('./sharing/peerPullAuthorization.js', () => ({
  readCallerInstanceId: (req) => req.headers?.['x-portos-instance-id'] || null,
}));

vi.mock('./sharing/peerSyncShared.js', () => ({
  findPeerById: vi.fn(async (id) => state.peer?.instanceId === id ? state.peer : null),
}));

vi.mock('./musicEngineCapabilities.js', () => ({
  listMusicEngineCapabilities: vi.fn(async () => state.capabilities),
}));

vi.mock('./mediaJobQueue/index.js', () => ({
  listJobs: vi.fn(() => state.jobs),
  isRemoteMediaJob: (job) => job?.kind === 'audio' && job.params?.remoteMedia !== undefined,
  getJob: vi.fn((id) => state.jobs.find((job) => job.id === id) || null),
  enqueueJob: vi.fn(({ kind, owner, params }) => {
    const suffix = String(state.nextId++).padStart(12, '0');
    const id = `00000000-0000-4000-8000-${suffix}`;
    const job = {
      id, kind, owner, params, status: 'queued', position: state.jobs.length + 1,
      queuedAt: '2026-08-16T00:00:00.000Z',
    };
    state.jobs.push(job);
    return { jobId: id, position: job.position, status: job.status };
  }),
  cancelJob: vi.fn(async (id) => {
    const job = state.jobs.find((candidate) => candidate.id === id);
    if (state.cancelResult.ok && job) {
      job.status = 'canceled';
      job.completedAt = '2026-08-16T00:01:00.000Z';
    }
    return state.cancelResult;
  }),
}));

import {
  authorizeFederatedMediaPeer,
  describeFederatedMediaJob,
  getFederatedMediaProviderStatus,
  normalizeFederatedMediaProviderConfig,
  submitFederatedMediaJob,
  __resetFederatedMediaProviderForTests,
} from './federatedMediaProvider.js';
import { enqueueJob } from './mediaJobQueue/index.js';
import { PATHS, sha256Text } from '../lib/fileUtils.js';

const originalMusicPath = PATHS.music;
const originalImagesPath = PATHS.images;
const originalVideosPath = PATHS.videos;
let tempMusicPath;
let tempImagesPath;
let tempVideosPath;

beforeAll(() => {
  tempMusicPath = mkdtempSync(join(tmpdir(), 'portos-federated-media-service-'));
  tempImagesPath = mkdtempSync(join(tmpdir(), 'portos-federated-media-images-'));
  tempVideosPath = mkdtempSync(join(tmpdir(), 'portos-federated-media-videos-'));
  PATHS.music = tempMusicPath;
  PATHS.images = tempImagesPath;
  PATHS.videos = tempVideosPath;
});

afterAll(() => {
  PATHS.music = originalMusicPath;
  PATHS.images = originalImagesPath;
  PATHS.videos = originalVideosPath;
  rmSync(tempMusicPath, { recursive: true, force: true });
  rmSync(tempImagesPath, { recursive: true, force: true });
  rmSync(tempVideosPath, { recursive: true, force: true });
});

const selection = { engine: 'minimax-music3', modelId: 'minimax-music3' };
const config = () => ({
  enabled: true, maxQueuedJobs: 2, audioModels: [selection], imageModels: [], videoModels: [],
});
const SAFE_PROMPT = 'Instrumental synthwave music with a dreamy mood, slow tempo, medium energy. No vocals or spoken words.';
const OTHER_SAFE_PROMPT = 'Instrumental ambient music with a calm mood, slow tempo, low energy. No vocals or spoken words.';
const input = () => ({ ...selection, kind: 'audio', prompt: SAFE_PROMPT, durationSec: 60, durationMode: 'manual' });

function readyEngine(overrides = {}) {
  return {
    id: 'minimax-music3',
    name: 'MiniMax Music 3',
    models: [{ id: 'minimax-music3', name: 'MiniMax Music 3', userAdded: false }],
    fixedModelInstall: true,
    modelReadyById: { 'minimax-music3': true },
    runtimeReady: true,
    platformSupported: true,
    cudaRequired: true,
    cudaState: 'available',
    minDurationSec: 1,
    maxDurationSec: 300,
    defaultDurationSec: 60,
    lyrics: true,
    autoDuration: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.settings = { federation: { mediaProvider: config() } };
  state.peer = { instanceId: 'peer-example', enabled: true };
  state.jobs = [];
  state.nextId = 1;
  state.capabilities = { engines: [readyEngine()], defaultEngine: 'musicgen' };
  state.cancelResult = { ok: true, status: 'canceled' };
  state.imageModels = [];
  state.videoModels = [];
  state.cachedRepos = new Set();
  __resetFederatedMediaProviderForTests();
});

describe('federated media provider authorization', () => {
  it('defaults absent settings to disabled with conservative limits', () => {
    expect(normalizeFederatedMediaProviderConfig({})).toEqual({
      enabled: false, maxQueuedJobs: 2, audioModels: [], imageModels: [], videoModels: [],
    });
  });

  it('requires verified Basic auth and an enabled registered peer', async () => {
    const baseReq = { headers: { 'x-portos-instance-id': 'peer-example' } };
    await expect(authorizeFederatedMediaPeer(baseReq)).rejects.toMatchObject({
      status: 403, code: 'MEDIA_PROVIDER_PEER_AUTH_REQUIRED',
    });
    await expect(authorizeFederatedMediaPeer({
      ...baseReq,
      portosAuthContext: { enabled: true, authenticated: true, method: 'session' },
    })).rejects.toMatchObject({
      status: 403, code: 'MEDIA_PROVIDER_PEER_AUTH_REQUIRED',
    });

    const req = {
      ...baseReq,
      portosAuthContext: { enabled: true, authenticated: true, method: 'basic' },
    };
    await expect(authorizeFederatedMediaPeer(req)).resolves.toEqual({
      callerId: 'peer-example', config: config(),
    });

    state.peer.enabled = false;
    await expect(authorizeFederatedMediaPeer(req)).rejects.toMatchObject({
      status: 403, code: 'MEDIA_PROVIDER_PEER_FORBIDDEN',
    });
  });
});

describe('federated media provider capacity and idempotency', () => {
  it('reports CUDA unknown as unavailable instead of optimistic capacity', async () => {
    state.capabilities.engines = [readyEngine({ cudaState: 'unknown' })];
    const status = await getFederatedMediaProviderStatus(config());
    expect(status).toMatchObject({ status: 'unavailable', wireVersion: 1, kinds: ['audio'] });
    expect(status.capabilities[0]).toMatchObject({
      ready: false, cudaState: 'unknown', unavailableReason: 'cuda-unknown',
    });
    expect(status.capabilities[0]).not.toHaveProperty('_engine');
  });

  it('reports an unmeasured CUDA VRAM profile as unavailable instead of optimistic capacity', async () => {
    state.capabilities.engines = [readyEngine({ vramState: 'unknown-size' })];
    const status = await getFederatedMediaProviderStatus(config());
    expect(status).toMatchObject({ status: 'unavailable' });
    expect(status.capabilities[0]).toMatchObject({
      ready: false, unavailableReason: 'vram-unknown-size',
    });
  });

  it('queues allowlisted audio without exposing the prompt in its response', async () => {
    const result = await submitFederatedMediaJob({
      callerId: 'peer-example', config: config(), input: input(), idempotencyKey: 'commission-1',
    });
    expect(result).toMatchObject({ replayed: false, job: { status: 'queued', kind: 'audio', wireVersion: 1 } });
    expect(result.job).not.toHaveProperty('params');
    expect(enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'audio', owner: 'federated-media:peer-example',
      params: expect.objectContaining({
        prompt: SAFE_PROMPT, engine: 'minimax-music3', modelId: 'minimax-music3',
        durationMode: 'manual',
        federatedMedia: expect.objectContaining({
          callerInstanceId: 'peer-example', idempotencyKey: 'commission-1',
        }),
      }),
    }));
  });

  it('replays a matching key and rejects a key reused with different input', async () => {
    const first = await submitFederatedMediaJob({
      callerId: 'peer-example', config: config(), input: input(), idempotencyKey: 'commission-1',
    });
    const replay = await submitFederatedMediaJob({
      callerId: 'peer-example', config: config(), input: input(), idempotencyKey: 'commission-1',
    });
    expect(replay.replayed).toBe(true);
    expect(replay.job.id).toBe(first.job.id);
    expect(enqueueJob).toHaveBeenCalledTimes(1);

    await expect(submitFederatedMediaJob({
      callerId: 'peer-example', config: config(),
      input: { ...input(), prompt: OTHER_SAFE_PROMPT }, idempotencyKey: 'commission-1',
    })).rejects.toMatchObject({ status: 409, code: 'MEDIA_PROVIDER_IDEMPOTENCY_CONFLICT' });
  });

  it('counts all active local media work against the conservative provider cap', async () => {
    state.jobs = [
      { id: 'local-1', owner: null, status: 'running' },
      { id: 'local-2', owner: null, status: 'queued' },
    ];
    await expect(submitFederatedMediaJob({
      callerId: 'peer-example', config: config(), input: input(), idempotencyKey: 'commission-2',
    })).rejects.toMatchObject({ status: 429, code: 'MEDIA_PROVIDER_BUSY' });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('does not count outgoing proxy jobs against this machine provider capacity', async () => {
    state.jobs = [
      {
        id: 'remote-outgoing',
        kind: 'audio',
        owner: null,
        status: 'running',
        params: { remoteMedia: { wireVersion: 1, peerId: '00000000-0000-4000-8000-000000000001' } },
      },
      { id: 'local-1', kind: 'video', owner: null, status: 'running', params: {} },
    ];

    await expect(submitFederatedMediaJob({
      callerId: 'peer-example', config: config(), input: input(), idempotencyKey: 'commission-remote-capacity',
    })).resolves.toMatchObject({ replayed: false, job: { status: 'queued' } });
  });

  it('fails closed when CUDA readiness is unknown', async () => {
    state.capabilities.engines = [readyEngine({ cudaState: 'unknown' })];
    await expect(submitFederatedMediaJob({
      callerId: 'peer-example', config: config(), input: input(), idempotencyKey: 'commission-3',
    })).rejects.toMatchObject({
      status: 503,
      code: 'MEDIA_PROVIDER_MODEL_UNAVAILABLE',
      context: { reason: 'cuda-unknown' },
    });
  });

  it('hides jobs owned by another caller', async () => {
    const created = await submitFederatedMediaJob({
      callerId: 'peer-example', config: config(), input: input(), idempotencyKey: 'commission-4',
    });
    await expect(describeFederatedMediaJob('other-peer', created.job.id)).rejects.toMatchObject({
      status: 404, code: 'MEDIA_PROVIDER_JOB_NOT_FOUND',
    });
  });

  it('describes only generator-shaped result files with verified byte integrity', async () => {
    const created = await submitFederatedMediaJob({
      callerId: 'peer-example', config: config(), input: input(), idempotencyKey: 'commission-5',
    });
    const job = state.jobs.find((candidate) => candidate.id === created.job.id);
    const filename = 'music-gen-11111111-1111-4111-8111-111111111111.wav';
    const bytes = Buffer.from('RIFF-fake-audio');
    writeFileSync(join(tempMusicPath, filename), bytes);
    Object.assign(job, {
      status: 'completed',
      completedAt: '2026-08-16T00:02:00.000Z',
      result: { filename, durationSec: 60, engine: selection.engine, modelId: selection.modelId },
    });

    const described = await describeFederatedMediaJob('peer-example', job.id);
    expect(described.result).toEqual({
      available: true,
      mimeType: 'audio/wav',
      sizeBytes: bytes.length,
      sha256: sha256Text(bytes),
      downloadUrl: `/api/federation/media/v1/jobs/${job.id}/result`,
      engine: selection.engine,
      modelId: selection.modelId,
      durationSec: 60,
    });
    expect(described.result).not.toHaveProperty('path');
    expect(described.result).not.toHaveProperty('filename');

    job.result.filename = `../${filename}`;
    await expect(describeFederatedMediaJob('peer-example', job.id)).rejects.toMatchObject({
      status: 410, code: 'MEDIA_PROVIDER_RESULT_UNAVAILABLE',
    });
  });
});

describe('federated media provider — image/video kinds', () => {
  const imageSelection = { engine: 'local', modelId: 'flux-dev' };
  const imageConfig = () => ({
    enabled: true, maxQueuedJobs: 2, audioModels: [], imageModels: [imageSelection], videoModels: [],
  });
  const imageInput = () => ({
    ...imageSelection, kind: 'image', prompt: 'a lighthouse at dawn', width: 1024, height: 1024,
  });

  beforeEach(() => {
    state.imageModels = [{ id: 'flux-dev', name: 'FLUX.1 dev', repo: 'black-forest-labs/FLUX.1-dev' }];
    state.videoModels = [{ id: 'ltx2', name: 'LTX2', repo: 'example/ltx2' }];
  });

  it('reports an image capability unavailable when no local runtime is configured', async () => {
    state.settings = { federation: { mediaProvider: imageConfig() } };
    const status = await getFederatedMediaProviderStatus(imageConfig(), { kinds: ['image'] });
    expect(status.kinds).toEqual(['image']);
    expect(status.capabilities).toEqual([expect.objectContaining({
      kind: 'image', engine: 'local', modelId: 'flux-dev',
      ready: false, unavailableReason: 'runtime-unavailable',
    })]);
    expect(status.status).toBe('unavailable');
  });

  it('reports an image capability ready once the runtime and model weights are present', async () => {
    state.settings = {
      federation: { mediaProvider: imageConfig() },
      imageGen: { local: { pythonPath: '/usr/bin/python3' } },
    };
    state.cachedRepos = new Set(['black-forest-labs/FLUX.1-dev']);
    const status = await getFederatedMediaProviderStatus(imageConfig(), { kinds: ['image'] });
    expect(status.capabilities[0]).toMatchObject({ ready: true, unavailableReason: null });
    expect(status.status).toBe('ready');
  });

  it('does not report image/video capabilities unless the caller opts into that kind', async () => {
    state.settings = {
      federation: { mediaProvider: imageConfig() },
      imageGen: { local: { pythonPath: '/usr/bin/python3' } },
    };
    state.cachedRepos = new Set(['black-forest-labs/FLUX.1-dev']);
    const status = await getFederatedMediaProviderStatus(imageConfig());
    expect(status.kinds).toEqual(['audio']);
    expect(status.capabilities).toEqual([]);
  });

  it('rejects a configured non-local engine as unknown rather than admitting it', async () => {
    const nonLocalConfig = () => ({
      enabled: true, maxQueuedJobs: 2, audioModels: [], videoModels: [],
      imageModels: [{ engine: 'sdapi', modelId: 'flux-dev' }],
    });
    state.settings = { federation: { mediaProvider: nonLocalConfig() } };
    await expect(submitFederatedMediaJob({
      callerId: 'peer-example',
      config: nonLocalConfig(),
      input: { kind: 'image', engine: 'sdapi', modelId: 'flux-dev', prompt: 'a lighthouse at dawn' },
      idempotencyKey: 'commission-image-1',
    })).rejects.toMatchObject({ status: 503, code: 'MEDIA_PROVIDER_MODEL_UNAVAILABLE', context: { reason: 'unknown-engine' } });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('queues an allowlisted local image job with the local runner param shape', async () => {
    state.settings = {
      federation: { mediaProvider: imageConfig() },
      imageGen: { local: { pythonPath: '/usr/bin/python3' } },
    };
    state.cachedRepos = new Set(['black-forest-labs/FLUX.1-dev']);
    const result = await submitFederatedMediaJob({
      callerId: 'peer-example', config: imageConfig(), input: imageInput(), idempotencyKey: 'commission-image-2',
    });
    expect(result).toMatchObject({ replayed: false, job: { status: 'queued', kind: 'image' } });
    expect(enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'image',
      owner: 'federated-media:peer-example',
      params: expect.objectContaining({
        pythonPath: '/usr/bin/python3',
        prompt: 'a lighthouse at dawn',
        modelId: 'flux-dev',
        width: 1024,
        height: 1024,
      }),
    }));
    // Audio-only fields never leak into the image job's queue params.
    const [call] = enqueueJob.mock.calls;
    expect(call[0].params).not.toHaveProperty('lyrics');
    expect(call[0].params).not.toHaveProperty('durationSec');
  });

  it('describes a completed image result with an image/png projection', async () => {
    state.settings = {
      federation: { mediaProvider: imageConfig() },
      imageGen: { local: { pythonPath: '/usr/bin/python3' } },
    };
    state.cachedRepos = new Set(['black-forest-labs/FLUX.1-dev']);
    const created = await submitFederatedMediaJob({
      callerId: 'peer-example', config: imageConfig(), input: imageInput(), idempotencyKey: 'commission-image-3',
    });
    const job = state.jobs.find((candidate) => candidate.id === created.job.id);
    const filename = `${job.id}.png`;
    const bytes = Buffer.from('fake-png-bytes');
    writeFileSync(join(tempImagesPath, filename), bytes);
    Object.assign(job, {
      status: 'completed', completedAt: '2026-08-16T00:02:00.000Z',
      result: { filename, engine: 'local', modelId: 'flux-dev' },
    });

    const described = await describeFederatedMediaJob('peer-example', job.id);
    expect(described.kind).toBe('image');
    expect(described.result).toMatchObject({ available: true, mimeType: 'image/png', sizeBytes: bytes.length });
  });
});
