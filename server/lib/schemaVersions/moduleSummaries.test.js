import { describe, it, expect } from 'vitest';
import { summaryProblems, SUMMARY_MAX } from '../../../scripts/lib-catalog.js';

describe('server/lib/schemaVersions module summaries', () => {
  it(`opens every module with a summary paragraph of at most ${SUMMARY_MAX} characters`, () => {
    expect(summaryProblems('server/lib/schemaVersions')).toEqual([]);
  });
});
