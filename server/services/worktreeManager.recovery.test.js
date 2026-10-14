import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
import { materializeGitRepo, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';
import { execGit } from '../lib/execGit.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-worktree-recovery-' });
vi.mock('../lib/fileUtils.js', async importOriginal => makeProxy(await importOriginal()));
const { PATHS } = await import('../lib/fileUtils.js');
const { removeWorktree } = await import('./worktreeManager.js');
afterAll(cleanup);

describe.skipIf(SKIP_HEAVY_INTEGRATION)('failed worktree cleanup recovery', () => {
  it('keeps the only committed copy recoverable when cleanup runs again after removing its checkout', async () => {
    const repo = join(tempRoot, 'source');
    await materializeGitRepo(repo);
    await mkdir(PATHS.worktrees, { recursive: true });
    const branch = 'cos/recovery/agent-example';
    const worktree = join(PATHS.worktrees, 'agent-example');
    await execGit(['worktree', 'add', '-b', branch, worktree, 'main'], repo);
    await writeFile(join(worktree, 'recoverable.txt'), 'unpublished agent work\n');
    await execGit(['add', 'recoverable.txt'], worktree);
    await execGit(['commit', '-m', 'unpublished work'], worktree);
    const options = { merge: false, preserveBranchWithCommits: true };

    expect((await removeWorktree('agent-example', repo, branch, options)).removed).toBe(true);
    expect((await removeWorktree('agent-example', repo, branch, options)).removed).toBe(true);

    // A retry can attach a new checkout and read the authored file, without
    // reflog surgery or a remote branch that the failed run never pushed.
    const resumed = join(PATHS.worktrees, 'agent-retry');
    await expect(execGit(['worktree', 'add', resumed, branch], repo)).resolves.toMatchObject({ exitCode: 0 });
    expect((await execGit(['show', 'HEAD:recoverable.txt'], resumed)).stdout).toBe('unpublished agent work\n');

    // Once that retry lands, both its first cleanup and any later completion
    // callback must report success without inventing a preserved branch.
    await execGit(['merge', branch, '--no-edit'], repo);
    expect(await removeWorktree('agent-retry', repo, branch, options)).toMatchObject({ removed: true, warnings: [] });
    expect(await removeWorktree('agent-retry', repo, branch, options)).toMatchObject({ removed: true, warnings: [] });
  });
});
