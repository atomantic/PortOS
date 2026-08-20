import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/peerHttpClient.js', () => ({
  peerFetch: vi.fn(),
}));

import { peerFetch } from '../lib/peerHttpClient.js';
import {
  assertFederatedMediaProviderSelection,
  mergePeerMediaProviderConfig,
  normalizePeerMediaProviderConfig,
  probeFederatedMediaProvider,
  resolveFederatedMediaProvider,
} from './federatedMediaConsumer.js';

const NOW = Date.parse('2026-08-17T12:00:00.000Z');
const selection = { kind: 'audio', engine: 'minimax-music3', modelId: 'minimax-music3' };

const peer = (overrides = {}) => ({
  id: 'peer-example',
  address: '192.0.2.10',
  port: 5555,
  enabled: true,
  mediaProvider: {
    enabled: true,
    audioModels: [{ engine: selection.engine, modelId: selection.modelId }],
  },
  ...overrides,
});

function readyStatus(overrides = {}) {
  return {
    wireVersion: 1,
    generatedAt: new Date(NOW).toISOString(),
    staleAfterMs: 60_000,
    status: 'ready',
    kinds: ['audio'],
    queue: {
      totalActive: 0,
      providerActive: 0,
      queued: 0,
      running: 0,
      maxQueuedJobs: 2,
      accepting: true,
    },
    capabilities: [{
      kind: 'audio',
      engine: selection.engine,
      engineName: 'MiniMax Music 3',
      modelId: selection.modelId,
      modelName: 'MiniMax Music 3',
      ready: true,
      unavailableReason: null,
      runtimeReady: true,
      platformSupported: true,
      cudaRequired: true,
      cudaState: 'available',
      minDurationSec: 10,
      maxDurationSec: 300,
      defaultDurationSec: 60,
      lyrics: true,
      autoDuration: false,
      privateFutureField: 'must-not-cross',
    }],
    privateFutureField: 'must-not-cross',
    ...overrides,
  };
}

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: vi.fn(async () => body === null ? '' : JSON.stringify(body)),
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('federated media consumer configuration', () => {
  it('defaults old peer records to disabled with no allowlisted models', () => {
    expect(normalizePeerMediaProviderConfig({})).toEqual({
      enabled: false, audioModels: [], imageModels: [], videoModels: [],
    });
  });

  it('preserves future config/model fields while normalizing and de-duplicating known pairs', () => {
    const merged = mergePeerMediaProviderConfig(
      { enabled: false, future: 'keep', audioModels: [] },
      {
        enabled: true,
        audioModels: [
          { engine: ' minimax-music3 ', modelId: 'minimax-music3', futureModel: 'keep-too' },
          { engine: 'minimax-music3', modelId: 'minimax-music3' },
        ],
      },
    );

    expect(merged).toEqual({
      enabled: true,
      future: 'keep',
      audioModels: [{ engine: 'minimax-music3', modelId: 'minimax-music3', futureModel: 'keep-too' }],
      imageModels: [],
      videoModels: [],
    });
  });

  it('bounds legacy direct-service allowlists to the route schema limit', () => {
    const audioModels = Array.from({ length: 101 }, (_, index) => ({
      engine: 'example-engine',
      modelId: `model-${index}`,
    }));

    expect(mergePeerMediaProviderConfig({}, { enabled: true, audioModels }).audioModels)
      .toHaveLength(100);
  });
});

describe('federated media provider discovery', () => {
  it('does not contact a peer until the user opts it in', async () => {
    const result = await probeFederatedMediaProvider(peer({ mediaProvider: undefined }), { now: NOW });
    expect(result).toMatchObject({ state: 'disabled', reason: 'not-configured', snapshot: null });
    expect(peerFetch).not.toHaveBeenCalled();
  });

  it('uses authenticated peerFetch and stores only the allowlisted wire projection', async () => {
    peerFetch.mockResolvedValue(response(readyStatus()));

    const target = peer();
    const result = await probeFederatedMediaProvider(target, { now: NOW });

    expect(peerFetch).toHaveBeenCalledWith(
      'http://192.0.2.10:5555/api/federation/media/v1/status',
      { signal: undefined },
      target,
    );
    expect(result).toMatchObject({ state: 'ready', reason: null, freshUntil: '2026-08-17T12:01:00.000Z' });
    expect(result.snapshot.privateFutureField).toBeUndefined();
    expect(result.snapshot.capabilities[0].privateFutureField).toBeUndefined();
  });

  it('marks expired capacity stale instead of treating a reachable peer as available', async () => {
    peerFetch.mockResolvedValue(response(readyStatus({ generatedAt: '2026-08-17T11:58:00.000Z' })));

    await expect(probeFederatedMediaProvider(peer(), { now: NOW })).resolves.toMatchObject({
      state: 'stale',
      reason: 'stale',
    });
  });

  it('distinguishes an older peer with no wire-v1 route', async () => {
    peerFetch.mockResolvedValue(response({ error: 'Not found' }, 404));

    await expect(probeFederatedMediaProvider(peer(), { now: NOW })).resolves.toMatchObject({
      state: 'unsupported',
      reason: 'wire-v1-not-supported',
      snapshot: null,
    });
  });

  it('rejects a media kind outside the known wire-v1 alphabet', async () => {
    const futureStatus = readyStatus({
      kinds: ['holo'],
      capabilities: [{ ...readyStatus().capabilities[0], kind: 'holo' }],
    });
    peerFetch.mockResolvedValue(response(futureStatus));

    await expect(probeFederatedMediaProvider(peer(), { now: NOW })).resolves.toMatchObject({
      state: 'invalid',
      reason: 'invalid-wire-response',
      snapshot: null,
    });
  });

  it('only asks a peer for image/video status once this install allowlists a model for that kind', async () => {
    peerFetch.mockResolvedValue(response(readyStatus()));

    await probeFederatedMediaProvider(peer(), { now: NOW });
    expect(peerFetch).toHaveBeenLastCalledWith(
      'http://192.0.2.10:5555/api/federation/media/v1/status',
      { signal: undefined },
      expect.anything(),
    );

    const withImage = peer({
      mediaProvider: {
        enabled: true,
        audioModels: [],
        imageModels: [{ engine: 'local', modelId: 'flux-dev' }],
      },
    });
    await probeFederatedMediaProvider(withImage, { now: NOW });
    expect(peerFetch).toHaveBeenLastCalledWith(
      'http://192.0.2.10:5555/api/federation/media/v1/status?kinds=image',
      { signal: undefined },
      expect.anything(),
    );
  });
});

describe('federated media provider selection', () => {
  it('resolves an explicit allowlisted model only after a fresh ready preflight', async () => {
    peerFetch.mockResolvedValue(response(readyStatus()));

    const resolved = await resolveFederatedMediaProvider(peer(), selection, { now: NOW });

    expect(resolved.capability).toMatchObject(selection);
    expect(resolved.status.queue.accepting).toBe(true);
  });

  it('rejects a model the local user did not allowlist before checking capacity', () => {
    const configured = peer({ mediaProvider: { enabled: true, audioModels: [] } });
    const probe = {
      state: 'ready',
      reason: null,
      snapshot: readyStatus(),
    };

    expect(() => assertFederatedMediaProviderSelection(configured, selection, probe, { now: NOW }))
      .toThrow(expect.objectContaining({ code: 'MEDIA_PROVIDER_MODEL_NOT_ALLOWED', status: 403 }));
  });

  it('rejects busy capacity and CUDA unknown even when the peer is reachable', () => {
    const busy = {
      state: 'busy',
      reason: 'provider-busy',
      snapshot: readyStatus({ status: 'busy', queue: { ...readyStatus().queue, accepting: false } }),
    };
    expect(() => assertFederatedMediaProviderSelection(peer(), selection, busy, { now: NOW }))
      .toThrow(expect.objectContaining({ code: 'MEDIA_PROVIDER_BUSY', status: 429 }));

    const cudaUnknownStatus = readyStatus();
    cudaUnknownStatus.capabilities[0] = {
      ...cudaUnknownStatus.capabilities[0],
      ready: false,
      unavailableReason: 'cuda-unknown',
      cudaState: 'unknown',
    };
    expect(() => assertFederatedMediaProviderSelection(peer(), selection, {
      state: 'ready',
      reason: null,
      snapshot: cudaUnknownStatus,
    }, { now: NOW })).toThrow(expect.objectContaining({ code: 'MEDIA_PROVIDER_MODEL_UNAVAILABLE' }));
  });

  it('revalidates cached snapshots before assignment', () => {
    expect(() => assertFederatedMediaProviderSelection(peer(), selection, {
      state: 'ready',
      reason: null,
      snapshot: { ...readyStatus(), queue: null },
    }, { now: NOW })).toThrow(expect.objectContaining({
      code: 'MEDIA_PROVIDER_UNAVAILABLE',
      context: { reason: 'invalid-wire-response' },
    }));
  });

  it('keeps each media kind on its own allowlist — an audio-only peer cannot be selected for image', () => {
    const probe = { state: 'ready', reason: null, snapshot: readyStatus() };
    expect(() => assertFederatedMediaProviderSelection(
      peer(), { kind: 'image', engine: 'local', modelId: 'flux-dev' }, probe, { now: NOW },
    )).toThrow(expect.objectContaining({ code: 'MEDIA_PROVIDER_MODEL_NOT_ALLOWED', status: 403 }));
  });

  it('resolves an allowlisted image model against an image capability', () => {
    const imageSelection = { kind: 'image', engine: 'local', modelId: 'flux-dev' };
    const configured = peer({
      mediaProvider: { enabled: true, audioModels: [], imageModels: [{ engine: 'local', modelId: 'flux-dev' }] },
    });
    const status = readyStatus({
      kinds: ['image'],
      capabilities: [{ ...readyStatus().capabilities[0], kind: 'image', engine: 'local', modelId: 'flux-dev' }],
    });
    const probe = { state: 'ready', reason: null, snapshot: status };

    const resolved = assertFederatedMediaProviderSelection(configured, imageSelection, probe, { now: NOW });
    expect(resolved.capability).toMatchObject(imageSelection);
  });
});
