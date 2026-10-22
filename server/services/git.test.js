import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPR, extractAgentSummary, requestCopilotReview } from './git.js';

describe('createPR', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Regression: `spawn` was previously used inside createPR but the
  // `import { spawn } from '../lib/childProcess.js'` line was dropped during a refactor,
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

describe('requestCopilotReview', () => {
  it('returns structured failure for unparseable URL without invoking gh', async () => {
    const result = await requestCopilotReview('/nonexistent-path-for-test', 'not a url');
    expect(result).toEqual({ success: false, error: expect.stringContaining('unparseable PR URL') });
  });

  it('returns { success: true, skipped: true } when the PR URL host is a non-GitHub forge', async () => {
    // The current implementation short-circuits on the PR URL's host (via
    // detectForgeCli(parsed.host)) before consulting the repo's origin remote.
    // A GitLab MR URL therefore skips cleanly regardless of `dir` — no git repo,
    // no system git binary, no environment-specific setup needed.
    const result = await requestCopilotReview('/nonexistent-path-for-test', 'https://gitlab.com/group/proj/-/merge_requests/1');
    expect(result).toEqual({ success: true, skipped: true });
  });

  // The success/failure paths invoke spawn() against the real `gh` binary.
  // Module-level mocking of `child_process` is fragile here: git.js captures
  // `spawn` at load time and `resolveForgeForRepo` itself shells out to git
  // and gh, making the mock surface bigger than the assertion is worth.
  // The mocked-spawn coverage is provided in cleanupAgentWorktree.test.js,
  // which mocks `./git.js` wholesale — here we just verify the parser/skip
  // contract so the request never reaches a real network call.
});

it('preserves forge credential exports for existing Git service callers', async () => {
  const auth = await import('./forgeAuth.js');
  const git = await import('./git.js');
  expect(git.resolveForgeTokenEnv).toBe(auth.resolveForgeTokenEnv);
  expect(git.resolveForgeForRepo).toBe(auth.resolveForgeForRepo);
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

  it('strips leading "## Summary" heading so the PR body does not double it up', () => {
    const output = [
      '🔧 Using Edit tool',
      '  → /path/to/file.js',
      '',
      '## Summary',
      '',
      'Added a Run Backup Now button and default-exclusions display.',
      'All tests pass.'
    ].join('\n');

    const summary = extractAgentSummary(output);
    expect(summary).not.toMatch(/^#{1,6}?\s*summary/i);
    expect(summary?.split('\n')[0]).toContain('Added a Run Backup Now button');
  });

  it('strips leading "Summary:" (no markdown prefix) too', () => {
    const output = [
      '🔧 Using Edit tool',
      '  → /path/to/file.js',
      '',
      'Summary:',
      '',
      'Added a Run Backup Now button and default-exclusions display.',
      'All tests pass.'
    ].join('\n');

    const summary = extractAgentSummary(output);
    expect(summary?.split('\n')[0]).toContain('Added a Run Backup Now button');
  });
});


// Every suite that exercises the resume path mocks `./git.js` wholesale, so a
// helper that was renamed or never exported stays invisible there and only fails
// at runtime (an ollama review pass flagged exactly this shape as a suspected bug).
// This asserts the real module against the real caller — the one place a mocked
// suite structurally cannot check.
describe('git.js exports the helpers the agent resume path calls', () => {
  it('exposes every function agentWorktreeCleanup.resolveResumePointer uses', async () => {
    const git = await vi.importActual('./git.js');
    const gitForge = await vi.importActual('../lib/gitForge.js');
    for (const name of ['parseGitRemote', 'parseGitHubOwnerFromRemote', 'pickGhAccountForOwner', 'detectForgeCli', 'parsePullRequestUrl']) {
      expect(git[name], `git.${name} must re-export gitForge.${name}`).toBe(gitForge[name]);
    }
    expect(git.isBranchMergedInto).toBe(git.hasBranchMergeEvidence);
    for (const name of [
      'getBranch', 'getStatusPorcelain', 'getBranchComparison',
      'hasBranchMergeEvidence', 'getWorktreeBranches', 'getDefaultBranch'
    ]) {
      expect(typeof git[name], `git.${name} must be exported`).toBe('function');
    }
  });
});
