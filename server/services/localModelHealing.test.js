import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  updateProvider: vi.fn(async () => ({ success: true })),
  addNotification: vi.fn(async () => ({})),
  emitLog: vi.fn(),
  ollamaInstalled: vi.fn(async () => []),
  lmStudioAvailable: vi.fn(async () => [])
}));

vi.mock('./cosEvents.js', () => ({ emitLog: mocks.emitLog }));
vi.mock('./providers.js', () => ({ updateProvider: mocks.updateProvider }));
vi.mock('./notifications.js', () => ({
  addNotification: mocks.addNotification,
  NOTIFICATION_TYPES: { AGENT_WARNING: 'agent_warning' },
  PRIORITY_LEVELS: { LOW: 'low' }
}));
vi.mock('./ollamaManager.js', () => ({
  getInstalledModels: mocks.ollamaInstalled,
  // Mirror the real predicate so localBackendForProvider classifies correctly.
  isOllamaProvider: (p) => p?.id === 'ollama' ||
    /ollama/i.test(p?.name || '') ||
    /(^|[/:])(?:localhost|127\.0\.0\.1|\[::1\]):11434\b/i.test(String(p?.endpoint || ''))
}));
vi.mock('./lmStudioManager.js', () => ({ getAvailableModels: mocks.lmStudioAvailable }));

const {
  localBackendForProvider,
  isModelNotFoundError,
  chooseFallbackModel,
  computeProviderPatch,
  healMissingLocalModel
} = await import('./localModelHealing.js');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateProvider.mockResolvedValue({ success: true });
  mocks.addNotification.mockResolvedValue({});
  mocks.ollamaInstalled.mockResolvedValue([]);
  mocks.lmStudioAvailable.mockResolvedValue([]);
});

describe('localBackendForProvider', () => {
  it('classifies Ollama by id, name, and port', () => {
    expect(localBackendForProvider({ id: 'ollama' })).toBe('ollama');
    expect(localBackendForProvider({ name: 'My Ollama' })).toBe('ollama');
    expect(localBackendForProvider({ endpoint: 'http://localhost:11434/v1' })).toBe('ollama');
  });

  it('classifies LM Studio by id, name, and port', () => {
    expect(localBackendForProvider({ id: 'lmstudio' })).toBe('lmstudio');
    expect(localBackendForProvider({ name: 'LM Studio' })).toBe('lmstudio');
    expect(localBackendForProvider({ name: 'lm-studio' })).toBe('lmstudio');
    expect(localBackendForProvider({ endpoint: 'http://127.0.0.1:1234/v1' })).toBe('lmstudio');
  });

  it('returns null for remote/CLI providers', () => {
    expect(localBackendForProvider({ id: 'anthropic', endpoint: 'https://api.anthropic.com/v1' })).toBeNull();
    expect(localBackendForProvider({ id: 'claude-code' })).toBeNull();
    expect(localBackendForProvider(null)).toBeNull();
  });
});

describe('isModelNotFoundError', () => {
  it('matches Ollama and LM Studio not-found messages', () => {
    expect(isModelNotFoundError('model "llama3" not found, try pulling it first')).toBe(true);
    expect(isModelNotFoundError('Provider returned 404: model \'foo\' not found')).toBe(true);
    expect(isModelNotFoundError('unknown model bar')).toBe(true);
    expect(isModelNotFoundError('model qwen does not exist')).toBe(true);
  });

  it('does NOT match "no models loaded" (separate recovery)', () => {
    expect(isModelNotFoundError('No models loaded')).toBe(false);
  });

  it('does not match unrelated errors', () => {
    expect(isModelNotFoundError('connection refused')).toBe(false);
    expect(isModelNotFoundError('')).toBe(false);
    expect(isModelNotFoundError(null)).toBe(false);
  });
});

describe('chooseFallbackModel', () => {
  it('prefers the editorial recommender', () => {
    const id = chooseFallbackModel([{ id: 'tiny:1b' }, { id: 'llama3.1:70b', params: '70B' }]);
    expect(id).toBe('llama3.1:70b');
  });

  it('falls back to the first non-embedding model when nothing ranks', () => {
    // recommendEditorialModel drops embeddings; chooseFallbackModel must too.
    const id = chooseFallbackModel([{ id: 'nomic-embed-text' }, { id: 'mystery-model' }]);
    expect(id).toBe('mystery-model');
  });

  it('returns null when given nothing', () => {
    expect(chooseFallbackModel([])).toBeNull();
    expect(chooseFallbackModel(null)).toBeNull();
  });
});

describe('computeProviderPatch', () => {
  it('repoints the default when it is the missing model', () => {
    const provider = { defaultModel: 'gone', models: ['gone'] };
    const patch = computeProviderPatch(provider, ['real'], 'real', 'gone');
    expect(patch.defaultModel).toBe('real');
    expect(patch.models).toEqual(['gone', 'real']);
  });

  it('repoints tier slots that point at uninstalled models', () => {
    const provider = { defaultModel: 'real', lightModel: 'gone', mediumModel: 'real', heavyModel: 'also-gone', models: ['real'] };
    const patch = computeProviderPatch(provider, ['real'], 'real', 'gone');
    expect(patch.lightModel).toBe('real');
    expect(patch.heavyModel).toBe('real');
    expect(patch.mediumModel).toBeUndefined(); // installed — left alone
    expect(patch.defaultModel).toBeUndefined(); // installed — left alone
  });

  it('does not duplicate the fallback in the models list', () => {
    const provider = { defaultModel: 'gone', models: ['gone', 'real'] };
    const patch = computeProviderPatch(provider, ['real'], 'real', 'gone');
    expect(patch.models).toBeUndefined();
  });
});

describe('healMissingLocalModel', () => {
  it('returns null for non-local providers (no enumeration possible)', async () => {
    const result = await healMissingLocalModel({ provider: { id: 'anthropic' }, requestedModel: 'claude-x' });
    expect(result).toBeNull();
    expect(mocks.updateProvider).not.toHaveBeenCalled();
  });

  it('returns null when nothing is installed to fall back to', async () => {
    mocks.ollamaInstalled.mockResolvedValue([]);
    const result = await healMissingLocalModel({ provider: { id: 'ollama', defaultModel: 'gone' }, requestedModel: 'gone' });
    expect(result).toBeNull();
  });

  it('returns null when the requested model is actually installed', async () => {
    mocks.ollamaInstalled.mockResolvedValue([{ id: 'llama3.1:8b' }]);
    const result = await healMissingLocalModel({ provider: { id: 'ollama', defaultModel: 'llama3.1:8b' }, requestedModel: 'llama3.1:8b' });
    expect(result).toBeNull();
    expect(mocks.updateProvider).not.toHaveBeenCalled();
  });

  it('repoints Ollama, persists, and notifies when the model is missing', async () => {
    mocks.ollamaInstalled.mockResolvedValue([{ id: 'llama3.1:70b', params: '70B' }, { id: 'tiny:1b' }]);
    const provider = { id: 'ollama', defaultModel: 'gone', models: ['gone'] };
    const result = await healMissingLocalModel({ provider, requestedModel: 'gone' });

    expect(result).toMatchObject({ healed: true, backend: 'ollama', model: 'llama3.1:70b', previous: 'gone' });
    expect(mocks.updateProvider).toHaveBeenCalledWith('ollama', expect.objectContaining({ defaultModel: 'llama3.1:70b' }));
    expect(mocks.addNotification).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent_warning' }));
    expect(mocks.emitLog).toHaveBeenCalledWith('warn', expect.stringContaining('llama3.1:70b'), expect.any(Object));
  });

  it('excludes LM Studio embedding models from the fallback pick', async () => {
    mocks.lmStudioAvailable.mockResolvedValue([
      { id: 'nomic-embed', type: 'embeddings' },
      { id: 'qwen2.5-7b-instruct', type: 'llm' }
    ]);
    const provider = { id: 'lmstudio', endpoint: 'http://localhost:1234/v1', defaultModel: 'gone', models: [] };
    const result = await healMissingLocalModel({ provider, requestedModel: 'gone' });
    expect(result.model).toBe('qwen2.5-7b-instruct');
  });

  it('still returns the heal result when persistence fails (best-effort)', async () => {
    mocks.ollamaInstalled.mockResolvedValue([{ id: 'llama3.1:8b' }]);
    mocks.updateProvider.mockRejectedValue(new Error('disk full'));
    const provider = { id: 'ollama', defaultModel: 'gone', models: [] };
    const result = await healMissingLocalModel({ provider, requestedModel: 'gone' });
    expect(result).toMatchObject({ healed: true, model: 'llama3.1:8b' });
  });
});
