import { describe, it, expect } from 'vitest';
import { resolveModelRates, isFreeProvider, estimateCostUsd, PRICING_AS_OF } from './modelPricing.js';

describe('resolveModelRates', () => {
  it('matches exact model ids', () => {
    const r = resolveModelRates('claude-code', 'claude-opus-4-8');
    expect(r).toMatchObject({ rateModel: 'claude-opus-4-8', inputPer1M: 5, outputPer1M: 25, matched: 'exact' });
  });

  it('resolves CLI shorthand model names via family rules', () => {
    expect(resolveModelRates('claude-code', 'opus')).toMatchObject({ rateModel: 'claude-opus-4-8', matched: 'family' });
    expect(resolveModelRates('claude-code', 'sonnet')).toMatchObject({ rateModel: 'claude-sonnet-4-5', matched: 'family' });
    expect(resolveModelRates('claude-code', 'haiku')).toMatchObject({ rateModel: 'claude-haiku-4-5', matched: 'family' });
  });

  it('resolves fable/mythos to the Claude 5 flagship rates', () => {
    expect(resolveModelRates('claude-code', 'claude-fable-5')).toMatchObject({ inputPer1M: 10, outputPer1M: 50 });
    expect(resolveModelRates('claude-code', 'fable')).toMatchObject({ rateModel: 'claude-fable-5', matched: 'family' });
  });

  it('resolves Bedrock-prefixed ids through family rules', () => {
    const r = resolveModelRates('claude-code-bedrock', 'global.anthropic.claude-opus-4-8');
    expect(r).toMatchObject({ rateModel: 'claude-opus-4-8', matched: 'family' });
  });

  it('resolves configured-default sentinels to their provider family', () => {
    expect(resolveModelRates('codex', 'codex-configured-default')).toMatchObject({ rateModel: 'gpt-5.3-codex', matched: 'family' });
    expect(resolveModelRates('grok', 'grok-configured-default')).toMatchObject({ rateModel: 'grok-4.5', matched: 'family' });
    expect(resolveModelRates('antigravity-cli', 'antigravity-configured-default')).toMatchObject({ rateModel: 'gemini-3.1-pro-preview', matched: 'family' });
  });

  it('resolves suffixed gpt-5.6 ids to their base rates', () => {
    expect(resolveModelRates('codex', 'gpt-5.6-terra-2026-06-01')).toMatchObject({ rateModel: 'gpt-5.6-terra', matched: 'family' });
  });

  it('prices Cerebras gpt-oss-120b at open-weights rates, not OpenAI GPT rates', () => {
    expect(resolveModelRates('cerebras', 'gpt-oss-120b')).toMatchObject({
      rateModel: 'gpt-oss-120b (cerebras)', inputPer1M: 0.35, outputPer1M: 0.75,
    });
  });

  it('keeps other gpt-oss sizes on open-weights rates rather than the proprietary /gpt/ rule', () => {
    expect(resolveModelRates('cerebras', 'gpt-oss-20b')).toMatchObject({ rateModel: 'gpt-oss-120b (cerebras)', matched: 'family' });
  });

  // gpt-oss is open-weights: the id does not identify the host, and rates differ
  // per host — so no bare gpt-oss id may report `exact` (that would strip the
  // UI's `~` approximate marker and claim a published rate we don't have).
  it('never reports an exact match for an open-weights gpt-oss id on any host', () => {
    for (const providerId of ['cerebras', 'groq', 'openrouter', 'some-custom-host']) {
      expect(resolveModelRates(providerId, 'gpt-oss-120b').matched).not.toBe('exact');
    }
  });

  it('still resolves proprietary OpenAI ids through the gpt family rule', () => {
    expect(resolveModelRates('codex', 'gpt-4.1')).toMatchObject({ rateModel: 'gpt-5.4', matched: 'family' });
  });

  it('estimates an unrecognized Cerebras model at the Cerebras flagship rate', () => {
    expect(resolveModelRates('cerebras', 'zai-glm-4.7')).toMatchObject({ rateModel: 'gpt-oss-120b (cerebras)', matched: 'providerDefault' });
  });

  it('falls back to a provider default when the model is unknown', () => {
    const r = resolveModelRates('claude-code', 'my-custom-alias');
    expect(r).toMatchObject({ rateModel: 'claude-sonnet-4-5', matched: 'providerDefault' });
  });

  it('falls back to the generic blended rate when nothing matches', () => {
    const r = resolveModelRates('mystery-provider', 'mystery-model');
    expect(r).toMatchObject({ rateModel: null, inputPer1M: 3, outputPer1M: 15, matched: 'fallback' });
  });

  it('handles null/undefined inputs without throwing', () => {
    expect(resolveModelRates(null, null).matched).toBe('fallback');
    expect(resolveModelRates(undefined, undefined).matched).toBe('fallback');
  });

  it('exposes the verification date', () => {
    expect(PRICING_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('isFreeProvider', () => {
  it('classifies ollama and lmstudio ids as free (object and string forms)', () => {
    expect(isFreeProvider('ollama')).toBe(true);
    expect(isFreeProvider('lmstudio')).toBe(true);
    expect(isFreeProvider({ id: 'ollama', type: 'api' })).toBe(true);
  });

  it('classifies ollamaBacked CLI wrappers as free', () => {
    expect(isFreeProvider({ id: 'claude-ollama', ollamaBacked: true, command: 'claude' })).toBe(true);
  });

  it('classifies localhost API endpoints as free', () => {
    expect(isFreeProvider({ id: 'my-local', type: 'api', endpoint: 'http://localhost:1234/v1' })).toBe(true);
    expect(isFreeProvider({ id: 'my-local', type: 'api', endpoint: 'http://127.0.0.1:11434/v1' })).toBe(true);
  });

  it('does not classify paid providers as free', () => {
    expect(isFreeProvider({ id: 'claude-code', type: 'cli', command: 'claude' })).toBe(false);
    expect(isFreeProvider({ id: 'grok', type: 'api', endpoint: 'https://api.x.ai/v1' })).toBe(false);
    expect(isFreeProvider('codex')).toBe(false);
    expect(isFreeProvider(null)).toBe(false);
  });
});

describe('estimateCostUsd', () => {
  it('computes input + output cost per 1M tokens', () => {
    const rates = { inputPer1M: 3, outputPer1M: 15 };
    expect(estimateCostUsd(1_000_000, 1_000_000, rates)).toBeCloseTo(18);
    expect(estimateCostUsd(500_000, 0, rates)).toBeCloseTo(1.5);
  });

  it('treats missing counts and rates as zero', () => {
    expect(estimateCostUsd(null, undefined, { inputPer1M: 3, outputPer1M: 15 })).toBe(0);
    expect(estimateCostUsd(1000, 1000, null)).toBe(0);
  });
});
