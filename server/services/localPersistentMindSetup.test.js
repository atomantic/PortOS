import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/systemCapabilities.js', () => ({
  detectSystemCapabilities: vi.fn(),
}));
vi.mock('../lib/processEnv.js', () => ({
  findCommandOnPath: vi.fn(),
}));
vi.mock('./providers.js', () => ({
  getProviderById: vi.fn(),
  updateProvider: vi.fn(),
}));
vi.mock('./localLlm.js', () => ({
  listModels: vi.fn(),
}));
vi.mock('./ollamaManager.js', () => ({
  getStatus: vi.fn(),
}));
vi.mock('./cos.js', () => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
}));

const { detectSystemCapabilities } = await import('../lib/systemCapabilities.js');
const { findCommandOnPath } = await import('../lib/processEnv.js');
const { getProviderById, updateProvider } = await import('./providers.js');
const { listModels } = await import('./localLlm.js');
const ollamaManager = await import('./ollamaManager.js');
const { getConfig, updateConfig } = await import('./cos.js');
const {
  applyLocalPersistentMindSetup,
  describeLocalPersistentMindSetup,
} = await import('./localPersistentMindSetup.js');

const grokBox = {
  platform: 'linux',
  appleSilicon: false,
  totalMemoryGb: 16,
  cuda: { status: 'absent', gpus: [], maxVramGb: null },
};

const apple64 = {
  platform: 'darwin',
  appleSilicon: true,
  totalMemoryGb: 64,
  cuda: { status: 'absent', gpus: [], maxVramGb: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  detectSystemCapabilities.mockResolvedValue(grokBox);
  findCommandOnPath.mockResolvedValue('/usr/local/bin/ollama');
  ollamaManager.getStatus.mockResolvedValue({ available: true });
  listModels.mockResolvedValue([{ id: 'qwen2.5:7b-instruct' }]);
  getProviderById.mockResolvedValue({
    id: 'ollama',
    enabled: false,
    defaultModel: null,
    models: [],
  });
  getConfig.mockResolvedValue({
    persistentMindProfile: { enabled: false, providerId: '', model: '' },
  });
  updateProvider.mockResolvedValue({ id: 'ollama', enabled: true });
  updateConfig.mockImplementation(async (updates) => ({
    persistentMindProfile: updates.persistentMindProfile,
  }));
});

describe('describeLocalPersistentMindSetup', () => {
  it('skips on curated GPU coding hosts', async () => {
    detectSystemCapabilities.mockResolvedValue(apple64);
    const status = await describeLocalPersistentMindSetup();
    expect(status.applicable).toBe(false);
    expect(status.recommendation).toBeNull();
    expect(status.steps[0].status).toBe('skipped');
  });

  it('reports todo steps on a fresh Grok-box host', async () => {
    listModels.mockResolvedValue([]);
    const status = await describeLocalPersistentMindSetup();
    expect(status.applicable).toBe(true);
    expect(status.recommendation.model).toBe('qwen2.5:7b-instruct');
    expect(status.steps.find((s) => s.id === 'ollama-installed').status).toBe('ready');
    expect(status.steps.find((s) => s.id === 'model-present').status).toBe('todo');
    expect(status.steps.find((s) => s.id === 'model-present').action?.modelId).toBe('qwen2.5:7b-instruct');
    expect(status.steps.find((s) => s.id === 'provider-enabled').status).toBe('todo');
    expect(status.ready).toBe(false);
  });

  it('accepts qwen2.5:7b as satisfying the model step', async () => {
    listModels.mockResolvedValue([{ id: 'qwen2.5:7b' }]);
    getProviderById.mockResolvedValue({
      id: 'ollama',
      enabled: true,
      defaultModel: 'qwen2.5:7b',
      models: ['qwen2.5:7b'],
    });
    const status = await describeLocalPersistentMindSetup();
    expect(status.matchedModel).toBe('qwen2.5:7b');
    expect(status.steps.find((s) => s.id === 'model-present').status).toBe('ready');
    expect(status.steps.find((s) => s.id === 'provider-enabled').status).toBe('ready');
  });
});

describe('applyLocalPersistentMindSetup', () => {
  it('enables the ollama provider and optionally pins the mind profile', async () => {
    const result = await applyLocalPersistentMindSetup({ setMindProfile: true });
    expect(result.success).toBe(true);
    expect(updateProvider).toHaveBeenCalledWith('ollama', expect.objectContaining({
      enabled: true,
      defaultModel: 'qwen2.5:7b-instruct',
      models: expect.arrayContaining(['qwen2.5:7b-instruct']),
    }));
    expect(updateConfig).toHaveBeenCalledWith({
      persistentMindProfile: expect.objectContaining({
        enabled: true,
        providerId: 'ollama',
        model: 'qwen2.5:7b-instruct',
      }),
    });
    expect(result.profile.providerId).toBe('ollama');
  });

  it('refuses apply on hosts outside the free local-mind path', async () => {
    detectSystemCapabilities.mockResolvedValue(apple64);
    const result = await applyLocalPersistentMindSetup({ setMindProfile: true });
    expect(result.success).toBe(false);
    expect(updateProvider).not.toHaveBeenCalled();
    expect(updateConfig).not.toHaveBeenCalled();
  });
});
