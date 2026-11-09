import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { realpath, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { destroyGitSandbox, makeGitSandbox } from '../lib/gitTestRepo.js';
import { execGit } from '../lib/execGit.js';

const fixture = vi.hoisted(() => ({ agent: null, owners: [], probe: null }));
vi.mock('./cos.js', () => ({ forceSpawnTask: vi.fn() }));
vi.mock('./cosTaskStore.js', () => ({ addTask: vi.fn(), updateTask: vi.fn() }));
vi.mock('./cosAgentLifecycle.js', () => ({
  getAgent: async () => fixture.agent, getAgentRecord: async () => fixture.agent, getAgents: async () => [],
}));
vi.mock('./agentRepoStateVerification.js', () => ({ verifyAgentRepoState: vi.fn(async () => ({})) }));
vi.mock('./cosClaimOwnershipState.js', async original => ({
  ...await original(), readClaimOwnershipAgents: vi.fn(async () => fixture.owners),
}));
vi.mock('./prProbe.js', async original => ({
  ...await original(), probePrForBranch: vi.fn(async () => fixture.probe),
}));

import { cleanupAgentWorktree } from './agentWorktreeCleanup.js';
import { readCompletedCheckoutIdentity } from './completedCheckoutEvidence.js';
import { verifyAgentRepoState } from './agentRepoStateVerification.js';
import { reserveCheckoutRetirementFence, withClaimOwnershipLock } from './cosClaimOwnershipState.js';

describe('claim coordinator cleanup', () => {
  let sandbox, checkout, head;
  const branch = 'claim/issue-42';
  const id = 'agent-claim';
  const start = '2026-01-01T00:00:00.000Z';
  const end = '2026-01-01T00:01:00.000Z';
  const run = async (opts = {}) => {
    const warnings = await cleanupAgentWorktree(id, true, {
      originalTask: { id: 'task-claim', metadata: { claimFlow: true } },
      ...opts,
    });
    await vi.waitFor(() => expect(verifyAgentRepoState).toHaveBeenCalled());
    return warnings;
  };
  const localRef = async () => execGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], sandbox.repo, { ignoreExitCode: true });
  const remoteRef = async () => (await execGit(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], sandbox.repo)).stdout.trim();

  beforeEach(async () => {
    vi.clearAllMocks();
    fixture.owners = [];
    sandbox = await makeGitSandbox({ origin: true });
    checkout = join(sandbox.scratch, 'claim');
    await execGit(['worktree', 'add', '-b', branch, checkout, 'main'], sandbox.repo);
    await writeFile(join(checkout, 'claimed.txt'), 'delivered\n');
    await execGit(['add', 'claimed.txt'], checkout);
    await execGit(['commit', '-m', 'Claimed change'], checkout);
    head = (await execGit(['rev-parse', 'HEAD'], checkout)).stdout.trim();
    await execGit(['push', 'origin', `HEAD:refs/heads/${branch}`], checkout);
    const identity = await readCompletedCheckoutIdentity({ repoPath: sandbox.repo, branch, path: checkout, head });
    fixture.agent = { id, taskId: 'task-claim', status: 'completed', startedAt: start, completedAt: end,
      metadata: { isWorktree: false, workspacePath: sandbox.repo, claimBranches: [branch],
        completedCheckouts: [{ version: 1, agentId: id, startedAt: start, capturedAt: end, ...identity }] } };
    fixture.probe = { readable: true, prState: 'MERGED', prHead: head };
  });

  afterEach(async () => { await destroyGitSandbox(sandbox?.scratch); });

  it('removes the captured merged checkout and only its exact remote head', async () => {
    expect(await run()).toEqual([]);
    expect(existsSync(checkout)).toBe(false);
    expect((await localRef()).exitCode).toBe(1);
    expect(await remoteRef()).toBe('');
  });

  it('keeps a remote branch that advanced after the captured delivery', async () => {
    const advanced = (await execGit(['commit-tree', `${head}^{tree}`, '-p', head, '-m', 'New remote work'], sandbox.repo)).stdout.trim();
    await execGit(['push', 'origin', `${advanced}:refs/heads/${branch}`], sandbox.repo);
    expect(await run()).toEqual([expect.stringContaining('remote branch head changed')]);
    expect(existsSync(checkout)).toBe(false);
    expect(await remoteRef()).toBe(`${advanced}\trefs/heads/${branch}`);
    expect(await run()).toEqual([expect.stringContaining('remote branch head changed')]);
  });

  it('retries the exact local ref after its checkout was removed but Git refused branch deletion', async () => {
    await execGit(['config', 'receive.denyDeletes', 'true'], sandbox.repo);
    expect(await run()).toEqual([expect.stringContaining('local branch deletion unverified')]);
    expect(existsSync(checkout)).toBe(false);
    expect((await localRef()).exitCode).toBe(0);
    await execGit(['config', '--unset', 'receive.denyDeletes'], sandbox.repo);
    expect(await run()).toEqual([]);
    expect((await localRef()).exitCode).toBe(1);
    expect(await remoteRef()).toBe('');
  });

  it('rechecks a retained remote after local cleanup succeeds', async () => {
    await execGit(['remote', 'set-url', '--push', 'origin', sandbox.repo], sandbox.repo);
    expect(await run()).toEqual([expect.stringContaining('remote target unverified')]);
    expect(existsSync(checkout)).toBe(false);
    expect(await remoteRef()).toContain(`refs/heads/${branch}`);
    await execGit(['remote', 'set-url', '--push', 'origin', sandbox.origin], sandbox.repo);
    expect(await run()).toEqual([]);
    expect(await remoteRef()).toBe('');
  });

  it('does not apply chained URL rewrites twice when deleting a remote branch', async () => {
    const otherOrigin = join(sandbox.scratch, 'other-origin.git');
    await execGit(['init', '--bare', otherOrigin], sandbox.repo);
    await execGit(['push', otherOrigin, `${head}:refs/heads/${branch}`], sandbox.repo);
    await execGit(['config', `url.${sandbox.origin}.insteadOf`, 'claim-origin:'], sandbox.repo);
    await execGit(['config', `url.${otherOrigin}.insteadOf`, sandbox.origin], sandbox.repo);
    await execGit(['remote', 'set-url', 'origin', 'claim-origin:'], sandbox.repo);
    expect(await run()).toEqual([]);
    expect(await remoteRef()).toBe('');
    const otherRef = await execGit(['--git-dir', otherOrigin, 'show-ref', '--verify', `refs/heads/${branch}`], sandbox.repo);
    expect(otherRef.stdout.trim()).toBe(`${head} refs/heads/${branch}`);
  });

  it('reports a surviving remote when the local checkout is absent and its capture is missing', async () => {
    await execGit(['worktree', 'remove', checkout], sandbox.repo);
    await execGit(['branch', '-D', branch], sandbox.repo);
    fixture.agent.metadata.completedCheckouts = [];
    expect(await run()).toEqual([expect.stringContaining('remote branch retained')]);
    expect(await remoteRef()).toContain(`refs/heads/${branch}`);
    await execGit(['push', 'origin', `:refs/heads/${branch}`], sandbox.repo);
    expect(await run()).toEqual([]);
  });

  it.each(['unowned', 'active owner'])('resolves a symlinked repository against the captured checkout and %s', async scenario => {
    const alias = join(sandbox.scratch, 'repo-alias');
    await symlink(sandbox.repo, alias, 'dir');
    fixture.agent.metadata.workspacePath = alias;
    if (scenario === 'active owner') fixture.owners = [{ id: 'other', status: 'running',
      metadata: { sourceWorkspace: await realpath(sandbox.repo), claimBranches: [branch] } }];
    const result = await run();
    if (scenario === 'active owner') {
      expect(result).toEqual([expect.stringContaining('claim-owner-active')]);
      expect(existsSync(checkout)).toBe(true);
    } else {
      expect(result).toEqual([]);
      expect(existsSync(checkout)).toBe(false);
    }
  });

  it('respects a checkout retirement reserved through another repository spelling', async () => {
    const alias = join(sandbox.scratch, 'repo-alias');
    await symlink(sandbox.repo, alias, 'dir');
    const release = await withClaimOwnershipLock(() => reserveCheckoutRetirementFence({ repoPath: alias, path: checkout, branch }));
    try {
      expect(await run()).toEqual([expect.stringContaining('checkout-retirement-reserved')]);
      expect(existsSync(checkout)).toBe(true);
    } finally { await withClaimOwnershipLock(release); }
  });

  it.each(['present', 'absent', 'unreadable'])('uses Git’s non-forced removal for a clean unmerged stand-down with remote %s', async remote => {
    await execGit(['reset', '--hard', 'origin/main'], checkout);
    head = (await execGit(['rev-parse', 'HEAD'], checkout)).stdout.trim();
    const identity = await readCompletedCheckoutIdentity({ repoPath: sandbox.repo, branch, path: checkout, head });
    fixture.agent.metadata.completedCheckouts = [{ version: 1, agentId: id, startedAt: start, capturedAt: end, ...identity }];
    fixture.probe = { readable: true, prState: null };
    if (remote === 'absent') await execGit(['push', 'origin', `:refs/heads/${branch}`], sandbox.repo);
    if (remote === 'unreadable') await execGit(['remote', 'set-url', 'origin', join(sandbox.scratch, 'missing-origin')], sandbox.repo);
    const result = await run();
    if (remote === 'present') expect(result).toEqual([expect.stringContaining('remote branch retained')]);
    else if (remote === 'unreadable') expect(result).toEqual([expect.stringContaining('remote branch state unavailable')]);
    else expect(result).toEqual([]);
    expect(existsSync(checkout)).toBe(false);
    expect((await localRef()).exitCode).toBe(1);
    if (remote === 'present') expect(await remoteRef()).toContain(`refs/heads/${branch}`);
  });

  // A server-provisioned claim (#15517) runs inside this checkout, so its own
  // completion sentinel is the one untracked file a clean stand-down leaves.
  it('removes a clean stand-down that holds only this run\'s completion sentinel', async () => {
    await execGit(['reset', '--hard', 'origin/main'], checkout);
    head = (await execGit(['rev-parse', 'HEAD'], checkout)).stdout.trim();
    const identity = await readCompletedCheckoutIdentity({ repoPath: sandbox.repo, branch, path: checkout, head });
    fixture.agent.metadata.completedCheckouts = [{ version: 1, agentId: id, startedAt: start, capturedAt: end, ...identity }];
    fixture.probe = { readable: true, prState: null };
    await execGit(['push', 'origin', `:refs/heads/${branch}`], sandbox.repo);
    await writeFile(join(checkout, `.agent-done-${id}`), '{}\n');
    expect(await run()).toEqual([]);
    expect(existsSync(checkout)).toBe(false);
    expect((await localRef()).exitCode).toBe(1);
  });

  // A re-claim of an issue whose PR already merged reuses the claim branch name
  // on a fresh checkout of the default branch; the forge reports the earlier
  // delivery's head, which is not this checkout's.
  it.each([['MERGED', 0], ['CLOSED', 0], ['OPEN', 1]])('handles a clean re-claim beside a %s PR at another head', async (prState, held) => {
    await execGit(['reset', '--hard', 'origin/main'], checkout);
    head = (await execGit(['rev-parse', 'HEAD'], checkout)).stdout.trim();
    const identity = await readCompletedCheckoutIdentity({ repoPath: sandbox.repo, branch, path: checkout, head });
    fixture.agent.metadata.completedCheckouts = [{ version: 1, agentId: id, startedAt: start, capturedAt: end, ...identity }];
    fixture.probe = { readable: true, prState, prHead: 'a'.repeat(40) };
    await execGit(['push', 'origin', `:refs/heads/${branch}`], sandbox.repo);
    expect(await run()).toHaveLength(held);
    expect(existsSync(checkout)).toBe(held === 1);
    expect((await localRef()).exitCode).toBe(held === 1 ? 0 : 1);
  });

  it('settles owned git work when a remote branch probe times out during cleanup', async () => {
    await execGit(['config', `url.ssh://slow-host/.insteadOf`, sandbox.origin], sandbox.repo);
    await execGit(['config', 'core.sshCommand', 'node -e "process.stdin.resume(); process.stdin.on(\'end\', () => process.exit(0)); setTimeout(() => {}, 10000);" --'], sandbox.repo);
    const result = await run({ remoteTimeoutMs: 100 });
    expect(result).toEqual([expect.stringContaining('remote branch state unavailable')]);
    expect(existsSync(checkout)).toBe(false);
  });

  it('settles owned git work when an unmerged stand-down remote probe times out', async () => {
    await execGit(['reset', '--hard', 'origin/main'], checkout);
    head = (await execGit(['rev-parse', 'HEAD'], checkout)).stdout.trim();
    const identity = await readCompletedCheckoutIdentity({ repoPath: sandbox.repo, branch, path: checkout, head });
    fixture.agent.metadata.completedCheckouts = [{ version: 1, agentId: id, startedAt: start, capturedAt: end, ...identity }];
    fixture.probe = { readable: true, prState: null };
    await execGit(['push', 'origin', `:refs/heads/${branch}`], sandbox.repo);
    await execGit(['config', `url.ssh://slow-host/.insteadOf`, sandbox.origin], sandbox.repo);
    await execGit(['config', 'core.sshCommand', 'node -e "process.stdin.resume(); process.stdin.on(\'end\', () => process.exit(0)); setTimeout(() => {}, 10000);" --'], sandbox.repo);
    const result = await run({ remoteTimeoutMs: 100 });
    expect(result).toEqual([expect.stringContaining('remote branch state unavailable')]);
    expect(existsSync(checkout)).toBe(false);
    expect((await localRef()).exitCode).toBe(1);
  });

  it.each(['active owner', 'changed head', 'locked checkout', 'unmerged work', 'different merged head'])('preserves %s', async scenario => {
    if (scenario === 'active owner') fixture.owners = [{ id: 'other', status: 'running', metadata: { sourceWorkspace: sandbox.repo, claimBranches: [branch] } }];
    if (scenario === 'changed head') {
      await writeFile(join(checkout, 'more.txt'), 'not delivered\n');
      await execGit(['add', 'more.txt'], checkout);
      await execGit(['commit', '-m', 'Later work'], checkout);
    }
    if (scenario === 'locked checkout') await execGit(['worktree', 'lock', checkout], sandbox.repo);
    if (scenario === 'unmerged work') fixture.probe = { readable: true, prState: null };
    if (scenario === 'different merged head') fixture.probe.prHead = 'a'.repeat(40);
    expect(await run()).toHaveLength(1);
    expect(existsSync(checkout)).toBe(true);
    expect((await localRef()).exitCode).toBe(0);
    expect(await remoteRef()).toContain(`refs/heads/${branch}`);
  });
});
