import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { execGit } from '../lib/execGit.js';
import { destroyGitSandbox, makeGitSandbox } from '../lib/gitTestRepo.js';
import { getDefaultBranch, getRepoBranches } from './git.js';

let sandbox;
const git = args => execGit(args, sandbox.repo);

beforeEach(async () => {
  sandbox = await makeGitSandbox();
  await git(['checkout', '-b', 'feature/example']);
});

afterEach(async () => {
  await destroyGitSandbox(sandbox?.scratch);
});

it('recognizes main and dev held by other worktrees', async () => {
  await git(['branch', 'master']);
  await git(['branch', 'develop']);
  await git(['tag', 'main']);
  await git(['worktree', 'add', join(sandbox.scratch, 'main-holder'), 'main']);
  await git(['worktree', 'add', '-b', 'dev', join(sandbox.scratch, 'dev-holder')]);

  expect(await getDefaultBranch(sandbox.repo, { allowRemote: false, strict: true })).toBe('main');
  expect(await getDefaultBranch(sandbox.repo, { allowRemote: false })).toBe('main');
  expect(await getRepoBranches(sandbox.repo)).toEqual({ baseBranch: 'main', devBranch: 'dev' });
});

it('prefers a verified remote HEAD and falls back when that ref disappears', async () => {
  await git(['update-ref', 'refs/remotes/origin/trunk', 'HEAD']);
  await git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']);

  expect(await getDefaultBranch(sandbox.repo, { allowRemote: false, strict: true })).toBe('trunk');
  expect(await getRepoBranches(sandbox.repo)).toEqual({ baseBranch: 'trunk', devBranch: null });

  await git(['update-ref', '-d', 'refs/remotes/origin/trunk']);
  await git(['branch', '-m', 'main', 'master']);
  expect(await getDefaultBranch(sandbox.repo, { allowRemote: false, strict: true })).toBe('master');
  expect(await getRepoBranches(sandbox.repo)).toEqual({ baseBranch: 'master', devBranch: null });

  await git(['branch', '-d', 'master']);
  expect(await getDefaultBranch(sandbox.repo, { allowRemote: false, strict: true })).toBeNull();
  expect(await getDefaultBranch(sandbox.repo, { allowRemote: false })).toBe('feature/example');
  expect(await getRepoBranches(sandbox.repo)).toEqual({ baseBranch: null, devBranch: null });
});
