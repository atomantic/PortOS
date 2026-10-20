// Real git: a pinned attach is a security boundary (the attached code is then
// executed), so what it checks out and which remote it tracks must be proven
// against git itself, not a scripted execGit.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { mockPathsDataRoot, mockTestIdentity } from '../lib/mockPathsDataRoot.js';
import { destroyGitSandbox, makeGitSandbox, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';
import { execGit } from '../lib/execGit.js';

const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-worktree-pinned-' });
vi.mock('../lib/fileUtils.js', async importOriginal => makeProxy(await importOriginal()));
vi.mock('./instanceIdentity.js', () => mockTestIdentity());
const { PATHS } = await import('../lib/fileUtils.js');
const { createWorktree, PINNED_HEAD_MOVED } = await import('./worktreeManager.js');
afterAll(cleanup);

const BRANCH = 'contributor/fix-thing';
const git = async (args, cwd) => (await execGit(args, cwd)).stdout.trim();

// Commit on a detached HEAD and publish it as `branch` on `remote`, leaving the
// primary checkout without a local copy, as a PR head looks to PortOS.
async function publish(repo, remote, branch, file) {
  await execGit(['checkout', '--detach', 'main'], repo);
  await writeFile(join(repo, file), `${file}\n`);
  await execGit(['add', file], repo);
  await execGit(['commit', '-m', file], repo);
  const sha = await git(['rev-parse', 'HEAD'], repo);
  await execGit(['push', remote, `HEAD:refs/heads/${branch}`], repo);
  await execGit(['checkout', 'main'], repo);
  return sha;
}

describe.skipIf(SKIP_HEAVY_INTEGRATION)('createWorktree pinned to a reviewed head', () => {
  let sandbox;
  beforeEach(async () => {
    if (sandbox) await destroyGitSandbox(sandbox.scratch);
    sandbox = await makeGitSandbox({ origin: true, prefix: 'portos-pinned-' });
  });
  afterAll(async () => { if (sandbox) await destroyGitSandbox(sandbox.scratch); });

  it('attaches a same-repo head at the reviewed commit, tracking origin', async () => {
    const reviewed = await publish(sandbox.repo, 'origin', BRANCH, 'reviewed.txt');

    const info = await createWorktree('agent-same', sandbox.repo, 'task-same', { existingBranch: BRANCH, expectedHeadSha: reviewed });

    expect(await git(['rev-parse', 'HEAD'], info.worktreePath)).toBe(reviewed);
    expect(await git(['rev-parse', '--abbrev-ref', `${BRANCH}@{upstream}`], sandbox.repo)).toBe(`origin/${BRANCH}`);
  });

  it('refuses, and leaves no checkout, when the head moved after review', async () => {
    const reviewed = await publish(sandbox.repo, 'origin', BRANCH, 'reviewed.txt');
    // The contributor pushes on top of the reviewed commit.
    await execGit(['checkout', '--detach', reviewed], sandbox.repo);
    await writeFile(join(sandbox.repo, 'unreviewed.txt'), 'unreviewed\n');
    await execGit(['add', 'unreviewed.txt'], sandbox.repo);
    await execGit(['commit', '-m', 'unreviewed'], sandbox.repo);
    await execGit(['push', 'origin', `HEAD:refs/heads/${BRANCH}`], sandbox.repo);
    await execGit(['checkout', 'main'], sandbox.repo);

    await expect(createWorktree('agent-moved', sandbox.repo, 'task-moved', { existingBranch: BRANCH, expectedHeadSha: reviewed }))
      .rejects.toMatchObject({ code: PINNED_HEAD_MOVED });
    expect(existsSync(join(PATHS.worktrees, 'agent-moved'))).toBe(false);
  });

  it('refuses when only a stale remote-tracking ref still names the reviewed commit', async () => {
    const reviewed = await publish(sandbox.repo, 'origin', BRANCH, 'reviewed.txt');
    // The branch is deleted upstream (not via this checkout, which would drop
    // its own tracking ref); without pruning, origin/<branch> survives.
    await execGit(['config', 'fetch.prune', 'false'], sandbox.repo);
    await execGit(['branch', '-D', BRANCH], sandbox.origin);

    await expect(createWorktree('agent-stale', sandbox.repo, 'task-stale', { existingBranch: BRANCH, expectedHeadSha: reviewed }))
      .rejects.toThrow();
    expect(existsSync(join(PATHS.worktrees, 'agent-stale'))).toBe(false);
  });

  it('resolves a pinned fork head through the fork even when origin has a same-named branch', async () => {
    // A fork PR opened from a branch whose name origin also uses: the unpinned
    // resolve order would pick origin's, a different branch entirely.
    await publish(sandbox.repo, 'origin', BRANCH, 'origin-only.txt');
    const forkPath = join(sandbox.scratch, 'fork.git');
    await execGit(['init', '--bare', forkPath], sandbox.scratch);
    const reviewed = await publish(sandbox.repo, forkPath, BRANCH, 'fork.txt');

    const info = await createWorktree('agent-fork', sandbox.repo, 'task-fork', {
      existingBranch: BRANCH,
      expectedHeadSha: reviewed,
      forkHead: { remoteUrl: forkPath, ownerLogin: 'contributor' },
    });

    expect(await git(['rev-parse', 'HEAD'], info.worktreePath)).toBe(reviewed);
    // `git push` must go to the contributor's fork, never to origin.
    expect(await git(['rev-parse', '--abbrev-ref', `${BRANCH}@{upstream}`], sandbox.repo)).toBe(`fork-contributor/${BRANCH}`);
  });
});
