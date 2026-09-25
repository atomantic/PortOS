import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { canonicalCatalogModelSlug, catalogSlugForProviderModel, providerCatalogSlugs } from './comparisonModelScope.js';

const root = join(import.meta.dirname, '../..');

describe('catalogSlugForProviderModel', () => {
  it('strips region prefixes, gateway namespaces and context-window markers', () => {
    expect(catalogSlugForProviderModel('us.anthropic.claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(catalogSlugForProviderModel('global.anthropic.claude-opus-5[1m]')).toBe('claude-opus-5');
    expect(catalogSlugForProviderModel('moonshotai/kimi-k2.5')).toBe('kimi-k2.5');
    expect(catalogSlugForProviderModel('google/gemma-4-31b-it')).toBe('gemma-4-31b-it');
    expect(catalogSlugForProviderModel('nvidia-nim/poolside/laguna-xs-2.1')).toBe('laguna-xs-2.1');
    expect(catalogSlugForProviderModel('opencode/muse-spark-1.3-contributor-free')).toBe('muse-spark-1.3');
  });

  it('strips stacked effort, mode and quantization suffixes', () => {
    expect(catalogSlugForProviderModel('claude-opus-5-thinking-xhigh')).toBe('claude-opus-5');
    expect(catalogSlugForProviderModel('gemini-3.8-flash-high')).toBe('gemini-3.8-flash');
    expect(catalogSlugForProviderModel('qwen3-235b-a22b-4bit')).toBe('qwen3-235b-a22b');
    expect(catalogSlugForProviderModel('gpt-oss-120b-mxfp4')).toBe('gpt-oss-120b');
  });

  it('resolves a local install id from the catalog entry that declares one, on either backend', () => {
    // An Ollama tag and its LM Studio GGUF repo are one model with two
    // spellings PortOS owns, so both reach the declared benchmark name.
    for (const id of ['ornith:35b', 'lmstudio-community/Ornith-1.0-35B-GGUF', 'ORNITH:35B']) {
      expect(catalogSlugForProviderModel(id)).toBe('ornith-1.0-35b');
    }
    expect(catalogSlugForProviderModel('qwen3-coder:30b')).toBe('qwen3-coder-30b-a3b');
    expect(catalogSlugForProviderModel('unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF')).toBe('devstral-small-2-24b');
  });

  it('gives a local build no benchmark identity unless its entry declares one', () => {
    // These are all real catalog entries — the mappings a textual rule would
    // invent are simply wrong: `-Reasoning` is model identity, not an effort
    // suffix, so stripping it lands on a DIFFERENT Cisco model; a 4-bit MLX
    // build is not the hosted endpoint whose price and throughput
    // `qwen3.8-27b` carries; and `-Thinking` in a GGUF repo name is identity,
    // not a reasoning-mode suffix, so stripping it lands on that model's
    // non-thinking sibling. None of these entries declares a `benchmarkModel`,
    // so silence — not a wrong guess — is the correct answer.
    expect(catalogSlugForProviderModel('hf.co/fdtn-ai/Foundation-Sec-8B-Reasoning-Q8_0-GGUF:Q8_0')).toBe('');
    expect(catalogSlugForProviderModel('qwen3.8:27b-mlx')).toBe('');
    expect(catalogSlugForProviderModel('qwen2.5-coder:32b')).toBe('');
    expect(catalogSlugForProviderModel('lmstudio-community/LFM2.5-1.2B-Thinking-GGUF')).toBe('');
  });

  it('leaves a name the index really spells that way alone', () => {
    // `-it` is Google's own name for the model, and a trailing build date is
    // part of the slug rather than a version to dot.
    expect(catalogSlugForProviderModel('google/gemma-4-31b-it')).toBe('gemma-4-31b-it');
    expect(catalogSlugForProviderModel('qwen3-235b-a22b-2507')).toBe('qwen3-235b-a22b-2507');
    expect(catalogSlugForProviderModel('deepseek-r1-0528')).toBe('deepseek-r1-0528');
  });

  it('reads a dashed trailing version as the catalog dotted version', () => {
    expect(catalogSlugForProviderModel('claude-sonnet-4-6')).toBe('claude-sonnet-4.6');
    expect(catalogSlugForProviderModel('claude-opus-4-6-thinking')).toBe('claude-opus-4.6');
    expect(catalogSlugForProviderModel('claude-fable-5-1')).toBe('claude-fable-5.1');
  });

  it('resolves names the two namespaces spell differently', () => {
    expect(catalogSlugForProviderModel('claude-haiku-4-5')).toBe('claude-4.5-haiku');
    expect(catalogSlugForProviderModel('gptoss-20b')).toBe('gpt-oss-20b');
  });

  it('returns empty for routing policies and non-model entries', () => {
    for (const entry of ['auto', 'openrouter/auto', 'antigravity-configured-default', 'composer-2.5', '', null]) {
      expect(catalogSlugForProviderModel(entry)).toBe('');
    }
  });

  it('rejects a routing alias that arrives namespaced, and one that is only recognizable namespaced', () => {
    // 'opencode/big-pickle' matches the alias only after the namespace comes off;
    // 'stealth/ox-alpha' matches only before it does.
    expect(catalogSlugForProviderModel('opencode/big-pickle')).toBe('');
    expect(catalogSlugForProviderModel('stealth/ox-alpha')).toBe('');
  });
});

describe('canonicalCatalogModelSlug', () => {
  it('dots a trailing all-digit version pair', () => {
    expect(canonicalCatalogModelSlug('claude-fable-5-1')).toBe('claude-fable-5.1');
    expect(canonicalCatalogModelSlug('claude-sonnet-4-6')).toBe('claude-sonnet-4.6');
  });

  it('leaves a build date, a parameter count and a plain name alone', () => {
    for (const slug of ['deepseek-r1-0528', 'qwen3-235b-a22b-2507', 'gpt-5.6-sol', 'llama-2-chat-70b']) {
      expect(canonicalCatalogModelSlug(slug)).toBe(slug);
    }
  });
});

describe('providerCatalogSlugs', () => {
  it('collects slugs across providers from either model shape', () => {
    const slugs = providerCatalogSlugs([
      { models: [{ model: 'claude-opus-5-thinking-max' }, { model: 'auto' }] },
      { models: ['us.anthropic.claude-sonnet-5'] },
    ]);
    expect([...slugs].sort()).toEqual(['claude-opus-5', 'claude-sonnet-5']);
  });

  it('matches shipped providers to the current observation model identities', async () => {
    const providers = JSON.parse(await readFile(join(root, 'data.reference/providers.json'), 'utf8'));
    const catalog = JSON.parse(await readFile(join(root, 'data.reference/model-comparison.json'), 'utf8'));
    const inventory = Object.values(providers.providers).map(provider => ({ models: provider.models || [] }));
    // Both provider ids and observations can carry gateway/vendor namespaces,
    // version spellings, or free-tier suffixes. Compare the canonical identity
    // on both sides. The public calibration cohort also includes models that
    // are not in the shipped provider defaults.
    const known = new Set(catalog.observations.map(row => catalogSlugForProviderModel(row.model)).filter(Boolean));
    const matched = [...providerCatalogSlugs(inventory)].filter(slug => known.has(slug));
    expect(known.size).toBeGreaterThan(0);
    expect(matched.length).toBeGreaterThan(20);
    // Keep coverage anchored across a subscription model and a free provider.
    expect(matched).toContain('grok-4.7');
    expect(matched).toContain('muse-spark-1.3');
  });
});

it('preserves release identities, dated snapshots, and Bedrock weight aliases', () => {
  for (const id of ['qwen3-max', 'qwen3-max-thinking', 'kimi-k2-thinking', 'sonar-reasoning', 'ling-3.0-flash-fin', 'gpt-4o-2024-08-06']) expect(catalogSlugForProviderModel(id)).toBe(id);
  expect(catalogSlugForProviderModel('qwen3-max-high')).toBe('qwen3-max');
  expect(catalogSlugForProviderModel('amazon-bedrock/us.meta.llama4-maverick-17b-instruct-v1:0')).toBe('llama-4-maverick');
  expect(catalogSlugForProviderModel('amazon-bedrock/nvidia.nemotron-super-3-120b')).toBe('nemotron-3-super-120b-a12b');
  expect(catalogSlugForProviderModel('gpt-oss:20b')).toBe('gpt-oss-20b');
});
