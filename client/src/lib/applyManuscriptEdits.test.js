import { describe, it, expect } from 'vitest';
import { applyEditsToContent, planManuscriptEdits } from './applyManuscriptEdits.js';

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

  it('applies an edit whose find differs only in whitespace (LLM reformatting)', () => {
    const content = 'PAGE 56\nPANEL 1\nGiant stands.';
    // find has an extra blank line the manuscript does not — still applies.
    const out = applyEditsToContent(content, [{ find: 'PAGE 56\n\nPANEL 1\nGiant stands.', replace: 'PAGE 56\nPANEL 1\nGiant kneels.' }]);
    expect(out).toBe('PAGE 56\nPANEL 1\nGiant kneels.');
  });
});

describe('planManuscriptEdits', () => {
  it('reports applied count and leaves content when nothing matches', () => {
    const plan = planManuscriptEdits('hello world', [{ find: 'xyz', replace: 'q' }]);
    expect(plan).toEqual({ output: 'hello world', applied: 0, notFound: 1, overlapping: 0 });
  });

  it('counts overlapping edits (which the server accept rejects) and keeps the earlier one', () => {
    const plan = planManuscriptEdits('abcdef', [
      { find: 'abc', replace: 'X' },
      { find: 'bcd', replace: 'Y' },
    ]);
    expect(plan.output).toBe('Xdef');
    expect(plan.applied).toBe(1);
    expect(plan.overlapping).toBe(1);
  });

  it('applies multiple non-overlapping edits with no drops', () => {
    const plan = planManuscriptEdits('alpha beta gamma', [
      { find: 'alpha', replace: 'A' },
      { find: 'gamma', replace: 'G' },
    ]);
    expect(plan.output).toBe('A beta G');
    expect(plan).toMatchObject({ applied: 2, notFound: 0, overlapping: 0 });
  });
});
