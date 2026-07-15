import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/execGit.js', () => ({
  execGit: vi.fn()
}));

vi.mock('./worktreeManager.js', () => ({
  listWorktrees: vi.fn().mockResolvedValue([])
}));

describe('getBranches', () => {
  let getBranches;
  let execGit;
  let listWorktrees;

  beforeEach(async () => {
    const execGitModule = await import('../lib/execGit.js');
    execGit = execGitModule.execGit;
    const worktreeModule = await import('./worktreeManager.js');
    listWorktrees = worktreeModule.listWorktrees;
    listWorktrees.mockResolvedValue([]);
    const gitModule = await import('./git.js');
    getBranches = gitModule.getBranches;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('flags a non-current, non-protected branch merged into the default branch, and excludes the current/default branch', async () => {
    execGit.mockImplementation((args) => {
      if (args[0] === 'branch' && args.includes('-vv')) {
        return Promise.resolve({
          stdout: [
            '*|main||',
            ' |feature/done|origin/feature/done|',
            ' |feature/wip|origin/feature/wip|[ahead 1]'
          ].join('\n'),
          stderr: '',
          exitCode: 0
        });
      }
      if (args[0] === 'symbolic-ref') {
        return Promise.resolve({ stdout: 'origin/main', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'rev-parse' && args.includes('--verify')) {
        return Promise.resolve({ stdout: 'abc123', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'branch' && args.includes('--list')) {
        return Promise.resolve({ stdout: '  main\n  feature/done\n  feature/wip\n', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'branch' && args.includes('--merged')) {
        return Promise.resolve({ stdout: 'main\nfeature/done\n', stderr: '', exitCode: 0 });
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });

    const branches = await getBranches('/fake/dir');

    const main = branches.find(b => b.name === 'main');
    const done = branches.find(b => b.name === 'feature/done');
    const wip = branches.find(b => b.name === 'feature/wip');

    expect(main.current).toBe(true);
    expect(main.isDefault).toBe(true);
    expect(main.merged).toBe(false);

    expect(done.isDefault).toBe(false);
    expect(done.merged).toBe(true);

    expect(wip.merged).toBe(false);
  });

  it('never flags a protected branch (e.g. dev) as merged even when it appears in the --merged output', async () => {
    execGit.mockImplementation((args) => {
      if (args[0] === 'branch' && args.includes('-vv')) {
        return Promise.resolve({
          stdout: ['*|main||', ' |dev||'].join('\n'),
          stderr: '',
          exitCode: 0
        });
      }
      if (args[0] === 'symbolic-ref') {
        return Promise.resolve({ stdout: 'origin/main', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'rev-parse' && args.includes('--verify')) {
        return Promise.resolve({ stdout: 'abc123', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'branch' && args.includes('--list')) {
        return Promise.resolve({ stdout: '  main\n  dev\n', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'branch' && args.includes('--merged')) {
        return Promise.resolve({ stdout: 'main\ndev\n', stderr: '', exitCode: 0 });
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });

    const branches = await getBranches('/fake/dir');
    const dev = branches.find(b => b.name === 'dev');

    expect(dev.merged).toBe(false);
  });

  it('falls back to the remote-tracking ref when there is no local branch matching the default (single-branch clone / feature-only worktree)', async () => {
    execGit.mockImplementation((args) => {
      if (args[0] === 'branch' && args.includes('-vv')) {
        return Promise.resolve({
          stdout: ['*|feature-a||', ' |feature-b||'].join('\n'),
          stderr: '',
          exitCode: 0
        });
      }
      if (args[0] === 'symbolic-ref') {
        // origin/HEAD resolves to main, but there is no local `main` branch
        return Promise.resolve({ stdout: 'origin/main', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'rev-parse' && args.includes('--verify')) {
        return Promise.resolve({ stdout: 'abc123', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'branch' && args.includes('--list')) {
        return Promise.resolve({ stdout: '  feature-a\n  feature-b\n', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'branch' && args.includes('--merged')) {
        if (args[2] === 'main') {
          // No local `main` ref exists — git errors out
          return Promise.resolve({ stdout: '', stderr: 'fatal: malformed object name main', exitCode: 128 });
        }
        if (args[2] === 'origin/main') {
          return Promise.resolve({ stdout: 'feature-b\n', stderr: '', exitCode: 0 });
        }
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });

    const branches = await getBranches('/fake/dir');
    const featureA = branches.find(b => b.name === 'feature-a');
    const featureB = branches.find(b => b.name === 'feature-b');

    expect(featureA.current).toBe(true);
    expect(featureA.merged).toBe(false);
    expect(featureB.merged).toBe(true);
  });

  it('flags a merged branch checked out in another worktree so the UI does not count it as locally deletable', async () => {
    // `git branch -d` refuses a branch checked out in a worktree, so
    // deleteMergedBranches skips it — getBranches must surface that via `worktree`
    // or the "Clean N merged" button promises deletions the server won't perform.
    listWorktrees.mockResolvedValue([
      { branch: 'refs/heads/feature/locked' }, // merged but checked out elsewhere
      { branch: 'refs/heads/main' }             // the current branch's own worktree
    ]);
    execGit.mockImplementation((args) => {
      if (args[0] === 'branch' && args.includes('-vv')) {
        return Promise.resolve({
          stdout: [
            '*|main||',
            ' |feature/locked|origin/feature/locked|',
            ' |feature/free|origin/feature/free|'
          ].join('\n'),
          stderr: '',
          exitCode: 0
        });
      }
      if (args[0] === 'symbolic-ref') {
        return Promise.resolve({ stdout: 'origin/main', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'rev-parse' && args.includes('--verify')) {
        return Promise.resolve({ stdout: 'abc123', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'branch' && args.includes('--list')) {
        return Promise.resolve({ stdout: '  main\n  feature/locked\n  feature/free\n', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'branch' && args.includes('--merged')) {
        return Promise.resolve({ stdout: 'main\nfeature/locked\nfeature/free\n', stderr: '', exitCode: 0 });
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });

    const branches = await getBranches('/fake/dir');
    const locked = branches.find(b => b.name === 'feature/locked');
    const free = branches.find(b => b.name === 'feature/free');
    const main = branches.find(b => b.name === 'main');

    // The worktree-locked branch is merged but flagged as a worktree branch,
    // so `merged && !worktree` (the client's deletable count) excludes it.
    expect(locked.merged).toBe(true);
    expect(locked.worktree).toBe(true);

    // A merged branch NOT in a worktree stays deletable.
    expect(free.merged).toBe(true);
    expect(free.worktree).toBe(false);

    // The current branch is never flagged as a worktree branch even though its
    // own worktree appears in listWorktrees (the `!b.current` guard).
    expect(main.worktree).toBe(false);
  });
});
