import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile, rm, readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { mockPathsDataRoot, mockTestIdentity } from '../lib/mockPathsDataRoot.js';
import { materializeGitRepo, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';
import { execGit } from '../lib/execGit.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-worktree-recovery-' });
vi.mock('../lib/fileUtils.js', async importOriginal => makeProxy(await importOriginal()));
vi.mock('../lib/paths.js', async importOriginal => makeProxy(await importOriginal()));
vi.mock('./instanceIdentity.js', () => mockTestIdentity());
const { PATHS } = await import('../lib/fileUtils.js');
const { removeWorktree, adoptWorktree, createWorktree } = await import('./worktreeManager.js');
afterAll(cleanup);

describe.skipIf(SKIP_HEAVY_INTEGRATION)('failed worktree cleanup recovery', () => {
  it('retains unfinished work across callbacks and recovers a checkout removed by an earlier workflow', async () => {
    const repo = join(tempRoot, 'source');
    await materializeGitRepo(repo);
    await mkdir(PATHS.worktrees, { recursive: true });
    await writeFile(join(PATHS.cos, 'state.json'), JSON.stringify({ agents: {} }));
    const branch = 'cos/recovery/agent-example';
    const worktree = join(PATHS.worktrees, 'agent-example');
    await execGit(['worktree', 'add', '-b', branch, worktree, 'main'], repo);
    await writeFile(join(worktree, 'recoverable.txt'), 'unpublished agent work\n');
    await execGit(['add', 'recoverable.txt'], worktree);
    await execGit(['commit', '-m', 'unpublished work'], worktree);
    const options = { merge: false, preserveBranchWithCommits: true };

    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await removeWorktree('agent-example', repo, branch, options)).toMatchObject({
        removed: false, warnings: expect.arrayContaining([expect.stringContaining('merge-evidence-unavailable')]),
      });
      expect(await readFile(join(worktree, 'recoverable.txt'), 'utf8')).toBe('unpublished agent work\n');
    }

    // Older workflows removed the checkout before preserving its branch. Model
    // that already-completed removal only inside this disposable repository.
    await execGit(['worktree', 'remove', worktree], repo);
    expect(await removeWorktree('agent-example', repo, branch, options)).toMatchObject({
      removed: true, warnings: expect.arrayContaining([expect.stringContaining('merge evidence was not established')]),
    });

    // A retry can attach a new checkout and read the authored file, without
    // reflog surgery or a remote branch that the failed run never pushed.
    const resumed = join(PATHS.worktrees, 'agent-retry');
    await expect(execGit(['worktree', 'add', resumed, branch], repo)).resolves.toMatchObject({ exitCode: 0 });
    expect((await execGit(['show', 'HEAD:recoverable.txt'], resumed)).stdout).toBe('unpublished agent work\n');

    // Once that retry lands, both its first cleanup and any later completion
    // callback must report success without inventing a preserved branch.
    await execGit(['merge', branch, '--no-edit'], repo);
    const reflog = await readFile(join(repo, '.git', 'logs', 'refs', 'heads', ...branch.split('/')));
    expect(await removeWorktree('agent-retry', repo, branch, options)).toMatchObject({ removed: true, warnings: [] });
    expect(await removeWorktree('agent-retry', repo, branch, options)).toMatchObject({ removed: true, warnings: [] });
    const archiveRoot = join(PATHS.cos, 'branch-retirement-archives');
    const archives = await readdir(archiveRoot);
    expect(archives).toHaveLength(1);
    expect(await readFile(join(archiveRoot, archives[0], 'reflog'))).toEqual(reflog);
    await expect(execGit(['bundle', 'verify', join(archiveRoot, archives[0], 'commits.bundle')], repo))
      .resolves.toMatchObject({ exitCode: 0 });
    expect((await execGit(['show-ref', '--verify', `refs/heads/${branch}`], repo, { ignoreExitCode: true })).exitCode).not.toBe(0);
  });
});

describe.skipIf(SKIP_HEAVY_INTEGRATION)('partial removal adoption safety', () => {
  it('preserves a damaged checkout and occupied branch, then permits recovery with ordinary edits', async () => {
    const repo = join(tempRoot, 'partial-source');
    await materializeGitRepo(repo);
    const files = Array.from({ length: 120 }, (_, i) => `tracked-${i}.txt`);
    await Promise.all(files.map(file => writeFile(join(repo, file), 'original\n')));
    await execGit(['add', '.'], repo);
    await execGit(['commit', '-m', 'tracked fixture'], repo);
    await mkdir(PATHS.worktrees, { recursive: true });
    const branch = 'cos/partial/agent-partial';
    const worktree = join(PATHS.worktrees, 'agent-partial');
    const target = join(PATHS.worktrees, 'agent-partial-retry');
    await execGit(['worktree', 'add', '-b', branch, worktree, 'main'], repo);
    await Promise.all(files.slice(0, 105).map(file => rm(join(worktree, file))));
    await writeFile(join(worktree, 'tracked-119.txt'), 'authored edit\n');
    await writeFile(join(worktree, 'draft.txt'), 'authored draft\n');
    const status = (await execGit(['status', '--porcelain'], worktree)).stdout;
    const head = (await execGit(['rev-parse', branch], repo)).stdout;
    const registrations = (await execGit(['worktree', 'list', '--porcelain'], repo)).stdout;

    expect(await adoptWorktree('agent-partial-retry', repo, worktree, branch)).toBeNull();
    expect(existsSync(target)).toBe(false);
    expect((await execGit(['status', '--porcelain'], worktree)).stdout).toBe(status);
    expect((await execGit(['rev-parse', branch], repo)).stdout).toBe(head);
    expect((await execGit(['worktree', 'list', '--porcelain'], repo)).stdout).toBe(registrations);
    // The caller's fresh-tree fallback must fail closed on the still-held branch;
    // it cannot detach the damaged checkout or reset its branch to get unstuck.
    await expect(createWorktree('agent-partial-retry', repo, 'task-partial', { existingBranch: branch }))
      .rejects.toThrow(/already (?:checked out|used by worktree)/);
    expect(existsSync(target)).toBe(false);
    expect((await execGit(['worktree', 'list', '--porcelain'], repo)).stdout).toBe(registrations);
    expect(await readFile(join(worktree, 'draft.txt'), 'utf8')).toBe('authored draft\n');

    // Explicit recovery restores only the simulated accidental deletions. One
    // authored deletion plus the tracked edit and untracked draft still resume.
    await execGit(['restore', '--', ...files.slice(1, 105)], worktree);
    const recoveredStatus = (await execGit(['status', '--porcelain'], worktree)).stdout;
    expect(await adoptWorktree('agent-partial-retry', repo, worktree, branch)).toMatchObject({ adopted: true, worktreePath: target });
    expect((await execGit(['status', '--porcelain'], target)).stdout).toBe(recoveredStatus);
    expect(await readFile(join(target, 'tracked-119.txt'), 'utf8')).toBe('authored edit\n');
    expect(await readFile(join(target, 'draft.txt'), 'utf8')).toBe('authored draft\n');
  });
});
