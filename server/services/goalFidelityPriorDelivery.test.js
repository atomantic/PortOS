/**
 * Real git history, because the guarantee is what the history proves: a retry's
 * reviewer sees an earlier attempt's change only with a proven merge or a
 * server-captured baseline and earlier head on the same retained branch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const agents = vi.hoisted(() => ({ resident: [], archived: [] }));
vi.mock('./cosAgentLifecycle.js', () => ({ getAgents: vi.fn(async () => agents.resident) }));
vi.mock('./cosAgentIndex.js', () => ({ getAgentsByDate: vi.fn(async () => agents.archived) }));

import { priorTaskDelivery } from './goalFidelityPriorDelivery.js';

const START = Date.parse('2026-01-02T00:00:00Z');
const attempt = (id, head, { taskId = 'task-1', startedAt = START - 60_000 } = {}) => ({
  id, taskId, startedAt, metadata: { completedCheckouts: [{ head }] },
});

describe('priorTaskDelivery', () => {
  let repo;
  const git = (...args) => execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();
  const commit = (file, message) => {
    writeFileSync(join(repo, file), `${message}\n`);
    git('add', file);
    git('commit', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const branchCommit = (branch, file, message) => {
    git('checkout', '-q', '-b', branch, 'main');
    const head = commit(file, message);
    git('checkout', '-q', 'main');
    return head;
  };
  const delivery = (head, maxChars = 60_000, options = {}) => priorTaskDelivery({
    taskId: 'task-1', workspacePath: repo, head, startedAt: START, maxChars, ...options,
  });
  const retainedAttempt = head => ({ ...attempt('agent-original', head), metadata: {
    completedCheckouts: [{ head, branch: 'retained-pr' }],
    primaryCheckoutBaseline: { head: git('rev-parse', 'main') },
  } });
  const mergeRetainedBranch = () => {
    const head = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    commit('upstream.txt', 'unrelated upstream work');
    git('merge', '-q', '--no-ff', '-m', 'Merge dependency PR', 'retained-pr');
    git('checkout', '-q', 'retained-pr');
    return head;
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'portos-prior-delivery-'));
    git('init', '-q', '-b', 'main');
    commit('base.txt', 'base');
    agents.resident = [];
    agents.archived = [];
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  // The overturned run: attempt 1 merged the root-cause fix, so attempt 2's own
  // window could not show it.
  it('returns the merged change and its commit messages for an archived attempt', async () => {
    const fixHead = branchCommit('attempt-1', 'fix.txt', 'fix: bound the prompt that caused the provider timeout');
    git('merge', '-q', '--no-ff', '-m', 'Merge attempt 1', 'attempt-1');
    agents.archived = [attempt('agent-1', fixHead)];
    const result = await delivery(git('rev-parse', 'HEAD'));
    expect(result.heads).toEqual([fixHead]);
    expect(result.diff).toContain('# fix: bound the prompt that caused the provider timeout');
    expect(result.diff).toContain('diff --git a/fix.txt b/fix.txt');
    expect(result.diff).not.toContain('base.txt');
  });

  it('offers nothing when the attempt\'s head never merged', async () => {
    const abandoned = branchCommit('attempt-1', 'fix.txt', 'fix: never merged');
    agents.resident = [attempt('agent-1', abandoned)];
    expect(await delivery(commit('other.txt', 'unrelated main commit'))).toBeNull();
  });

  it('offers nothing for a head that landed without a merge commit', async () => {
    const fastForwarded = branchCommit('attempt-1', 'fix.txt', 'fix: fast forwarded');
    git('merge', '-q', '--ff-only', 'attempt-1');
    agents.resident = [attempt('agent-1', fastForwarded)];
    expect(await delivery(git('rev-parse', 'HEAD'))).toBeNull();
  });

  // #15770: two bumps precede the recovery window; the recovery repairs only
  // Reactor checksums, then merges the continued tip, NOT the earlier tip.
  it('recovers the full retained PR and reported audit coverage without a refreshed upstream ref', async () => {
    git('checkout', '-q', '-b', 'retained-pr');
    commit('server-package.json', 'fix: update minimatch to 11.0.8');
    const earlierHead = commit('client-package.json', 'fix: update Lucide, Vite, nanoid and private uv');
    const original = retainedAttempt(earlierHead);
    original.metadata.taskSummary = 'Paginated alerts: zero open. Complete PR preload: no bots. Four npm audits clean; 451 Python OSV queries clean. Container/native coverage gaps remain tracked.';
    agents.archived = [original];
    commit('setup-reactor.js', 'fix: align the five uv release digests');
    const head = mergeRetainedBranch();
    const options = { base: earlierHead, includeExecutionReport: true };
    const result = await delivery(head, 60_000, options);
    expect(result.heads).toEqual([earlierHead]);
    expect(result.diff).toContain('diff --git a/server-package.json');
    expect(result.diff).toContain('diff --git a/client-package.json');
    expect(result.diff).toContain('diff --git a/setup-reactor.js');
    expect(result.diff).toContain('# fix: update minimatch');
    expect(result.diff).toContain(original.metadata.taskSummary);
    expect(result.diff).toContain('Agent-authored claims; command execution is not independently established');
    expect(result.diff).not.toContain('upstream.txt');
    expect((await delivery(head, 60_000, { base: earlierHead })).diff).not.toContain('execution report');
    const bounded = await delivery(head, result.diff.indexOf('Paginated') + 20, options);
    expect(bounded.diff.length).toBeLessThanOrEqual(result.diff.indexOf('Paginated') + 20);
  });

  it('does not borrow an unmerged or later branch head without retained-branch provenance', async () => {
    git('checkout', '-q', '-b', 'retained-pr');
    const earlierHead = commit('package.json', 'fix: dependency bump');
    agents.resident = [attempt('agent-original', earlierHead)];
    const unmerged = commit('setup-reactor.js', 'fix: checksums');
    expect(await delivery(unmerged)).toBeNull();
    mergeRetainedBranch();
    const later = commit('later.txt', 'later unmerged work');
    expect(await delivery(later)).toBeNull();
  });

  it.each(['different branch', 'different window base', 'different task', 'unrelated source baseline'])(
    'does not restore earlier source with %s', async mismatch => {
      git('checkout', '-q', '-b', 'retained-pr');
      const earlierHead = commit('package.json', 'fix: dependency bump');
      const original = retainedAttempt(earlierHead);
      agents.resident = [original];
      const head = commit('setup-reactor.js', 'fix: checksums');
      let base = earlierHead;
      if (mismatch === 'different branch') original.metadata.completedCheckouts[0].branch = 'another-pr';
      if (mismatch === 'different window base') base = original.metadata.primaryCheckoutBaseline.head;
      if (mismatch === 'different task') original.taskId = 'another-task';
      if (mismatch === 'unrelated source baseline') original.metadata.primaryCheckoutBaseline.head = branchCommit('unrelated', 'other.txt', 'another branch');
      if (mismatch === 'unrelated source baseline') git('checkout', '-q', 'retained-pr');
      expect(await delivery(head, 60_000, { base })).toBeNull();
    },
  );

  it('rejects an earlier task head already on the merge first parent', async () => {
    const upstream = commit('upstream.txt', 'earlier work on main');
    agents.resident = [attempt('agent-original', upstream)];
    git('checkout', '-q', '-b', 'retained-pr');
    commit('setup-reactor.js', 'fix: checksums only');
    expect(await delivery(mergeRetainedBranch())).toBeNull();
  });

  it('uses net current source so a continuation cannot resurrect a reverted dependency update', async () => {
    git('checkout', '-q', '-b', 'retained-pr');
    const earlierHead = commit('package.json', 'fix: dependency bump');
    agents.resident = [retainedAttempt(earlierHead)];
    git('revert', '--no-edit', earlierHead);
    commit('setup-reactor.js', 'fix: checksums only');
    const result = await delivery(mergeRetainedBranch(), 60_000, { base: earlierHead });
    expect(result.diff).toContain('diff --git a/setup-reactor.js');
    expect(result.diff).not.toContain('diff --git a/package.json');
  });

  it('ignores merges that belong to another task or start after this run', async () => {
    const otherTask = branchCommit('other', 'other.txt', 'fix: another task');
    git('merge', '-q', '--no-ff', '-m', 'Merge other', 'other');
    const later = branchCommit('later', 'later.txt', 'fix: a later run');
    git('merge', '-q', '--no-ff', '-m', 'Merge later', 'later');
    agents.resident = [
      attempt('agent-other', otherTask, { taskId: 'task-2' }),
      attempt('agent-later', later, { startedAt: START + 60_000 }),
    ];
    expect(await delivery(git('rev-parse', 'HEAD'))).toBeNull();
  });

  it('stays within the budget left over by this run\'s own diff', async () => {
    const fixHead = branchCommit('attempt-1', 'fix.txt', 'fix: a change too large for the budget');
    git('merge', '-q', '--no-ff', '-m', 'Merge attempt 1', 'attempt-1');
    agents.resident = [attempt('agent-1', fixHead)];
    const head = git('rev-parse', 'HEAD');
    const { diff } = await delivery(head, 120);
    expect(diff.length).toBeLessThanOrEqual(120);
    expect(diff).toContain('…[earlier delivery truncated]');
    expect(await delivery(head, 0)).toBeNull();
  });
});
