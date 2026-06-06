import { describe, it, expect } from 'vitest';
import { insightProvenance } from './ActionableInsightsBanner';

// The banner stamps each surfaced insight with a provenance chip. The honesty
// distinction the feature exists to enforce is that a *counted fact* (N tasks
// awaiting approval, N blocked, N health issues) must read as data-backed, while
// only the success-rate-modeled types (auto-skipped task types, peak-hour
// suggestion) read as inferred. These tests pin that mapping so it can't silently
// regress back to a single hardcoded level.
describe('ActionableInsightsBanner insightProvenance', () => {
  it('marks direct-count insight types as data-backed', () => {
    for (const type of ['approval', 'blocked', 'health', 'briefing', 'tasks']) {
      expect(insightProvenance(type).level).toBe('data-backed');
    }
  });

  it('marks success-rate-modeled insight types as inferred', () => {
    for (const type of ['learning', 'peak-time']) {
      expect(insightProvenance(type).level).toBe('inferred');
    }
  });

  it('defaults an unknown insight type to data-backed (a count, not a model)', () => {
    // New insight types are far more likely to be counts than statistical models,
    // so the safe default is data-backed — an over-claim of "inferred" is the one
    // mislabel this feature must avoid.
    expect(insightProvenance('some-future-type').level).toBe('data-backed');
  });
});
