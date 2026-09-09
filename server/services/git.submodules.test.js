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

import { execGit } from '../lib/execGit.js';

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

  it('rejects a path that is not a submodule of the repo', async () => {
    scriptGit();
    const { updateSubmodule } = await import('./git.js');

    await expect(updateSubmodule('lib/other', { repoPath: REPO })).rejects.toThrow(/Unknown submodule path/);
    expect(callsFor('submodule').filter(([args]) => args[1] === 'update')).toHaveLength(0);
  });
});
