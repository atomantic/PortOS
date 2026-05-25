import { describe, it, expect } from 'vitest';
import {
  BACKENDS, isBackend, LOCAL_LLM_CATALOG, LOCAL_LLM_CATEGORIES, getCatalog, searchCatalog, mapModelToBackend
} from './localLlmCatalog.js';

describe('localLlmCatalog', () => {
  describe('isBackend', () => {
    it('accepts the two known backends and rejects everything else', () => {
      expect(BACKENDS).toEqual(['ollama', 'lmstudio']);
      expect(isBackend('ollama')).toBe(true);
      expect(isBackend('lmstudio')).toBe(true);
      expect(isBackend('file')).toBe(false);
      expect(isBackend(undefined)).toBe(false);
    });
  });

  describe('getCatalog', () => {
    it('projects entries onto the backend-specific install id', () => {
      const ollama = getCatalog('ollama');
      const llama = ollama.find((m) => m.key === 'llama3.2');
      expect(llama.id).toBe('llama3.2');
      expect(llama.category).toBe('chat');
      const lms = getCatalog('lmstudio');
      const llamaLms = lms.find((m) => m.key === 'llama3.2');
      expect(llamaLms.id).toBe('lmstudio-community/Llama-3.2-3B-Instruct-GGUF');
    });

    it('only includes entries that ship a build for the backend', () => {
      expect(getCatalog('ollama').length).toBe(LOCAL_LLM_CATALOG.filter((e) => e.ollama).length);
    });

    it('keeps every entry in a known category', () => {
      const categories = new Set(LOCAL_LLM_CATEGORIES.map((c) => c.id));
      expect(LOCAL_LLM_CATALOG.every((entry) => categories.has(entry.category))).toBe(true);
    });

    it('marks installed models (tag-insensitive for Ollama)', () => {
      const list = getCatalog('ollama', ['llama3.2:latest']);
      expect(list.find((m) => m.id === 'llama3.2').installed).toBe(true);
      expect(list.find((m) => m.id === 'mistral').installed).toBe(false);
    });

    it('matches LM Studio installed ids despite the -GGUF suffix / publisher prefix', () => {
      const list = getCatalog('lmstudio', ['lmstudio-community/Llama-3.2-3B-Instruct-GGUF']);
      expect(list.find((m) => m.key === 'llama3.2').installed).toBe(true);
    });

    it('returns [] for an unknown backend', () => {
      expect(getCatalog('nope')).toEqual([]);
    });
  });

  describe('searchCatalog', () => {
    it('returns everything for an empty query', () => {
      expect(searchCatalog('ollama', '').length).toBe(getCatalog('ollama').length);
    });
    it('filters by name, family, and description', () => {
      expect(searchCatalog('ollama', 'coding').some((m) => m.key === 'qwen3.6-35b-a3b')).toBe(true);
      expect(searchCatalog('ollama', 'vision').some((m) => m.key === 'llava')).toBe(true);
      expect(searchCatalog('ollama', 'embedding').some((m) => m.key === 'nomic-embed-text-v2-moe')).toBe(true);
      expect(searchCatalog('ollama', 'zzzznotamodel')).toEqual([]);
    });
  });

  describe('mapModelToBackend', () => {
    it('maps a known model exactly across backends', () => {
      expect(mapModelToBackend('ollama', 'llama3.2:latest', 'lmstudio'))
        .toEqual({ targetId: 'lmstudio-community/Llama-3.2-3B-Instruct-GGUF', exact: true });
      expect(mapModelToBackend('lmstudio', 'lmstudio-community/Llama-3.2-3B-Instruct-GGUF', 'ollama'))
        .toEqual({ targetId: 'llama3.2', exact: true });
    });

    it('best-effort derives an Ollama name for an unknown LM Studio model', () => {
      const r = mapModelToBackend('lmstudio', 'someorg/Mystery-Model-7B-Instruct-GGUF', 'ollama');
      expect(r.exact).toBe(false);
      expect(r.targetId).toBe('mystery-model');
    });

    it('returns null (skip) when mapping an unknown model TO LM Studio', () => {
      expect(mapModelToBackend('ollama', 'custom-unlisted', 'lmstudio'))
        .toEqual({ targetId: null, exact: false });
    });

    it('refuses same-backend or unknown-backend mappings', () => {
      expect(mapModelToBackend('ollama', 'llama3.2', 'ollama')).toEqual({ targetId: null, exact: false });
      expect(mapModelToBackend('ollama', 'llama3.2', 'nope')).toEqual({ targetId: null, exact: false });
    });
  });
});
