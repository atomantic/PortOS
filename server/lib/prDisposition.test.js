import { describe, expect, it } from 'vitest';
import { PR_COMPLETIONS, resolvePrCompletion } from './prDisposition.js';

describe('resolvePrCompletion', () => {
  it('prefers an explicit valid disposition', () => {
    expect(resolvePrCompletion({ prCompletion: PR_COMPLETIONS.LEAVE_OPEN, reviewLoop: true }))
      .toBe(PR_COMPLETIONS.LEAVE_OPEN);
  });

  it.each([
    [{ openPR: true, reviewLoop: true }, PR_COMPLETIONS.REVIEW_THEN_MERGE],
    [{ openPR: true, reviewLoop: 'true' }, PR_COMPLETIONS.REVIEW_THEN_MERGE],
    [{ openPR: true, reviewLoop: false }, PR_COMPLETIONS.MERGE_ON_GREEN],
    [{ openPR: true }, PR_COMPLETIONS.MERGE_ON_GREEN],
  ])('preserves legacy behavior for %o', (metadata, expected) => {
    expect(resolvePrCompletion(metadata)).toBe(expected);
  });

  it('falls back to legacy behavior when an unrecognized value is stored', () => {
    expect(resolvePrCompletion({ prCompletion: 'later', reviewLoop: true }))
      .toBe(PR_COMPLETIONS.REVIEW_THEN_MERGE);
  });
});
