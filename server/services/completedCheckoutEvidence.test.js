import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execGit } from '../lib/execGit.js';
import { materializeGitRepo } from '../lib/gitTestRepo.js';
import { captureCheckoutSeeds, captureCompletedCheckouts, captureSeededCompletionCheckouts, hasCompletedCheckoutEvidence, readCompletedCheckoutIdentity } from './completedCheckoutEvidence.js';

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
    expect(receipts[0]).toMatchObject({ branch, head, incarnation: { pointer: { ino: expect.any(String) } } });
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
    expect(identity).toMatchObject({ branch, head, incarnation: { pointer: { ino: expect.any(String) } } });
    expect(await captureCompletedCheckouts(agent, { success: true })).toEqual([]);
    expect((await execGit(['worktree', 'list', '--porcelain'], repoPath)).stdout).toContain('locked owned operator checkout');
  });

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

  it('withholds late capture when only a physical seed survived and no terminal head was observed', async () => {
    const checkoutSeeds = await captureCheckoutSeeds(agent);
    const record = { ...completed([]), metadata: { ...agent.metadata, checkoutSeeds,
      checkoutCapture: { status: 'pending', targets: [], unknown: true } } };
    await execGit(['commit', '--allow-empty', '-m', 'later writer in the same physical checkout'], path);
    expect(await captureSeededCompletionCheckouts(record)).toBeNull();
    expect(await hasCompletedCheckoutEvidence([record], { ...target(), head: (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim() })).toBe(false);
  });
});
