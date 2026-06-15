import { describe, it, expect, vi, beforeEach } from 'vitest';

const getProviderById = vi.fn();
const loadMeta = vi.fn();
const readArchivedConversation = vi.fn();
const runPromptThroughProvider = vi.fn();

vi.mock('./providers.js', () => ({ getProviderById }));
vi.mock('./brainStorage.js', () => ({ loadMeta }));
vi.mock('./chatgptImport.js', () => ({ readArchivedConversation }));
vi.mock('../lib/promptRunner.js', () => ({ runPromptThroughProvider }));

let summarizer;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  summarizer = await import('./memorySummarizer.js');
});

describe('memorySummarizer — summarizeForEmbedding', () => {
  it('summarizes the FULL archived transcript for a chatgpt-import record (not the preview)', async () => {
    loadMeta.mockResolvedValue({ defaultProvider: 'ollama', defaultModel: 'gpt-oss:20b' });
    getProviderById.mockResolvedValue({ id: 'ollama', type: 'api', endpoint: 'http://localhost:11434/v1' });
    readArchivedConversation.mockResolvedValue({ transcript: 'FULL TRANSCRIPT with every turn included' });
    runPromptThroughProvider.mockResolvedValue({ text: '  a dense summary  ' });

    const out = await summarizer.summarizeForEmbedding(
      { source: 'chatgpt-import', sourceRef: 'abc.json' },
      'the short truncated preview'
    );

    expect(readArchivedConversation).toHaveBeenCalledWith('abc.json');
    // The prompt fed the FULL transcript, not the fallback preview.
    const prompt = runPromptThroughProvider.mock.calls[0][0].prompt;
    expect(prompt).toContain('FULL TRANSCRIPT with every turn included');
    expect(prompt).not.toContain('the short truncated preview');
    // Uses the Brain default model.
    expect(runPromptThroughProvider.mock.calls[0][0].model).toBe('gpt-oss:20b');
    expect(out).toBe('a dense summary'); // trimmed
  });

  it('uses the fallback text for a non-import record (no archive lookup)', async () => {
    loadMeta.mockResolvedValue({ defaultProvider: 'ollama', defaultModel: 'gpt-oss:20b' });
    getProviderById.mockResolvedValue({ id: 'ollama', type: 'api', endpoint: 'http://localhost:11434/v1' });
    runPromptThroughProvider.mockResolvedValue({ text: 'summary' });

    await summarizer.summarizeForEmbedding({ type: 'observation' }, 'the combined memory text');

    expect(readArchivedConversation).not.toHaveBeenCalled();
    expect(runPromptThroughProvider.mock.calls[0][0].prompt).toContain('the combined memory text');
  });

  it('falls back to the ollama provider AND its own model when the Brain default does not resolve', async () => {
    // meta.defaultModel names a model on the now-missing provider — it must NOT
    // be sent to the ollama fallback (would 404). The fallback uses ollama's
    // own defaultModel instead.
    loadMeta.mockResolvedValue({ defaultProvider: 'some-removed-provider', defaultModel: 'model-on-missing-provider' });
    getProviderById.mockImplementation(async (id) =>
      id === 'ollama' ? { id: 'ollama', type: 'api', endpoint: 'http://localhost:11434/v1', defaultModel: 'gpt-oss:20b' } : null
    );
    runPromptThroughProvider.mockResolvedValue({ text: 'summary' });

    const out = await summarizer.summarizeForEmbedding({ type: 'observation' }, 'text');

    expect(getProviderById).toHaveBeenCalledWith('ollama');
    expect(out).toBe('summary');
    // The stale default-provider model must not leak into the fallback call.
    const usedModel = runPromptThroughProvider.mock.calls[0][0].model;
    expect(usedModel).toBe('gpt-oss:20b');
    expect(usedModel).not.toBe('model-on-missing-provider');
  });

  it('returns null when no provider is configured (caller then truncates)', async () => {
    loadMeta.mockResolvedValue({});
    getProviderById.mockResolvedValue(null);

    const out = await summarizer.summarizeForEmbedding({ type: 'observation' }, 'text');

    expect(out).toBeNull();
    expect(runPromptThroughProvider).not.toHaveBeenCalled();
  });

  it('returns null when the provider call throws (caller then truncates)', async () => {
    loadMeta.mockResolvedValue({ defaultProvider: 'ollama', defaultModel: 'gpt-oss:20b' });
    getProviderById.mockResolvedValue({ id: 'ollama', type: 'api', endpoint: 'http://localhost:11434/v1' });
    runPromptThroughProvider.mockRejectedValue(new Error('model timeout'));

    const out = await summarizer.summarizeForEmbedding({ type: 'observation' }, 'text');
    expect(out).toBeNull();
  });

  it('returns null on an empty model response (not an empty string)', async () => {
    loadMeta.mockResolvedValue({ defaultProvider: 'ollama', defaultModel: 'gpt-oss:20b' });
    getProviderById.mockResolvedValue({ id: 'ollama', type: 'api', endpoint: 'http://localhost:11434/v1' });
    runPromptThroughProvider.mockResolvedValue({ text: '   ' });

    const out = await summarizer.summarizeForEmbedding({ type: 'observation' }, 'text');
    expect(out).toBeNull();
  });
});
