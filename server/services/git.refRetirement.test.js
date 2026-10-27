import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeGitSandbox, destroyGitSandbox } from '../lib/gitTestRepo.js';
import { execGit } from '../lib/execGit.js';
import { deleteBranch } from './git.js';

const ownership = vi.hoisted(() => ({ agents: [], moveHead: null }));
vi.mock('./cosClaimOwnershipState.js', () => ({
  withClaimOwnershipLock: work => work(),
  readClaimOwnershipAgents: async () => ownership.agents,
}));
vi.mock('./worktreeManager.js', async original => {
  const actual = await original();
  return { ...actual, deleteCompletedLocalBranch: (repo, branch, head, options) =>
    actual.deleteCompletedLocalBranch(repo, branch, head, { ...options, beforeMutation: async () => {
      await options.beforeMutation();
      await ownership.moveHead?.();
    } }) };
});
let sandbox, head;
const git = async args => (await execGit(args, sandbox.repo)).stdout.trim();
beforeEach(async () => {
  ownership.agents = [];
  ownership.moveHead = null;
  sandbox = await makeGitSandbox({ origin: true, prefix: 'portos-pinned-ref-' });
  await git(['checkout', '-b', 'finished']);
  await writeFile(join(sandbox.repo, 'source.txt'), 'private completed source\n');
  await git(['add', 'source.txt']);
  await git(['commit', '-m', 'completed work']);
  head = await git(['rev-parse', 'HEAD']);
  await git(['push', 'origin', 'finished']);
  await git(['checkout', 'main']);
});
afterEach(async () => { if (sandbox) await destroyGitSandbox(sandbox.scratch); });

it('removes the exact selected local ref through Git and preserves its source outside branch inventory', async () => {
  expect(await deleteBranch(sandbox.repo, 'finished', { local: true, expectedHead: head })).toEqual({
    branch: 'finished', results: { local: 'deleted' },
  });
  const absent = await execGit(['show-ref', '--verify', '--quiet', 'refs/heads/finished'], sandbox.repo, { ignoreExitCode: true });
  expect(absent.exitCode).toBe(1);
  expect(await git(['rev-parse', `refs/portos/completed/${head}`])).toBe(head);
  expect(await git(['show', `${head}:source.txt`])).toBe('private completed source');
});

it('retains a moved head, a checked-out branch, and an unreadable owner set', async () => {
  await expect(deleteBranch(sandbox.repo, 'finished', { local: true, expectedHead: '0'.repeat(40) }))
    .rejects.toMatchObject({ code: 'BRANCH_HEAD_CHANGED' });
  ownership.agents = null;
  await expect(deleteBranch(sandbox.repo, 'finished', { local: true, expectedHead: head }))
    .rejects.toMatchObject({ code: 'BRANCH_OWNER_HELD' });
  ownership.agents = [];
  const holder = join(sandbox.scratch, 'holder');
  await git(['worktree', 'add', holder, 'finished']);
  await expect(deleteBranch(sandbox.repo, 'finished', { local: true, expectedHead: head }))
    .rejects.toThrow('checked out in a worktree');
  expect(await git(['rev-parse', 'refs/heads/finished'])).toBe(head);
});

it('lets the real receiver refuse a ref that moves after review without deleting the newer work', async () => {
  const newer = await git(['commit-tree', 'HEAD^{tree}', '-p', head, '-m', 'new owner work']);
  ownership.moveHead = () => git(['update-ref', 'refs/heads/finished', newer, head]);
  const result = await deleteBranch(sandbox.repo, 'finished', { local: true, expectedHead: head });
  expect(result.results.local).toBe('failed: branch head or holder changed');
  expect(await git(['rev-parse', 'refs/heads/finished'])).toBe(newer);
  expect(await git(['rev-parse', `refs/portos/completed/${head}`])).toBe(head);
});

it('retains the remote when a combined request fails its owner check with or without a local ref', async () => {
  ownership.agents = null;
  await expect(deleteBranch(sandbox.repo, 'finished', { local: true, remote: true }))
    .rejects.toMatchObject({ code: 'BRANCH_OWNER_HELD' });
  expect(await git(['ls-remote', '--heads', 'origin', 'refs/heads/finished']))
    .toBe(`${head}\trefs/heads/finished`);
  expect(await git(['rev-parse', 'refs/heads/finished'])).toBe(head);
  await git(['branch', '-D', 'finished']);
  await expect(deleteBranch(sandbox.repo, 'finished', { local: true, remote: true }))
    .rejects.toMatchObject({ code: 'BRANCH_OWNER_HELD' });
  expect(await git(['ls-remote', '--heads', 'origin', 'refs/heads/finished']))
    .toBe(`${head}\trefs/heads/finished`);
});

it('deletes the remote when a combined request finds the local branch already absent', async () => {
  await git(['branch', '-D', 'finished']);
  expect(await deleteBranch(sandbox.repo, 'finished', { local: true, remote: true })).toEqual({
    branch: 'finished', results: { local: 'not found', remote: 'deleted' },
  });
  expect(await git(['ls-remote', '--heads', 'origin', 'refs/heads/finished'])).toBe('');
});

it.each(['directory', 'dangling symlink'])('retains the remote when the local ref is an occupied %s', async kind => {
  const gitDir = await git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  await git(['branch', '-D', 'finished']);
  const refPath = join(gitDir, 'refs', 'heads', 'finished');
  if (kind === 'directory') await mkdir(refPath);
  else await symlink(join(sandbox.scratch, 'missing-ref'), refPath);
  const result = await deleteBranch(sandbox.repo, 'finished', { local: true, remote: true });
  expect(result.results).toEqual({ local: 'failed: unable to resolve branch head', remote: 'retained: local branch deletion refused' });
  expect(await git(['ls-remote', '--heads', 'origin', 'refs/heads/finished']))
    .toBe(`${head}\trefs/heads/finished`);
});

it('retains the remote when the local ref cannot be resolved or changes during deletion', async () => {
  await git(['branch', '-D', 'finished']);
  await git(['symbolic-ref', 'refs/heads/finished', 'refs/heads/missing']);
  const broken = await deleteBranch(sandbox.repo, 'finished', { local: true, remote: true });
  expect(broken.results).toEqual({ local: 'failed: unable to resolve branch head', remote: 'retained: local branch deletion refused' });
  expect(await git(['ls-remote', '--heads', 'origin', 'refs/heads/finished'])).toBe(`${head}\trefs/heads/finished`);

  await git(['symbolic-ref', '--delete', 'refs/heads/finished']);
  await git(['update-ref', 'refs/heads/finished', head]);
  const newer = await git(['commit-tree', 'HEAD^{tree}', '-p', head, '-m', 'new owner work']);
  ownership.moveHead = () => git(['update-ref', 'refs/heads/finished', newer, head]);
  const moved = await deleteBranch(sandbox.repo, 'finished', { local: true, remote: true });
  expect(moved.results).toEqual({ local: 'failed: branch head or holder changed', remote: 'retained: local branch deletion refused' });
  expect(await git(['ls-remote', '--heads', 'origin', 'refs/heads/finished'])).toBe(`${head}\trefs/heads/finished`);
  expect(await git(['rev-parse', 'refs/heads/finished'])).toBe(newer);
});
