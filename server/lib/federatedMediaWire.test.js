import { describe, expect, it } from 'vitest';
import {
  federatedMediaAudioProfileSchema,
  federatedMediaProviderStatusSchema,
  federatedMediaProviderJobSchema,
  isFederatedMediaAudioPrompt,
  normalizeRequestedMediaKinds,
  renderFederatedMediaAudioPrompt,
} from './federatedMediaWire.js';

const job = (overrides = {}) => ({
  wireVersion: 1,
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'audio',
  status: 'queued',
  queuedAt: '2026-08-17T12:00:00.000Z',
  startedAt: null,
  completedAt: null,
  position: 1,
  progress: null,
  etaMs: null,
  ...overrides,
});

describe('federated media provider job wire projection', () => {
  it('strips unknown provider fields before consumer reconciliation', () => {
    const parsed = federatedMediaProviderJobSchema.parse(job({ privateFutureField: 'do-not-relay' }));
    expect(parsed.privateFutureField).toBeUndefined();
  });

  it('rejects invalid integrity metadata and kinds outside the known wire-v1 alphabet', () => {
    expect(federatedMediaProviderJobSchema.safeParse(job({
      status: 'completed',
      completedAt: '2026-08-17T12:01:00.000Z',
      result: {
        available: true,
        mimeType: 'audio/wav',
        sizeBytes: 10,
        sha256: 'not-a-hash',
        downloadUrl: '/result',
        engine: 'example-engine',
        modelId: 'example/model',
        durationSec: 30,
      },
    })).success).toBe(false);
    expect(federatedMediaProviderJobSchema.safeParse(job({ kind: 'holo' })).success).toBe(false);
  });

  it('accepts image and video as first-class kinds, each with their own result mime type', () => {
    expect(federatedMediaProviderJobSchema.safeParse(job({ kind: 'video' })).success).toBe(true);
    expect(federatedMediaProviderJobSchema.safeParse(job({
      kind: 'image',
      status: 'completed',
      completedAt: '2026-08-17T12:01:00.000Z',
      result: {
        available: true,
        mimeType: 'image/png',
        sizeBytes: 10,
        sha256: 'a'.repeat(64),
        downloadUrl: '/result',
        engine: 'local',
        modelId: 'flux-dev',
        durationSec: null,
      },
    })).success).toBe(true);
    expect(federatedMediaProviderJobSchema.safeParse(job({
      kind: 'image',
      status: 'completed',
      completedAt: '2026-08-17T12:01:00.000Z',
      result: {
        available: true,
        mimeType: 'video/mp4',
        sizeBytes: 10,
        sha256: 'a'.repeat(64),
        downloadUrl: '/result',
        engine: 'local',
        modelId: 'example/model',
        durationSec: null,
      },
    })).success).toBe(false);
  });
});

describe('federated media status kind projection', () => {
  const status = (overrides = {}) => ({
    wireVersion: 1,
    generatedAt: '2026-08-17T12:00:00.000Z',
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
    capabilities: [],
    ...overrides,
  });

  it('rejects a capability kind omitted from the negotiated projection', () => {
    expect(federatedMediaProviderStatusSchema.safeParse(status({
      capabilities: [{
        kind: 'image', engine: 'local', engineName: 'Local', modelId: 'example/model', modelName: 'Example',
        ready: true, unavailableReason: null, runtimeReady: true, platformSupported: true,
        cudaRequired: false, cudaState: 'available', minDurationSec: null, maxDurationSec: null,
        defaultDurationSec: null, lyrics: false, autoDuration: false,
      }],
    })).success).toBe(false);
  });
});

describe('normalizeRequestedMediaKinds', () => {
  it('defaults to audio-only so an unopted-in caller gets the original shape', () => {
    expect(normalizeRequestedMediaKinds()).toEqual(['audio']);
    expect(normalizeRequestedMediaKinds('')).toEqual(['audio']);
    expect(normalizeRequestedMediaKinds('nonsense,also-bad')).toEqual(['audio']);
  });

  it('parses a comma-separated list down to the known, deduplicated subset', () => {
    expect(normalizeRequestedMediaKinds('audio,image,image,video,holo')).toEqual(['audio', 'image', 'video']);
    expect(normalizeRequestedMediaKinds(['video', ' image '])).toEqual(['video', 'image']);
  });
});

describe('federated media privacy-safe audio profiles', () => {
  it('renders provider prompts only from fixed musical vocabulary', () => {
    const profile = {
      style: 'cinematic',
      mood: 'dreamy',
      tempo: 'slow',
      energy: 'medium',
      instruments: ['strings', 'synthesizer'],
    };

    const prompt = renderFederatedMediaAudioPrompt(profile);
    expect(prompt).toBe('Instrumental cinematic music with a dreamy mood, slow tempo, medium energy, featuring strings and synthesizer. No vocals or spoken words.');
    expect(isFederatedMediaAudioPrompt(prompt)).toBe(true);
    expect(isFederatedMediaAudioPrompt('Cinematic music for alice@example.com')).toBe(false);
    expect(federatedMediaAudioProfileSchema.safeParse({
      ...profile,
      subject: 'alice@example.com',
    }).success).toBe(false);
    expect(renderFederatedMediaAudioPrompt({ ...profile, mood: 'a named person' })).toBeNull();
  });
});
