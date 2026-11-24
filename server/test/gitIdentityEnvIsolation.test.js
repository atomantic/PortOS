import { describe, it, expect } from 'vitest';

// Meaningful when the launching shell exports a git identity (agent sessions do):
// vitest.setup.js must have scrubbed it before any suite builds a git fixture.
describe('git identity env isolation (#18423)', () => {
  it('does not leak GIT_AUTHOR_*/GIT_COMMITTER_* into test workers', () => {
    const leaked = Object.keys(process.env).filter((k) => /^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)$/.test(k));
    expect(leaked).toEqual([]);
  });
});
