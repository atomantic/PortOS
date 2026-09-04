/**
 * `matchesScratchRoot` decides whether an abandoned worktree holds work or only
 * PortOS's own pipeline state — a false negative costs an agent run per teardown
 * pass, a false positive would let a real change set be reaped. The input is
 * `git status --porcelain` output as `classifyWorktreeDirt` strips it, so the
 * cases here are the shapes git actually emits.
 */

import { describe, it, expect } from 'vitest';
import { isAgentScratchPath, matchesScratchRoot, AGENT_SCRATCH_PATHS } from './agentScratchPaths.js';

describe('matchesScratchRoot', () => {
  it('matches a directory root, its trailing-slash form, and anything beneath it', () => {
    const roots = ['.portos-public-review'];
    expect(matchesScratchRoot('.portos-public-review', roots)).toBe(true);
    // git collapses an untracked directory to its root with a trailing slash…
    expect(matchesScratchRoot('.portos-public-review/', roots)).toBe(true);
    // …and expands it to individual files under `-uall`.
    expect(matchesScratchRoot('.portos-public-review/PR-42.patch', roots)).toBe(true);
    expect(matchesScratchRoot('.portos-public-review/nested/deep.json', roots)).toBe(true);
  });

  // A caller spelling a directory the conventional way must not be silently
  // ignored — 'temp' vs 'temp/' matching differently is an option that looks
  // configured and does nothing.
  it('normalizes the ROOT as well as the path', () => {
    expect(matchesScratchRoot('build/out.js', ['build/'])).toBe(true);
    expect(matchesScratchRoot('build', ['build/'])).toBe(true);
    expect(matchesScratchRoot('build/', ['build/'])).toBe(true);
    // An empty or slash-only root matches nothing, rather than everything.
    expect(matchesScratchRoot('anything', ['', '/'])).toBe(false);
  });

  it('does not match a sibling that merely shares the prefix', () => {
    const roots = ['.portos-public-review', 'PORTOS_PUBLIC_REVIEW_INPUT.json'];
    expect(matchesScratchRoot('.portos-public-review-notes.md', roots)).toBe(false);
    expect(matchesScratchRoot('PORTOS_PUBLIC_REVIEW_INPUT.json.bak', roots)).toBe(false);
    // A same-named file nested under real source is not the harness's bundle.
    expect(matchesScratchRoot('docs/PORTOS_PUBLIC_REVIEW_INPUT.json', roots)).toBe(false);
  });

  it('is false for non-strings, empties and an empty root list rather than throwing', () => {
    expect(matchesScratchRoot(undefined, ['x'])).toBe(false);
    expect(matchesScratchRoot(null, ['x'])).toBe(false);
    expect(matchesScratchRoot('', ['x'])).toBe(false);
    expect(matchesScratchRoot('   ', ['x'])).toBe(false);
    expect(matchesScratchRoot(42, ['x'])).toBe(false);
    expect(matchesScratchRoot('anything', [])).toBe(false);
  });
});

describe('isAgentScratchPath', () => {
  it('recognizes the public-review bundle and nothing else', () => {
    expect(isAgentScratchPath('PORTOS_PUBLIC_REVIEW_INPUT.json')).toBe(true);
    expect(isAgentScratchPath('.portos-public-review/PR-42.patch')).toBe(true);
    expect(isAgentScratchPath('server/services/thing.js')).toBe(false);
    expect(AGENT_SCRATCH_PATHS).toEqual(['PORTOS_PUBLIC_REVIEW_INPUT.json', '.portos-public-review']);
  });
});
