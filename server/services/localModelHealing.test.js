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
  getBaseUrl: () => 'http://localhost:11434',
  // Mirror the real predicate so localBackendForProvider classifies correctly.
  isOllamaProvider: (p) => p?.id === 'ollama' ||
    /ollama/i.test(p?.name || '') ||
    /(^|[/:])(?:localhost|127\.0\.0\.1|\[::1\]):11434\b/i.test(String(p?.endpoint || ''))
}));
vi.mock('./lmStudioManager.js', () => ({
  getAvailableModels: mocks.lmStudioAvailable,
  getBaseUrl: () => 'http://localhost:1234'
}));

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

  it('classifies an endpoint-only provider by port across loopback/bind-all spellings', () => {
    // No id/name — only the endpoint identifies the backend. Every local-host
    // spelling on the default port must classify.
    expect(localBackendForProvider({ endpoint: 'http://127.0.0.53:11434/v1' })).toBe('ollama');
    expect(localBackendForProvider({ endpoint: 'http://0.0.0.0:11434' })).toBe('ollama');
    expect(localBackendForProvider({ endpoint: 'http://[::1]:1234/v1' })).toBe('lmstudio');
    expect(localBackendForProvider({ endpoint: 'http://0.0.0.0:1234' })).toBe('lmstudio');
  });

  it('returns null for remote/CLI providers', () => {
    expect(localBackendForProvider({ id: 'anthropic', endpoint: 'https://api.anthropic.com/v1' })).toBeNull();
    expect(localBackendForProvider({ id: 'claude-code' })).toBeNull();
    // A LAN/Tailscale peer on the backend's default port is NOT a local backend.
    expect(localBackendForProvider({ endpoint: 'http://192.168.1.20:11434/v1' })).toBeNull();
    expect(localBackendForProvider({ endpoint: 'http://10.0.0.5:1234' })).toBeNull();
    // Local instance but not a known backend port.
    expect(localBackendForProvider({ endpoint: 'http://localhost:9999' })).toBeNull();
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

    expect(result).toMatchObject({ healed: true, backend: 'ollama', model: 'llama3.1:70b', previous: 'gone', persisted: true });
    expect(mocks.updateProvider).toHaveBeenCalledWith('ollama', expect.objectContaining({ defaultModel: 'llama3.1:70b' }));
    expect(mocks.addNotification).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent_warning' }));
    expect(mocks.emitLog).toHaveBeenCalledWith('warn', expect.stringContaining('updated the provider default'), expect.any(Object));
  });

  it('declines to heal when the provider endpoint points at a different instance', async () => {
    // Ollama manager lists from localhost:11434; this provider is a remote
    // Ollama on another host — healing from the local list would persist a
    // model that isn't installed on the remote.
    mocks.ollamaInstalled.mockResolvedValue([{ id: 'llama3.1:8b' }]);
    const provider = { id: 'ollama', endpoint: 'http://10.0.0.5:11434/v1', defaultModel: 'gone', models: [] };
    const result = await healMissingLocalModel({ provider, requestedModel: 'gone' });
    expect(result).toBeNull();
    expect(mocks.ollamaInstalled).not.toHaveBeenCalled();
    expect(mocks.updateProvider).not.toHaveBeenCalled();
  });

  it.each([
    ['127.0.0.1', 'http://127.0.0.1:11434/v1'],
    ['127.0.0.53', 'http://127.0.0.53:11434/v1'], // anywhere in 127.0.0.0/8
    ['0.0.0.0 bind-all', 'http://0.0.0.0:11434/v1'] // manager bound to all interfaces, reached as localhost
  ])('treats loopback/bind-all host %s as the same instance as localhost', async (_label, endpoint) => {
    // Manager lists from localhost:11434; these all name the SAME instance and
    // must not be refused over a host-spelling difference.
    mocks.ollamaInstalled.mockResolvedValue([{ id: 'llama3.1:8b' }]);
    const provider = { id: 'ollama', endpoint, defaultModel: 'gone', models: [] };
    const result = await healMissingLocalModel({ provider, requestedModel: 'gone' });
    expect(result).toMatchObject({ healed: true, model: 'llama3.1:8b' });
  });

  it('reports persisted:false when updateProvider returns null (provider id gone)', async () => {
    mocks.ollamaInstalled.mockResolvedValue([{ id: 'llama3.1:8b' }]);
    mocks.updateProvider.mockResolvedValue(null); // toolkit returns null for an unknown id
    const provider = { id: 'stale-ollama', name: 'Ollama', defaultModel: 'gone', models: [] };
    const result = await healMissingLocalModel({ provider, requestedModel: 'gone' });
    expect(result).toMatchObject({ healed: true, model: 'llama3.1:8b', persisted: false });
    const [, message] = mocks.emitLog.mock.calls[0];
    expect(message).toContain('for this run');
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

  it('returns persisted:false and does not claim the default was saved when persistence fails', async () => {
    mocks.ollamaInstalled.mockResolvedValue([{ id: 'llama3.1:8b' }]);
    mocks.updateProvider.mockRejectedValue(new Error('disk full'));
    const provider = { id: 'ollama', defaultModel: 'gone', models: [] };
    const result = await healMissingLocalModel({ provider, requestedModel: 'gone' });
    // The run still recovers (heal returns the working model)...
    expect(result).toMatchObject({ healed: true, model: 'llama3.1:8b', persisted: false });
    // ...but the user is NOT told the default was saved.
    const [, message] = mocks.emitLog.mock.calls[0];
    expect(message).toContain('for this run');
    expect(message).not.toContain('updated the provider default');
  });
});
