import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { execGit } from '../../lib/execGit.js';
import { destroyGitSandbox, makeGitSandbox, SKIP_HEAVY_INTEGRATION } from '../../lib/gitTestRepo.js';
import { createPersistentWorktree, mergeBaseIntoFeatureWorktree, removePersistentWorktree } from './persistent.js';

const { paths } = vi.hoisted(() => ({ paths: {} }));
vi.mock('./paths.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, get WORKTREES_DIR() { return paths.worktrees; } };
});

describe.skipIf(SKIP_HEAVY_INTEGRATION)('persistent feature worktrees', () => {
  const agentId = 'fixture-agent';
  const branch = 'feature/example';
  let sandbox;
  let worktreePath;

  beforeEach(async () => {
    sandbox = await makeGitSandbox({ origin: true });
    paths.worktrees = join(sandbox.scratch, 'worktrees');
    worktreePath = join(sandbox.scratch, 'feature-agents', agentId, 'worktree');
  });

  afterEach(async () => {
    await destroyGitSandbox(sandbox?.scratch);
    sandbox = undefined;
  });

  const create = () => createPersistentWorktree(agentId, sandbox.repo, branch, 'main');
  const remove = () => removePersistentWorktree(agentId, sandbox.repo, branch);
  const merge = () => mergeBaseIntoFeatureWorktree(agentId, 'main');
  const gitText = async (args, cwd = sandbox.repo) => (await execGit(args, cwd)).stdout.trim();
  const hasRef = async (ref, cwd = sandbox.repo) =>
    (await execGit(['rev-parse', '--verify', '--quiet', ref], cwd, { ignoreExitCode: true })).exitCode === 0;
  const upstream = () => gitText(['for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`]);
  const commitEdit = async (cwd, contents) => {
    await writeFile(join(cwd, 'initial.txt'), contents);
    await execGit(['commit', '-am', 'Edit initial file'], cwd);
  };

  it('starts a new branch at the fetched base without tracking it and removes the worktree and branch', async () => {
    await execGit(['config', 'branch.autoSetupMerge', 'always'], sandbox.repo);
    await commitEdit(sandbox.repo, 'updated upstream\n');
    await execGit(['push', 'origin', 'main'], sandbox.repo);
    await execGit(['reset', '--hard', 'HEAD^'], sandbox.repo);

    expect(await create()).toEqual({ worktreePath, branchName: branch, baseBranch: 'main' });
    expect(await gitText(['branch', '--show-current'], worktreePath)).toBe(branch);
    expect(await gitText(['rev-parse', 'HEAD'], worktreePath)).toBe(await gitText(['rev-parse', 'origin/main']));
    expect(await upstream()).toBe('');
    expect((await execGit(['config', '--get', `branch.${branch}.merge`], sandbox.repo, { ignoreExitCode: true })).exitCode).toBe(1);

    await commitEdit(worktreePath, 'unmerged feature edit\n');
    expect(await remove()).toEqual({ removed: true, warnings: [] });
    expect(existsSync(worktreePath)).toBe(false);
    expect(await hasRef(`refs/heads/${branch}`)).toBe(false);
    expect(await gitText(['worktree', 'list', '--porcelain'])).not.toContain(`branch refs/heads/${branch}`);
    expect(await remove()).toEqual({ removed: false });
  });

  it('attaches an existing local branch at its own tip and clears an unsafe base upstream', async () => {
    await commitEdit(sandbox.repo, 'local feature content\n');
    await execGit(['branch', '--track', branch, 'origin/main'], sandbox.repo);
    const localTip = await gitText(['rev-parse', branch]);

    await create();

    expect(await gitText(['branch', '--show-current'], worktreePath)).toBe(branch);
    expect(await gitText(['rev-parse', 'HEAD'], worktreePath)).toBe(localTip);
    expect(await upstream()).toBe('');
  });

  it('attaches a remote-only branch and tracks its matching remote ref', async () => {
    await commitEdit(sandbox.repo, 'remote feature content\n');
    await execGit(['push', 'origin', `HEAD:refs/heads/${branch}`], sandbox.repo);
    expect(await hasRef(`refs/heads/${branch}`)).toBe(false);

    await create();

    expect(await gitText(['branch', '--show-current'], worktreePath)).toBe(branch);
    expect(await gitText(['rev-parse', 'HEAD'], worktreePath)).toBe(await gitText(['rev-parse', `origin/${branch}`]));
    expect(await upstream()).toBe(`origin/${branch}`);
  });

  it('rolls back a new branch when Git refuses an occupied worktree path', async () => {
    await mkdir(worktreePath, { recursive: true });
    const sentinel = join(worktreePath, 'keep.txt');
    await writeFile(sentinel, 'existing content');

    await expect(create()).rejects.toThrow(/already exists/);

    expect(await hasRef(`refs/heads/${branch}`)).toBe(false);
    expect(await gitText(['worktree', 'list', '--porcelain'])).not.toContain(`branch refs/heads/${branch}`);
    expect(await readFile(sentinel, 'utf8')).toBe('existing content');
  });

  it('merges a newer base and aborts a subsequent content conflict', async () => {
    expect(await merge()).toEqual({ merged: false, reason: 'worktree-missing' });
    await create();
    await commitEdit(sandbox.repo, 'first upstream edit\n');
    await execGit(['push', 'origin', 'main'], sandbox.repo);
    expect(await merge()).toEqual({ merged: true });
    expect(await readFile(join(worktreePath, 'initial.txt'), 'utf8')).toBe('first upstream edit\n');

    await commitEdit(worktreePath, 'feature edit\n');
    const featureTip = await gitText(['rev-parse', 'HEAD'], worktreePath);
    await commitEdit(sandbox.repo, 'conflicting upstream edit\n');
    await execGit(['push', 'origin', 'main'], sandbox.repo);

    expect(await merge()).toEqual({ merged: false, reason: expect.any(String) });
    expect(await hasRef('MERGE_HEAD', worktreePath)).toBe(false);
    expect(await gitText(['status', '--porcelain'], worktreePath)).toBe('');
    expect(await gitText(['rev-parse', 'HEAD'], worktreePath)).toBe(featureTip);
    expect(await readFile(join(worktreePath, 'initial.txt'), 'utf8')).toBe('feature edit\n');
  });
});
