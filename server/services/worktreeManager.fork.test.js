import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { mockPathsDataRoot, mockTestIdentity } from '../lib/mockPathsDataRoot.js';
import { materializeGitRepo, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';
import { execGit } from '../lib/execGit.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-worktree-fork-' });
vi.mock('../lib/fileUtils.js', async importOriginal => makeProxy(await importOriginal()));
vi.mock('./instanceIdentity.js', () => mockTestIdentity());
const { PATHS } = await import('../lib/fileUtils.js');
const { createWorktree, removeWorktree } = await import('./worktreeManager.js');
afterAll(cleanup);

const git = async (repo, ...args) => (await execGit(args, repo)).stdout.trim();
const commit = async (repo, file) => {
  await writeFile(join(repo, file), `${file}\n`);
  await git(repo, 'add', file);
  await git(repo, 'commit', '-m', file);
  return git(repo, 'rev-parse', 'HEAD');
};

describe.skipIf(SKIP_HEAVY_INTEGRATION)('fork checkout and publication', () => {
  it('isolates fork main from checked-out main, publishes to the fork, and preserves local retry commits', async () => {
    const repo = join(tempRoot, 'source');
    const origin = join(tempRoot, 'origin.git');
    const fork = join(tempRoot, 'fork.git');
    const contributor = join(tempRoot, 'contributor');
    await materializeGitRepo(repo);
    await git(repo, 'clone', '--bare', repo, origin);
    await git(repo, 'remote', 'add', 'origin', origin);
    await git(repo, 'clone', '--bare', repo, fork);
    await materializeGitRepo(contributor);
    await git(contributor, 'remote', 'add', 'origin', fork);
    const forkHead = await commit(contributor, 'contribution.txt');
    await git(contributor, 'push', 'origin', 'main');
    const primaryHead = await commit(repo, 'primary-only.txt');
    await git(repo, 'push', 'origin', 'main');
    await mkdir(PATHS.worktrees, { recursive: true });
    const options = { existingBranch: 'main', forkHead: { remoteUrl: fork, ownerLogin: 'contributor' }, linkDependencies: false };

    const attached = await createWorktree('agent-fork', repo, 'task-fork', options);
    expect(attached.branchName).toBe('fork/contributor/main');
    expect(await git(attached.worktreePath, 'rev-parse', 'HEAD')).toBe(forkHead);
    expect(await git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(await git(repo, 'rev-parse', 'main')).toBe(primaryHead);
    expect(await git(attached.worktreePath, 'config', 'branch.fork/contributor/main.merge')).toBe('refs/heads/main');
    expect(await git(attached.worktreePath, 'config', 'branch.fork/contributor/main.pushRemote')).toBe('fork-contributor');
    const published = await commit(attached.worktreePath, 'review-fix.txt');
    // This is the exact explicit destination handed to agents by both prompts.
    await git(attached.worktreePath, 'push', 'fork-contributor', 'HEAD:refs/heads/main');
    expect(await git(fork, 'rev-parse', 'main')).toBe(published);
    expect(await git(origin, 'rev-parse', 'main')).toBe(primaryHead);
    await git(repo, 'branch', 'same-repo-head', 'main');
    const sameRepo = await createWorktree('agent-same-repo', repo, 'task-same', { existingBranch: 'same-repo-head', linkDependencies: false });
    expect(sameRepo.branchName).toBe('same-repo-head');
    expect(await git(sameRepo.worktreePath, 'rev-parse', 'HEAD')).toBe(primaryHead);
    const unpublished = await commit(attached.worktreePath, 'retry-work.txt');
    await removeWorktree('agent-fork', repo, attached.branchName, { merge: false, preserveBranchWithCommits: true });
    const retry = await createWorktree('agent-retry', repo, 'task-fork', options);
    expect(await git(retry.worktreePath, 'rev-parse', 'HEAD')).toBe(unpublished);
    expect(await git(fork, 'rev-parse', 'main')).toBe(published);
    expect(await git(origin, 'rev-parse', 'main')).toBe(primaryHead);
  });
});
