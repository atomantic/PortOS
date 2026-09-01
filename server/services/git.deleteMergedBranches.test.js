import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/execGit.js', () => ({
  execGit: vi.fn()
}));

vi.mock('./worktreeManager.js', () => ({
  isGitLockError: vi.fn(),
  listWorktrees: vi.fn().mockResolvedValue([])
}));

import { execGit } from '../lib/execGit.js';
import { listWorktrees } from './worktreeManager.js';
import { deleteMergedBranches } from './git.js';

const result = (stdout = '', exitCode = 0, stderr = '') => ({ stdout, stderr, exitCode });

beforeEach(() => {
  listWorktrees.mockResolvedValue([{ branch: 'refs/heads/feature/locked' }]);
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
  it('reports merged branches held by worktrees while deleting eligible locals', async () => {
    const cleanup = await deleteMergedBranches('/repo');

    expect(cleanup.deleted).toEqual([{ name: 'feature/free', local: 'deleted', remote: null }]);
    expect(cleanup.skipped).toEqual(['feature/locked (local: checked out in a worktree)']);
    expect(execGit).toHaveBeenCalledWith(['branch', '-d', 'feature/free'], '/repo', { ignoreExitCode: true });
    expect(execGit).not.toHaveBeenCalledWith(['branch', '-d', 'feature/locked'], '/repo', { ignoreExitCode: true });
  });
});
