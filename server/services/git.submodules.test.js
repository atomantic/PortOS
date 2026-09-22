import { describe, it, expect, vi, beforeEach } from 'vitest';

// Drive updateSubmodule off a scripted git, so the test asserts the exact
// command sequence (and the commit guard) rather than re-implementing it.
vi.mock('../lib/execGit.js', () => {
  const execGit = vi.fn();
  return {
    execGit,
    execGitSafe: (...args) => execGit(...args).catch(err => ({ exitCode: 1, stdout: '', stderr: err.message }))
  };
});

// Mocked so the retry path is driven by a decision, not by real file mtimes —
// `lib/gitStaleLock.test.js` owns proving WHICH locks it agrees to remove.
vi.mock('../lib/gitStaleLock.js', () => ({ clearStaleGitLock: vi.fn(() => null) }));

import { execGit } from '../lib/execGit.js';
import { clearStaleGitLock } from '../lib/gitStaleLock.js';

const REPO = '/Users/me/project';
const SUB = 'lib/dep';

const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });

/**
 * Scripted git: submodule status reports `lib/dep`, origin/HEAD points at
 * `defaultBranch`, HEAD is on `currentBranch`, and `git diff --cached` reports
 * the submodule as staged unless `stagedPointer` is false.
 */
function scriptGit({ defaultBranch = 'main', currentBranch = defaultBranch, stagedPointer = true } = {}) {
  execGit.mockImplementation(async (args) => {
    const [a, b] = args;
    if (a === 'submodule' && b === 'status') return ok(' 1111111222222233333334444444555555566 lib/dep (heads/main)\n');
    if (a === 'submodule' && b === 'update') return ok('');
    if (a === 'symbolic-ref') return ok(`origin/${defaultBranch}\n`);
    if (a === 'rev-parse' && b === '--verify') return ok('ref\n');
    if (a === 'rev-parse' && b === '--abbrev-ref') return ok(`${currentBranch}\n`);
    if (a === 'branch' && b === '--list') return ok(`* ${currentBranch}\n  ${defaultBranch}\n`);
    if (a === 'add') return ok('');
    if (a === 'diff') return ok(stagedPointer ? `${SUB}\n` : '');
    if (a === 'commit') return ok(`[${defaultBranch} abc1234] chore\n`);
    return ok('');
  });
}

const callsFor = (verb) => execGit.mock.calls.filter(([args]) => args[0] === verb);

describe('updateSubmodule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates without committing when commit is not requested', async () => {
    scriptGit();
    const { updateSubmodule } = await import('./git.js');

    const result = await updateSubmodule(SUB, { repoPath: REPO });

    expect(result).toEqual({ newCommit: '1111111', committed: false });
    expect(callsFor('commit')).toHaveLength(0);
    // Every command ran against the caller's repo, not the PortOS checkout.
    for (const [, cwd] of execGit.mock.calls) expect(cwd).toBe(REPO);
  });

  it('commits the pointer bump on the default branch when commit is requested', async () => {
    scriptGit();
    const { updateSubmodule } = await import('./git.js');

    const result = await updateSubmodule(SUB, { repoPath: REPO, commit: true });

    expect(result).toMatchObject({
      newCommit: '1111111',
      committed: true,
      commitSha: 'abc1234',
      defaultBranch: 'main',
      currentBranch: 'main'
    });
    expect(result.commitMessage).toContain(SUB);
    // Only the submodule pointer is staged — never the rest of a dirty tree.
    expect(callsFor('add')[0][0]).toEqual(['add', '--', `:(literal)${SUB}`]);
    expect(callsFor('commit')).toHaveLength(1);
  });

  it('refuses to commit when the repo is checked out on another branch', async () => {
    scriptGit({ defaultBranch: 'main', currentBranch: 'feature/wip' });
    const { updateSubmodule } = await import('./git.js');

    const result = await updateSubmodule(SUB, { repoPath: REPO, commit: true });

    expect(result).toMatchObject({
      committed: false,
      commitSkipped: 'not-on-default-branch',
      defaultBranch: 'main',
      currentBranch: 'feature/wip'
    });
    expect(callsFor('add')).toHaveLength(0);
    expect(callsFor('commit')).toHaveLength(0);
  });

  it('reports no-changes instead of creating an empty commit', async () => {
    scriptGit({ stagedPointer: false });
    const { updateSubmodule } = await import('./git.js');

    const result = await updateSubmodule(SUB, { repoPath: REPO, commit: true });

    expect(result).toMatchObject({ committed: false, commitSkipped: 'no-changes' });
    expect(callsFor('commit')).toHaveLength(0);
  });

  // A killed git process leaves `index.lock` inside `.git/modules/<subPath>/`,
  // which every worktree of the repo shares — so without this, pressing Update
  // Submodule fails forever, blaming a git process that exited long ago.
  it('clears an abandoned lock and retries once', async () => {
    scriptGit();
    const lockError = new Error("fatal: Unable to create '/Users/me/project/.git/modules/lib/dep/index.lock': File exists");
    let updates = 0;
    const scripted = execGit.getMockImplementation();
    execGit.mockImplementation(async (args, cwd, options) => {
      if (args[0] === 'submodule' && args[1] === 'update' && ++updates === 1) throw lockError;
      return scripted(args, cwd, options);
    });
    clearStaleGitLock.mockReturnValue('/Users/me/project/.git/modules/lib/dep/index.lock');
    const { updateSubmodule } = await import('./git.js');

    const result = await updateSubmodule(SUB, { repoPath: REPO });

    expect(result).toEqual({ newCommit: '1111111', committed: false });
    expect(clearStaleGitLock).toHaveBeenCalledWith(lockError.message);
    expect(callsFor('submodule').filter(([args]) => args[1] === 'update')).toHaveLength(2);
  });

  it('surfaces the lock failure when the lock is too young to clear', async () => {
    // A genuinely concurrent update must be REPORTED, not raced: clearing
    // refused, so there is nothing to retry.
    scriptGit();
    const lockError = new Error("fatal: Unable to create '/Users/me/project/.git/modules/lib/dep/index.lock': File exists");
    execGit.mockImplementation(async (args) => {
      if (args[0] === 'submodule' && args[1] === 'update') throw lockError;
      return ok(' 1111111222222233333334444444555555566 lib/dep (heads/main)\n');
    });
    clearStaleGitLock.mockReturnValue(null);
    const { updateSubmodule } = await import('./git.js');

    await expect(updateSubmodule(SUB, { repoPath: REPO })).rejects.toThrow(/Unable to create/);
    expect(callsFor('submodule').filter(([args]) => args[1] === 'update')).toHaveLength(1);
  });

  it('rejects a path that is not a submodule of the repo', async () => {
    scriptGit();
    const { updateSubmodule } = await import('./git.js');

    await expect(updateSubmodule('lib/other', { repoPath: REPO })).rejects.toThrow(/Unknown submodule path/);
    expect(callsFor('submodule').filter(([args]) => args[1] === 'update')).toHaveLength(0);
  });

  it('exports submodule operations directly from gitSubmodules.js', async () => {
    const direct = await import('./gitSubmodules.js');
    const facade = await import('./git.js');
    expect(direct.getSubmodules).toBe(facade.getSubmodules);
    expect(direct.getSubmoduleOverview).toBe(facade.getSubmoduleOverview);
    expect(direct.getSubmodulePaths).toBe(facade.getSubmodulePaths);
    expect(direct.updateSubmodule).toBe(facade.updateSubmodule);
  });
});

