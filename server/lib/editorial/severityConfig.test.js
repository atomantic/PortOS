import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SEVERITY_WEIGHTS,
  DEFAULT_BLOCKING_SEVERITIES,
  BLOCKING_GATES,
  mergeSeverityWeights,
  resolveBlockingSet,
  sanitizeSeverityWeights,
  sanitizeBlockingSeverities,
} from './severityConfig.js';

describe('severityConfig defaults (#1616)', () => {
  it('exposes the frozen default weights', () => {
    expect(DEFAULT_SEVERITY_WEIGHTS).toEqual({ high: 12, medium: 5, low: 1 });
    expect(Object.isFrozen(DEFAULT_SEVERITY_WEIGHTS)).toBe(true);
  });

  it('exposes the frozen default blocking sets + gate list', () => {
    expect(BLOCKING_GATES).toEqual(['arc', 'beatContinuity', 'editorial']);
    expect(DEFAULT_BLOCKING_SEVERITIES.arc).toEqual(['high', 'medium']);
    expect(DEFAULT_BLOCKING_SEVERITIES.beatContinuity).toEqual(['high', 'medium']);
    expect(DEFAULT_BLOCKING_SEVERITIES.editorial).toEqual(['high']);
    expect(Object.isFrozen(DEFAULT_BLOCKING_SEVERITIES)).toBe(true);
  });
});

describe('mergeSeverityWeights (#1616)', () => {
  it('empty / non-object override keeps the defaults (absent must not clobber)', () => {
    expect(mergeSeverityWeights({})).toEqual({ high: 12, medium: 5, low: 1 });
    expect(mergeSeverityWeights(undefined)).toEqual({ high: 12, medium: 5, low: 1 });
    expect(mergeSeverityWeights(null)).toEqual({ high: 12, medium: 5, low: 1 });
    expect(mergeSeverityWeights([1, 2, 3])).toEqual({ high: 12, medium: 5, low: 1 });
  });

  it('applies a partial override, keeping defaults for absent keys', () => {
    expect(mergeSeverityWeights({ high: 20 })).toEqual({ high: 20, medium: 5, low: 1 });
    expect(mergeSeverityWeights({ medium: 8, low: 2 })).toEqual({ high: 12, medium: 8, low: 2 });
  });

  it('accepts 0 as a valid weight (non-negative)', () => {
    expect(mergeSeverityWeights({ low: 0 })).toEqual({ high: 12, medium: 5, low: 0 });
  });

  it('rejects negative / NaN / string / non-finite per-key (keeps the default)', () => {
    expect(mergeSeverityWeights({ high: -1 })).toEqual({ high: 12, medium: 5, low: 1 });
    expect(mergeSeverityWeights({ high: NaN })).toEqual({ high: 12, medium: 5, low: 1 });
    expect(mergeSeverityWeights({ high: '20' })).toEqual({ high: 12, medium: 5, low: 1 });
    expect(mergeSeverityWeights({ high: Infinity })).toEqual({ high: 12, medium: 5, low: 1 });
  });

  it('returns a fresh object, never the frozen default', () => {
    const out = mergeSeverityWeights({});
    expect(out).not.toBe(DEFAULT_SEVERITY_WEIGHTS);
    expect(Object.isFrozen(out)).toBe(false);
  });
});

describe('resolveBlockingSet (#1616)', () => {
  it('absent gate → the gate default set', () => {
    expect([...resolveBlockingSet({}, 'arc')].sort()).toEqual(['high', 'medium']);
    expect([...resolveBlockingSet(undefined, 'editorial')]).toEqual(['high']);
    // gate present but not an array → default
    expect([...resolveBlockingSet({ arc: 'high' }, 'arc')].sort()).toEqual(['high', 'medium']);
  });

  it('explicit empty array → empty Set (nothing blocks, distinct from absent)', () => {
    const set = resolveBlockingSet({ arc: [] }, 'arc');
    expect(set.size).toBe(0);
  });

  it('filters junk severities and dedupes', () => {
    const set = resolveBlockingSet({ arc: ['high', 'bogus', 'high', 'low'] }, 'arc');
    expect([...set].sort()).toEqual(['high', 'low']);
  });

  it('a single-severity override is honored', () => {
    expect([...resolveBlockingSet({ arc: ['high'] }, 'arc')]).toEqual(['high']);
  });
});

describe('sanitizeSeverityWeights (#1616)', () => {
  it('keeps only valid non-negative numeric keys, drops the rest', () => {
    expect(sanitizeSeverityWeights({ high: 20, medium: -1, low: '2', bogus: 9 }))
      .toEqual({ high: 20 });
    expect(sanitizeSeverityWeights({ low: 0 })).toEqual({ low: 0 });
  });

  it('returns {} for empty / invalid input (round-trips as defaults via merge)', () => {
    expect(sanitizeSeverityWeights({})).toEqual({});
    expect(sanitizeSeverityWeights(null)).toEqual({});
    expect(sanitizeSeverityWeights('x')).toEqual({});
    expect(sanitizeSeverityWeights([1])).toEqual({});
    // an all-invalid override persists as {} and merge falls back to defaults
    expect(mergeSeverityWeights(sanitizeSeverityWeights({ high: 'no' })))
      .toEqual({ high: 12, medium: 5, low: 1 });
  });
});

describe('sanitizeBlockingSeverities (#1616)', () => {
  it('keeps only gate keys whose value is an array, filtered + deduped', () => {
    expect(sanitizeBlockingSeverities({
      arc: ['high', 'bogus', 'high'],
      beatContinuity: 'high', // non-array → dropped
      editorial: ['medium', 'low'],
      bogusGate: ['high'], // unknown gate → dropped
    })).toEqual({ arc: ['high'], editorial: ['medium', 'low'] });
  });

  it('preserves an explicit empty array (nothing blocks)', () => {
    expect(sanitizeBlockingSeverities({ arc: [] })).toEqual({ arc: [] });
  });

  it('returns {} for empty / invalid input', () => {
    expect(sanitizeBlockingSeverities({})).toEqual({});
    expect(sanitizeBlockingSeverities(null)).toEqual({});
    expect(sanitizeBlockingSeverities([])).toEqual({});
  });
});
