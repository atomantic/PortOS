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
      const gemma = ollama.find((m) => m.key === 'gemma4-12b');
      expect(gemma.id).toBe('gemma4:12b');
      expect(gemma.category).toBe('general');
      const lms = getCatalog('lmstudio');
      const gemmaLms = lms.find((m) => m.key === 'gemma4-12b');
      expect(gemmaLms.id).toBe('lmstudio-community/gemma-4-12B-it-GGUF');
    });

    it('only includes entries that ship a build for the backend', () => {
      expect(getCatalog('ollama').length).toBe(LOCAL_LLM_CATALOG.filter((e) => e.ollama).length);
    });

    it('keeps every primary and secondary recommendation category known', () => {
      const categories = new Set(LOCAL_LLM_CATEGORIES.map((c) => c.id));
      expect(LOCAL_LLM_CATALOG.every((entry) => categories.has(entry.category))).toBe(true);
      expect(LOCAL_LLM_CATALOG.every((entry) => (
        Array.isArray(entry.recommendedFor)
        && entry.recommendedFor.includes(entry.category)
        && entry.recommendedFor.every((category) => categories.has(category))
      ))).toBe(true);
    });

    it('marks installed models (tag-insensitive for Ollama)', () => {
      const list = getCatalog('ollama', ['glm-4.7-flash:latest']);
      expect(list.find((m) => m.id === 'glm-4.7-flash').installed).toBe(true);
      expect(list.find((m) => m.id === 'gemma4:12b').installed).toBe(false);
    });

    it('matches LM Studio installed ids despite the -GGUF suffix / publisher prefix', () => {
      const list = getCatalog('lmstudio', ['lmstudio-community/gemma-4-12B-it-GGUF']);
      expect(list.find((m) => m.key === 'gemma4-12b').installed).toBe(true);
    });

    it('gates the current Qwen MLX recommendations to Apple Silicon', () => {
      const mlxKey = 'qwen3.8-27b-mlx-4bit';
      const uncensoredKey = 'qwen3.8-27b-uncensored-mlx';
      expect(getCatalog('lmstudio').find((m) => m.key === mlxKey)).toMatchObject({
        format: 'mlx',
        id: 'mlx-community/Qwen3.8-27B-4bit'
      });
      expect(getCatalog('ollama', [], { appleSilicon: true }).find((m) => m.key === mlxKey)).toMatchObject({
        format: 'mlx',
        id: 'qwen3.8:27b-mlx'
      });
      expect(getCatalog('ollama', ['qwen3.8:27b-mlx'], { appleSilicon: true })
        .find((m) => m.key === mlxKey)?.installed).toBe(true);
      expect(getCatalog('lmstudio', ['lmstudio-community/Qwen3.8-27B-MLX-4bit'])
        .find((m) => m.key === mlxKey)?.installed).toBe(true);
      expect(getCatalog('lmstudio', [], { appleSilicon: true }).some((m) => m.key === mlxKey)).toBe(true);
      expect(getCatalog('lmstudio', [], { appleSilicon: false }).some((m) => m.key === mlxKey)).toBe(false);
      expect(getCatalog('ollama', [], { appleSilicon: false }).some((m) => m.key === mlxKey)).toBe(false);
      expect(getCatalog('lmstudio', [], { appleSilicon: true }).find((m) => m.key === uncensoredKey)).toMatchObject({
        format: 'mlx',
        id: 'https://huggingface.co/orcarouter/Qwen3.8-27B-Uncensored-MLX',
        note: expect.stringContaining('Gated on Hugging Face')
      });
      expect(getCatalog('lmstudio', ['orcarouter/Qwen3.8-27B-Uncensored-MLX'], { appleSilicon: true })
        .find((m) => m.key === uncensoredKey)?.installed).toBe(true);
      expect(getCatalog('lmstudio', [], { appleSilicon: false }).some((m) => m.key === uncensoredKey)).toBe(false);
      expect(getCatalog('ollama', [], { appleSilicon: true }).some((m) => m.key === uncensoredKey)).toBe(false);
    });

    it('returns [] for an unknown backend', () => {
      expect(getCatalog('nope')).toEqual([]);
    });

    it('ships the small tool-calling models recommended for the voice fast-path tier-3', () => {
      const ollama = getCatalog('ollama');
      const lms = getCatalog('lmstudio');
      const hermesO = ollama.find((m) => m.key === 'hermes-3-llama-3.1-8b');
      const qwen3bO = ollama.find((m) => m.key === 'qwen2.5-3b');
      // Present on both backends…
      expect(hermesO?.id).toBe('hermes3');
      expect(lms.find((m) => m.key === 'hermes-3-llama-3.1-8b')?.id).toBe('NousResearch/Hermes-3-Llama-3.1-8B-GGUF');
      expect(qwen3bO?.id).toBe('hf.co/lmstudio-community/Qwen2.5-3B-Instruct-GGUF:Q4_K_M');
      expect(lms.find((m) => m.key === 'qwen2.5-3b')?.id).toBe('lmstudio-community/Qwen2.5-3B-Instruct-GGUF');
      // …and both advertise tool use (the reason they're recommended here).
      expect(hermesO.capabilities).toContain('tools');
      expect(qwen3bO.capabilities).toContain('tools');
    });

    it('keeps catalog keys unique', () => {
      const keys = LOCAL_LLM_CATALOG.map((e) => e.key);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('surfaces a documented context window as contextLength, null otherwise', () => {
      const ollama = getCatalog('ollama');
      // granite4.1-8b documents a 128K window.
      expect(ollama.find((m) => m.key === 'granite4.1-8b').contextLength).toBe(131072);
      // qwen3.8-27b documents a native 256K window.
      expect(ollama.find((m) => m.key === 'qwen3.8-27b').contextLength).toBe(262144);
      // Entries whose real window isn't a documented round number expose null
      // (never undefined) rather than an invented one.
      expect(ollama.find((m) => m.key === 'glm-4.7-flash').contextLength).toBeNull();
    });

    it('marks Qwen3.8 as the flagship general model without hiding its coding and vision use cases', () => {
      const qwen = getCatalog('ollama').find((m) => m.key === 'qwen3.8-27b');
      expect(qwen).toMatchObject({
        category: 'general',
        featured: { label: 'Best overall' },
      });
      expect(qwen.recommendedFor).toEqual(expect.arrayContaining(['general', 'coding', 'reasoning', 'vision']));
      expect(qwen.capabilities).toEqual(expect.arrayContaining(['code', 'tools', 'vision']));
    });

    it('never lists an Ollama `:cloud` tag — those manifests carry no local weights', () => {
      expect(LOCAL_LLM_CATALOG.every((e) => !/(?:^|:)cloud$/.test(e.ollama || ''))).toBe(true);
    });
  });

  describe('searchCatalog', () => {
    it('returns everything for an empty query', () => {
      expect(searchCatalog('ollama', '').length).toBe(getCatalog('ollama').length);
    });
    it('filters by name, family, and description', () => {
      expect(searchCatalog('ollama', 'coding').some((m) => m.key === 'qwen3.6-35b-a3b')).toBe(true);
      expect(searchCatalog('ollama', 'coding').some((m) => m.key === 'qwen3.8-27b')).toBe(true);
      expect(searchCatalog('ollama', 'vision').some((m) => m.key === 'qwen3-vl-8b')).toBe(true);
      expect(searchCatalog('ollama', 'embedding').some((m) => m.key === 'nomic-embed-text-v2-moe')).toBe(true);
      expect(searchCatalog('ollama', 'zzzznotamodel')).toEqual([]);
    });
  });

  describe('mapModelToBackend', () => {
    it('maps a known model exactly across backends', () => {
      expect(mapModelToBackend('ollama', 'gemma4:12b', 'lmstudio'))
        .toEqual({ targetId: 'lmstudio-community/gemma-4-12B-it-GGUF', exact: true });
      expect(mapModelToBackend('lmstudio', 'lmstudio-community/gemma-4-12B-it-GGUF', 'ollama'))
        .toEqual({ targetId: 'gemma4:12b', exact: true });
    });

    it('still maps models retired from the suggested-install catalog', () => {
      // Retiring an entry from LOCAL_LLM_CATALOG must not downgrade an existing
      // install's migrate to a guessed stem — RETIRED_MODEL_MAPPINGS keeps it exact.
      expect(getCatalog('ollama').some((m) => m.key === 'llama3.2')).toBe(false);
      expect(mapModelToBackend('ollama', 'llama3.2:latest', 'lmstudio'))
        .toEqual({ targetId: 'lmstudio-community/Llama-3.2-3B-Instruct-GGUF', exact: true });
      expect(mapModelToBackend('lmstudio', 'lmstudio-community/Llama-3.2-3B-Instruct-GGUF', 'ollama'))
        .toEqual({ targetId: 'llama3.2', exact: true });
      expect(mapModelToBackend('ollama', 'qwen2.5vl:32b', 'lmstudio'))
        .toEqual({ targetId: 'lmstudio-community/Qwen2.5-VL-32B-Instruct-GGUF', exact: true });
    });

    it('best-effort derives an Ollama name for an unknown LM Studio model', () => {
      const r = mapModelToBackend('lmstudio', 'someorg/Mystery-Model-7B-Instruct-GGUF', 'ollama');
      expect(r.exact).toBe(false);
      expect(r.targetId).toBe('mystery-model');
    });

    it('maps the known Qwen MLX build across backend-specific registries', () => {
      expect(mapModelToBackend('lmstudio', 'mlx-community/Qwen3.8-27B-4bit', 'ollama'))
        .toEqual({ targetId: 'qwen3.8:27b-mlx', exact: true });
      expect(mapModelToBackend('lmstudio', 'lmstudio-community/Qwen3.8-27B-MLX-4bit', 'ollama'))
        .toEqual({ targetId: 'qwen3.8:27b-mlx', exact: true });
      expect(mapModelToBackend('ollama', 'qwen3.8:27b-mlx', 'lmstudio'))
        .toEqual({ targetId: 'mlx-community/Qwen3.8-27B-4bit', exact: true });
    });

    it('does not invent an Ollama target for the LM Studio-only uncensored MLX build', () => {
      expect(mapModelToBackend('lmstudio', 'orcarouter/Qwen3.8-27B-Uncensored-MLX', 'ollama'))
        .toEqual({ targetId: null, exact: false });
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
