import { describe, it, expect } from 'vitest';
import { isEmbeddingModel, isGenerationModel, recommendEditorialModel } from './localModelHeuristics.js';

describe('localModelHeuristics', () => {
  describe('isEmbeddingModel', () => {
    it('flags known embedding models', () => {
      for (const id of [
        'nomic-embed-text:latest',
        'mxbai-embed-large',
        'bge-m3',
        'snowflake-arctic-embed:latest',
        'text-embedding-3-small',
        'gte-large',
      ]) {
        expect(isEmbeddingModel(id), id).toBe(true);
      }
    });

    it('does not flag chat/generation models', () => {
      for (const id of [
        'qwen3.6:35b',
        'gpt-oss:20b',
        'llama3.2:latest',
        'command-r-plus:latest',
        'gemma2:27b',
        'mistral-small:latest',
      ]) {
        expect(isEmbeddingModel(id), id).toBe(false);
      }
    });

    it('handles non-strings', () => {
      expect(isEmbeddingModel(null)).toBe(false);
      expect(isEmbeddingModel(undefined)).toBe(false);
      expect(isEmbeddingModel('')).toBe(false);
    });

    it('isGenerationModel is the inverse for real ids', () => {
      expect(isGenerationModel('qwen3.6:35b')).toBe(true);
      expect(isGenerationModel('nomic-embed-text:latest')).toBe(false);
      expect(isGenerationModel('')).toBe(false);
    });
  });

  describe('recommendEditorialModel', () => {
    it('prefers a large general instruct model over a small one', () => {
      const rec = recommendEditorialModel([
        { id: 'llama3.2:latest', params: '3.2B' },
        { id: 'qwen3.6:35b', params: '35B' },
      ]);
      expect(rec?.id).toBe('qwen3.6:35b');
      expect(rec.reason).toMatch(/editorial/i);
    });

    it('never recommends an embedding model', () => {
      const rec = recommendEditorialModel([
        { id: 'nomic-embed-text:latest' },
        { id: 'llama3.2:latest', params: '3.2B' },
      ]);
      expect(rec?.id).toBe('llama3.2:latest');
    });

    it('skips code-specialized and vision models', () => {
      const rec = recommendEditorialModel([
        { id: 'codellama:13b', params: '13B' },
        { id: 'llava:13b', params: '13B' },
        { id: 'gemma2:9b', params: '9B' },
      ]);
      expect(rec?.id).toBe('gemma2:9b');
    });

    it('accepts plain string ids', () => {
      const rec = recommendEditorialModel(['command-r-plus:latest', 'phi3:mini']);
      expect(rec?.id).toBe('command-r-plus:latest');
    });

    it('prefers an instruction-tuned model over chatty Command R+ for fix generation', () => {
      // Command R+ is larger but RAG/long-form-tuned and leaks commentary into
      // structured fixes; an instruction-tight model is the better editorial pick.
      const rec = recommendEditorialModel([
        { id: 'command-r-plus:latest', params: '104B' },
        { id: 'qwen3.6:35b', params: '35B' },
      ]);
      expect(rec?.id).toBe('qwen3.6:35b');
    });

    it('returns null when nothing is suitable', () => {
      expect(recommendEditorialModel([])).toBeNull();
      expect(recommendEditorialModel(['nomic-embed-text:latest', 'mxbai-embed-large'])).toBeNull();
      expect(recommendEditorialModel(null)).toBeNull();
    });
  });
});
