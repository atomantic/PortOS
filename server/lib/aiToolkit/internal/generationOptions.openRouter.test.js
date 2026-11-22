import { describe, it, expect } from 'vitest';
import {
  resolveOpenRouterProviderField,
  openRouterBodyFragment,
} from './generationOptions.js';
import { providerRoutingSchema } from '../validation.js';

const OR = 'https://openrouter.ai/api/v1';

describe('resolveOpenRouterProviderField', () => {
  it('omits unset and empty keys', () => {
    const provider = { endpoint: OR, providerRouting: { sort: null, only: [], require_parameters: false, data_collection: 'deny' } };
    expect(resolveOpenRouterProviderField(provider, 'a/b')).toEqual({ data_collection: 'deny' });
  });

  it('merges a per-model override over the flat defaults, tolerating the openrouter/ prefix', () => {
    const provider = {
      endpoint: OR,
      providerRouting: {
        sort: 'price',
        data_collection: 'deny',
        models: { 'anthropic/claude-x': { only: ['anthropic'], sort: 'latency' } },
      },
    };
    expect(resolveOpenRouterProviderField(provider, 'openrouter/anthropic/claude-x'))
      .toEqual({ sort: 'latency', data_collection: 'deny', only: ['anthropic'] });
    expect(resolveOpenRouterProviderField(provider, 'other/model')).toEqual({ sort: 'price', data_collection: 'deny' });
  });

  it('lets an explicit empty override list clear an inherited pin', () => {
    const provider = { endpoint: OR, providerRouting: { only: ['together'], models: { m: { only: [] } } } };
    expect(resolveOpenRouterProviderField(provider, 'm')).toBeUndefined();
  });

  it('is a no-op for every non-OpenRouter endpoint', () => {
    const routing = { sort: 'price' };
    for (const endpoint of ['http://localhost:11434/v1', 'https://api.openai.com/v1', 'https://api.anthropic.com/v1', 'not a url']) {
      expect(resolveOpenRouterProviderField({ endpoint, providerRouting: routing }, 'm')).toBeUndefined();
      expect(openRouterBodyFragment({ endpoint, providerRouting: routing }, 'm')).toEqual({});
    }
  });

  it('recognizes the service definition id', () => {
    expect(resolveOpenRouterProviderField({ serviceDefinitionId: 'openrouter', providerRouting: { sort: 'price' } }, 'm')).toEqual({ sort: 'price' });
  });
});

describe('providerRoutingSchema', () => {
  it('rejects unknown keys, bad enums and nested models', () => {
    expect(providerRoutingSchema.safeParse({ sort: 'cheap' }).success).toBe(false);
    expect(providerRoutingSchema.safeParse({ bogus: 1 }).success).toBe(false);
    expect(providerRoutingSchema.safeParse({ models: { m: { models: {} } } }).success).toBe(false);
  });

  it('lowercases and trims slugs', () => {
    expect(providerRoutingSchema.parse({ only: [' Anthropic '] })).toEqual({ only: ['anthropic'] });
  });
});
