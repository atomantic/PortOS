import { describe, it, expect } from 'vitest';
import { meanQualityScore } from './revisionSteps.js';

describe('meanQualityScore (#2171)', () => {
  it('averages only judged, finite scores', () => {
    expect(meanQualityScore({ scores: [
      { judged: true, qualityScore: 6 },
      { judged: true, qualityScore: 8 },
      { judged: false, qualityScore: null },
    ] })).toBe(7);
  });
  it('is null when nothing is judged', () => {
    expect(meanQualityScore({ scores: [{ judged: false, qualityScore: null }] })).toBe(null);
    expect(meanQualityScore({ scores: [] })).toBe(null);
  });
});
