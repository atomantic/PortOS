// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { summaryProblems, SUMMARY_MAX } from '../../../scripts/lib-catalog.js';

// The module catalog (`node scripts/lib-catalog.js <term>`) is derived from each
// module's header, so a module without a short summary is invisible to discovery.
describe('client/src/hooks module summaries', () => {
  it(`opens every module with a summary paragraph of at most ${SUMMARY_MAX} characters`, () => {
    expect(summaryProblems('client/src/hooks')).toEqual([]);
  });
});
