import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/execGit.js', () => ({
  execGit: vi.fn()
}));

describe('getDefaultBranch', () => {
  let getDefaultBranch;
  let execGit;

  beforeEach(async () => {
    const execGitModule = await import('../lib/execGit.js');
    execGit = execGitModule.execGit;
    const gitModule = await import('./git.js');
    getDefaultBranch = gitModule.getDefaultBranch;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns branch from origin/HEAD when available', async () => {
    execGit.mockImplementation((args) => {
      if (args[0] === 'symbolic-ref' && args.includes('refs/remotes/origin/HEAD')) {
        return Promise.resolve({ stdout: 'origin/main', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'rev-parse' && args.includes('--verify')) {
        return Promise.resolve({ stdout: 'abc123', stderr: '', exitCode: 0 });
      }
      return Promise.reject(new Error('unexpected'));
    });

    const result = await getDefaultBranch('/fake/dir');
    expect(result).toBe('main');
  });

  it('strips origin/ prefix from various branch names', async () => {
    execGit.mockImplementation((args) => {
      if (args[0] === 'symbolic-ref') {
        return Promise.resolve({ stdout: 'origin/develop', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'rev-parse' && args.includes('--verify')) {
        return Promise.resolve({ stdout: 'abc123', stderr: '', exitCode: 0 });
      }
      return Promise.reject(new Error('unexpected'));
    });

    const result = await getDefaultBranch('/fake/dir');
    expect(result).toBe('develop');
  });

  it('skips remote detection when allowRemote=false', async () => {
    const calls = [];
    execGit.mockImplementation((args) => {
      calls.push(args.join(' '));
      if (args[0] === 'symbolic-ref') {
        return Promise.reject(new Error('not set'));
      }
      if (args[0] === 'branch') {
        return Promise.resolve({ stdout: '  main\n  dev\n', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'rev-parse') {
        return Promise.resolve({ stdout: 'main', stderr: '', exitCode: 0 });
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });

    const result = await getDefaultBranch('/fake/dir', { allowRemote: false });
    expect(result).toBe('main');
    expect(calls.some(c => c.includes('set-head'))).toBe(false);
  });

  it('attempts remote set-head when allowRemote=true and origin/HEAD unset', async () => {
    const calls = [];
    execGit.mockImplementation((args) => {
      calls.push(args.join(' '));
      if (args[0] === 'symbolic-ref') {
        // First call fails, second succeeds after set-head
        if (calls.filter(c => c.startsWith('symbolic-ref')).length === 1) {
          return Promise.reject(new Error('not set'));
        }
        return Promise.resolve({ stdout: 'origin/main', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'remote' && args.includes('set-head')) {
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });

    const result = await getDefaultBranch('/fake/dir', { allowRemote: true });
    expect(result).toBe('main');
    expect(calls.some(c => c.includes('set-head'))).toBe(true);
  });

  it('falls back to master when main not in branch list', async () => {
    execGit.mockImplementation((args) => {
      if (args[0] === 'symbolic-ref') {
        return Promise.reject(new Error('not set'));
      }
      if (args[0] === 'branch') {
        return Promise.resolve({ stdout: '  master\n  feature/x\n', stderr: '', exitCode: 0 });
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });

    const result = await getDefaultBranch('/fake/dir', { allowRemote: false });
    expect(result).toBe('master');
  });

  it('falls back to current HEAD when no standard branches exist', async () => {
    execGit.mockImplementation((args) => {
      if (args[0] === 'symbolic-ref') {
        return Promise.reject(new Error('not set'));
      }
      if (args[0] === 'branch') {
        return Promise.resolve({ stdout: '  develop\n  feature/x\n', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) {
        return Promise.resolve({ stdout: 'develop', stderr: '', exitCode: 0 });
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });

    const result = await getDefaultBranch('/fake/dir', { allowRemote: false });
    expect(result).toBe('develop');
  });

  it('returns null when all detection methods fail', async () => {
    execGit.mockImplementation((args) => {
      if (args[0] === 'symbolic-ref') {
        return Promise.reject(new Error('not set'));
      }
      if (args[0] === 'branch') {
        return Promise.resolve({ stdout: '  feature/x\n  feature/y\n', stderr: '', exitCode: 0 });
      }
      if (args[0] === 'rev-parse') {
        return Promise.resolve({ stdout: 'HEAD', stderr: '', exitCode: 0 });
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });

    const result = await getDefaultBranch('/fake/dir', { allowRemote: false });
    expect(result).toBeNull();
  });
});
