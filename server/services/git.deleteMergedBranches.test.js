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
import { listWorktrees } from './worktreeManager.js';
import { deleteMergedBranches, deleteMergedRemoteBranches } from './git.js';
const HEAD = 'a'.repeat(40);
const REMOTE = 'https://example.com/team/repo.git';
const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
let local, remote, fetchFailed, moved, held, fetchEndpoints, pushEndpoints;
beforeEach(() => {
  vi.clearAllMocks();
  local = ['main', 'release', 'feature/done']; remote = ['origin/feature/done']; fetchFailed = moved = false; held = null;
  fetchEndpoints = pushEndpoints = [REMOTE];
  listWorktrees.mockResolvedValue([]);
  readClaimOwnershipAgents.mockResolvedValue([]);
  readBranchCompletionHold.mockResolvedValue(null);
  cleanupMerged.mockImplementation(async (_dir, _target, [{ branch }]) => held
    ? { cleaned: [], skipped: [{ branch, reason: held }] } : { cleaned: [branch], skipped: [] });
  execGit.mockImplementation(async args => {
    if (args[0] === 'remote') return ok((args.includes('--push') ? pushEndpoints : fetchEndpoints).join('\n'));
    if (args[0] === 'symbolic-ref') return ok('origin/main\n');
    if (args[0] === 'rev-parse') return ok(HEAD);
    if (args[0] === 'branch' && args.includes('--list')) return ok(local.join('\n'));
    if (args[0] === 'branch') return ok((args.includes('-r') ? remote : local).join('\n'));
    if (args[0] === 'fetch') return { ...ok(), exitCode: fetchFailed ? 1 : 0 };
    if (args[0] === 'ls-remote' && args.includes('--symref')) return ok(`ref: refs/heads/main\tHEAD\n${HEAD}\tHEAD\n`);
    if (args[0] === 'ls-remote') return ok(`${HEAD}\t${args.at(-1)}\n`);
    if (args[0] === 'push') return { ...ok(), exitCode: moved ? 1 : 0 };
    return ok();
  });
});
describe('delete merged branches', () => {
  it('shares local retirement and leases the merged remote head', async () => {
    const result = await deleteMergedBranches('/repo');
    expect(result.deleted).toEqual([{ name: 'feature/done', local: 'deleted', remote: 'deleted' }]);
    expect(cleanupMerged).toHaveBeenCalledWith('/repo', HEAD, [{ branch: 'feature/done' }], { activeAgentIds: null });
    expect(execGit).toHaveBeenCalledWith(['push', `--force-with-lease=refs/heads/feature/done:${HEAD}`, '--', REMOTE, ':refs/heads/feature/done'], '/repo', { ignoreExitCode: true });
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
  it.each(['changed', 'missing', 'unreadable'])('holds stale or unverifiable remote defaults (%s) before any mutation', async mode => {
    const exec = execGit.getMockImplementation();
    execGit.mockImplementation(args => args[0] === 'ls-remote' && args.includes('--symref')
      ? Promise.resolve(mode === 'changed' ? ok(`ref: refs/heads/trunk\tHEAD\n${HEAD}\tHEAD\n`)
        : mode === 'missing' ? ok(`${HEAD}\tHEAD\n`) : { ...ok(), exitCode: 128 }) : exec(args));
    const reason = mode === 'changed' ? 'default-branch-changed' : 'default-branch-unverified';
    expect(await deleteMergedBranches('/repo')).toMatchObject({ deleted: [], skipped: [`cleanup (${reason})`] });
    expect(await deleteMergedRemoteBranches('/repo', ['trunk'], { defaultBranch: 'main' })).toEqual({ deleted: [], skipped: [{ branch: 'trunk', reason }] });
    expect(cleanupMerged).not.toHaveBeenCalled();
    expect(execGit.mock.calls.some(([args]) => ['fetch', 'push'].includes(args[0]))).toBe(false);
    expect(execGit).toHaveBeenCalledWith(['ls-remote', '--symref', '--', REMOTE, 'HEAD'], '/repo');
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
    expect(cleanupMerged).toHaveBeenCalledWith('/repo', HEAD, [{ branch: 'feature/squashed' }], expect.any(Object));
  });
  it('includes remote-only squash candidates instead of relying on ancestry listing', async () => {
    local = ['main'];
    expect((await deleteMergedBranches('/repo')).deleted).toEqual([{ name: 'feature/done', local: null, remote: 'deleted' }]);
    expect(execGit.mock.calls.some(([args]) => args[0] === 'branch' && args.includes('--merged'))).toBe(false);
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
  it.each(['different', 'multiple', 'missing'])('retains every ref when push endpoint is %s', async mode => {
    pushEndpoints = mode === 'different' ? ['https://example.com/fork/repo.git']
      : mode === 'multiple' ? [REMOTE, 'https://example.com/mirror/repo.git'] : [];
    const result = await deleteMergedBranches('/repo');
    expect(result.deleted).toEqual([]);
    expect(result.skipped).toEqual(['cleanup (fetch and push must identify one identical remote endpoint)']);
    expect(cleanupMerged).not.toHaveBeenCalled();
    expect(execGit.mock.calls.some(([args]) => ['fetch', 'push'].includes(args[0]))).toBe(false);
  });
  it('keeps reads, merge proof and writes bound when origin changes during retirement', async () => {
    cleanupMerged.mockImplementation(async (_dir, _target, [{ branch }]) => {
      fetchEndpoints = pushEndpoints = ['https://example.com/other/repo.git'];
      return { cleaned: [branch], skipped: [] };
    });
    const result = await deleteMergedBranches('/repo');
    expect(result.deleted[0].remote).toBe('deleted');
    for (const [args] of execGit.mock.calls.filter(([args]) => ['fetch', 'ls-remote', 'push'].includes(args[0]))) {
      expect(args).toContain(REMOTE);
      expect(args).not.toContain('origin');
      expect(args).not.toContain(fetchEndpoints[0]);
    }
  });
});

describe('selected remote retirement', () => {
  const retire = () => deleteMergedRemoteBranches('/repo', ['feature/done'], { defaultBranch: 'main' });
  it('only retires the selected ref and never performs local cleanup', async () => {
    const result = await retire();
    expect(result).toEqual({ deleted: ['feature/done'], skipped: [] });
    expect(cleanupMerged).not.toHaveBeenCalled();
    const pushes = execGit.mock.calls.filter(([args]) => args[0] === 'push');
    expect(pushes).toHaveLength(1);
    expect(pushes[0][0]).toEqual(['push', `--force-with-lease=refs/heads/feature/done:${HEAD}`, '--', REMOTE, ':refs/heads/feature/done']);
  });
  it.each(['local ref', 'tracking alias', 'holder', 'unknown holders'])('retains a recovery ref with %s', async kind => {
    const exec = execGit.getMockImplementation();
    if (kind === 'holder') listWorktrees.mockResolvedValue([{ path: '/new', branch: 'refs/heads/feature/done' }]);
    else if (kind === 'unknown holders') listWorktrees.mockRejectedValue(new Error('unreadable'));
    else execGit.mockImplementation(args => args[0] === 'for-each-ref'
      ? Promise.resolve(ok(kind === 'local ref' ? 'feature/done\t' : 'different-name\torigin/feature/done')) : exec(args));
    const result = await retire();
    expect(result.deleted).toEqual([]);
    expect(result.skipped[0].reason).toMatch(/local|worktree/);
    expect(execGit.mock.calls.some(([args]) => args[0] === 'push')).toBe(false);
  });
  it('rechecks local ownership after merge proof', async () => {
    const exec = execGit.getMockImplementation();
    let added = false;
    execGit.mockImplementation(args => {
      if (args[0] === 'merge-base') added = true;
      if (args[0] === 'for-each-ref' && added) return Promise.resolve(ok('new-local\torigin/feature/done'));
      return exec(args);
    });
    expect((await retire()).skipped).toEqual([{ branch: 'feature/done', reason: 'local branch or upstream still exists' }]);
    expect(execGit.mock.calls.some(([args]) => args[0] === 'push')).toBe(false);
  });
  it('holds a reopened or incomplete workflow at the remote boundary', async () => {
    readBranchCompletionHold.mockResolvedValue('completion-pending');
    expect((await retire()).skipped).toEqual([{ branch: 'feature/done', reason: 'completion-pending' }]);
    expect(execGit.mock.calls.some(([args]) => args[0] === 'push')).toBe(false);
  });
  it('does not retire protected refs supplied by a caller', async () => {
    expect((await deleteMergedRemoteBranches('/repo', ['main', 'release'], { defaultBranch: 'main' })).deleted).toEqual([]);
    expect(execGit.mock.calls.some(([args]) => args[0] === 'push')).toBe(false);
  });
  it('fails closed when the current remote head is no longer merged', async () => {
    const exec = execGit.getMockImplementation();
    execGit.mockImplementation(args => ['merge-base', 'cherry'].includes(args[0])
      ? Promise.resolve({ ...ok(), exitCode: 1 }) : exec(args));
    expect((await retire()).skipped).toEqual([{ branch: 'feature/done', reason: 'current head is not merged' }]);
    expect(execGit.mock.calls.some(([args]) => args[0] === 'push')).toBe(false);
  });
});
