import { describe, it, expect } from 'vitest';
import { buildCleanTags, cognitiveSummary } from './PostSessionLauncher';

// Pure-function tests for PostSessionLauncher's pre-submit helpers (issue
// #2102 gap #10). Both were lifted from component-body closures to module
// scope with explicit parameters (`tags` for buildCleanTags) so they can be
// tested directly without rendering the launcher or its provider fetch.

describe('buildCleanTags', () => {
  it('keeps a filled-in value, trimmed', () => {
    expect(buildCleanTags({ sleep: '  good  ', caffeine: '', stress: '' })).toEqual({ sleep: 'good' });
  });

  it('drops empty-string values', () => {
    expect(buildCleanTags({ sleep: '', caffeine: '', stress: '' })).toEqual({});
  });

  it('drops whitespace-only values', () => {
    expect(buildCleanTags({ sleep: '   ', caffeine: '\t', stress: '' })).toEqual({});
  });

  it('keeps multiple filled-in values, each trimmed independently', () => {
    expect(buildCleanTags({ sleep: 'poor', caffeine: ' 2 cups ', stress: 'high' })).toEqual({
      sleep: 'poor',
      caffeine: '2 cups',
      stress: 'high',
    });
  });

  it('returns an empty object for an empty tags map', () => {
    expect(buildCleanTags({})).toEqual({});
  });
});

describe('cognitiveSummary', () => {
  it('summarizes n-back as "<n>-back", defaulting n to 2', () => {
    expect(cognitiveSummary('n-back', {})).toBe('2-back');
    expect(cognitiveSummary('n-back', { n: 3 })).toBe('3-back');
  });

  it('summarizes digit-span as a start–max length range, defaulting to 3–8', () => {
    expect(cognitiveSummary('digit-span', {})).toBe('3–8');
    expect(cognitiveSummary('digit-span', { startLength: 4, maxLength: 9 })).toBe('4–9');
  });

  it('summarizes schulte-table as a size×size grid, defaulting to 5×5', () => {
    expect(cognitiveSummary('schulte-table', {})).toBe('5×5');
    expect(cognitiveSummary('schulte-table', { size: 6 })).toBe('6×6');
  });

  it('summarizes reaction-time as trial count + mode, defaulting to 15 trials (simple)', () => {
    expect(cognitiveSummary('reaction-time', {})).toBe('15 trials (simple)');
    expect(cognitiveSummary('reaction-time', { count: 20, mode: 'choice' })).toBe('20 trials (choice)');
  });

  it('falls back to "<count> trials" for an unrecognized type with a count', () => {
    expect(cognitiveSummary('stroop', { count: 10 })).toBe('10 trials');
  });

  it('falls back to an empty string for an unrecognized type with no count', () => {
    expect(cognitiveSummary('mental-rotation', {})).toBe('');
  });
});
