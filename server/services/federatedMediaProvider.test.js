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
  laneWidthByKind: {},
}));

vi.mock('./settings.js', () => ({
  getSettings: vi.fn(async () => state.settings),
}));

vi.mock('../lib/mediaModels.js', () => ({
  getImageModels: vi.fn(() => state.imageModels),
  getVideoModels: vi.fn(() => state.videoModels),
  isEditOnly: (model) => model?.editOnly === true,
  isFlux2: (model) => model?.runner === 'flux2',
  repoForModel: (model) => model?.repo ?? null,
}));

vi.mock('../lib/hfCache.js', () => ({
  inspectModelCache: vi.fn(async (repo) => ({ cached: state.cachedRepos.has(repo) })),
  findCachedRepoFiles: vi.fn(async (repo, files) => (
    state.cachedRepos.has(repo) ? files.map((file) => `/cached/${file}`) : null
  )),
}));

vi.mock('./videoGen/runtimes.js', async () => {
  const actual = await vi.importActual('./videoGen/runtimes.js');
  return { ...actual, isByovRuntimeReady: vi.fn(async () => true) };
});

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
  // Widths deliberately differ per kind so a test can tell a minimum from a sum
  // or a max; the real queue routes every federated kind to the same lane, but
  // that is the thing under test, not a premise of it.
  laneConcurrencyFor: vi.fn((job) => state.laneWidthByKind[job?.kind] ?? 1),
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
import { enqueueJob, laneConcurrencyFor } from './mediaJobQueue/index.js';
import { PATHS, sha256Text } from '../lib/fileUtils.js';
import { canonicalStringify } from '../lib/objects.js';

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
  state.laneWidthByKind = { audio: 1, image: 1, video: 1 };
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

  // The bug this replaced: summing every local lane told an audio-only provider
  // it "runs 4 at a time" because the parallel cloud-CLI lane is wide, when its
  // music renders serialize one at a time. Widths differ per kind here so a sum
  // (12), a max (10), and the fail-closed minimum (1) are all distinguishable.
  it('reports the narrowest lane a negotiated kind lands on, never a sum or a max', async () => {
    state.laneWidthByKind = { audio: 1, image: 10, video: 1 };
    const status = await getFederatedMediaProviderStatus(config(), { kinds: ['audio', 'image', 'video'] });
    expect(status.queue.concurrency).toBe(1);
    // And it asks about the job shape the provider actually enqueues: adding a
    // cloud `mode` would route the probe to a lane no federated job uses.
    expect(laneConcurrencyFor).toHaveBeenCalledWith({ kind: 'image', params: {} });
  });

  it('reports the width of the one negotiated kind when only one was asked for', async () => {
    state.laneWidthByKind = { audio: 4, image: 1, video: 1 };
    const status = await getFederatedMediaProviderStatus(config());
    expect(status.queue.concurrency).toBe(4);
  });

  it('breaks the shared queue down by federated kind, excluding outgoing proxy jobs', async () => {
    state.jobs = [
      { id: 'a', kind: 'audio', status: 'running', owner: 'federated-media:peer-example' },
      { id: 'b', kind: 'audio', status: 'queued', owner: null },
      { id: 'c', kind: 'image', status: 'queued', owner: null },
      // Outgoing proxy work: rendered on a peer, so it occupies no lane here.
      { id: 'd', kind: 'audio', status: 'running', owner: null, params: { remoteMedia: {} } },
      // A kind this contract does not federate still holds a local lane, so it
      // counts toward totalActive while having no bucket of its own.
      { id: 'e', kind: 'training', status: 'running', owner: null },
    ];
    const status = await getFederatedMediaProviderStatus(config(), { kinds: ['audio', 'image', 'video'] });
    expect(status.queue.byKind).toEqual({
      audio: { running: 1, queued: 1 },
      image: { running: 0, queued: 1 },
    });
    // byKind is machine-wide while these are the federated share, counted in
    // the same pass — only job 'a' is owned by a federated caller. The training
    // job holds a lane but has no bucket, which is why byKind need not sum to
    // totalActive.
    expect(status.queue).toMatchObject({
      providerActive: 1, running: 1, queued: 0, totalActive: 4,
    });
  });

  // Reporting image/video occupancy to a consumer that negotiated audio only
  // would leave byKind as the one part of the payload the kind projection does
  // not govern.
  it('scopes the per-kind breakdown to the negotiated kinds', async () => {
    state.jobs = [
      { id: 'a', kind: 'image', status: 'running', owner: null },
      // Federated work of a kind this caller did not negotiate: invisible in
      // byKind, but still part of the federated share of the machine — so a
      // kind filter applied before the owner check would under-report it.
      { id: 'b', kind: 'image', status: 'running', owner: 'federated-media:peer-example' },
    ];
    const status = await getFederatedMediaProviderStatus(config());
    expect(status.queue.byKind).toEqual({});
    expect(status.queue).toMatchObject({ totalActive: 2, providerActive: 1, running: 1, queued: 0 });
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

  // ADR docs/decisions/2026-08-22-federated-media-input-assets.md rule 2: lyrics
  // cross to an allowlisted peer because no fixed vocabulary encodes them
  // without discarding them — but only into a model that sings.
  it('renders lyrics on a lyric-capable model and advertises that its wire accepts them', async () => {
    await submitFederatedMediaJob({
      callerId: 'peer-example', config: config(),
      input: { ...input(), lyrics: '[verse]\nwords' }, idempotencyKey: 'commission-lyrics',
    });
    expect(enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({ lyrics: '[verse]\nwords' }),
    }));

    const status = await getFederatedMediaProviderStatus(config());
    expect(status.capabilities[0]).toMatchObject({ lyrics: true, acceptsLyrics: true });
  });

  it('refuses lyrics for an instrumental-only model rather than dropping them', async () => {
    state.capabilities.engines = [readyEngine({ lyrics: false })];
    await expect(submitFederatedMediaJob({
      callerId: 'peer-example', config: config(),
      input: { ...input(), lyrics: '[verse]\nwords' }, idempotencyKey: 'commission-lyrics',
    })).rejects.toMatchObject({ status: 400, code: 'MEDIA_PROVIDER_LYRICS_UNSUPPORTED' });
    expect(enqueueJob).not.toHaveBeenCalled();

    const status = await getFederatedMediaProviderStatus(config());
    expect(status.capabilities[0]).toMatchObject({ lyrics: false, acceptsLyrics: false });
  });

  // An instrumental take on a lyrical engine sends `lyrics: ''`. Gating on
  // presence rather than content would refuse a submission carrying no
  // conditioning at all.
  it('admits an empty lyrics field on an instrumental-only model', async () => {
    state.capabilities.engines = [readyEngine({ lyrics: false })];
    await expect(submitFederatedMediaJob({
      callerId: 'peer-example', config: config(),
      input: { ...input(), lyrics: '' }, idempotencyKey: 'commission-instrumental',
    })).resolves.toMatchObject({ replayed: false });
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

  it('replays a kind-less audio job created before the explicit kind field existed', async () => {
    const legacyInput = { ...input() };
    delete legacyInput.kind;
    state.jobs = [{
      id: '00000000-0000-4000-8000-000000000099',
      kind: 'audio',
      owner: 'federated-media:peer-example',
      status: 'queued',
      queuedAt: '2026-08-16T00:00:00.000Z',
      params: {
        federatedMedia: {
          wireVersion: 1,
          callerInstanceId: 'peer-example',
          idempotencyKey: 'legacy-audio',
          requestHash: sha256Text(canonicalStringify(legacyInput)),
        },
      },
    }];

    const replay = await submitFederatedMediaJob({
      callerId: 'peer-example', config: config(), input: input(), idempotencyKey: 'legacy-audio',
    });
    expect(replay.replayed).toBe(true);
    expect(replay.job.id).toBe('00000000-0000-4000-8000-000000000099');
    expect(enqueueJob).not.toHaveBeenCalled();
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

  it('does not gate bundled image runtimes on the legacy mflux python path', async () => {
    state.settings = { federation: { mediaProvider: imageConfig() } };
    state.imageModels = [{
      id: 'flux-dev', name: 'FLUX.2', runner: 'flux2', repo: 'example/flux2',
    }];
    state.cachedRepos = new Set(['example/flux2']);
    const status = await getFederatedMediaProviderStatus(imageConfig(), { kinds: ['image'] });
    expect(status.capabilities[0]).toMatchObject({
      ready: true, runtimeReady: true, unavailableReason: null,
    });
  });

  it('does not gate BYOV video runtimes on the legacy mflux python path', async () => {
    const videoConfig = () => ({
      enabled: true, maxQueuedJobs: 2, audioModels: [], imageModels: [],
      videoModels: [{ engine: 'local', modelId: 'ltx2' }],
    });
    state.settings = { federation: { mediaProvider: videoConfig() } };
    state.cachedRepos = new Set(['example/ltx2']);
    state.videoModels = [{
      id: 'ltx2', name: 'LTX2', runtime: 'ltx2', repo: 'example/ltx2', supportedModes: ['text'],
    }];
    const status = await getFederatedMediaProviderStatus(videoConfig(), { kinds: ['video'] });
    expect(status.capabilities[0]).toMatchObject({
      ready: true, runtimeReady: true, unavailableReason: null,
    });
  });

  it('does not advertise image-edit or image-only video models for this text-only wire', async () => {
    const incompatibleImageConfig = () => ({
      enabled: true, maxQueuedJobs: 2, audioModels: [], videoModels: [],
      imageModels: [{ engine: 'local', modelId: 'edit-only' }],
    });
    state.settings = { federation: { mediaProvider: incompatibleImageConfig() }, imageGen: { local: { pythonPath: '/usr/bin/python3' } } };
    state.imageModels = [{
      id: 'edit-only', name: 'Edit only', repo: 'example/edit', editOnly: true,
    }];
    state.cachedRepos = new Set(['example/edit']);
    const imageStatus = await getFederatedMediaProviderStatus(incompatibleImageConfig(), { kinds: ['image'] });
    expect(imageStatus.capabilities[0]).toMatchObject({ ready: false, unavailableReason: 'unsupported-input' });

    const incompatibleVideoConfig = () => ({
      enabled: true, maxQueuedJobs: 2, audioModels: [], imageModels: [],
      videoModels: [{ engine: 'local', modelId: 'image-only' }],
    });
    state.videoModels = [{
      id: 'image-only', name: 'Image only', runtime: 'ltx2', repo: 'example/image-only', supportedModes: ['image'],
    }];
    state.cachedRepos = new Set(['example/image-only']);
    const videoStatus = await getFederatedMediaProviderStatus(incompatibleVideoConfig(), { kinds: ['video'] });
    expect(videoStatus.capabilities[0]).toMatchObject({ ready: false, unavailableReason: 'unsupported-input' });
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

// ADR docs/decisions/2026-08-20-federated-visual-prompts.md draws the privacy
// line at payload *class*, not at the prompt: a submitted job body may carry
// the prompt the peer is being asked to render, but a status/capability payload
// and the read-back job projection must never carry prompt or record content.
// A prompt is generated from project records, so a leak here would put universe
// canon and character names into a payload the ADR says is absolutely
// prompt-free. Both guarded paths (getFederatedMediaProviderStatus,
// describeFederatedMediaJob) are kind-agnostic allowlists, so every kind is
// exercised — a per-kind field added to either is exactly the regression.
describe('federated media provider — prompt-free status and projection payloads', () => {
  const IMAGE_PROMPT = 'a lighthouse at dawn over Example Bay';
  const VIDEO_PROMPT = 'a tram climbing a hill in Example City';

  const kinds = [
    {
      kind: 'audio',
      // Audio prompts are already restricted to a canonical profile string, so
      // the sentinel is a fragment of that rather than free text.
      sentinel: 'dreamy',
      resultDir: () => tempMusicPath,
      resultName: (id) => `music-gen-${id}.wav`,
      setup: () => {
        state.settings = { federation: { mediaProvider: config() } };
      },
      config: () => config(),
      input: () => input(),
    },
    {
      kind: 'image',
      sentinel: IMAGE_PROMPT,
      resultDir: () => tempImagesPath,
      resultName: (id) => `${id}.png`,
      setup: () => {
        state.imageModels = [{ id: 'flux-dev', name: 'FLUX.1 dev', repo: 'black-forest-labs/FLUX.1-dev' }];
        state.cachedRepos = new Set(['black-forest-labs/FLUX.1-dev']);
        state.settings = {
          federation: { mediaProvider: imagePrivacyConfig() },
          imageGen: { local: { pythonPath: '/usr/bin/python3' } },
        };
      },
      config: () => imagePrivacyConfig(),
      input: () => ({
        engine: 'local', modelId: 'flux-dev', kind: 'image',
        prompt: IMAGE_PROMPT, width: 1024, height: 1024,
      }),
    },
    {
      kind: 'video',
      sentinel: VIDEO_PROMPT,
      resultDir: () => tempVideosPath,
      resultName: (id) => `${id}.mp4`,
      setup: () => {
        state.videoModels = [{
          id: 'ltx2', name: 'LTX2', runtime: 'ltx2', repo: 'example/ltx2', supportedModes: ['text'],
        }];
        state.cachedRepos = new Set(['example/ltx2']);
        state.settings = { federation: { mediaProvider: videoPrivacyConfig() } };
      },
      config: () => videoPrivacyConfig(),
      input: () => ({ engine: 'local', modelId: 'ltx2', kind: 'video', prompt: VIDEO_PROMPT }),
    },
  ];

  const imagePrivacyConfig = () => ({
    enabled: true, maxQueuedJobs: 2, audioModels: [],
    imageModels: [{ engine: 'local', modelId: 'flux-dev' }], videoModels: [],
  });
  const videoPrivacyConfig = () => ({
    enabled: true, maxQueuedJobs: 2, audioModels: [], imageModels: [],
    videoModels: [{ engine: 'local', modelId: 'ltx2' }],
  });

  it.each(kinds)('keeps the $kind prompt out of the status payload and both job projections', async (scenario) => {
    scenario.setup();
    const created = await submitFederatedMediaJob({
      callerId: 'peer-example',
      config: scenario.config(),
      input: scenario.input(),
      idempotencyKey: `privacy-${scenario.kind}`,
    });
    const payload = (value) => JSON.stringify(value ?? null);

    // Bypass probe: these assertions only mean something if the sentinel is
    // findable at all. The queued job params legitimately carry it — that is
    // the local render input, not a wire payload.
    expect(payload(enqueueJob.mock.calls.at(-1)[0].params)).toContain(scenario.sentinel);

    // submitFederatedMediaJob returns describeFederatedMediaJob's projection,
    // so this is both the submit response and the queued poll response.
    expect(payload(created.job)).not.toContain(scenario.sentinel);

    const status = await getFederatedMediaProviderStatus(scenario.config(), { kinds: [scenario.kind] });
    expect(payload(status)).not.toContain(scenario.sentinel);
    // The underscore-prefixed internals publicCapability strips are not prompts,
    // but _pythonPath is an absolute local interpreter path — record content by
    // the same rule, and the one field this payload could realistically regress
    // into leaking if that map is ever dropped.
    expect(status.capabilities[0]).not.toHaveProperty('_pythonPath');
    expect(status.capabilities[0]).not.toHaveProperty('_model');

    // The completed projection is the third payload class: it gains a result
    // block built per kind from the rendered file, which must not reintroduce
    // the prompt.
    const job = state.jobs.find((candidate) => candidate.id === created.job.id);
    const filename = scenario.resultName(job.id);
    const resultPath = join(scenario.resultDir(), filename);
    // Job ids restart at 1 per test while the temp dirs live for the whole
    // file, so an earlier test's render can already sit at this path — drop it,
    // or this case would still pass with its own write removed.
    rmSync(resultPath, { force: true });
    writeFileSync(resultPath, Buffer.from('fake-media-bytes'));
    Object.assign(job, {
      status: 'completed',
      completedAt: '2026-08-16T00:02:00.000Z',
      result: { filename, engine: scenario.input().engine, modelId: scenario.input().modelId },
    });
    const completed = await describeFederatedMediaJob('peer-example', job.id);
    expect(completed.result).toMatchObject({ available: true });
    expect(payload(completed)).not.toContain(scenario.sentinel);
  });

  it('populates frameStride, maxNumFrames, and resolutionOptions for visual models and null for audio', async () => {
    state.videoModels = [{
      id: 'wan22_t2v_a14b',
      name: 'Wan 2.2 T2V A14B',
      runtime: 'wan22',
      repo: 'example/wan22',
      supportedModes: ['text'],
      frameStride: 4,
      frameOptions: [25, 49, 73, 97, 121],
      resolutionOptions: [{ label: '1344x768 (16:9)', w: 1344, h: 768 }],
    }];
    state.cachedRepos = new Set(['example/wan22']);
    const providerConfig = {
      enabled: true,
      maxQueuedJobs: 2,
      audioModels: [selection],
      imageModels: [],
      videoModels: [{ engine: 'local', modelId: 'wan22_t2v_a14b' }],
    };
    state.settings = { federation: { mediaProvider: providerConfig } };

    const status = await getFederatedMediaProviderStatus(providerConfig, { kinds: ['audio', 'video'] });
    const audioCap = status.capabilities.find((c) => c.kind === 'audio');
    const videoCap = status.capabilities.find((c) => c.kind === 'video');

    expect(audioCap).toMatchObject({
      frameStride: null,
      maxNumFrames: null,
      frameOptions: null,
      fpsOptions: null,
      resolutionOptions: null,
    });
    expect(videoCap).toMatchObject({
      frameStride: 4,
      maxNumFrames: 121,
      frameOptions: [25, 49, 73, 97, 121],
      resolutionOptions: [{ label: '1344x768 (16:9)', w: 1344, h: 768 }],
    });
  });

  it('sanitizes out-of-range, non-integer, and oversized constraint arrays provider-side', async () => {
    state.videoModels = [{
      id: 'custom_model',
      name: 'Custom Model',
      runtime: 'wan22',
      repo: 'example/wan22',
      supportedModes: ['text'],
      frameStride: -4,
      maxNumFrames: 'not-a-number',
      frameOptions: [25, 33.5, -10, 'invalid', 49],
      resolutionOptions: [
        { label: 'valid', w: 1344, h: 768 },
        { label: '4k-too-large', w: 3840, h: 2160 },
        { label: 'too-small', w: 32, h: 32 },
        { label: 'invalid-w', w: 'NaN', h: 768 },
      ],
    }];
    state.cachedRepos = new Set(['example/wan22']);
    const providerConfig = {
      enabled: true,
      maxQueuedJobs: 2,
      audioModels: [],
      imageModels: [],
      videoModels: [{ engine: 'local', modelId: 'custom_model' }],
    };
    state.settings = { federation: { mediaProvider: providerConfig } };

    const status = await getFederatedMediaProviderStatus(providerConfig, { kinds: ['video'] });
    const cap = status.capabilities[0];

    expect(cap.frameStride).toBeNull();
    expect(cap.maxNumFrames).toBe(49);
    expect(cap.frameOptions).toEqual([25, 49]);
    expect(cap.resolutionOptions).toEqual([{ label: 'valid', w: 1344, h: 768 }]);
  });
});
