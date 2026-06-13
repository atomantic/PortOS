import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockJsonResponse } from '../lib/testHelper.js';

let svc;

beforeEach(async () => {
  vi.resetModules();
  // No HF token in tests — getHfToken reads settings/env, stub to null.
  vi.doMock('../lib/hfToken.js', () => ({ getHfToken: async () => null }));
  svc = await import('./videoLoraSuggestions.js');
  svc._resetVideoSuggestionsCache();
});

describe('getVideoSuggestions', () => {
  it('returns curated video cards enriched with HF metadata', async () => {
    const fetchImpl = async () => mockJsonResponse({
      cardData: { description: 'Audio-reactive LTX LoRA.', thumbnail: 'https://hf/preview.png' },
    });
    const cards = await svc.getVideoSuggestions({ fetchImpl });
    expect(cards.length).toBeGreaterThan(0);
    const card = cards[0];
    expect(card.source).toBe('huggingface');
    expect(card.runnerFamily).toBe('ltx-video');
    expect(card.repo).toBe('fal/ltx2.3-audio-reactive-lora');
    expect(card.description).toBe('Audio-reactive LTX LoRA.');
    expect(card.previewImageUrl).toBe('https://hf/preview.png');
    expect(card.installUrl).toBe('https://huggingface.co/fal/ltx2.3-audio-reactive-lora');
  });

  it('degrades to the static card when the HF metadata fetch fails', async () => {
    const fetchImpl = async () => ({ ok: false, status: 404 });
    const cards = await svc.getVideoSuggestions({ fetchImpl });
    expect(cards.length).toBeGreaterThan(0);
    expect(cards[0].repo).toBe('fal/ltx2.3-audio-reactive-lora');
    expect(cards[0].runnerFamily).toBe('ltx-video');
    // No metadata → no description / preview, but the card is still usable.
    expect(cards[0].description).toBe('');
    expect(cards[0].previewImageUrl).toBe(null);
    expect(cards[0].installUrl).toBe('https://huggingface.co/fal/ltx2.3-audio-reactive-lora');
  });

  it('caches across calls within the TTL (no re-fetch)', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return mockJsonResponse({ cardData: {} }); };
    await svc.getVideoSuggestions({ fetchImpl });
    const after = calls;
    await svc.getVideoSuggestions({ fetchImpl });
    expect(calls).toBe(after);
  });

  it('force=true busts the cache', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return mockJsonResponse({ cardData: {} }); };
    await svc.getVideoSuggestions({ fetchImpl });
    const after = calls;
    await svc.getVideoSuggestions({ fetchImpl, force: true });
    expect(calls).toBeGreaterThan(after);
  });
});
