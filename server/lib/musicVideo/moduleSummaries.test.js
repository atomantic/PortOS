import { describe, it, expect } from 'vitest';
import { summaryProblems, SUMMARY_MAX } from '../../../scripts/lib-catalog.js';

// The catalog lists only modules directly inside a catalog directory, so this
// music-video subdirectory of server/lib is its own catalog directory (#16561).
describe('server/lib/musicVideo module summaries', () => {
  it(`opens every module with a summary paragraph of at most ${SUMMARY_MAX} characters`, () => {
    expect(summaryProblems('server/lib/musicVideo')).toEqual([]);
  });
});
