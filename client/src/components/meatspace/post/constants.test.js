import { describe, it, expect } from 'vitest';
import { computeDomainAverages, domainLabel } from './constants';

describe('domainLabel', () => {
  it('maps known domain keys to their human label', () => {
    expect(domainLabel('math')).toBe('Mental Math');
    expect(domainLabel('verbal')).toBe('Verbal Agility');
  });

  it('labels the catch-all bucket "Other"', () => {
    expect(domainLabel('other')).toBe('Other');
  });

  it('falls back to the raw key for unknown domains', () => {
    expect(domainLabel('mystery')).toBe('mystery');
  });
});

describe('computeDomainAverages', () => {
  it('derives the domain from the drill TYPE, not the coarse module segment', () => {
    // pun-wordplay lives under the `wordplay` domain even though its coarse
    // module is `llm-drills`; multiplication is `math`.
    const result = computeDomainAverages({
      'mental-math:multiplication': 90,
      'llm-drills:pun-wordplay': 60,
    });
    const byKey = Object.fromEntries(result.map(d => [d.key, d]));
    expect(byKey.math.score).toBe(90);
    expect(byKey.math.label).toBe('Mental Math');
    expect(byKey.wordplay.score).toBe(60);
    expect(byKey.wordplay.label).toBe('Wordplay');
  });

  it('averages multiple drills within the same domain (rounded)', () => {
    // pun-wordplay + word-association are both `wordplay`: mean(60, 71) = 65.5 → 66
    const result = computeDomainAverages({
      'llm-drills:pun-wordplay': 60,
      'llm-drills:word-association': 71,
    });
    expect(result).toEqual([{ key: 'wordplay', label: 'Wordplay', score: 66 }]);
  });

  it('sorts strongest domain first', () => {
    const result = computeDomainAverages({
      'mental-math:multiplication': 40,
      'llm-drills:pun-wordplay': 90,
      'llm-drills:story-recall': 70,
    });
    expect(result.map(d => d.key)).toEqual(['wordplay', 'verbal', 'math']);
  });

  it('buckets unmapped drill types under "other"', () => {
    const result = computeDomainAverages({ 'legacy:removed-drill': 50 });
    expect(result).toEqual([{ key: 'other', label: 'Other', score: 50 }]);
  });

  it('returns an empty list for empty stats', () => {
    expect(computeDomainAverages({})).toEqual([]);
    expect(computeDomainAverages()).toEqual([]);
  });
});
