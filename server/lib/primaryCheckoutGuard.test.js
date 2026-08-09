/**
 * Branch-jack detector tests (#3680).
 *
 * Run against REAL git repositories in a temp dir rather than a mocked
 * `execGit`: the whole value of this module is that it reads git state
 * correctly, and a mock that returns whatever the test author expected `git
 * rev-parse` to print proves nothing about that.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execGit } from './execGit.js';
import {
  capturePrimaryCheckoutState,
  detectPrimaryCheckoutDrift,
  formatDriftMessage,
  formatDriftRecovery,
  PRIMARY_CHECKOUT_MUTATED_CATEGORY,
  PRIMARY_CHECKOUT_MUTATED_REASON,
} from './primaryCheckoutGuard.js';

let repo;
let scratch;

async function commit(subject) {
  await writeFile(join(repo, `${subject.replace(/\W+/g, '-')}.txt`), subject);
  await execGit(['add', '-A'], repo);
  await execGit(['commit', '-m', subject], repo);
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'portos-branch-jack-'));
  repo = join(scratch, 'primary');
  await execGit(['init', '-b', 'main', repo], scratch);
  // Local identity so the suite doesn't depend on (or read) the host's git config.
  await execGit(['config', 'user.email', 'agent@example.com'], repo);
  await execGit(['config', 'user.name', 'Example Agent'], repo);
  await commit('initial');
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
});

describe('capturePrimaryCheckoutState', () => {
  it('reads the current branch and HEAD', async () => {
    const state = await capturePrimaryCheckoutState(repo);
    expect(state.path).toBe(repo);
    expect(state.branch).toBe('main');
    expect(state.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('returns null for a missing path, a non-repo, and a non-string', async () => {
    expect(await capturePrimaryCheckoutState(join(scratch, 'nope'))).toBeNull();
    expect(await capturePrimaryCheckoutState(scratch)).toBeNull();
    expect(await capturePrimaryCheckoutState(null)).toBeNull();
    expect(await capturePrimaryCheckoutState('')).toBeNull();
  });
});

describe('detectPrimaryCheckoutDrift', () => {
  it('reports no drift when the primary checkout is untouched', async () => {
    const baseline = await capturePrimaryCheckoutState(repo);
    // Simulate the run happening entirely elsewhere: nothing touches `repo`.
    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch: 'claim/issue-1' });
    expect(verdict).toEqual({ drifted: false });
  });

  it('detects commits landed on the primary checkout during the run', async () => {
    const baseline = await capturePrimaryCheckoutState(repo);
    await commit('branch jacked one');
    await commit('branch jacked two');

    const verdict = await detectPrimaryCheckoutDrift(baseline, { agentBranch: 'cos/task-x/agent-y' });
    expect(verdict.drifted).toBe(true);
    expect(verdict.reason).toBe(PRIMARY_CHECKOUT_MUTATED_REASON);
    expect(verdict.category).toBe(PRIMARY_CHECKOUT_MUTATED_CATEGORY);
    expect(verdict.commitCount).toBe(2);
    // The message names the drifted branch and the commit count...
    expect(verdict.message).toContain('main');
    expect(verdict.message).toContain('2 new commits');
    // ...and the fix names the agent branch plus the exact recovery command.
    expect(verdict.suggestedFix).toContain('cos/task-x/agent-y');
    expect(verdict.suggestedFix).toContain(`git -C ${repo} reset --hard origin/main`);
  });

  it('detects a branch switch even with no new commits', async () => {
    const baseline = await capturePrimaryCheckoutState(repo);
    await execGit(['checkout', '-b', 'someone-elses-branch'], repo);

    const verdict = await detectPrimaryCheckoutDrift(baseline);
    expect(verdict.drifted).toBe(true);
    expect(verdict.commitCount).toBe(0);
    expect(verdict.message).toContain('main → someone-elses-branch');
  });

  it('reports no drift when there is nothing to check', async () => {
    expect(await detectPrimaryCheckoutDrift(null)).toEqual({ drifted: false });
    expect(await detectPrimaryCheckoutDrift({ path: repo })).toEqual({ drifted: false });
    // A checkout that vanished mid-run verified nothing, so it must not
    // manufacture a failure.
    const baseline = await capturePrimaryCheckoutState(repo);
    await rm(repo, { recursive: true, force: true });
    expect(await detectPrimaryCheckoutDrift(baseline)).toEqual({ drifted: false });
  });

  it('still reports the drift when the commit count is unresolvable', async () => {
    const baseline = { path: repo, branch: 'main', head: 'f'.repeat(40) };
    const verdict = await detectPrimaryCheckoutDrift(baseline);
    expect(verdict.drifted).toBe(true);
    expect(verdict.commitCount).toBeNull();
    expect(verdict.message).toContain('commit count unresolved');
  });
});

describe('prose helpers', () => {
  const baseline = { path: '/example/repo', branch: 'main', head: 'a'.repeat(40) };
  const current = { path: '/example/repo', branch: 'main', head: 'b'.repeat(40) };

  it('singularizes a one-commit drift', () => {
    expect(formatDriftMessage({ baseline, current, commitCount: 1 })).toContain('(1 new commit)');
    expect(formatDriftRecovery({ current, commitCount: 1, agentBranch: null })).toContain('1 commit ');
  });

  it('never tells the user PortOS already fixed it', () => {
    const fix = formatDriftRecovery({ current, commitCount: 3, agentBranch: 'claim/issue-3680' });
    expect(fix).toContain('DISCARDS');
    expect(fix).toContain('PortOS will not run it for you');
  });
});
