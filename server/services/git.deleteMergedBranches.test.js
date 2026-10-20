import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../lib/execGit.js', () => {
  const execGit = vi.fn();
  return { execGit, execGitSafe: (...args) => execGit(...args).catch(error => ({ exitCode: 1, stdout: '', stderr: error.message })) };
});
vi.mock('./worktreeManager.js', () => ({ isGitLockError: vi.fn(), listWorktrees: vi.fn(async () => []) }));
vi.mock('./branchReconcile.js', () => ({ cleanupMerged: vi.fn() }));
vi.mock('./cosClaimOwnershipState.js', () => ({ withClaimOwnershipLock: work => work(), readClaimOwnershipAgents: vi.fn(async () => []) }));
vi.mock('./branchCompletionPolicy.js', () => ({ readBranchCompletionHold: vi.fn(async () => null) }));
import { execGit } from '../lib/execGit.js';
import { cleanupMerged } from './branchReconcile.js';
import { readClaimOwnershipAgents } from './cosClaimOwnershipState.js';
import { readBranchCompletionHold } from './branchCompletionPolicy.js';
import { deleteMergedBranches } from './git.js';
const HEAD = 'a'.repeat(40);
const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
let local, remote, fetchFailed, moved, held;
beforeEach(() => {
  vi.clearAllMocks();
  local = ['main', 'release', 'feature/done']; remote = ['origin/feature/done']; fetchFailed = moved = false; held = null;
  readClaimOwnershipAgents.mockResolvedValue([]);
  readBranchCompletionHold.mockResolvedValue(null);
  cleanupMerged.mockImplementation(async (_dir, _target, [{ branch }]) => held
    ? { cleaned: [], skipped: [{ branch, reason: held }] } : { cleaned: [branch], skipped: [] });
  execGit.mockImplementation(async args => {
    if (args[0] === 'symbolic-ref') return ok('origin/main\n');
    if (args[0] === 'rev-parse') return ok(HEAD);
    if (args[0] === 'branch' && args.includes('--list')) return ok(local.join('\n'));
    if (args[0] === 'branch') return ok((args.includes('-r') ? remote : local).join('\n'));
    if (args[0] === 'fetch') return { ...ok(), exitCode: fetchFailed ? 1 : 0 };
    if (args[0] === 'ls-remote') return ok(`${HEAD}\trefs/heads/feature/done\n`);
    if (args[0] === 'push') return { ...ok(), exitCode: moved ? 1 : 0 };
    return ok();
  });
});
describe('delete merged branches', () => {
  it('shares local retirement and leases the merged remote head', async () => {
    const result = await deleteMergedBranches('/repo');
    expect(result.deleted).toEqual([{ name: 'feature/done', local: 'deleted', remote: 'deleted' }]);
    expect(cleanupMerged).toHaveBeenCalledWith('/repo', 'refs/remotes/origin/main', [{ branch: 'feature/done' }], { activeAgentIds: null });
    expect(execGit).toHaveBeenCalledWith(['push', `--force-with-lease=refs/heads/feature/done:${HEAD}`, 'origin', ':refs/heads/feature/done'], '/repo', { ignoreExitCode: true });
    expect(readBranchCompletionHold).toHaveBeenCalledWith({ repoPath: '/repo', branch: 'feature/done', tip: HEAD, retirement: true });
  });
  it.each(['archive-failed', 'worktree-locked', 'worktree-dirty', 'claim-owner-active'])('retains both refs on %s', async reason => {
    held = reason;
    const result = await deleteMergedBranches('/repo');
    expect(result.deleted).toEqual([]);
    expect(result.skipped.join(' ')).toMatch(/archive|locked|dirty|active/);
    expect(execGit.mock.calls.some(([args]) => args[0] === 'push')).toBe(false);
  });
  it('does not use stale merge flags when refresh fails', async () => {
    fetchFailed = true;
    expect((await deleteMergedBranches('/repo')).skipped).toEqual(['cleanup (remote default could not be refreshed)']);
    expect(cleanupMerged).not.toHaveBeenCalled();
  });
  it('reports a remote ref that advances after evidence was read', async () => {
    moved = true;
    const result = await deleteMergedBranches('/repo');
    expect(result.deleted[0]).toMatchObject({ local: 'deleted', remote: 'failed' });
    expect(result.skipped).toContain('feature/done (remote: head changed or deletion failed)');
  });
  it('sends squash-merged candidates to the shared evidence gate', async () => {
    remote = []; local.push('feature/squashed');
    await deleteMergedBranches('/repo');
    expect(cleanupMerged).toHaveBeenCalledWith('/repo', 'refs/remotes/origin/main', [{ branch: 'feature/squashed' }], expect.any(Object));
  });
  it('holds active exclusions and unreadable remote ownership', async () => {
    const excluded = await deleteMergedBranches('/repo', { excludeBranches: async () => new Set(['feature/done']) });
    expect(excluded.skipped).toEqual(['feature/done (used by an active agent)']);
    expect(cleanupMerged).not.toHaveBeenCalled();
    readClaimOwnershipAgents.mockResolvedValue(null);
    const unknown = await deleteMergedBranches('/repo');
    expect(unknown.skipped.join(' ')).toContain('ownership');
    expect(execGit.mock.calls.some(([args]) => args[0] === 'push')).toBe(false);
  });
});
