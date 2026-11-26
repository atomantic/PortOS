// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { moaProviderOptions } from './moaProviderOptions.js';

describe('moaProviderOptions', () => {
  it('offers each runnable preset as a moa: record pinned to its aggregator model', () => {
    const providers = [{ id: 'agg', defaultModel: 'agg-default' }];
    const options = moaProviderOptions([
      { id: 'pinned', providerId: 'moa:pinned', name: 'Pinned', aggregator: { providerId: 'agg', model: 'big' } },
      { id: 'inherits', providerId: 'moa:inherits', name: 'Inherits', enabled: false, aggregator: { providerId: 'agg' } },
      { id: 'modelless', providerId: 'moa:modelless', name: 'Modelless', aggregator: { providerId: 'gone' } },
      { id: null, name: 'Broken', invalid: 'aggregator: Required' },
    ], providers);
    expect(options).toEqual([
      { id: 'moa:pinned', name: 'MoA: Pinned', type: 'moa', enabled: true, models: ['big'], defaultModel: 'big', moaPresetId: 'pinned' },
      { id: 'moa:inherits', name: 'MoA: Inherits', type: 'moa', enabled: true, models: ['agg-default'], defaultModel: 'agg-default', moaPresetId: 'inherits' },
    ]);
    expect(moaProviderOptions(null)).toEqual([]);
  });
});
