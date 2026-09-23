import { afterEach, expect, it, vi } from 'vitest';
import { modelComparisonImportSchema } from '../lib/validation.js';

vi.mock('./modelComparison.js', () => ({
  importModelComparison: vi.fn(async value => value),
}));

const {
  importModelComparison,
} = await import('./modelComparison.js');
const {
  syncOpenRouterCatalog,
  transformOpenRouterEndpointsToObservations,
  transformOpenRouterModelsToObservations,
} = await import('./openrouterBenchmarks.js');

const retrievedAt = '2026-09-23T00:00:00.000Z';

afterEach(() => {
  vi.restoreAllMocks();
  importModelComparison.mockClear();
});

it('keeps routed pricing separate from first-party pricing and creates a distinct long-context identity', () => {
  const observations = transformOpenRouterModelsToObservations([{
    id: 'example/model-x',
    name: 'Model X',
    pricing: {
      prompt: '0.000001',
      completion: '0.000002',
      internal_reasoning: '0.000003',
      overrides: [{ min_prompt_tokens: 128, prompt: '0.000004' }],
    },
  }], { retrievedAt });

  expect(observations).toHaveLength(2);
  const standard = observations.find(row => row.configuration.includes('standard pricing tier'));
  const longContext = observations.find(row => row.configuration.includes('minimum 128 prompt tokens'));
  expect(standard).toMatchObject({
    provider: 'OpenRouter',
    benchmark: 'OpenRouter routed API pricing',
    inputPerMillion: { value: 1, source: { url: 'https://openrouter.ai/api/v1/models', retrievedAt } },
    outputPerMillion: { value: 2 },
    reasoningPerMillion: { value: 3 },
  });
  expect(longContext).toMatchObject({
    provider: 'OpenRouter',
    inputPerMillion: { value: 4 },
    outputPerMillion: { value: 2 },
    reasoningPerMillion: { value: 3 },
  });
  expect(longContext.id).not.toBe(standard.id);
  expect(standard.configuration).toContain('example/model-x');
  expect(standard.notes).toContain('not the model creator first-party price');
  expect(modelComparisonImportSchema.parse({ schemaVersion: 1, observations }).observations).toHaveLength(2);
});

it('preserves free-route zero prices and separates UTC-window tiers when published', () => {
  const observations = transformOpenRouterModelsToObservations([{
    id: 'example/model-x:free',
    name: 'Model X (free)',
    pricing: {
      prompt: '0',
      completion: '0',
      overrides: [{ utc_days: ['Saturday', 'Sunday'], prompt: '0.000001' }],
    },
  }], { retrievedAt });

  expect(observations).toHaveLength(2);
  expect(observations[0].inputPerMillion.value).toBe(0);
  expect(observations[0].outputPerMillion.value).toBe(0);
  expect(observations[1].inputPerMillion.value).toBe(1);
  expect(observations[1].configuration).toContain('saturday, sunday');
  expect(new Set(observations.map(row => row.id)).size).toBe(2);
});

it('skips OpenRouter meta-models whose documented price sentinel means unavailable', () => {
  const observations = transformOpenRouterModelsToObservations([
    { id: 'example/model-x', name: 'Model X', pricing: { prompt: '0.000001', completion: '0.000002' } },
    { id: 'openrouter/auto', name: 'Auto Router', pricing: { prompt: '-1', completion: '-1' } },
  ], { retrievedAt });

  expect(observations).toHaveLength(1);
  expect(observations[0].provider).toBe('OpenRouter');
  expect(observations[0].inputPerMillion.value).toBe(1);
});

it('keeps speed metrics on the serving endpoint that reported them and preserves nulls', () => {
  const observations = transformOpenRouterEndpointsToObservations([{
    model: { id: 'example/model-x', name: 'Model X' },
    endpoints: [
      {
        provider_name: 'Example Hosting', tag: 'fast', name: 'Model X Fast', model_id: 'example/model-x-fast', quantization: 'fp8',
        context_length: 64000, max_completion_tokens: 8192,
        latency_last_30m: { p50: 0.8 }, throughput_last_30m: { p50: null },
      },
      {
        provider_name: 'Other Hosting', tag: 'standard', name: 'Model X Standard', model_id: 'example/model-x-standard', quantization: 'int8',
        context_length: 32000, max_completion_tokens: 4096,
        latency_last_30m: { p50: null }, throughput_last_30m: { p50: 42 },
      },
    ],
  }], { retrievedAt });

  expect(observations).toHaveLength(2);
  expect(observations[0]).toMatchObject({
    responseSeconds: { value: 0.8, source: { retrievedAt, url: 'https://openrouter.ai/api/v1/models/example/model-x/endpoints' } },
    tokensPerSecond: null,
    inputPerMillion: null,
    outputPerMillion: null,
  });
  expect(observations[1]).toMatchObject({ responseSeconds: null, tokensPerSecond: { value: 42 } });
  expect(observations[0].configuration).toContain('Example Hosting');
  expect(observations[0].configuration).toContain('example/model-x-fast');
  expect(observations[0].configuration).toContain('fp8');
  expect(observations[1].configuration).toContain('Other Hosting');
  expect(new Set(observations.map(row => row.id)).size).toBe(2);
  expect(modelComparisonImportSchema.parse({ schemaVersion: 1, observations }).observations).toHaveLength(2);
});

it('rejects an empty upstream catalog before importing any evidence', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ data: [] }),
  });

  await expect(syncOpenRouterCatalog()).rejects.toMatchObject({ status: 502 });
  expect(importModelComparison).not.toHaveBeenCalled();
});
