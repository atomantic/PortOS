// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { planManuscriptEdits } from './applyManuscriptEdits.js';

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
// @vitest-environment node
