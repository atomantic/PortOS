import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  isGitRepo,
  createDisposableWorktree,
  collectWorktreeDiff,
  removeWorktree,
  applyDiffToLive,
  execGit,
} from './sandbox.js';

// Exercises the disposable-worktree isolation + promotion helpers against a
// real throwaway git repo. These prove the agent's edits land in an isolated
// checkout and only reach the live tree through an explicit validated apply.
describe('git worktree isolation (integration)', () => {
  let repo;
  let scratch;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'autofix-git-'));
    repo = join(scratch, 'repo');
    await mkdir(repo, { recursive: true });
    await execGit(['init', '-q'], repo);
    await execGit(['config', 'user.email', 'test@test'], repo);
    await execGit(['config', 'user.name', 'test'], repo);
    await execGit(['config', 'commit.gpgsign', 'false'], repo);
    await writeFile(join(repo, 'app.js'), 'const x = 1\n');
    await execGit(['add', '-A'], repo);
    await execGit(['commit', '-q', '-m', 'init'], repo);
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  });

  it('detects a git checkout', async () => {
    expect(await isGitRepo(repo)).toBe(true);
    const nonRepo = join(scratch, 'plain');
    await mkdir(nonRepo, { recursive: true });
    expect(await isGitRepo(nonRepo)).toBe(false);
  });

  it('runs an edit in the worktree, collects a diff, and promotes it to live', async () => {
    const wt = await createDisposableWorktree(repo, join(scratch, 'worktrees'), 'sess1');
    expect(wt.error).toBeUndefined();
    expect(wt.path).toBeTruthy();

    // Simulate the agent editing a file INSIDE the isolated worktree.
    await writeFile(join(wt.path, 'app.js'), 'const x = 2\n');

    const diff = await collectWorktreeDiff(wt.path);
    expect(diff).toContain('app.js');
    expect(diff).toContain('+const x = 2');

    // The live checkout is untouched until we explicitly promote.
    expect(await readFile(join(repo, 'app.js'), 'utf8')).toBe('const x = 1\n');

    const applied = await applyDiffToLive(repo, diff, scratch);
    expect(applied.ok).toBe(true);
    expect(await readFile(join(repo, 'app.js'), 'utf8')).toBe('const x = 2\n');

    await removeWorktree(repo, wt.path);
    const list = await execGit(['worktree', 'list'], repo);
    expect(list.stdout).not.toContain('sess1');
  });

  it('discarding the worktree leaves the live checkout unchanged (rollback boundary)', async () => {
    const wt = await createDisposableWorktree(repo, join(scratch, 'worktrees'), 'sess2');
    await writeFile(join(wt.path, 'app.js'), 'const x = 999\n');
    await writeFile(join(wt.path, 'evil.js'), 'rm -rf /\n');
    // Never promote — just discard.
    await removeWorktree(repo, wt.path);
    expect(await readFile(join(repo, 'app.js'), 'utf8')).toBe('const x = 1\n');
    // The new file the agent created never reached the live tree.
    await expect(readFile(join(repo, 'evil.js'), 'utf8')).rejects.toBeTruthy();
  });
});
