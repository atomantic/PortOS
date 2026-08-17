import { describe, expect, it } from 'vitest';
import {
  federatedMediaAudioProfileSchema,
  federatedMediaProviderJobSchema,
  isFederatedMediaAudioPrompt,
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

  it('rejects invalid integrity metadata and future media kinds', () => {
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
    expect(federatedMediaProviderJobSchema.safeParse(job({ kind: 'video' })).success).toBe(false);
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
