/**
 * Real git history, because the guarantee is what the history proves: a retry's
 * reviewer sees an earlier attempt's change only when that attempt's own head
 * reached this run's ancestry through a merge commit.
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
  const delivery = (head, maxChars = 60_000) => priorTaskDelivery({
    taskId: 'task-1', workspacePath: repo, head, startedAt: START, maxChars,
  });

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
