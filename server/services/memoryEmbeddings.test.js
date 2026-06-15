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
const mockModelsResponse = (ids) => {
  const body = JSON.stringify({ data: ids.map((id) => ({ id })) });
  return { ok: true, json: async () => JSON.parse(body), text: async () => body };
};

describe('memoryEmbeddings — provider-aware config (Ollama vs LM Studio)', () => {
  it('uses the configured model for a non-LM-Studio provider and reports modelPresent', async () => {
    getCosConfig.mockResolvedValue({ embeddingProviderId: 'ollama', embeddingModel: 'nomic-embed-text' });
    getProviderById.mockResolvedValue({ id: 'ollama', endpoint: 'http://localhost:11434/v1' });
    // Ollama's /v1/models lists installed models tagged with :latest.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockModelsResponse(['nomic-embed-text:latest', 'llama3.2:latest'])
    );

    const status = await embeddings.checkAvailability();

    // Probed /v1/models on the OLLAMA endpoint, not LM Studio's :1234.
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

  it('flags modelPresent:false when the configured model is not installed on the provider', async () => {
    getCosConfig.mockResolvedValue({ embeddingProviderId: 'ollama', embeddingModel: 'mxbai-embed-large' });
    getProviderById.mockResolvedValue({ id: 'ollama', endpoint: 'http://localhost:11434/v1' });
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockModelsResponse(['nomic-embed-text:latest'])
    );

    const status = await embeddings.checkAvailability();

    expect(status.available).toBe(true);
    expect(status.modelPresent).toBe(false);
  });

  it('does NOT hit LM Studio model-load endpoints for a non-LM-Studio provider', async () => {
    getCosConfig.mockResolvedValue({ embeddingProviderId: 'ollama', embeddingModel: 'nomic-embed-text' });
    getProviderById.mockResolvedValue({ id: 'ollama', endpoint: 'http://localhost:11434/v1' });
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockModelsResponse(['nomic-embed-text:latest']));

    await embeddings.checkAvailability();

    // The LM-Studio-only discover/load dance (/api/v0/models, /api/v1/models/load)
    // must never be called for Ollama.
    const urls = fetchSpy.mock.calls.map((c) => c[0]);
    expect(urls.some((u) => u.includes('/api/v0/models'))).toBe(false);
    expect(urls.some((u) => u.includes('/api/v1/models/load'))).toBe(false);
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
