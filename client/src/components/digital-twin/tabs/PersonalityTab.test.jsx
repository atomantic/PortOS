import { describe, it, expect } from 'vitest';
import {
  humanizeTrait,
  traitKeyUnion,
  seriesLabel,
  dedupeSeriesLabels,
  providerModelOptions,
  alignmentColor
} from './PersonalityTab.jsx';

describe('PersonalityTab helpers', () => {
  it('humanizeTrait splits camelCase and capitalizes', () => {
    expect(humanizeTrait('errorAversion')).toBe('Error Aversion');
    expect(humanizeTrait('humor')).toBe('Humor');
    expect(humanizeTrait('selfCensorship')).toBe('Self Censorship');
  });

  it('traitKeyUnion unions keys across runs and tolerates missing traits', () => {
    const runs = [
      { traits: { humor: { score: 0.5 }, empathy: { score: 0.2 } } },
      { traits: { humor: { score: 0.9 }, dogmatism: { score: 0.1 } } },
      {} // record with no traits map
    ];
    expect(traitKeyUnion(runs)).toEqual(['humor', 'empathy', 'dogmatism']);
    expect(traitKeyUnion([])).toEqual([]);
  });

  it('seriesLabel prefers the model and falls back to providerId', () => {
    const ts = '2026-07-14T12:00:00.000Z';
    expect(seriesLabel({ model: 'm1', providerId: 'p1', timestamp: ts })).toMatch(/^m1 · /);
    expect(seriesLabel({ model: null, providerId: 'p1', timestamp: ts })).toMatch(/^p1 · /);
  });

  it('dedupeSeriesLabels suffixes later collisions and leaves uniques alone', () => {
    expect(dedupeSeriesLabels(['a', 'b', 'a', 'a'])).toEqual(['a', 'b', 'a (3)', 'a (4)']);
    expect(dedupeSeriesLabels(['x', 'y'])).toEqual(['x', 'y']);
  });

  it('providerModelOptions filters sentinel ids and falls back to a null default chip', () => {
    expect(
      providerModelOptions({ models: ['gpt-x', 'codex-configured-default'], defaultModel: 'gpt-x' })
    ).toEqual(['gpt-x']);
    // Sentinel-only provider (e.g. antigravity) → one "provider default" chip.
    expect(
      providerModelOptions({
        models: ['antigravity-configured-default'],
        defaultModel: 'antigravity-configured-default'
      })
    ).toEqual([null]);
    // No models at all → defaultModel fallback.
    expect(providerModelOptions({ models: [], defaultModel: 'm-default' })).toEqual(['m-default']);
    expect(providerModelOptions({ models: [], defaultModel: null })).toEqual([null]);
  });

  it('alignmentColor thresholds match the success/warning/error bands', () => {
    expect(alignmentColor(0.9)).toBe('text-port-success');
    expect(alignmentColor(0.5)).toBe('text-port-warning');
    expect(alignmentColor(0.1)).toBe('text-port-error');
  });
});
