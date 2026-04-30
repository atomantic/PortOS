import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPR, extractAgentSummary, parseGitHubOwnerFromRemote, pickGhAccountForOwner, parseGitRemote, detectForgeCli, parsePullRequestUrl, requestCopilotReview } from './git.js';

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

describe('parsePullRequestUrl', () => {
  it('parses GitHub PR URLs', () => {
    expect(parsePullRequestUrl('https://github.com/atomantic/PortOS/pull/185')).toEqual({
      host: 'github.com', owner: 'atomantic', repo: 'PortOS', number: 185
    });
    expect(parsePullRequestUrl('http://github.example.com/org/repo/pull/1')).toEqual({
      host: 'github.example.com', owner: 'org', repo: 'repo', number: 1
    });
  });

  it('parses GitLab MR URLs', () => {
    expect(parsePullRequestUrl('https://gitlab.com/group/project/-/merge_requests/42')).toEqual({
      host: 'gitlab.com', owner: 'group', repo: 'project', number: 42
    });
  });

  it('parses GitLab MR URLs with subgroups (owner = full group path)', () => {
    expect(parsePullRequestUrl('https://gitlab.com/group/subgroup/project/-/merge_requests/7')).toEqual({
      host: 'gitlab.com', owner: 'group/subgroup', repo: 'project', number: 7
    });
    expect(parsePullRequestUrl('https://gitlab.example.com/g1/g2/g3/proj/-/merge_requests/100')).toEqual({
      host: 'gitlab.example.com', owner: 'g1/g2/g3', repo: 'proj', number: 100
    });
  });

  it('tolerates trailing path segments and query/hash fragments', () => {
    expect(parsePullRequestUrl('https://github.com/atomantic/PortOS/pull/186/files')).toEqual({
      host: 'github.com', owner: 'atomantic', repo: 'PortOS', number: 186
    });
    expect(parsePullRequestUrl('https://github.com/atomantic/PortOS/pull/186/commits/abc')).toEqual({
      host: 'github.com', owner: 'atomantic', repo: 'PortOS', number: 186
    });
    expect(parsePullRequestUrl('https://github.com/atomantic/PortOS/pull/186?diff=split')).toEqual({
      host: 'github.com', owner: 'atomantic', repo: 'PortOS', number: 186
    });
    expect(parsePullRequestUrl('https://gitlab.com/group/sub/proj/-/merge_requests/9/diffs')).toEqual({
      host: 'gitlab.com', owner: 'group/sub', repo: 'proj', number: 9
    });
  });

  it('returns null for invalid input', () => {
    expect(parsePullRequestUrl(null)).toBeNull();
    expect(parsePullRequestUrl('')).toBeNull();
    expect(parsePullRequestUrl(undefined)).toBeNull();
    expect(parsePullRequestUrl('https://github.com/atomantic/PortOS')).toBeNull();
    expect(parsePullRequestUrl('not a url')).toBeNull();
    expect(parsePullRequestUrl('https://github.com/atomantic/PortOS/pull/notanumber')).toBeNull();
    expect(parsePullRequestUrl('https://github.com/atomantic/PortOS/pull/0')).toBeNull();
  });
});

describe('requestCopilotReview', () => {
  it('returns structured failure for unparseable URL without invoking gh', async () => {
    const result = await requestCopilotReview('/nonexistent-path-for-test', 'not a url');
    expect(result).toEqual({ success: false, error: expect.stringContaining('unparseable PR URL') });
  });

  it('does not throw on a parseable URL when gh is unavailable (graceful failure)', async () => {
    // We can't easily mock spawn here, but we can confirm the function returns
    // a structured failure rather than throwing when invoked end-to-end.
    const result = await requestCopilotReview('/nonexistent-path-for-test', 'https://github.com/test/repo/pull/1');
    expect(result).toHaveProperty('success');
    if (!result.success) expect(typeof result.error).toBe('string');
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
