import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/execGit.js', () => ({
  execGit: vi.fn()
}));

vi.mock('./worktreeManager.js', () => ({
  isGitLockError: vi.fn(),
  listWorktrees: vi.fn().mockResolvedValue([]),
  reapMergedWorktrees: vi.fn()
}));

import { execGit } from '../lib/execGit.js';
import { listWorktrees, reapMergedWorktrees } from './worktreeManager.js';
import { deleteMergedBranches } from './git.js';

const result = (stdout = '', exitCode = 0, stderr = '') => ({ stdout, stderr, exitCode });

beforeEach(() => {
  listWorktrees.mockResolvedValue([{ branch: 'refs/heads/feature/locked' }]);
  reapMergedWorktrees.mockResolvedValue({ reaped: [], skipped: [], defaultBranch: 'main' });
  execGit.mockImplementation((args) => {
    if (args[0] === 'symbolic-ref') return Promise.resolve(result('origin/main\n'));
    if (args[0] === 'rev-parse' && args.includes('--verify')) return Promise.resolve(result('abc123\n'));
    if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) return Promise.resolve(result('main\n'));
    if (args[0] === 'branch' && args.includes('--list')) return Promise.resolve(result('  main\n  feature/locked\n  feature/free\n'));
    if (args[0] === 'branch' && args.includes('-r') && args.includes('--merged')) return Promise.resolve(result(''));
    if (args[0] === 'branch' && args.includes('--merged')) {
      return Promise.resolve(result('main\nfeature/locked\nfeature/free\n'));
    }
    if (args[0] === 'fetch') return Promise.resolve(result());
    if (args[0] === 'branch' && args[1] === '-d') return Promise.resolve(result());
    return Promise.resolve(result());
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('deleteMergedBranches', () => {
  it('reports merged branches the reaper refused, while deleting eligible locals', async () => {
    reapMergedWorktrees.mockResolvedValue({
      reaped: [],
      skipped: [{ path: '/wt/locked', branch: 'feature/locked', reason: 'uncommitted' }]
    });

    const cleanup = await deleteMergedBranches('/repo');

    expect(cleanup.deleted).toEqual([{ name: 'feature/free', local: 'deleted', remote: null }]);
    // The reaper's reason is what tells the user why the branch survived — the
    // generic "it's in a worktree" wording is now only the unknown-reason fallback.
    expect(cleanup.skipped).toEqual(['feature/locked (local: worktree has uncommitted changes)']);
    expect(execGit).toHaveBeenCalledWith(['branch', '-d', 'feature/free'], '/repo', { ignoreExitCode: true });
    expect(execGit).not.toHaveBeenCalledWith(['branch', '-d', 'feature/locked'], '/repo', { ignoreExitCode: true });
  });

  it('reports a worktree-held branch generically when the reaper named no reason', async () => {
    const cleanup = await deleteMergedBranches('/repo');

    expect(cleanup.skipped).toEqual(['feature/locked (local: checked out in a worktree)']);
  });

  it('counts a reaped worktree branch as deleted and folds its remote half into one row', async () => {
    reapMergedWorktrees.mockResolvedValue({
      reaped: [{ path: '/wt/reaped', branch: 'feature/reaped', locked: false, branchDeleted: true }],
      skipped: []
    });
    execGit.mockImplementation((args) => {
      if (args[0] === 'symbolic-ref') return Promise.resolve(result('origin/main\n'));
      if (args[0] === 'rev-parse' && args.includes('--verify')) return Promise.resolve(result('abc123\n'));
      if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) return Promise.resolve(result('main\n'));
      if (args[0] === 'branch' && args.includes('--list')) return Promise.resolve(result('  main\n'));
      if (args[0] === 'branch' && args.includes('-r') && args.includes('--merged')) {
        return Promise.resolve(result('origin/main\norigin/feature/reaped\n'));
      }
      if (args[0] === 'branch' && args.includes('--merged')) return Promise.resolve(result('main\n'));
      return Promise.resolve(result());
    });

    const cleanup = await deleteMergedBranches('/repo');

    expect(cleanup.deleted).toEqual([
      { name: 'feature/reaped', local: 'deleted', remote: 'deleted', worktree: 'removed' }
    ]);
    // The reap already deleted the local branch — re-running `branch -d` would
    // only produce a spurious "not found" skip.
    expect(execGit).not.toHaveBeenCalledWith(['branch', '-d', 'feature/reaped'], '/repo', { ignoreExitCode: true });
    expect(execGit).toHaveBeenCalledWith(['push', 'origin', '--delete', 'feature/reaped'], '/repo', { ignoreExitCode: true });
  });

  it('hands the reaper the protected branches, agent ids and default branch, and skips its own fetch', async () => {
    const excludeBranches = new Set(['feature/agent-work']);
    const activeAgentIds = new Set(['agent-1']);

    await deleteMergedBranches('/repo', { excludeBranches, activeAgentIds });

    expect(reapMergedWorktrees).toHaveBeenCalledWith('/repo', {
      activeAgentIds,
      excludeBranches,
      includeUnmanagedTrees: true,
      // Passed so the reap skips its own lookup, which can stall on `remote set-head`.
      defaultBranch: 'main'
    });
    // reapMergedWorktrees fetches --prune itself; a second round-trip is waste.
    expect(execGit).not.toHaveBeenCalledWith(['fetch', 'origin', '--prune'], '/repo', { ignoreExitCode: true });
  });

  it('retries the branch delete when the reap removed the tree but not the branch', async () => {
    reapMergedWorktrees.mockResolvedValue({
      reaped: [{ path: '/wt/locked', branch: 'feature/locked', locked: false, branchDeleted: false }],
      skipped: []
    });

    const cleanup = await deleteMergedBranches('/repo');

    // The worktree hold is gone with the tree, so the branch is an ordinary
    // target again rather than being reported as still checked out.
    expect(execGit).toHaveBeenCalledWith(['branch', '-d', 'feature/locked'], '/repo', { ignoreExitCode: true });
    expect(cleanup.deleted).toContainEqual({ name: 'feature/locked', local: 'deleted', remote: null });
    expect(cleanup.skipped).toEqual([]);
  });

  it('falls back to branch-only cleanup when the reap throws', async () => {
    reapMergedWorktrees.mockRejectedValue(new Error('worktree list failed'));

    const cleanup = await deleteMergedBranches('/repo');

    expect(cleanup.deleted).toEqual([{ name: 'feature/free', local: 'deleted', remote: null }]);
    expect(execGit).toHaveBeenCalledWith(['fetch', 'origin', '--prune'], '/repo', { ignoreExitCode: true });
  });
});
