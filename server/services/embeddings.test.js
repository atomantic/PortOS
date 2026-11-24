import { describe, it, expect, vi, beforeEach } from 'vitest';

// The catalog embedder resolves `settings.embeddings` and routes to the manager.
vi.mock('./settings.js', () => ({ getSettings: vi.fn() }));
vi.mock('./ollamaManager.js', () => ({ getEmbeddings: vi.fn() }));
vi.mock('./lmStudioManager.js', () => ({ getEmbeddings: vi.fn() }));

const { getSettings } = await import('./settings.js');
const ollama = await import('./ollamaManager.js');
const lmstudio = await import('./lmStudioManager.js');
const { embedIngredient, embedSearchQuery } = await import('./embeddings.js');

const vec = (seed) => Array.from({ length: 768 }, (_, i) => (i === 0 ? seed : 0));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('embedSearchQuery — catalog query vectors share the row writer (#18296)', () => {
  it('embeds the query with the same provider + model embedIngredient writes rows with', async () => {
    getSettings.mockResolvedValue({ embeddings: { provider: 'lmstudio', model: 'text-embedding-nomic-embed-text-v1.5' } });
    lmstudio.getEmbeddings.mockImplementation(async (_text, { model }) => ({ success: true, embedding: vec(1), model }));

    const written = await embedIngredient({ name: 'Mara', payload: { role: 'courier' } });
    const query = await embedSearchQuery('a courier in the rain');

    expect(written.embeddingModel).toBe('text-embedding-nomic-embed-text-v1.5');
    expect(query).toEqual(vec(1));
    const models = lmstudio.getEmbeddings.mock.calls.map(([, opts]) => opts.model);
    expect(models).toEqual(['text-embedding-nomic-embed-text-v1.5', 'text-embedding-nomic-embed-text-v1.5']);
    expect(ollama.getEmbeddings).not.toHaveBeenCalled();
  });

  it('returns null (FTS-only search) when catalog embeddings are disabled or the embed fails', async () => {
    getSettings.mockResolvedValue({ embeddings: { provider: 'none' } });
    expect(await embedSearchQuery('anything')).toBeNull();
    expect(ollama.getEmbeddings).not.toHaveBeenCalled();

    getSettings.mockResolvedValue({ embeddings: { provider: 'ollama', model: 'nomic-embed-text' } });
    ollama.getEmbeddings.mockResolvedValue({ success: false, error: 'Ollama not available' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await embedSearchQuery('anything')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
