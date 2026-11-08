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
vi.mock('./cosState.js', () => ({
  getConfig: vi.fn(),
}));
vi.mock('./cos.js', () => ({
  updateConfig: vi.fn(),
}));

const { detectSystemCapabilities } = await import('../lib/systemCapabilities.js');
const { findCommandOnPath } = await import('../lib/processEnv.js');
const { getProviderById, updateProvider } = await import('./providers.js');
const { listModels } = await import('./localLlm.js');
const ollamaManager = await import('./ollamaManager.js');
const { getConfig } = await import('./cosState.js');
const { updateConfig } = await import('./cos.js');
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

  it('does not report a mind profile pinned to an unpulled model as ready', async () => {
    listModels.mockResolvedValue([]);
    getConfig.mockResolvedValue({
      persistentMindProfile: { enabled: true, providerId: 'ollama', model: 'qwen2.5:7b-instruct' },
    });
    const status = await describeLocalPersistentMindSetup();
    const mindStep = status.steps.find((s) => s.id === 'mind-profile');
    expect(mindStep.status).toBe('todo');
    expect(mindStep.detail).toMatch(/not pulled/);
    expect(status.mindProfileReady).toBe(false);
    expect(status.modelCatalog).toBe('listed');
  });

  it('does not call a stopped daemon "model not pulled"', async () => {
    ollamaManager.getStatus.mockResolvedValue({ available: false });
    getConfig.mockResolvedValue({
      persistentMindProfile: { enabled: true, providerId: 'ollama', model: 'qwen2.5:7b-instruct' },
    });
    const status = await describeLocalPersistentMindSetup();
    const mindStep = status.steps.find((s) => s.id === 'mind-profile');
    expect(status.modelCatalog).toBe('daemon-down');
    expect(mindStep.status).toBe('todo');
    expect(mindStep.detail).toMatch(/unavailable/);
    expect(mindStep.detail).not.toMatch(/not pulled/);
    expect(listModels).not.toHaveBeenCalled();
  });

  it('does not treat an unreadable model list as proof the model is missing', async () => {
    listModels.mockRejectedValue(new Error('tags failed'));
    getConfig.mockResolvedValue({
      persistentMindProfile: { enabled: true, providerId: 'ollama', model: 'qwen2.5:7b-instruct' },
    });
    const status = await describeLocalPersistentMindSetup();
    const mindStep = status.steps.find((s) => s.id === 'mind-profile');
    expect(status.modelCatalog).toBe('list-failed');
    expect(status.steps.find((s) => s.id === 'model-present').status).toBe('blocked');
    expect(mindStep.detail).toMatch(/could not be read/);
    expect(mindStep.detail).not.toMatch(/not pulled/);
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

  it('refuses to pin the mind profile before the recommended model is pulled', async () => {
    listModels.mockResolvedValue([]);
    const result = await applyLocalPersistentMindSetup({ setMindProfile: true });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Pull `qwen2\.5:7b-instruct`/);
    expect(updateProvider).not.toHaveBeenCalled();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('enables the provider without repointing its default model when nothing is pulled', async () => {
    listModels.mockResolvedValue([]);
    getProviderById.mockResolvedValue({
      id: 'ollama',
      enabled: false,
      defaultModel: 'llama3.2:3b',
      models: ['llama3.2:3b'],
    });
    const result = await applyLocalPersistentMindSetup({ setMindProfile: false });
    expect(result.success).toBe(true);
    expect(updateProvider).toHaveBeenCalledWith('ollama', { enabled: true });
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('refuses an explicit recommended tag that the daemon has not listed', async () => {
    listModels.mockResolvedValue([{ id: 'llama3.2:3b' }]);
    const result = await applyLocalPersistentMindSetup({
      setMindProfile: true,
      modelId: 'qwen2.5:7b-instruct',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Pull `qwen2\.5:7b-instruct`/);
    expect(updateProvider).not.toHaveBeenCalled();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('pins the installed alias when the request names the unpulled recommended spelling', async () => {
    listModels.mockResolvedValue([{ id: 'qwen2.5:7b' }]);
    const result = await applyLocalPersistentMindSetup({
      setMindProfile: true,
      modelId: 'qwen2.5:7b-instruct',
    });
    expect(result.success).toBe(true);
    expect(updateProvider).toHaveBeenCalledWith('ollama', expect.objectContaining({
      enabled: true,
      defaultModel: 'qwen2.5:7b',
    }));
    expect(updateConfig).toHaveBeenCalledWith({
      persistentMindProfile: expect.objectContaining({ model: 'qwen2.5:7b' }),
    });
  });

  it('refuses to pin while Ollama is not answering', async () => {
    ollamaManager.getStatus.mockResolvedValue({ available: false });
    const result = await applyLocalPersistentMindSetup({ setMindProfile: true });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Start Ollama/);
    expect(result.error).not.toMatch(/not pulled/);
    expect(updateProvider).not.toHaveBeenCalled();
  });

  it('refuses apply on hosts outside the free local-mind path', async () => {
    detectSystemCapabilities.mockResolvedValue(apple64);
    const result = await applyLocalPersistentMindSetup({ setMindProfile: true });
    expect(result.success).toBe(false);
    expect(updateProvider).not.toHaveBeenCalled();
    expect(updateConfig).not.toHaveBeenCalled();
  });
});
