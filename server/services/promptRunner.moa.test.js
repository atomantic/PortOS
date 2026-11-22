import { beforeEach, describe, expect, it, vi } from 'vitest';

// The MoA seam end to end: resolve `moa:<id>`, dispatch through
// runPromptThroughProvider, and re-enter it once per member as a bounded
// completion. Only the single-request executor and the stores are doubled.
vi.mock('./runner.js', () => ({
  createRun: vi.fn(), executeApiRun: vi.fn(), executeCliRun: vi.fn(), hasModelFlag: vi.fn(() => false),
  extractBakedModel: vi.fn(() => null), stopRun: vi.fn(), patchRunMetadata: vi.fn(async () => {}), finalizeRunRecord: vi.fn(),
}));
vi.mock('./apiCompletionRun.js', () => ({ executeApiCompletionRun: vi.fn() }));
vi.mock('./chatCompletionExchange.js', () => ({ completionContextRefusal: vi.fn(() => null) }));
vi.mock('./provider/providers.js', () => ({
  getActiveProvider: vi.fn(async () => ({ id: 'active', type: 'api', defaultModel: 'active-model' })),
  getProviderById: vi.fn(),
  getAllProviders: vi.fn(async () => ({ activeProvider: null, providers: [] })),
}));
const preset = vi.hoisted(() => ({
  id: 'council', name: 'Council', enabled: true, privacyFilter: 'off', advisorMaxTokens: 256,
  referenceModels: [{ providerId: 'a' }, { providerId: 'b', model: 'b-small' }],
  aggregator: { providerId: 'agg', model: 'agg-big' },
}));
vi.mock('./moaPresets.js', async () => {
  const { moaProviderRecord } = await import('../lib/moaConfig.js');
  return {
    getMoaPreset: vi.fn(async (id) => (id === 'council' ? preset : null)),
    resolveMoaProvider: vi.fn(async (id) => (id === 'moa:council' ? moaProviderRecord(preset) : null)),
  };
});

const providers = await import('./provider/providers.js');
const { executeApiCompletionRun } = await import('./apiCompletionRun.js');
const runner = await import('./runner.js');
const { resolveProviderAndModel, runPromptThroughProvider } = await import('./promptRunner.js');

const api = (id) => ({ id, name: id, type: 'api', enabled: true, defaultModel: `${id}-model` });

beforeEach(() => {
  vi.clearAllMocks();
  providers.getProviderById.mockImplementation(async (id) => api(id));
  executeApiCompletionRun.mockImplementation(async ({ provider, model }) => ({ text: `${provider.id}:${model}`, runId: `run-${provider.id}`, model, provider }));
});

describe('MoA through runPromptThroughProvider', () => {
  it('resolves moa:<id> to its virtual record and an unknown one to the active provider', async () => {
    expect(await resolveProviderAndModel({ providerId: 'moa:council' })).toMatchObject({ provider: { id: 'moa:council', type: 'moa' }, selectedModel: 'agg-big' });
    expect((await resolveProviderAndModel({ providerId: 'moa:gone' })).provider.id).toBe('active');
  });

  it('runs each member as its own bounded completion run and returns the aggregator answer', async () => {
    const { provider } = await resolveProviderAndModel({ providerId: 'moa:council' });
    const result = await runPromptThroughProvider({ provider, prompt: 'Explain caching.', source: 'ask', completion: { temperature: 0.3 } });

    const calls = executeApiCompletionRun.mock.calls.map(([args]) => args);
    expect(calls.map((c) => [c.provider.id, c.model])).toEqual([['a', 'a-model'], ['b', 'b-small'], ['agg', 'agg-big']]);
    expect(calls.slice(0, 2).every((c) => c.completion.maxTokens === 256 && c.prompt.startsWith('Explain caching.'))).toBe(true);
    expect(calls[2].completion).toEqual({ temperature: 0.3 });
    expect(calls[2].prompt).toMatch(/^Explain caching\.[\s\S]*<moa-advisory responded="2" of="2">[\s\S]*a:a-model[\s\S]*b:b-small/);
    expect(result).toMatchObject({ text: 'agg:agg-big', runId: 'run-agg', moa: { aggregatorRunId: 'run-agg' } });
    expect(runner.patchRunMetadata).toHaveBeenCalledWith('run-a', { moa: expect.objectContaining({ role: 'reference', parentRunId: 'run-agg' }) });
  });
});
