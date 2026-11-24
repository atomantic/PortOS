import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { execGit } from '../lib/execGit.js';
import { makeGitSandbox, destroyGitSandbox, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';
import { getBranchComparison, getCommits, getGitInfo, getStatus, stageFiles, unstageFiles } from './git.js';

// Real git: what these pin is how git itself spells subjects and paths.
describe.skipIf(SKIP_HEAVY_INTEGRATION)('Git tab reads', () => {
  let sandbox;
  let repo;
  const git = (...args) => execGit(args, repo);
  const row = async (path) => (await getStatus(repo)).files.find(file => file.path === path);

  beforeEach(async () => {
    sandbox = await makeGitSandbox();
    repo = sandbox.repo;
  });
  afterEach(() => destroyGitSandbox(sandbox.scratch));

  it('lists and counts a commit whose subject holds quotes or a backslash', async () => {
    await git('checkout', '-q', '-b', 'dev');
    await git('commit', '-q', '--allow-empty', '-m', 'Revert "a change"');
    await git('commit', '-q', '--allow-empty', '-m', 'fix: escape \\d in a pattern');

    expect((await getCommits(repo, 2)).map(commit => commit.message))
      .toEqual(['fix: escape \\d in a pattern', 'Revert "a change"']);
    expect(await getBranchComparison(repo, 'main', 'dev')).toMatchObject({ ahead: 2 });
  });

  it('stages and unstages a path with a space and a renamed file', async () => {
    await writeFile(join(repo, 'my file.txt'), 'x\n');
    await stageFiles(repo, [(await row('my file.txt')).path]);
    expect(await row('my file.txt')).toMatchObject({ staged: true });
    await git('commit', '-q', '-m', 'add');

    await git('mv', 'my file.txt', 'moved.txt');
    const renamed = await row('moved.txt');
    expect(renamed).toMatchObject({ staged: true, origPath: 'my file.txt' });
    await unstageFiles(repo, [renamed.path, renamed.origPath]);
    expect((await getStatus(repo)).staged).toBe(0);
  });

  it('counts staged changes in the branch summary', async () => {
    await writeFile(join(repo, 'a.txt'), 'one\n');
    await git('add', 'a.txt');
    await git('commit', '-q', '-m', 'add a');
    await appendFile(join(repo, 'a.txt'), 'two\n');
    await stageFiles(repo, ['a.txt']);

    expect((await getGitInfo(repo)).diffStats).toMatchObject({ files: 1, insertions: 1 });
  });
});
