import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPR, extractAgentSummary, parseGitHubOwnerFromRemote, pickGhAccountForOwner, parseGitRemote, detectForgeCli } from './git.js';

describe('parseGitRemote', () => {
  it('parses GitHub SSH urls', () => {
    expect(parseGitRemote('git@github.com:atomantic/PortOS.git')).toEqual({ host: 'github.com', owner: 'atomantic' });
    expect(parseGitRemote('git@github.com:atomantic/PortOS')).toEqual({ host: 'github.com', owner: 'atomantic' });
  });

  it('parses GitHub HTTPS urls', () => {
    expect(parseGitRemote('https://github.com/atomantic/PortOS.git')).toEqual({ host: 'github.com', owner: 'atomantic' });
    expect(parseGitRemote('https://github.com/atomantic/PortOS')).toEqual({ host: 'github.com', owner: 'atomantic' });
  });

  it('parses GitLab SSH and HTTPS urls (including subgroup paths)', () => {
    expect(parseGitRemote('git@gitlab.com:my-group/my-project.git')).toEqual({ host: 'gitlab.com', owner: 'my-group' });
    expect(parseGitRemote('https://gitlab.com/my-group/sub/proj.git')).toEqual({ host: 'gitlab.com', owner: 'my-group' });
    expect(parseGitRemote('git@gitlab.example.com:team/repo.git')).toEqual({ host: 'gitlab.example.com', owner: 'team' });
  });

  it('returns null for empty, null, or malformed input', () => {
    expect(parseGitRemote('')).toBeNull();
    expect(parseGitRemote(null)).toBeNull();
    expect(parseGitRemote(undefined)).toBeNull();
    expect(parseGitRemote('github.com:atomantic/PortOS')).toBeNull();
    expect(parseGitRemote('git@github.com:noslash')).toBeNull();
  });
});

describe('parseGitHubOwnerFromRemote (back-compat wrapper)', () => {
  it('returns owner only for github.com hosts', () => {
    expect(parseGitHubOwnerFromRemote('git@github.com:atomantic/PortOS.git')).toBe('atomantic');
    expect(parseGitHubOwnerFromRemote('https://github.com/atomantic/PortOS')).toBe('atomantic');
  });

  it('returns null for non-github hosts', () => {
    expect(parseGitHubOwnerFromRemote('git@gitlab.com:foo/bar.git')).toBeNull();
    expect(parseGitHubOwnerFromRemote('https://bitbucket.org/foo/bar')).toBeNull();
  });

  it('returns null for empty or malformed input', () => {
    expect(parseGitHubOwnerFromRemote('')).toBeNull();
    expect(parseGitHubOwnerFromRemote(null)).toBeNull();
    expect(parseGitHubOwnerFromRemote('git@github.com:noslash')).toBeNull();
  });
});

describe('detectForgeCli', () => {
  it('routes github.com to gh', () => {
    expect(detectForgeCli('github.com')).toBe('gh');
  });

  it('routes gitlab.com and self-hosted gitlab to glab', () => {
    expect(detectForgeCli('gitlab.com')).toBe('glab');
    expect(detectForgeCli('gitlab.example.com')).toBe('glab');
    expect(detectForgeCli('GitLab.Internal.Co')).toBe('glab');
  });

  it('defaults to gh for unknown or empty hosts', () => {
    expect(detectForgeCli('bitbucket.org')).toBe('gh');
    expect(detectForgeCli(null)).toBe('gh');
    expect(detectForgeCli('')).toBe('gh');
  });
});

describe('pickGhAccountForOwner', () => {
  it('matches owner to account case-insensitively', () => {
    expect(pickGhAccountForOwner('atomantic', ['atomantic', 'ClawedCode'])).toBe('atomantic');
    expect(pickGhAccountForOwner('Atomantic', ['atomantic', 'ClawedCode'])).toBe('atomantic');
    expect(pickGhAccountForOwner('clawedcode', ['atomantic', 'ClawedCode'])).toBe('ClawedCode');
    expect(pickGhAccountForOwner('CLAWEDCODE', ['atomantic', 'ClawedCode'])).toBe('ClawedCode');
  });

  it('returns null when no account matches the owner', () => {
    expect(pickGhAccountForOwner('someorg', ['atomantic', 'ClawedCode'])).toBeNull();
  });

  it('returns null with empty inputs', () => {
    expect(pickGhAccountForOwner('atomantic', [])).toBeNull();
    expect(pickGhAccountForOwner('atomantic', null)).toBeNull();
    expect(pickGhAccountForOwner(null, ['atomantic'])).toBeNull();
    expect(pickGhAccountForOwner('', ['atomantic'])).toBeNull();
  });
});

describe('createPR', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Regression: `spawn` was previously used inside createPR but the
  // `import { spawn } from 'child_process'` line was dropped during a refactor,
  // causing every CoS-agent PR to fail with "spawn is not defined" and falling
  // back to the recovery-task path. The check below ensures a real call into
  // createPR doesn't throw a ReferenceError before completing.
  it('does not throw ReferenceError when spawn is invoked (regression: missing spawn import)', async () => {
    // Use a non-existent cwd; gh will simply fail to launch ("ENOENT") which
    // is the desired failure mode — it must surface as a structured
    // { success: false, error: ... } object, not a thrown ReferenceError.
    const result = await createPR('/nonexistent-path-for-test', {
      title: 'test',
      body: 'test',
      base: 'main',
      head: 'test-branch'
    });

    expect(result).toHaveProperty('success', false);
    expect(typeof result.error).toBe('string');
    // The error must come from gh/spawn behavior, NOT from a missing-import bug.
    expect(result.error).not.toMatch(/spawn is not defined/);
  });
});

describe('extractAgentSummary', () => {
  it('returns null for short output', () => {
    expect(extractAgentSummary(null)).toBeNull();
    expect(extractAgentSummary('')).toBeNull();
    expect(extractAgentSummary('too short')).toBeNull();
  });

  it('extracts trailing summary after last tool-call line', () => {
    const output = [
      'Investigating the bug.',
      '🔧 Using Read tool',
      '  → /path/to/file.js',
      '',
      'Implemented the fix by adding the missing null check on line 42.',
      'All tests pass: 187/187.'
    ].join('\n');

    const summary = extractAgentSummary(output);
    expect(summary).toContain('Implemented the fix');
    expect(summary).toContain('All tests pass');
    expect(summary).not.toContain('🔧');
  });
});
