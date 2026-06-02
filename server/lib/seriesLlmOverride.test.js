import { describe, it, expect } from 'vitest';
import { resolveSeriesLlmOverride } from './seriesLlmOverride.js';

describe('resolveSeriesLlmOverride', () => {
  const series = { llm: { provider: 'anthropic', model: 'claude-x' } };

  it('falls back to the series provider/model when no override is passed', () => {
    expect(resolveSeriesLlmOverride(series, {})).toEqual({
      provider: 'anthropic',
      model: 'claude-x',
      providerMatchesSeries: true,
    });
  });

  it('inherits the series model when an override names the same provider', () => {
    expect(resolveSeriesLlmOverride(series, { overrideProvider: 'anthropic' })).toEqual({
      provider: 'anthropic',
      model: 'claude-x',
      providerMatchesSeries: true,
    });
  });

  it('drops the series model when an override switches provider without a model', () => {
    expect(resolveSeriesLlmOverride(series, { overrideProvider: 'openai' })).toEqual({
      provider: 'openai',
      model: undefined,
      providerMatchesSeries: false,
    });
  });

  it('honors an explicit override model even when switching providers', () => {
    expect(
      resolveSeriesLlmOverride(series, { overrideProvider: 'openai', overrideModel: 'gpt-x' }),
    ).toEqual({ provider: 'openai', model: 'gpt-x', providerMatchesSeries: false });
  });

  it('honors an explicit override model when staying on the series provider', () => {
    expect(
      resolveSeriesLlmOverride(series, { overrideModel: 'claude-y' }),
    ).toEqual({ provider: 'anthropic', model: 'claude-y', providerMatchesSeries: true });
  });

  it('returns undefined provider/model when the series has no llm config and no override', () => {
    expect(resolveSeriesLlmOverride({}, {})).toEqual({
      provider: undefined,
      model: undefined,
      providerMatchesSeries: true,
    });
  });

  it('tolerates a null/undefined series', () => {
    expect(resolveSeriesLlmOverride(null, { overrideProvider: 'openai' })).toEqual({
      provider: 'openai',
      model: undefined,
      providerMatchesSeries: false,
    });
    expect(resolveSeriesLlmOverride(undefined, {})).toEqual({
      provider: undefined,
      model: undefined,
      providerMatchesSeries: true,
    });
  });

  it('defaults overrides to an empty object', () => {
    expect(resolveSeriesLlmOverride(series)).toEqual({
      provider: 'anthropic',
      model: 'claude-x',
      providerMatchesSeries: true,
    });
  });
});
