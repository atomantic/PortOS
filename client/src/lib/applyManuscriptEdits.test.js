import { describe, it, expect } from 'vitest';
import { applyEditsToContent } from './applyManuscriptEdits.js';

describe('applyEditsToContent', () => {
  it('applies a single find/replace', () => {
    expect(applyEditsToContent('the door slammed shut', [{ find: 'slammed', replace: 'creaked' }]))
      .toBe('the door creaked shut');
  });

  it('applies multiple non-overlapping edits without offset drift', () => {
    const out = applyEditsToContent('alpha beta gamma', [
      { find: 'alpha', replace: 'ALPHA' },
      { find: 'gamma', replace: 'GAMMA' },
    ]);
    expect(out).toBe('ALPHA beta GAMMA');
  });

  it('skips an edit whose find is absent', () => {
    expect(applyEditsToContent('hello world', [{ find: 'xyz', replace: 'q' }])).toBe('hello world');
  });

  it('drops a later edit that overlaps an earlier one', () => {
    // Both target overlapping ranges of "abcdef"; keep the earlier (lower-start).
    const out = applyEditsToContent('abcdef', [
      { find: 'abc', replace: 'X' },
      { find: 'bcd', replace: 'Y' },
    ]);
    expect(out).toBe('Xdef');
  });

  it('disambiguates a recurring find by the anchorQuote', () => {
    const text = 'run ... [here] run ... done';
    const out = applyEditsToContent(text, [{ find: 'run', replace: 'WALK', anchorQuote: '[here]' }]);
    // Replaces the second "run" (nearest the anchor), not the first.
    expect(out).toBe('run ... [here] WALK ... done');
  });

  it('returns content unchanged for empty edit list', () => {
    expect(applyEditsToContent('text', [])).toBe('text');
  });
});
