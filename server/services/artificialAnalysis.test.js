import { describe, expect, it, vi } from 'vitest';
import {
  slugify,
  parseModelNameAndEffort,
  transformAAModelsToObservations,
  fetchAllArtificialAnalysisModels,
  syncArtificialAnalysisCatalog,
} from './artificialAnalysis.js';
import * as modelComparison from './modelComparison.js';

describe('artificialAnalysis service', () => {
  describe('slugify', () => {
    it('normalizes names into url-safe slugs', () => {
      expect(slugify('GPT-5.6 Sol')).toBe('gpt-5.6-sol');
      expect(slugify('Claude Opus 5 (Adaptive Reasoning)')).toBe('claude-opus-5-adaptive-reasoning');
      expect(slugify('   DeepSeek  V4 Pro   ')).toBe('deepseek-v4-pro');
      expect(slugify('')).toBe('');
      expect(slugify(null)).toBe('');
    });
  });

  describe('parseModelNameAndEffort', () => {
    it('extracts base model and reasoning effort from parenthetical tags', () => {
      expect(parseModelNameAndEffort('GPT-5.6 Sol (low)')).toEqual({
        baseName: 'GPT-5.6 Sol',
        modelSlug: 'gpt-5.6-sol',
        effort: 'low',
        configDetail: 'low',
      });

      expect(parseModelNameAndEffort('GPT-5.6 Terra (max)')).toEqual({
        baseName: 'GPT-5.6 Terra',
        modelSlug: 'gpt-5.6-terra',
        effort: 'max',
        configDetail: 'max',
      });

      expect(parseModelNameAndEffort('Claude Opus 5 (Adaptive Reasoning, Xhigh Effort)')).toEqual({
        baseName: 'Claude Opus 5',
        modelSlug: 'claude-opus-5',
        effort: 'xhigh',
        configDetail: 'Adaptive Reasoning, Xhigh Effort',
      });

      expect(parseModelNameAndEffort('Gemini 3.5 Flash (minimal)')).toEqual({
        baseName: 'Gemini 3.5 Flash',
        modelSlug: 'gemini-3.5-flash',
        effort: 'minimal',
        configDetail: 'minimal',
      });

      expect(parseModelNameAndEffort('MiMo-V2.5-Pro (Non-reasoning)')).toEqual({
        baseName: 'MiMo-V2.5-Pro',
        modelSlug: 'mimo-v2.5-pro',
        effort: 'non-reasoning',
        configDetail: 'Non-reasoning',
      });

      expect(parseModelNameAndEffort('DeepSeek R1 (Reasoning)')).toEqual({
        baseName: 'DeepSeek R1',
        modelSlug: 'deepseek-r1',
        effort: 'reasoning',
        configDetail: 'Reasoning',
      });

      expect(parseModelNameAndEffort('Mistral Large 3')).toEqual({
        baseName: 'Mistral Large 3',
        modelSlug: 'mistral-large-3',
        effort: 'unspecified',
        configDetail: '',
      });
    });
  });

  describe('transformAAModelsToObservations', () => {
    it('transforms raw AA models into schema-compliant observations and preserves reference identities', () => {
      const sampleModels = [
        {
          id: 'aa-uuid-1',
          name: 'GPT-5.6 Sol (max)',
          slug: 'gpt-5-6-sol',
          model_creator: { name: 'OpenAI' },
          evaluations: { artificial_analysis_intelligence_index: 51.3 },
          artificial_analysis_intelligence_index_cost: { cost_per_task: { total_cost: 1.2495 } },
          pricing: { price_1m_input_tokens: 4, price_1m_output_tokens: 20 },
          performance: {
            median_end_to_end_response_time_seconds: 113.0,
            median_output_tokens_per_second: 85.5,
          },
        },
        {
          id: 'aa-uuid-2',
          name: 'GPT-5.6 Sol (medium)',
          slug: 'gpt-5-6-sol-medium',
          model_creator: { name: 'OpenAI' },
          evaluations: { artificial_analysis_intelligence_index: 46.0 },
          artificial_analysis_intelligence_index_cost: { cost_per_task: { total_cost: 0.3671 } },
          pricing: { price_1m_input_tokens: 4, price_1m_output_tokens: 20 },
          performance: {
            median_end_to_end_response_time_seconds: 11.9,
            median_output_tokens_per_second: 70.2,
          },
        },
        {
          id: 'aa-uuid-3',
          name: 'Claude Fable 5.1 (Adaptive Reasoning, Max Effort, Default Fallback)',
          slug: 'claude-fable-5-1',
          model_creator: { name: 'Anthropic' },
          evaluations: { artificial_analysis_intelligence_index: 56.8 },
          artificial_analysis_intelligence_index_cost: { cost_per_task: { total_cost: 6.1169 } },
          pricing: { price_1m_input_tokens: 10, price_1m_output_tokens: 50 },
          performance: {
            median_end_to_end_response_time_seconds: 273.9,
            median_output_tokens_per_second: 67.1,
          },
        },
      ];

      const obs = transformAAModelsToObservations(sampleModels, { retrievedAt: '2026-09-05T00:00:00Z' });
      expect(obs).toHaveLength(3);

      const solMax = obs.find(o => o.effort === 'max' && o.model === 'gpt-5.6-sol');
      expect(solMax).toBeDefined();
      expect(solMax.id).toBe('aa-v4.2-openai-gpt-5.6-sol-max');
      expect(solMax.provider).toBe('OpenAI');
      expect(solMax.quality.value).toBe(51.3);
      expect(solMax.costPerTask.value).toBe(1.2495);
      expect(solMax.responseSeconds.value).toBe(113);
      expect(solMax.tokensPerSecond.value).toBe(85.5);

      // Frozen id, dotted model — max has to join the rest of Fable 5.1's curve.
      const fableMax = obs.find(o => o.model === 'claude-fable-5.1');
      expect(fableMax).toBeDefined();
      expect(fableMax.id).toBe('aa-v4.2-anthropic-claude-fable-5-1-max');
    });

    it('skips models that have no sourced metrics', () => {
      const emptyModel = [{
        id: 'empty',
        name: 'Empty Model',
        slug: 'empty-model',
        model_creator: { name: 'Empty' },
        evaluations: { artificial_analysis_intelligence_index: null },
        artificial_analysis_intelligence_index_cost: null,
        pricing: null,
        performance: null,
      }];
      expect(transformAAModelsToObservations(emptyModel)).toHaveLength(0);
    });
  });

  describe('fetchAllArtificialAnalysisModels', () => {
    it('throws 400 when apiKey is missing', async () => {
      await expect(fetchAllArtificialAnalysisModels(null)).rejects.toThrow(/API key is required/i);
    });

    it('handles pagination across multiple pages', async () => {
      const originalFetch = globalThis.fetch;
      try {
        let callCount = 0;
        globalThis.fetch = vi.fn().mockImplementation((url) => {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve({
              ok: true,
              json: async () => ({
                data: [{ id: '1', name: 'Page 1 Model', slug: 'p1', model_creator: { name: 'OpenAI' } }],
                pagination: { has_more: true },
              }),
            });
          }
          return Promise.resolve({
            ok: true,
            json: async () => ({
              data: [{ id: '2', name: 'Page 2 Model', slug: 'p2', model_creator: { name: 'OpenAI' } }],
              pagination: { has_more: false },
            }),
          });
        });

        const models = await fetchAllArtificialAnalysisModels('test-key');
        expect(models).toHaveLength(2);
        expect(callCount).toBe(2);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('syncArtificialAnalysisCatalog', () => {
    it('throws 400 when no API key is provided and env is empty', async () => {
      delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
      await expect(syncArtificialAnalysisCatalog({})).rejects.toThrow(/No Artificial Analysis API key provided/i);
    });

    it('successfully syncs and imports observations', async () => {
      const originalFetch = globalThis.fetch;
      const importSpy = vi.spyOn(modelComparison, 'importModelComparison').mockResolvedValue({
        schemaVersion: 1,
        observations: [{ id: 'obs-1' }],
      });

      try {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            data: [{
              id: 'm1',
              name: 'Synced Model (high)',
              slug: 'synced-model',
              model_creator: { name: 'Test' },
              evaluations: { artificial_analysis_intelligence_index: 40 },
              artificial_analysis_intelligence_index_cost: { cost_per_task: { total_cost: 0.5 } },
              pricing: { price_1m_input_tokens: 1, price_1m_output_tokens: 2 },
              performance: { median_end_to_end_response_time_seconds: 5 },
            }],
            pagination: { has_more: false },
          }),
        });

        const result = await syncArtificialAnalysisCatalog({ apiKey: 'valid-key' });
        expect(result.success).toBe(true);
        expect(result.fetched).toBe(1);
        expect(result.observations).toBe(1);
        expect(importSpy).toHaveBeenCalled();
      } finally {
        globalThis.fetch = originalFetch;
        importSpy.mockRestore();
      }
    });
  });
});
