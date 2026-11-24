import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir, symlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// Newline-normalizer: git checks files out through core.autocrlf, so a Windows
// working tree holds CRLF whatever the worktree edit wrote. These assertions
// are about promoted content, not the platform's newline style.
const lf = (v) => String(v).split('\r\n').join('\n');
import {
  isGitRepo,
  createDisposableWorktree,
  collectWorktreeDiff,
  validateProposedDiff,
  removeWorktree,
  sweepStaleWorktrees,
  applyDiffToLive,
  execGit,
} from './sandbox.js';
// The autofixer package has no runner of its own — these specs run under the
// server vitest config's '../autofixer/**' glob — and tempPathGuard.js imports
// nothing but node builtins, so reusing it here keeps ONE definition of "is
// this really a throwaway dir" rather than a second copy (#4554).
import { assertTempPath } from '../server/lib/tempPathGuard.js';

// Exercises the disposable-worktree isolation + promotion helpers against a
// real throwaway git repo. These prove the agent's edits land in an isolated
// checkout and only reach the live tree through an explicit validated apply.
describe('git worktree isolation (integration)', () => {
  let repo;
  let scratch;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'autofix-git-'));
    // The 'git config user.email test@test' lines below are what corrupted a
    // real checkout once, so prove the target is disposable before running any
    // of them — never let a bad path fall through to process.cwd() (#4554).
    assertTempPath(scratch, 'autofixer git fixture setup');
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
    assertTempPath(scratch, 'autofixer git fixture teardown');
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  });

  it('sweeps leftover worktrees: removes the directory and unregisters it from the repo', async () => {
    const parent = join(scratch, 'worktrees');
    const wt = await createDisposableWorktree(repo, parent, 'autofixer_leaked_1_abc');
    expect(await execGit(['worktree', 'list', '--porcelain'], repo).then((r) => r.stdout)).toContain('autofixer_leaked_1_abc');

    expect(await sweepStaleWorktrees(parent)).toEqual(['autofixer_leaked_1_abc']);

    await expect(readFile(join(wt.path, 'app.js'), 'utf8')).rejects.toThrow();
    expect(await execGit(['worktree', 'list', '--porcelain'], repo).then((r) => r.stdout)).not.toContain('autofixer_leaked_1_abc');
    expect(await sweepStaleWorktrees(join(scratch, 'missing'))).toEqual([]);
  });

  it('detects a git checkout', async () => {
    expect(await isGitRepo(repo)).toBe(true);
    const nonRepo = join(scratch, 'plain');
    await mkdir(nonRepo, { recursive: true });
    expect(await isGitRepo(nonRepo)).toBe(false);
    // A missing path answers false rather than asking git about process.cwd(),
    // which for this suite is the PortOS checkout itself (#4554).
    expect(await isGitRepo(undefined)).toBe(false);
    expect(await isGitRepo('')).toBe(false);
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
    expect(validateProposedDiff(diff)).toEqual({ ok: true, files: ['app.js'] });

    // The live checkout is untouched until we explicitly promote. Compare
    // newline-normalized: git checks files out through core.autocrlf, so a
    // Windows working tree holds CRLF no matter what the worktree edit wrote.
    expect(lf(await readFile(join(repo, 'app.js'), 'utf8'))).toBe('const x = 1\n');

    const applied = await applyDiffToLive(repo, diff, scratch);
    expect(applied.ok).toBe(true);
    expect(lf(await readFile(join(repo, 'app.js'), 'utf8'))).toBe('const x = 2\n');

    await removeWorktree(repo, wt.path);
    const list = await execGit(['worktree', 'list'], repo);
    expect(list.stdout).not.toContain('sess1');
  });

  it('rejects case-variant forbidden files, symlinks, and non-ASCII/renamed forbidden paths collected from a worktree', async () => {
    // Seed an existing file + symlink in the repo so we test both new and modified symlinks + renames.
    await mkdir(join(repo, 'café'), { recursive: true });
    await writeFile(join(repo, 'café', 'safe.js'), 'const ok = 1;\n');
    await symlink('safe.js', join(repo, 'existing-link'));
    await execGit(['add', '-A'], repo);
    await execGit(['commit', '-q', '-m', 'seed'], repo);

    // 1) Case-variant .Npmrc
    const wtCase = await createDisposableWorktree(repo, join(scratch, 'worktrees'), 'case');
    await writeFile(join(wtCase.path, '.Npmrc'), 'registry=https://evil.example/\n');
    expect(validateProposedDiff(await collectWorktreeDiff(wtCase.path)).ok).toBe(false);
    await removeWorktree(repo, wtCase.path);

    // 2) New symlink and modified existing symlink (mode 120000)
    const wtLink = await createDisposableWorktree(repo, join(scratch, 'worktrees'), 'symlink');
    await symlink('/etc/passwd', join(wtLink.path, 'new-link'));
    expect(validateProposedDiff(await collectWorktreeDiff(wtLink.path)).ok).toBe(false);
    await removeWorktree(repo, wtLink.path);

    const wtModLink = await createDisposableWorktree(repo, join(scratch, 'worktrees'), 'mod-symlink');
    await rm(join(wtModLink.path, 'existing-link'));
    await symlink('/etc/passwd', join(wtModLink.path, 'existing-link'));
    expect(validateProposedDiff(await collectWorktreeDiff(wtModLink.path)).ok).toBe(false);
    await removeWorktree(repo, wtModLink.path);

    // 3) Non-ASCII path + 100%-similarity rename to .npmrc (collected with --no-renames and core.quotePath=false)
    const wtRename = await createDisposableWorktree(repo, join(scratch, 'worktrees'), 'rename');
    await rm(join(wtRename.path, 'café', 'safe.js'));
    await writeFile(join(wtRename.path, 'café', '.npmrc'), 'const ok = 1;\n');
    const renameDiff = await collectWorktreeDiff(wtRename.path);
    expect(validateProposedDiff(renameDiff).ok).toBe(false);
    await removeWorktree(repo, wtRename.path);

    // 4) Legitimate non-ASCII source fix still validates and promotes cleanly
    const wtValid = await createDisposableWorktree(repo, join(scratch, 'worktrees'), 'valid-utf8');
    await writeFile(join(wtValid.path, 'café', 'safe.js'), 'const ok = 2;\n');
    const validDiff = await collectWorktreeDiff(wtValid.path);
    expect(validateProposedDiff(validDiff)).toEqual({ ok: true, files: ['café/safe.js'] });
    expect((await applyDiffToLive(repo, validDiff, scratch)).ok).toBe(true);
    expect(lf(await readFile(join(repo, 'café', 'safe.js'), 'utf8'))).toBe('const ok = 2;\n');
    await removeWorktree(repo, wtValid.path);
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
