import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execGit } from '../lib/execGit.js';
import { materializeGitRepo } from '../lib/gitTestRepo.js';
import { captureCompletedCheckouts, hasCompletedCheckoutEvidence, readCompletedCheckoutIdentity, completedCheckoutReceiptValid, isGitCommitSha, shortBranch, findValidCheckoutCaptures } from './completedCheckoutEvidence.js';

describe('completed claim checkout evidence', () => {
  let scratch, repoPath, path, head, agent;
  const branch = 'claim/issue-1';
  const target = () => ({ repoPath, path, branch, head });
  const completed = receipts => ({ ...agent, status: 'completed', completedAt: new Date().toISOString(),
    result: { success: true }, metadata: { ...agent.metadata, completedCheckouts: receipts } });

  beforeEach(async () => {
    // Preserve tmpdir's spelling for the destructive fixture guard: Windows
    // may expose TEMP as an 8.3 alias while async realpath returns its long name.
    scratch = await mkdtemp(join(tmpdir(), 'completed-checkout-'));
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

  it.each([false, true])('captures the registered checkout without granting unbound claim authority (pinned=%s)', async pinned => {
    agent.metadata = { isWorktree: true, sourceWorkspace: repoPath, workspacePath: path, worktreeBranch: branch,
      claimBranches: ['claim/reserved-other-checkout'],
      ...(pinned ? { claimBranch: branch, claimPicksOwnBranch: false } : {}) };
    const receipts = await captureCompletedCheckouts(agent, { success: true });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ branch, head });
    expect(receipts[0]).not.toHaveProperty('incarnation');
    expect(await hasCompletedCheckoutEvidence([completed(receipts)], target())).toBe(false);
    expect(await captureCompletedCheckouts({ ...agent, metadata: { ...agent.metadata, workspacePath: repoPath } }, { success: true })).toEqual([]);
  });

  it.each([false, true])('captures a source-checkout claim without a separate sourceWorkspace (pinned=%s)', async pinned => {
    agent.metadata = { claimPicksOwnBranch: !pinned, ...(pinned ? { claimBranch: branch } : {}), isWorktree: false, workspacePath: repoPath, claimBranches: [branch] };
    const receipts = await captureCompletedCheckouts(agent, { success: true });
    expect(receipts).toEqual([expect.objectContaining({ branch, head, path: expect.stringMatching(/claim$/) })]);
    expect(await hasCompletedCheckoutEvidence([completed(receipts)], target())).toBe(true);
    // An ordinary worktree run's workspace is its own checkout, never the repository.
    expect(await captureCompletedCheckouts({ ...agent, metadata: { isWorktree: true, workspacePath: repoPath, worktreeBranch: branch } }, { success: true })).toEqual([]);
  });

  it('allows a scoped identity fact-read of a locked checkout without changing default capture refusal or its lock', async () => {
    await execGit(['worktree', 'lock', '--reason', 'owned operator checkout', path], repoPath);
    expect(await readCompletedCheckoutIdentity(target())).toBeNull();
    const identity = await readCompletedCheckoutIdentity({ ...target(), allowLocked: true });
    expect(identity).toEqual({ repoPath: expect.any(String), branch, path: expect.any(String), head });
    expect(await captureCompletedCheckouts(agent, { success: true })).toEqual([]);
    expect((await execGit(['worktree', 'list', '--porcelain'], repoPath)).stdout).toContain('locked owned operator checkout');
  });

  it('ignores legacy incarnation fields when the checkout still has the recorded branch, path and head', async () => {
    const receipts = await captureCompletedCheckouts(agent, { success: true });
    expect(receipts).toHaveLength(1);
    receipts[0].incarnation = { obsolete: true };
    const record = completed(receipts);
    expect(await hasCompletedCheckoutEvidence([record], target())).toBe(true);
    await execGit(['worktree', 'remove', path], repoPath);
    await execGit(['worktree', 'add', path, branch], repoPath);
    expect((await execGit(['rev-parse', 'HEAD'], path)).stdout.trim()).toBe(head);
    expect(await hasCompletedCheckoutEvidence([record], target())).toBe(true);
  });

  it('captures the remaining claimed checkouts when another claimed branch has no checkout (#14103)', async () => {
    agent.metadata = { ...agent.metadata, claimBranches: ['claim/issue-missing', branch] };
    const receipts = await captureCompletedCheckouts(agent, { success: true, strict: true });
    expect(receipts).toEqual([expect.objectContaining({ branch, head })]);
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

  it('loads legacy late v2 captures without consulting obsolete seeds or incarnation fields', () => {
    const record = completed([]);
    const receipt = { version: 2, agentId: agent.id, startedAt: agent.startedAt,
      capturedAt: new Date().toISOString(), ...target(), incarnation: { obsolete: true } };
    record.completedAt = agent.startedAt;
    record.metadata.checkoutSeeds = [{ obsolete: true }];
    expect(completedCheckoutReceiptValid(record, receipt)).toBe(true);
    expect(completedCheckoutReceiptValid(record, { ...receipt, agentId: 'other' })).toBe(false);
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

  it('validates strict 40-or-64-char Git commit SHAs and rejects 41-63 char hex strings', () => {
    expect(isGitCommitSha('a'.repeat(40))).toBe(true);
    expect(isGitCommitSha('0123456789abcdef'.repeat(4))).toBe(true);
    expect(isGitCommitSha('a'.repeat(39))).toBe(false);
    for (const length of [41, 48, 56, 63]) {
      expect(isGitCommitSha('a'.repeat(length)), `length ${length}`).toBe(false);
    }
    expect(isGitCommitSha('a'.repeat(65))).toBe(false);
    expect(isGitCommitSha('A'.repeat(40))).toBe(false);
    expect(isGitCommitSha(`${'a'.repeat(39)}g`)).toBe(false);
    expect(isGitCommitSha(null)).toBe(false);
    expect(isGitCommitSha(undefined)).toBe(false);
    expect(isGitCommitSha(12345)).toBe(false);
  });

  it('normalizes refs/heads/ branch names and filters valid completed-checkout captures', () => {
    expect(shortBranch('refs/heads/claim/issue-1')).toBe('claim/issue-1');
    expect(shortBranch('claim/issue-1')).toBe('claim/issue-1');
    expect(shortBranch('refs/tags/v1.0.0')).toBe('refs/tags/v1.0.0');
    expect(shortBranch(undefined)).toBeUndefined();

    const validReceipt = {
      version: 1, agentId: agent.id, startedAt: agent.startedAt,
      capturedAt: agent.startedAt, repoPath, branch, path, head,
    };
    const otherBranchReceipt = { ...validReceipt, branch: 'claim/issue-2', path: `${path}-2` };
    const driftedShaReceipt = { ...validReceipt, branch: 'claim/issue-3', head: 'a'.repeat(48) };
    const missingPathReceipt = { ...validReceipt, branch: 'claim/issue-4', path: '' };
    const wrongRepoReceipt = { ...validReceipt, branch: 'claim/issue-5', repoPath: `${repoPath}-other` };
    const record = completed([validReceipt, otherBranchReceipt, driftedShaReceipt, missingPathReceipt, wrongRepoReceipt]);

    expect(findValidCheckoutCaptures(record, { branch, repoPath })).toEqual([validReceipt]);
    expect(findValidCheckoutCaptures(record, { branch, repoPath, path })).toEqual([validReceipt]);
    expect(findValidCheckoutCaptures(record, { branch, repoPath, path: `${path}-other` })).toEqual([]);
    expect(findValidCheckoutCaptures(record, { excludeBranch: branch, repoPath })).toEqual([otherBranchReceipt]);
    expect(findValidCheckoutCaptures(record, { branch: 'claim/issue-3', repoPath })).toEqual([]);
    expect(findValidCheckoutCaptures(record, { branch: 'claim/issue-4', repoPath })).toEqual([]);
    expect(findValidCheckoutCaptures(record, { branch: 'claim/issue-5', repoPath })).toEqual([]);
    expect(findValidCheckoutCaptures(record, { branch, repoPath: null })).toEqual([]);
  });
});
