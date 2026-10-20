import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execGit } from '../lib/execGit.js';
import { materializeGitRepo } from '../lib/gitTestRepo.js';
import { captureCompletedCheckouts, hasCompletedCheckoutEvidence } from './completedCheckoutEvidence.js';

describe('completed claim checkout evidence', () => {
  let scratch, repoPath, path, head, agent;
  const branch = 'claim/issue-1';
  const target = () => ({ repoPath, path, branch, head });
  const completed = receipts => ({ ...agent, status: 'completed', completedAt: new Date().toISOString(),
    result: { success: true }, metadata: { ...agent.metadata, completedCheckouts: receipts } });

  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'completed-checkout-')));
    repoPath = join(scratch, 'repo');
    path = join(scratch, 'claim');
    await mkdir(repoPath);
    await materializeGitRepo(repoPath, { identity: { name: 'Test', email: 'test@example.com' } });
    await execGit(['worktree', 'add', '-b', branch, path, 'main'], repoPath);
    head = (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim();
    agent = { id: 'agent-1', status: 'running', startedAt: new Date(Date.now() - 1000).toISOString(),
      metadata: { claimPicksOwnBranch: true, sourceWorkspace: repoPath, claimBranches: [branch] } };
  });
  afterEach(async () => { await rm(scratch, { recursive: true, force: true, maxRetries: 3 }); });

  it('rejects a new checkout reusing the completed branch, path and exact head', async () => {
    const receipts = await captureCompletedCheckouts(agent, { success: true });
    expect(receipts).toHaveLength(1);
    const record = completed(receipts);
    expect(await hasCompletedCheckoutEvidence([record], target())).toBe(true);
    await execGit(['worktree', 'remove', path], repoPath);
    await execGit(['worktree', 'add', path, branch], repoPath);
    expect((await execGit(['rev-parse', 'HEAD'], path)).stdout.trim()).toBe(head);
    expect(await hasCompletedCheckoutEvidence([record], target())).toBe(false);
  });

  it('withholds proof for failed, historical, released, unreadable or changed checkouts', async () => {
    expect(await captureCompletedCheckouts(agent, { success: false })).toEqual([]);
    expect(await captureCompletedCheckouts({ ...agent, status: 'completed' }, { success: true })).toEqual([]);
    expect(await captureCompletedCheckouts({ ...agent, metadata: { ...agent.metadata, claimBranches: [], claimReleasedBranches: [branch] } }, { success: true })).toEqual([]);
    expect(await hasCompletedCheckoutEvidence([completed([])], target())).toBe(false);

    const receipts = await captureCompletedCheckouts(agent, { success: true });
    const record = completed(receipts);
    expect(await hasCompletedCheckoutEvidence([{ ...record, result: { success: false } }], target())).toBe(false);
    expect(await hasCompletedCheckoutEvidence([{ ...record, startedAt: '2025-01-01T00:00:00Z' }], target())).toBe(false);
    await execGit(['commit', '--allow-empty', '-m', 'later work'], path);
    head = (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim();
    expect(await hasCompletedCheckoutEvidence([record], target())).toBe(false);
    await execGit(['worktree', 'remove', path], repoPath);
    expect(await captureCompletedCheckouts(agent, { success: true })).toEqual([]);
    expect(await hasCompletedCheckoutEvidence([record], target())).toBe(false);
  });

  it('does not let an older success authorize the unchanged checkout after a newer claim fails', async () => {
    const record = completed(await captureCompletedCheckouts(agent, { success: true }));
    expect(await hasCompletedCheckoutEvidence([record], target())).toBe(true);
    for (const binding of [{ claimBranches: [branch] }, { claimReleasedBranches: [branch] }, { worktreeBranch: branch }]) {
      const newer = { id: 'agent-2', status: 'completed', startedAt: new Date().toISOString(),
        result: { success: false }, metadata: { sourceWorkspace: repoPath, ...binding } };
      expect(await hasCompletedCheckoutEvidence([record, newer], target())).toBe(false);
      // A reported success with no server receipt and unreadable ordering also
      // cannot revive the older run's authority over this same checkout.
      expect(await hasCompletedCheckoutEvidence([record, { ...newer, result: { success: true } }], target())).toBe(false);
      expect(await hasCompletedCheckoutEvidence([record, { ...newer, startedAt: null }], target())).toBe(false);
    }
  });
});
