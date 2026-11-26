// test-memo: git-fixture
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { execGit } from '../../lib/execGit.js';
import { registerGitAgent, useAgentGitSandbox } from './agentGit.testFixtures.js';

const fixture = useAgentGitSandbox();

it('keeps an unmerged checkout pending and settles its task after published integration and retirement', async () => {
  const { repo } = fixture;
  const agentId = 'agent-recovery';
  const { addTask, getTaskById, updateTask } = await import('../cos/cosTaskStore.js');
  const { completeAgent, getAgentRecord } = await import('../cos/cosAgentLifecycle.js');
  const { sweepRepoStateVerifications, verifyAgentRepoState } = await import('./agentRepoStateVerification.js');

  const queued = await addTask({ description: 'Recover interrupted repository cleanup', metadata: { openPR: true } }, 'user', { suppressDequeue: true });
  const { worktreePath, branchName } = await registerGitAgent(repo, agentId, queued);
  await writeFile(join(worktreePath, 'delivery.txt'), 'recoverable delivery');
  await execGit(['add', 'delivery.txt'], worktreePath);
  await execGit(['commit', '-m', 'Recoverable delivery'], worktreePath);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim();

  const task = await updateTask(queued.id, { status: 'in_progress', metadata: {
    deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: agentId,
  } }, 'user', { suppressDequeue: true });
  const agentState = await completeAgent(agentId, { success: false, executionSuccess: true, cleanupPending: true });
  expect(agentState.metadata.completedCheckouts).toEqual([expect.objectContaining({ branch: branchName, head })]);

  // An unavailable forge retains the completion audit for service recovery.
  fixture.forgeLookupAvailable = false;
  const verification = await verifyAgentRepoState({ agentId, agentState, task, success: false });
  expect(verification).toMatchObject({ verified: false, skipReason: 'cleanup-delivery-unverified',
    observed: { worktreePresent: true, localBranchPresent: true, remoteBranchPresent: false, branchMerged: false } });
  expect(await sweepRepoStateVerifications()).toMatchObject({ checked: 1, attemptedAgentIds: [agentId] });
  expect(await getTaskById(task.id)).toMatchObject({ status: 'in_progress' });
  expect((await execGit(['rev-parse', `refs/heads/${branchName}`], repo)).stdout.trim()).toBe(head);
  const pending = await getAgentRecord(agentId);
  expect(pending.metadata.repoStateVerification).toMatchObject({ status: 'pending' });
  expect(pending.metadata.completionCleanup).toMatchObject({ replayAttempts: 1, retryAt: expect.any(String) });

  // The repository was integrated and retired while completion recovery was
  // waiting. The next due sweep should reconcile the original task and agent.
  await execGit(['merge', '--ff-only', branchName], repo);
  await execGit(['push', 'origin', 'main'], repo);
  await execGit(['worktree', 'remove', worktreePath], repo);
  await execGit(['branch', '-d', branchName], repo);
  fixture.forgeLookupAvailable = true;
  expect(await sweepRepoStateVerifications()).toMatchObject({ checked: 0 });

  vi.setSystemTime(new Date(pending.metadata.completionCleanup.retryAt));
  try {
    expect(await sweepRepoStateVerifications()).toMatchObject({ checked: 1, attemptedAgentIds: [agentId] });
    expect(await getTaskById(task.id)).toMatchObject({ status: 'completed', metadata: { taskOutcome: { status: 'completed' } } });
    const settled = await getAgentRecord(agentId);
    expect(settled.metadata.repoStateVerification).toMatchObject({ status: 'completed', reasons: [] });
    expect(Object.values(settled.metadata.cleanupOutcomes)).toContainEqual(expect.objectContaining({
      branch: branchName, status: 'verified', reason: 'already-absent-integrated', committedIntegrationVerified: true,
    }));
    expect(await sweepRepoStateVerifications()).toMatchObject({ checked: 0, pendingAtStart: 0 });
  } finally {
    vi.useRealTimers();
  }
});
