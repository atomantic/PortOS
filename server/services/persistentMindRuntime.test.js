import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getMemoryStats: vi.fn(),
  getLoadedOllamaModelsAt: vi.fn(),
  getLoadedLmStudioModelsAt: vi.fn(),
  probeOpenAiModels: vi.fn(),
  preparePersistentMindContext: vi.fn(),
  readPersistentMindMemories: vi.fn(),
}));

vi.mock('../lib/memoryStats.js', () => ({ getMemoryStats: mocks.getMemoryStats }));
vi.mock('../lib/openAiModelsProbe.js', () => ({ probeOpenAiModels: mocks.probeOpenAiModels }));
vi.mock('./ollamaManager.js', () => ({
  getLoadedModelsAt: mocks.getLoadedOllamaModelsAt,
}));
vi.mock('./lmStudioManager.js', () => ({
  getLoadedModelsAt: mocks.getLoadedLmStudioModelsAt,
  modelIdsReferToSameRepo: (left, right) => String(left).split('/').pop().toLowerCase() === String(right).split('/').pop().toLowerCase(),
}));
vi.mock('./persistentMindContext.js', () => ({
  preparePersistentMindContext: mocks.preparePersistentMindContext,
  readPersistentMindMemories: mocks.readPersistentMindMemories,
}));

import {
  inspectPersistentMindRuntime,
  persistentMindLocalBackend,
  persistentMindModelMatches,
} from './persistentMindRuntime.js';

describe('persistent mind runtime telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMemoryStats.mockResolvedValue({ total: 1000, used: 400, free: 600 });
    mocks.getLoadedOllamaModelsAt.mockResolvedValue({ models: [], error: null });
    mocks.getLoadedLmStudioModelsAt.mockResolvedValue({ models: [], error: null });
    mocks.probeOpenAiModels.mockResolvedValue({ reachable: true, models: [], error: null });
    mocks.readPersistentMindMemories.mockResolvedValue([{ id: 'memory-1' }]);
    mocks.preparePersistentMindContext.mockResolvedValue({ chars: 1200, approximateTokens: 300, summaryState: 'ready' });
  });

  it('only treats the configured local endpoints as directly observable backends', () => {
    expect(persistentMindLocalBackend({ id: 'ollama', endpoint: 'http://localhost:11434/v1' })).toBe('ollama');
    expect(persistentMindLocalBackend({ id: 'lmstudio', endpoint: 'http://localhost:1234/v1' })).toBe('lmstudio');
    expect(persistentMindLocalBackend({ command: 'opencode', llamaBacked: true, endpoint: 'http://localhost:5568/v1' })).toBe('llama');
    expect(persistentMindLocalBackend({ id: 'ollama', endpoint: 'http://example.com:11434/v1' })).toBeNull();
    expect(persistentMindLocalBackend({ id: 'codex' })).toBeNull();
  });

  it('reconciles Ollama latest tags and LM Studio repository ids', () => {
    expect(persistentMindModelMatches('ollama', 'Qwen3:latest', { id: 'qwen3' })).toBe(true);
    expect(persistentMindModelMatches('lmstudio', 'publisher/example-model', { id: 'other/example-model' })).toBe(true);
    expect(persistentMindModelMatches('ollama', 'qwen3', { id: 'other-model' })).toBe(false);
  });

  it('reports active inference, exact context size, memory usage, and local model residency', async () => {
    mocks.getLoadedOllamaModelsAt.mockResolvedValue({
      models: [{ id: 'QWEN3', sizeVram: 200, expiresAt: '2026-08-27T13:00:00.000Z' }],
      error: null,
    });
    const runtime = await inspectPersistentMindRuntime({
      state: { activeTurn: { id: 'turn-1', startedAt: '2026-08-27T12:00:00.000Z', providerId: 'ollama', model: 'qwen3' } },
      profile: { providerId: 'ollama', model: 'configured-model' },
      prompt: { identity: 'Resident mind', instructions: 'Stay grounded.' },
      provider: { id: 'ollama', endpoint: 'http://localhost:11500/v1' },
    });

    expect(runtime).toMatchObject({
      inference: {
        active: true,
        turnId: 'turn-1',
        providerId: 'ollama',
        model: 'qwen3',
        residency: { status: 'loaded', backend: 'ollama', loaded: true, memoryBytes: 200 },
      },
      context: { chars: 1200, maxChars: 32000, approximateTokens: 300, summaryState: 'ready', memoryCount: 1 },
      system: { memory: { total: 1000, used: 400, free: 600, usagePercent: 40 } },
    });
    expect(mocks.preparePersistentMindContext).toHaveBeenCalledWith({
      identity: 'Resident mind', instructions: 'Stay grounded.', memories: [{ id: 'memory-1' }],
    });
    expect(mocks.getLoadedOllamaModelsAt).toHaveBeenCalledWith('http://localhost:11500/v1');
  });

  it('does not misreport a failed local residency probe as an unloaded model', async () => {
    mocks.getLoadedOllamaModelsAt.mockResolvedValue({ models: [], error: 'Ollama unavailable' });
    const runtime = await inspectPersistentMindRuntime({
      state: { activeTurn: null },
      profile: { providerId: 'ollama', model: 'qwen3' },
      prompt: {},
      provider: { id: 'ollama', endpoint: 'http://localhost:11434/v1' },
    });
    expect(runtime.inference.residency).toMatchObject({ status: 'unknown', loaded: null });
  });

  it('uses an LM Studio provider endpoint for its residency probe', async () => {
    mocks.getLoadedLmStudioModelsAt.mockResolvedValue({
      models: [{ id: 'publisher/example-model' }],
      error: null,
    });
    const runtime = await inspectPersistentMindRuntime({
      state: { activeTurn: null },
      profile: { providerId: 'lmstudio', model: 'publisher/example-model' },
      prompt: {},
      provider: { id: 'lmstudio', endpoint: 'http://localhost:12400/v1' },
    });

    expect(mocks.getLoadedLmStudioModelsAt).toHaveBeenCalledWith('http://localhost:12400/v1');
    expect(runtime.inference.residency).toMatchObject({ status: 'loaded', backend: 'lmstudio', loaded: true });
  });

  it('reports model residency for other local OpenAI-compatible runtimes', async () => {
    mocks.probeOpenAiModels.mockResolvedValue({ reachable: true, models: ['dflash'], error: null });
    const runtime = await inspectPersistentMindRuntime({
      state: { activeTurn: null },
      profile: { providerId: 'opencode-llama', model: 'dflash' },
      prompt: {},
      provider: {
        id: 'opencode-llama',
        command: 'opencode',
        llamaBacked: true,
        endpoint: 'http://localhost:5568/v1',
      },
    });

    expect(mocks.probeOpenAiModels).toHaveBeenCalledWith('http://localhost:5568/v1', { apiKey: '' });
    expect(runtime.inference.residency).toMatchObject({ status: 'loaded', backend: 'llama', loaded: true });
  });
});
