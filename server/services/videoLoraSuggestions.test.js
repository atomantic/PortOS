import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockJsonResponse } from '../lib/testHelper.js';

let svc;

beforeEach(async () => {
  vi.resetModules();
  // No HF token in tests — getHfToken reads settings/env, stub to null.
  vi.doMock('./hfToken.js', () => ({ getHfToken: async () => null }));
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
    expect(card.file).toBe('ltx2.3_audio_reactive_lora_v2.safetensors');
    expect(card.name).toBe('LTX-2.3 Audio Reactive V2');
    expect(card.description).toBe('Audio-reactive LTX LoRA.');
    expect(card.previewImageUrl).toBe('https://hf/preview.png');
    expect(card.installUrl).toBe('https://huggingface.co/fal/ltx2.3-audio-reactive-lora');
  });

  it('includes the MiniMax H3 curated card', async () => {
    const fetchImpl = async () => mockJsonResponse({ cardData: {} });
    const cards = await svc.getVideoSuggestions({ fetchImpl });
    const card = cards.find((c) => c.repo === 'KennethFal/vh5tape-vhs-lora-minimax-h3');
    expect(card).toBeTruthy();
    expect(card.runnerFamily).toBe('minimax-h3');
    expect(card.file).toBe('vh5tape.safetensors');
    expect(card.installUrl).toBe('https://huggingface.co/KennethFal/vh5tape-vhs-lora-minimax-h3');
  });

  it('degrades to the static card when the HF metadata fetch fails', async () => {
    const fetchImpl = async () => ({ ok: false, status: 404 });
    const cards = await svc.getVideoSuggestions({ fetchImpl });
    expect(cards.length).toBeGreaterThan(0);
    expect(cards[0].repo).toBe('fal/ltx2.3-audio-reactive-lora');
    expect(cards[0].file).toBe('ltx2.3_audio_reactive_lora_v2.safetensors');
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

describe('searchVideoLoras', () => {
  // The list-search endpoint (HF_API with no path segment after it) and the
  // per-repo metadata endpoint (HF_API/<repo>) share a base URL — route the
  // fetchImpl on that distinction, exactly like the real HF API shapes them.
  const listResponse = (items, { link = null } = {}) => ({
    ok: true,
    text: async () => JSON.stringify(items),
    headers: { get: (name) => (name.toLowerCase() === 'link' ? link : null) },
  });
  const routedFetch = ({ list, models }) => async (url) => {
    if (String(url).startsWith('https://huggingface.co/api/models?')) return listResponse(list);
    const repo = String(url).replace('https://huggingface.co/api/models/', '');
    const model = models[repo];
    if (!model) return { ok: false, status: 404 };
    return mockJsonResponse(model);
  };

  it('classifies from the full model card, includes the recommended file, and builds a usable card', async () => {
    const fetchImpl = routedFetch({
      list: [{ id: 'someorg/some-ltx-lora', tags: ['ltx-video'], downloads: 42, likes: 7 }],
      models: {
        'someorg/some-ltx-lora': {
          id: 'someorg/some-ltx-lora',
          tags: ['ltx-video'],
          cardData: { base_model: 'Lightricks/LTX-2.3', description: 'A test LTX LoRA.', thumbnail: 'https://hf/preview.png' },
          siblings: [{ rfilename: 'lora.safetensors' }],
        },
      },
    });
    const result = await svc.searchVideoLoras({ family: 'ltx-video', query: 'lora', fetchImpl });
    expect(result.items).toHaveLength(1);
    const card = result.items[0];
    expect(card.source).toBe('huggingface');
    expect(card.repo).toBe('someorg/some-ltx-lora');
    expect(card.revision).toBe('main');
    expect(card.file).toBe('lora.safetensors');
    expect(card.files).toEqual([{ file: 'lora.safetensors', recommended: true }]);
    expect(card.runnerFamily).toBe('ltx-video');
    expect(card.downloads).toBe(42);
    expect(card.description).toBe('A test LTX LoRA.');
    expect(card.previewImageUrl).toBe('https://hf/preview.png');
    expect(card.installUrl).toBe('https://huggingface.co/someorg/some-ltx-lora');
  });

  it('rejects a candidate with no .safetensors sibling (base checkpoint, not an installable adapter)', async () => {
    const fetchImpl = routedFetch({
      list: [{ id: 'someorg/base-checkpoint', tags: ['ltx-video'] }],
      models: {
        'someorg/base-checkpoint': {
          id: 'someorg/base-checkpoint',
          tags: ['ltx-video'],
          siblings: [{ rfilename: 'model.bin' }],
        },
      },
    });
    const result = await svc.searchVideoLoras({ query: 'checkpoint', fetchImpl });
    expect(result.items).toEqual([]);
  });

  it('lets the user pick when a repo publishes several LoRA files, instead of guessing', async () => {
    const fetchImpl = routedFetch({
      list: [{ id: 'someorg/multi-lora', tags: ['minimax-h3'] }],
      models: {
        'someorg/multi-lora': {
          id: 'someorg/multi-lora',
          tags: ['minimax', 'h3'],
          siblings: [
            { rfilename: 'variant-a.safetensors' },
            { rfilename: 'pytorch_lora_weights.safetensors' },
          ],
        },
      },
    });
    const result = await svc.searchVideoLoras({ family: 'minimax-h3', query: 'multi', fetchImpl });
    expect(result.items).toHaveLength(1);
    const card = result.items[0];
    // pickHfLoraFile prefers the canonical `pytorch_lora_weights.safetensors`
    // name — but BOTH files stay listed so the UI can offer the other one.
    expect(card.file).toBe('pytorch_lora_weights.safetensors');
    expect(card.files).toEqual([
      { file: 'variant-a.safetensors', recommended: false },
      { file: 'pytorch_lora_weights.safetensors', recommended: true },
    ]);
  });

  it('drops a repo that does not confirm as the requested family once the full card is in hand', async () => {
    const fetchImpl = routedFetch({
      // Tags look LTX-ish at the list level, but the full card's base_model
      // says otherwise — the FULL classification is the real verdict.
      list: [{ id: 'someorg/not-actually-video', tags: ['lora'] }],
      models: {
        'someorg/not-actually-video': {
          id: 'someorg/not-actually-video',
          tags: ['lora'],
          cardData: { base_model: 'black-forest-labs/FLUX.2-dev' },
          siblings: [{ rfilename: 'lora.safetensors' }],
        },
      },
    });
    const result = await svc.searchVideoLoras({ query: 'x', fetchImpl });
    expect(result.items).toEqual([]);
  });

  it('paginates: forwards the cursor and returns the next page token', async () => {
    let capturedUrl = null;
    const fetchImpl = async (url) => {
      capturedUrl = url;
      return listResponse([], { link: '<https://huggingface.co/api/models?cursor=PAGE3>; rel="next"' });
    };
    const result = await svc.searchVideoLoras({ query: 'x', cursor: 'https://huggingface.co/api/models?cursor=PAGE2', fetchImpl });
    expect(capturedUrl).toBe('https://huggingface.co/api/models?cursor=PAGE2');
    expect(result.nextCursor).toBe('https://huggingface.co/api/models?cursor=PAGE3');
  });

  it('tolerates one candidate failing its metadata fetch without dropping the rest of the page', async () => {
    const fetchImpl = routedFetch({
      list: [
        { id: 'someorg/unreachable', tags: ['ltx-video'] },
        { id: 'someorg/reachable', tags: ['ltx-video'] },
      ],
      models: {
        // 'someorg/unreachable' intentionally absent → routedFetch 404s it.
        'someorg/reachable': {
          id: 'someorg/reachable',
          tags: ['ltx-video'],
          siblings: [{ rfilename: 'lora.safetensors' }],
        },
      },
    });
    const result = await svc.searchVideoLoras({ family: 'ltx-video', query: 'x', fetchImpl });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].repo).toBe('someorg/reachable');
  });

  it('caches identical (family, query, author, cursor) searches within the TTL', async () => {
    let calls = 0;
    const fetchImpl = async (url) => {
      calls += 1;
      if (String(url).startsWith('https://huggingface.co/api/models?')) return listResponse([]);
      return { ok: false, status: 404 };
    };
    await svc.searchVideoLoras({ query: 'repeat', fetchImpl });
    const after = calls;
    await svc.searchVideoLoras({ query: 'repeat', fetchImpl });
    expect(calls).toBe(after);
  });

  it('force=true busts the search cache', async () => {
    let calls = 0;
    const fetchImpl = async (url) => {
      calls += 1;
      if (String(url).startsWith('https://huggingface.co/api/models?')) return listResponse([]);
      return { ok: false, status: 404 };
    };
    await svc.searchVideoLoras({ query: 'repeat', fetchImpl });
    const after = calls;
    await svc.searchVideoLoras({ query: 'repeat', fetchImpl, force: true });
    expect(calls).toBeGreaterThan(after);
  });

  it('bubbles a failed list-search request (uncached) so the UI can offer a retry', async () => {
    const fetchImpl = async () => ({ ok: false, status: 503 });
    await expect(svc.searchVideoLoras({ query: 'x', fetchImpl })).rejects.toMatchObject({ code: 'HF_SEARCH_FAILED' });
    // A failed top-level request must not poison the cache — retrying with a
    // working fetchImpl should succeed rather than replaying the failure.
    const retryFetch = routedFetch({ list: [], models: {} });
    await expect(svc.searchVideoLoras({ query: 'x', fetchImpl: retryFetch })).resolves.toMatchObject({ items: [] });
  });
});
