// test-memo: git-fixture
import { execFileSync } from 'node:child_process';
import { on } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { execGit } from '../../lib/execGit.js';
import { registerGitAgent, useAgentGitSandbox } from './agentGit.testFixtures.js';

const fixture = useAgentGitSandbox();

async function cleanUpFailedRun(agentId, task) {
  const { completeAgent } = await import('../cos/cosAgentLifecycle.js');
  const { cosEvents } = await import('../cos/cosEvents.js');
  const { cleanupAgentWorktree } = await import('./agentWorktreeCleanup.js');
  await completeAgent(agentId, { success: false });
  // The public cleanup returns before its detached verification. Join that
  // audit's lifecycle so teardown cannot remove a repository still in use.
  const updates = on(cosEvents, 'agent:updated', { signal: AbortSignal.timeout(20_000) });
  try {
    const warnings = await cleanupAgentWorktree(agentId, false, { originalTask: task });
    for await (const [update] of updates) {
      if (update.id === agentId && update.deliveryActivity === null) break;
    }
    return warnings;
  } finally {
    await updates.return();
  }
}

async function addFixtureTask(description) {
  const { addTask } = await import('../cos/cosTaskStore.js');
  return addTask({ description }, 'user', { suppressDequeue: true });
}

it('retains a dirty checkout with both tracked and untracked edits', async () => {
  const { repo } = fixture;
  const agentId = 'agent-dirty';
  const task = await addFixtureTask('Keep unfinished edits');
  const { worktreePath, branchName } = await registerGitAgent(repo, agentId, task);
  await writeFile(join(worktreePath, 'initial.txt'), 'tracked edit');
  await writeFile(join(worktreePath, 'scratch.txt'), 'untracked edit');

  expect(await cleanUpFailedRun(agentId, task)).toEqual([
    expect.stringContaining('uncommitted changes detected'),
  ]);

  const { listWorktrees } = await import('../worktreeManager.js');
  expect(await listWorktrees(repo)).toContainEqual(expect.objectContaining({ branch: `refs/heads/${branchName}` }));
  expect(await readFile(join(worktreePath, 'initial.txt'), 'utf8')).toBe('tracked edit');
  expect(await readFile(join(worktreePath, 'scratch.txt'), 'utf8')).toBe('untracked edit');
});

it('keeps a clean checkout with an unpublished commit until the commit is merged', async () => {
  const { repo } = fixture;
  const agentId = 'agent-unpublished';
  const task = await addFixtureTask('Keep an unpublished commit');
  const { worktreePath, branchName } = await registerGitAgent(repo, agentId, task);
  await writeFile(join(worktreePath, 'change.txt'), 'agent delivery');
  await execGit(['add', 'change.txt'], worktreePath);
  await execGit(['commit', '-m', 'Agent delivery'], worktreePath);
  const { stdout: head } = await execGit(['rev-parse', 'HEAD'], worktreePath);

  expect(await cleanUpFailedRun(agentId, task)).toEqual([
    expect.stringContaining('merge-evidence-unavailable'),
  ]);

  const { listWorktrees } = await import('../worktreeManager.js');
  expect(await listWorktrees(repo)).toContainEqual(expect.objectContaining({ branch: `refs/heads/${branchName}` }));
  expect(await readFile(join(worktreePath, 'change.txt'), 'utf8')).toBe('agent delivery');
  expect((await execGit(['rev-parse', `refs/heads/${branchName}`], repo)).stdout).toBe(head);
  expect((await execGit(['ls-remote', '--heads', 'origin', branchName], repo)).stdout).toBe('');

  await execGit(['merge', '--ff-only', branchName], repo);
  await execGit(['push', 'origin', 'main'], repo);
  expect(await cleanUpFailedRun(agentId, task)).toEqual([]);

  expect(existsSync(worktreePath)).toBe(false);
  expect(await listWorktrees(repo)).not.toContainEqual(expect.objectContaining({ branch: `refs/heads/${branchName}` }));
  const local = await execGit(['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], repo, { ignoreExitCode: true });
  expect(local.exitCode).toBe(1);
  expect(execFileSync('git', ['ls-remote', '--heads', 'origin', 'main'], { cwd: repo, encoding: 'utf8' }).trim())
    .toBe(`${head.trim()}\trefs/heads/main`);
});
