import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { catalogSlugForProviderModel, providerCatalogSlugs } from './comparisonModelScope.js';

const root = join(import.meta.dirname, '../..');

describe('catalogSlugForProviderModel', () => {
  it('strips region prefixes, gateway namespaces and context-window markers', () => {
    expect(catalogSlugForProviderModel('us.anthropic.claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(catalogSlugForProviderModel('global.anthropic.claude-opus-5[1m]')).toBe('claude-opus-5');
    expect(catalogSlugForProviderModel('moonshotai/kimi-k2.5')).toBe('kimi-k2.5');
    expect(catalogSlugForProviderModel('opencode/muse-spark-1.3-contributor-free')).toBe('muse-spark-1.3');
  });

  it('strips stacked effort, mode and quantization suffixes', () => {
    expect(catalogSlugForProviderModel('claude-opus-5-thinking-xhigh')).toBe('claude-opus-5');
    expect(catalogSlugForProviderModel('gemini-3.8-flash-high')).toBe('gemini-3.8-flash');
    expect(catalogSlugForProviderModel('qwen3-235b-a22b-4bit')).toBe('qwen3-235b-a22b');
    expect(catalogSlugForProviderModel('gpt-oss-120b-mxfp4')).toBe('gpt-oss-120b');
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
});

describe('providerCatalogSlugs', () => {
  it('collects slugs across providers from either model shape', () => {
    const slugs = providerCatalogSlugs([
      { models: [{ model: 'claude-opus-5-thinking-max' }, { model: 'auto' }] },
      { models: ['us.anthropic.claude-sonnet-5'] },
    ]);
    expect([...slugs].sort()).toEqual(['claude-opus-5', 'claude-sonnet-5']);
  });

  it('resolves the shipped provider config onto real catalog models', async () => {
    const providers = JSON.parse(await readFile(join(root, 'data.reference/providers.json'), 'utf8'));
    const catalog = JSON.parse(await readFile(join(root, 'data.reference/model-comparison.json'), 'utf8'));
    const inventory = Object.values(providers.providers).map(provider => ({ models: provider.models || [] }));
    const known = new Set(catalog.observations.map(row => row.model));
    const matched = [...providerCatalogSlugs(inventory)].filter(slug => known.has(slug));
    // A mapping regression shows up as this collapsing toward zero.
    expect(matched.length).toBeGreaterThan(30);
    expect(matched).toContain('claude-opus-5');
    expect(matched).toContain('gpt-5.6-sol');
  });
});
