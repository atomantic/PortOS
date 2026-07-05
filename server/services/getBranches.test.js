import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/execGit.js', () => ({
  execGit: vi.fn()
}));

describe('getBranches', () => {
  let getBranches;
  let execGit;

  beforeEach(async () => {
    const execGitModule = await import('../lib/execGit.js');
    execGit = execGitModule.execGit;
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
});
