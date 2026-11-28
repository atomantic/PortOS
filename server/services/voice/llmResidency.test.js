import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProviderById: vi.fn(),
  fetchWithTimeout: vi.fn(),
  ollamaLoaded: vi.fn(),
  lmStudioLoaded: vi.fn(),
}));

vi.mock('../provider/providers.js', () => ({ getProviderById: mocks.getProviderById }));
vi.mock('../../lib/fetchWithTimeout.js', () => ({ fetchWithTimeout: mocks.fetchWithTimeout }));
vi.mock('../ollamaManager.js', () => ({ getLoadedModelsAt: mocks.ollamaLoaded }));
vi.mock('../lmStudioManager.js', () => ({ getLoadedModelsAt: mocks.lmStudioLoaded }));

const { probeVoiceLlmResidency } = await import('./llmResidency.js');

const json = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('probeVoiceLlmResidency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads Ollama residency at the provider endpoint and treats a bare tag as :latest', async () => {
    mocks.getProviderById.mockResolvedValue({ id: 'ollama', endpoint: 'http://localhost:11434/v1' });
    mocks.ollamaLoaded.mockResolvedValue({ models: [{ id: 'model-a:latest' }], error: null });
    await expect(probeVoiceLlmResidency({ providerId: 'ollama', apiBase: 'http://localhost:11434/v1', model: 'model-a' }))
      .resolves.toEqual({ state: 'loaded', runtime: 'ollama', model: 'model-a' });
    expect(mocks.ollamaLoaded).toHaveBeenCalledWith('http://localhost:11434', expect.any(Object));

    mocks.ollamaLoaded.mockResolvedValue({ models: [{ id: 'model-b:7b' }], error: null });
    expect((await probeVoiceLlmResidency({ providerId: 'ollama', apiBase: 'http://localhost:11434/v1', model: 'model-a' })).state).toBe('unloaded');
  });

  it('answers unknown instead of unloaded when the residency list could not be read', async () => {
    mocks.getProviderById.mockResolvedValue({ id: 'lmstudio', endpoint: 'http://localhost:1234/v1' });
    mocks.lmStudioLoaded.mockResolvedValue({ models: [], error: 'unreachable' });
    expect((await probeVoiceLlmResidency({ providerId: 'lmstudio', apiBase: 'http://localhost:1234/v1', model: 'm' })).state).toBe('unknown');
  });

  it('maps llama-server health and idle sleep onto loading, unloaded and loaded', async () => {
    mocks.getProviderById.mockResolvedValue({ id: 'llama', llamaBacked: true, endpoint: 'http://localhost:8080/v1' });
    const target = { providerId: 'llama', apiBase: 'http://localhost:8080/v1', model: 'm' };

    mocks.fetchWithTimeout.mockResolvedValueOnce(json(503));
    expect((await probeVoiceLlmResidency(target)).state).toBe('loading');

    mocks.fetchWithTimeout.mockResolvedValueOnce(json(200)).mockResolvedValueOnce(json(200, { is_sleeping: true }));
    expect((await probeVoiceLlmResidency(target)).state).toBe('unloaded');

    mocks.fetchWithTimeout.mockResolvedValueOnce(json(200)).mockResolvedValueOnce(json(200, { is_sleeping: false }));
    expect((await probeVoiceLlmResidency(target)).state).toBe('loaded');

    mocks.fetchWithTimeout.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect((await probeVoiceLlmResidency(target)).state).toBe('offline');
  });

  it('says nothing about a hosted provider', async () => {
    mocks.getProviderById.mockResolvedValue({ id: 'hosted', endpoint: 'https://api.example.com/v1' });
    expect((await probeVoiceLlmResidency({ providerId: 'hosted', apiBase: 'https://api.example.com/v1', model: 'm' })).state).toBe('unknown');
    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled();
  });
});
