import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mocks for the config sources memoryEmbeddings reads in initConfig().
const getCosConfig = vi.fn();
const getProviderById = vi.fn();

vi.mock('./cos.js', () => ({ getConfig: getCosConfig }));
vi.mock('./providers.js', () => ({ getProviderById }));
// memoryBackend pulls in the DB; stub it to just the default config export.
vi.mock('./memoryBackend.js', () => ({
  DEFAULT_MEMORY_CONFIG: {
    embeddingProvider: 'lmstudio',
    embeddingEndpoint: 'http://localhost:1234/v1/embeddings',
    embeddingModel: 'text-embedding-nomic-embed-text-v2-moe',
    embeddingDimension: 768,
    embeddingMaxTokens: 2048,
  },
}));

let embeddings;
let fetchSpy;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  embeddings = await import('./memoryEmbeddings.js');
  embeddings.reinitialize(); // clear cached config between tests
});

afterEach(() => {
  fetchSpy?.mockRestore();
});

// Build a fake `GET /v1/models` response. readResponseJson() reads the body via
// `.text()` (it tolerates non-JSON), so the payload must be the JSON string.
const okJson = (obj) => {
  const body = JSON.stringify(obj);
  return { ok: true, json: async () => JSON.parse(body), text: async () => body };
};
const mockModelsResponse = (ids) => okJson({ data: ids.map((id) => ({ id })) });

// An Ollama-style backend: serves /v1/models but 404s LM Studio's native
// /api/v0/models capability probe. Route by URL so the probe is recognized as
// "not LM Studio".
const ollamaFetch = (v1ModelIds) => (url) => {
  if (String(url).includes('/api/v0/models')) {
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
  }
  return Promise.resolve(mockModelsResponse(v1ModelIds));
};

describe('memoryEmbeddings — provider-aware config (Ollama vs LM Studio)', () => {
  it('uses the configured model for a non-LM-Studio backend and reports modelPresent', async () => {
    getCosConfig.mockResolvedValue({ embeddingProviderId: 'ollama', embeddingModel: 'nomic-embed-text' });
    getProviderById.mockResolvedValue({ id: 'ollama', endpoint: 'http://localhost:11434/v1' });
    // /v1/models lists installed models tagged with :latest; /api/v0/models 404s.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      ollamaFetch(['nomic-embed-text:latest', 'llama3.2:latest'])
    );

    const status = await embeddings.checkAvailability();

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:11434/v1/models',
      expect.objectContaining({ method: 'GET' })
    );
    expect(status.available).toBe(true);
    // Configured model is authoritative (not guessed from `.includes('embed')`).
    expect(status.embeddingModel).toBe('nomic-embed-text');
    // ':latest'-tagged install counts as present.
    expect(status.modelPresent).toBe(true);
  });

  it('flags modelPresent:false when the configured model is not installed on the backend', async () => {
    getCosConfig.mockResolvedValue({ embeddingProviderId: 'ollama', embeddingModel: 'mxbai-embed-large' });
    getProviderById.mockResolvedValue({ id: 'ollama', endpoint: 'http://localhost:11434/v1' });
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(ollamaFetch(['nomic-embed-text:latest']));

    const status = await embeddings.checkAvailability();

    expect(status.available).toBe(true);
    expect(status.modelPresent).toBe(false);
  });

  it('does NOT POST the LM Studio load endpoint for a non-LM-Studio backend', async () => {
    getCosConfig.mockResolvedValue({ embeddingProviderId: 'ollama', embeddingModel: 'nomic-embed-text' });
    getProviderById.mockResolvedValue({ id: 'ollama', endpoint: 'http://localhost:11434/v1' });
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(ollamaFetch(['nomic-embed-text:latest']));

    await embeddings.checkAvailability();

    // The native probe (/api/v0/models) may be attempted (it's how we DETECT
    // non-LMS — it 404s), but the model-LOAD POST must never fire for Ollama.
    const loadCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('/api/v1/models/load'));
    expect(loadCalls.length).toBe(0);
  });

  it('detects LM Studio by capability even under a renamed provider id, and only greens when a model is loaded', async () => {
    // Provider id is NOT "lmstudio" — but the endpoint serves the native API.
    getCosConfig.mockResolvedValue({ embeddingProviderId: 'my-local-lms', embeddingModel: '' });
    getProviderById.mockResolvedValue({ id: 'my-local-lms', endpoint: 'http://localhost:1234/v1' });
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      if (String(url).includes('/api/v0/models')) {
        // LM Studio native API: a downloaded-but-NOT-loaded embedding model.
        return Promise.resolve(okJson({ data: [{ id: 'nomic-embed-v1.5', type: 'embeddings', state: 'not-loaded' }] }));
      }
      if (String(url).includes('/api/v1/models/load')) {
        return Promise.resolve({ ok: true, json: async () => ({}), text: async () => '' });
      }
      return Promise.resolve(mockModelsResponse(['some-chat-model'])); // /v1/models
    });

    const status = await embeddings.checkAvailability();

    expect(status.available).toBe(true);
    // It recognized LM Studio (renamed id) and ran the load dance.
    const loadCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('/api/v1/models/load'));
    expect(loadCalls.length).toBe(1);
    // After a successful load, modelPresent is true and the model id is set.
    expect(status.modelPresent).toBe(true);
    expect(status.embeddingModel).toContain('nomic-embed');
  });

  it('reports unreachable when the embedding backend GET fails', async () => {
    getCosConfig.mockResolvedValue({ embeddingProviderId: 'ollama', embeddingModel: 'nomic-embed-text' });
    getProviderById.mockResolvedValue({ id: 'ollama', endpoint: 'http://localhost:11434/v1' });
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503, _err: undefined });

    const status = await embeddings.checkAvailability();
    expect(status.available).toBe(false);
    expect(status.error).toContain('503');
  });
});

describe('memoryEmbeddings — context-budget truncation + overflow retry', () => {
  beforeEach(() => {
    getCosConfig.mockResolvedValue({ embeddingProviderId: 'ollama', embeddingModel: 'nomic-embed-text' });
    getProviderById.mockResolvedValue({ id: 'ollama', endpoint: 'http://localhost:11434/v1' });
  });

  // readResponseJson() reads the body via `.text()`, so the payload must be the
  // JSON STRING (not just `.json()`).
  const embedOk = () => {
    const body = JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] });
    return { ok: true, json: async () => JSON.parse(body), text: async () => body };
  };
  const contextOverflow = () => ({
    ok: false, status: 400,
    text: async () => JSON.stringify({ error: { message: 'the input length exceeds the context length' } }),
    json: async () => ({}),
  });
  const notLmStudio = () => Promise.resolve({ ok: false, status: 404, text: async () => '', json: async () => ({}) });

  // Route the LM-Studio native probe to a 404 (so the backend is recognized as
  // Ollama and the load dance is skipped); delegate the /v1/embeddings POSTs to
  // a per-test queue of responses.
  const wireFetch = (embedResponses) => {
    let i = 0;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      if (String(url).includes('/api/v0/models')) return notLmStudio();
      const r = embedResponses[Math.min(i, embedResponses.length - 1)];
      i += 1;
      return Promise.resolve(typeof r === 'function' ? r() : r);
    });
  };
  // Only the /v1/embeddings POST calls, in order (filters out the probe).
  const embedCalls = () => fetchSpy.mock.calls.filter(c => String(c[0]).includes('/embeddings'));

  it('truncates a long input to the model context budget before sending', async () => {
    const longText = 'x'.repeat(50000);
    wireFetch([embedOk]);

    const emb = await embeddings.generateEmbedding(longText);

    expect(emb).toEqual([0.1, 0.2, 0.3]);
    const body = JSON.parse(embedCalls()[0][1].body);
    expect(body.input.length).toBe(Math.floor(2048 * 0.85 * 3)); // 5222 chars
    expect(body.input.length).toBeLessThan(50000);
  });

  it('shrinks and retries when the backend still reports a context overflow', async () => {
    wireFetch([contextOverflow, embedOk]);

    const emb = await embeddings.generateEmbedding('x'.repeat(50000));

    expect(emb).toEqual([0.1, 0.2, 0.3]);
    const calls = embedCalls();
    expect(calls.length).toBe(2);
    const firstLen = JSON.parse(calls[0][1].body).input.length;
    const secondLen = JSON.parse(calls[1][1].body).input.length;
    expect(secondLen).toBe(Math.floor(firstLen / 2)); // halved on retry
  });

  it('returns null (not a throw) when input stays over context after shrinking', async () => {
    wireFetch([contextOverflow]);
    const emb = await embeddings.generateEmbedding('x'.repeat(50000));
    expect(emb).toBeNull();
    expect(embedCalls().length).toBeLessThanOrEqual(3); // bounded retries
  });

  it('does NOT shrink on a non-overflow error — fails fast with null', async () => {
    wireFetch([{ ok: false, status: 500, text: async () => 'internal error', json: async () => ({}) }]);
    const emb = await embeddings.generateEmbedding('short text');
    expect(emb).toBeNull();
    expect(embedCalls().length).toBe(1); // no retry on a non-context error
  });

  it('batch: falls back to per-item embedding when the batch overflows', async () => {
    // Batch POST overflows; then each of the 2 items embeds individually.
    wireFetch([contextOverflow, embedOk, embedOk]);

    const out = await embeddings.generateBatchEmbeddings(['a', 'b']);

    expect(out).toEqual([[0.1, 0.2, 0.3], [0.1, 0.2, 0.3]]);
    expect(embedCalls().length).toBe(3);
  });
});
