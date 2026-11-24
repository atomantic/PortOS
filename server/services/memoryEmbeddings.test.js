import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mocks for the config sources memoryEmbeddings resolves its backend from:
// settings.embeddings first, the legacy CoS pair only while that is unset.
const getCosConfig = vi.fn();
const getProviderById = vi.fn();
const summarizeForEmbedding = vi.fn();
const getSettings = vi.fn();
const settingsEvents = new EventEmitter();

vi.mock('./cos/cosState.js', () => ({ getConfig: getCosConfig }));
vi.mock('./provider/providers.js', () => ({ getProviderById }));
vi.mock('./settings.js', () => ({ getSettings, settingsEvents }));
// The managers own the base URLs the catalog embedder (embeddings.js) uses.
const OLLAMA_BASE = 'http://192.0.2.10:11434';
const LMSTUDIO_BASE = 'http://192.0.2.20:1234';
vi.mock('./ollamaManager.js', () => ({ getBaseUrl: () => OLLAMA_BASE }));
vi.mock('./lmStudioManager.js', () => ({ getBaseUrl: () => LMSTUDIO_BASE }));
// generateMemoryEmbedding dynamically imports this for over-budget records.
vi.mock('./memorySummarizer.js', () => ({ summarizeForEmbedding }));
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
  settingsEvents.removeAllListeners();
  // Default: settings.embeddings never saved → legacy CoS config resolves.
  getSettings.mockResolvedValue({});
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
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const emb = await embeddings.generateEmbedding('x'.repeat(50000));
    // The shrink-and-retry is the designed handling of an over-long input: stdout, not stderr.
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Embedding input over context; retrying at'));
    expect(warn).not.toHaveBeenCalled();

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

  it('resolves null (never rejects) when the backend is unreachable', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      if (String(url).includes('/api/v0/models')) return notLmStudio();
      return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    });
    await expect(embeddings.generateEmbedding('short text')).resolves.toBeNull();
    await expect(embeddings.generateQueryEmbedding('short text')).resolves.toBeNull();
  });

});

describe('generateMemoryEmbedding — summarize over-budget records', () => {
  beforeEach(() => {
    getCosConfig.mockResolvedValue({ embeddingProviderId: 'ollama', embeddingModel: 'nomic-embed-text' });
    getProviderById.mockResolvedValue({ id: 'ollama', endpoint: 'http://localhost:11434/v1' });
  });

  const embedOk = () => {
    const body = JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] });
    return { ok: true, json: async () => JSON.parse(body), text: async () => body };
  };
  const notLmStudio = () => Promise.resolve({ ok: false, status: 404, text: async () => '', json: async () => ({}) });
  const wireFetch = () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      if (String(url).includes('/api/v0/models')) return notLmStudio();
      return Promise.resolve(embedOk());
    });
  };
  const embedBody = () => JSON.parse(fetchSpy.mock.calls.find(c => String(c[0]).includes('/embeddings'))[1].body);

  it('does NOT summarize a within-budget memory (embeds content directly)', async () => {
    wireFetch();
    await embeddings.generateMemoryEmbedding({ type: 'observation', content: 'a short note' });
    expect(summarizeForEmbedding).not.toHaveBeenCalled();
    expect(embedBody().input).toContain('a short note');
  });

  it('summarizes an over-budget memory and embeds the summary, not the raw content', async () => {
    wireFetch();
    summarizeForEmbedding.mockResolvedValue('TIGHT SUMMARY of the whole thing');
    const huge = 'y'.repeat(40000); // well over the 5222-char budget

    await embeddings.generateMemoryEmbedding({ type: 'observation', category: 'personal', content: huge });

    expect(summarizeForEmbedding).toHaveBeenCalledTimes(1);
    const input = embedBody().input;
    expect(input).toContain('TIGHT SUMMARY of the whole thing');
    expect(input).not.toContain('yyyyyyyyyy'); // raw content was replaced
    // Metadata header is retained alongside the summary.
    expect(input).toContain('Type: observation');
  });

  it('falls back to truncated content when summarization is unavailable', async () => {
    wireFetch();
    summarizeForEmbedding.mockResolvedValue(null); // summarizer down / no provider
    const huge = 'z'.repeat(40000);

    const emb = await embeddings.generateMemoryEmbedding({ type: 'observation', content: huge });

    expect(emb).toEqual([0.1, 0.2, 0.3]);
    // Embedded the (truncated) raw content, not a summary.
    expect(embedBody().input).toContain('zzzz');
    expect(embedBody().input.length).toBeLessThan(40000);
  });
});

describe('memoryEmbeddings — settings.embeddings is the single source of truth (#18296)', () => {
  const embedOk = (vector = [0.4, 0.5, 0.6]) => {
    const body = JSON.stringify({ data: [{ index: 0, embedding: vector }] });
    return { ok: true, json: async () => JSON.parse(body), text: async () => body };
  };
  const notFound = () => Promise.resolve({ ok: false, status: 404, text: async () => '', json: async () => ({}) });
  // Non-LM-Studio backend: native probe 404s, /v1/models lists `modelIds`, embeds succeed.
  const wireOpenAiBackend = (modelIds = []) => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = String(url);
      if (u.includes('/api/v0/models')) return notFound();
      if (u.endsWith('/v1/models')) return Promise.resolve(mockModelsResponse(modelIds));
      return Promise.resolve(embedOk());
    });
  };
  const embedPosts = () => fetchSpy.mock.calls.filter((c) => String(c[0]).endsWith('/v1/embeddings'));

  it('embeds through the settings.embeddings backend + model and ignores the legacy CoS pair', async () => {
    getSettings.mockResolvedValue({ embeddings: { provider: 'ollama', model: 'nomic-embed-text' } });
    getCosConfig.mockResolvedValue({ embeddingProviderId: 'lmstudio', embeddingModel: 'text-embedding-nomic-embed-text-v2-moe' });
    wireOpenAiBackend();

    expect(await embeddings.generateEmbedding('hello')).toEqual([0.4, 0.5, 0.6]);

    const [url, init] = embedPosts()[0];
    expect(url).toBe(`${OLLAMA_BASE}/v1/embeddings`);
    expect(JSON.parse(init.body).model).toBe('nomic-embed-text');
    expect(getCosConfig).not.toHaveBeenCalled();
    expect(await embeddings.getActiveEmbeddingModel()).toBe('nomic-embed-text');
  });

  it('falls back to the legacy CoS provider/model only while settings.embeddings is unset', async () => {
    getSettings.mockResolvedValue({});
    getCosConfig.mockResolvedValue({ embeddingProviderId: 'ollama', embeddingModel: 'mxbai-embed-large' });
    getProviderById.mockResolvedValue({ id: 'ollama', endpoint: 'http://192.0.2.30:11434/v1' });
    wireOpenAiBackend();

    await embeddings.generateEmbedding('hello');

    const [url, init] = embedPosts()[0];
    expect(url).toBe('http://192.0.2.30:11434/v1/embeddings');
    expect(JSON.parse(init.body).model).toBe('mxbai-embed-large');
    expect(await embeddings.resolveEmbeddingSource()).toMatchObject({ source: 'legacy', provider: 'ollama', disabled: false });
    expect(await embeddings.getActiveEmbeddingModel()).toBe('mxbai-embed-large');
  });

  it("provider 'none' disables memory and query embedding without touching any backend", async () => {
    getSettings.mockResolvedValue({ embeddings: { provider: 'none', model: null } });
    getCosConfig.mockResolvedValue({ embeddingProviderId: 'lmstudio' });
    wireOpenAiBackend();

    expect(await embeddings.generateEmbedding('hello')).toBeNull();
    expect(await embeddings.generateQueryEmbedding('hello')).toBeNull();
    // Over budget would normally summarize first — disabled must not call the summarizer.
    expect(await embeddings.generateMemoryEmbedding({ type: 'fact', content: 'q'.repeat(40000) })).toBeNull();
    expect(summarizeForEmbedding).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    const status = await embeddings.checkAvailability();
    expect(status).toMatchObject({ available: false, disabled: true, source: 'settings', provider: 'none' });
    expect(await embeddings.getActiveEmbeddingModel()).toBeNull();
  });

  it('a settings:updated save of settings.embeddings switches the backend without a restart', async () => {
    getSettings.mockResolvedValue({ embeddings: { provider: 'ollama', model: 'nomic-embed-text' } });
    wireOpenAiBackend();
    await embeddings.generateEmbedding('first');
    expect(embedPosts()[0][0]).toBe(`${OLLAMA_BASE}/v1/embeddings`);

    // An unrelated settings save keeps the cached config (no re-read).
    const readsBefore = getSettings.mock.calls.length;
    settingsEvents.emit('settings:updated', { embeddings: { provider: 'ollama', model: 'nomic-embed-text' }, timezone: 'UTC' });
    await embeddings.generateEmbedding('second');
    expect(getSettings.mock.calls.length).toBe(readsBefore);

    // Models → Embeddings saves a different backend → the next embed uses it.
    const next = { embeddings: { provider: 'lmstudio', model: 'text-embedding-nomic-embed-text-v1.5' } };
    getSettings.mockResolvedValue(next);
    settingsEvents.emit('settings:updated', next);
    await embeddings.generateEmbedding('third');
    const [url, init] = embedPosts().at(-1);
    expect(url).toBe(`${LMSTUDIO_BASE}/v1/embeddings`);
    expect(JSON.parse(init.body).model).toBe('text-embedding-nomic-embed-text-v1.5');

    // Saving 'none' turns memory embedding off on the next call.
    const off = { embeddings: { provider: 'none' } };
    getSettings.mockResolvedValue(off);
    settingsEvents.emit('settings:updated', off);
    const postsBefore = embedPosts().length;
    expect(await embeddings.generateEmbedding('fourth')).toBeNull();
    expect(embedPosts().length).toBe(postsBefore);
  });

  it('a save that lands while the first config build is in flight is not lost to the stale read', async () => {
    wireOpenAiBackend();
    let releaseStaleRead;
    getSettings.mockImplementationOnce(() => new Promise((resolve) => { releaseStaleRead = resolve; }));
    const first = embeddings.generateEmbedding('first');

    const next = { embeddings: { provider: 'lmstudio', model: 'text-embedding-nomic-embed-text-v1.5' } };
    getSettings.mockResolvedValue(next);
    settingsEvents.emit('settings:updated', next);
    releaseStaleRead({ embeddings: { provider: 'ollama', model: 'nomic-embed-text' } });
    await first;

    await embeddings.generateEmbedding('second');
    expect(embedPosts().at(-1)[0]).toBe(`${LMSTUDIO_BASE}/v1/embeddings`);
  });

  it('discovers an installed embedding model when settings name a backend but no model', async () => {
    getSettings.mockResolvedValue({ embeddings: { provider: 'ollama', model: null } });
    wireOpenAiBackend(['llama3.2:latest', 'nomic-embed-text:latest']);

    await embeddings.generateEmbedding('hello');

    // Never the LM Studio DEFAULT model name, which Ollama doesn't have.
    expect(JSON.parse(embedPosts()[0][1].body).model).toBe('nomic-embed-text:latest');
    expect(await embeddings.getActiveEmbeddingModel()).toBe('nomic-embed-text:latest');
  });
});
