/**
 * Integration tests for merge-verified worktree reaping.
 *
 * These exercise REAL git (in a throwaway temp repo) rather than mirroring the
 * logic inline, because the squash-merge detection in isBranchMergedInto relies
 * on git's own `commit-tree` + `cherry` patch-id behavior — a hand-mirrored copy
 * wouldn't catch git-version quirks, and that detection is the safety gate the
 * reaper trusts before deleting anything.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execGit } from '../lib/execGit.js';
import { isBranchMergedInto } from './git.js';
import { reapMergedWorktrees } from './worktreeManager.js';

async function commitFile(dir, name, content, message) {
  await writeFile(join(dir, name), content);
  await execGit(['add', '.'], dir);
  await execGit(['commit', '-m', message], dir);
}

async function initRepo() {
  // realpath-resolve: on macOS mkdtemp returns a /var symlink while
  // `git worktree list` records the canonical /private/var path, which would
  // break the reaper's startsWith() location checks and our path assertions.
  const dir = realpathSync(await mkdtemp(join(tmpdir(), 'portos-reap-')));
  await execGit(['init', '-b', 'main'], dir);
  await execGit(['config', 'user.email', 'test@example.com'], dir);
  await execGit(['config', 'user.name', 'Test'], dir);
  await execGit(['config', 'commit.gpgsign', 'false'], dir);
  await commitFile(dir, 'base.txt', 'base\n', 'base');
  return dir;
}

describe('isBranchMergedInto', () => {
  let dir;
  beforeEach(async () => { dir = await initRepo(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('detects a normal (--no-ff) merge', async () => {
    await execGit(['checkout', '-b', 'feat'], dir);
    await commitFile(dir, 'feat.txt', 'work\n', 'feat work');
    await execGit(['checkout', 'main'], dir);
    await execGit(['merge', '--no-ff', 'feat', '--no-edit'], dir);

    expect(await isBranchMergedInto(dir, 'feat', 'main')).toBe(true);
  });

  it('detects a squash merge (branch tip is NOT an ancestor)', async () => {
    await execGit(['checkout', '-b', 'squashed'], dir);
    await commitFile(dir, 's1.txt', 'one\n', 'commit one');
    await commitFile(dir, 's2.txt', 'two\n', 'commit two');
    await execGit(['checkout', 'main'], dir);
    await execGit(['merge', '--squash', 'squashed'], dir);
    await execGit(['commit', '-m', 'squashed work'], dir);

    // Sanity: the original tip is genuinely not reachable from main.
    const ancestor = await execGit(['merge-base', '--is-ancestor', 'squashed', 'main'], dir, { ignoreExitCode: true });
    expect(ancestor.exitCode).not.toBe(0);

    expect(await isBranchMergedInto(dir, 'squashed', 'main')).toBe(true);
  });

  it('detects a multi-commit rebase merge after the target branch advanced', async () => {
    await execGit(['checkout', '-b', 'rebased'], dir);
    await commitFile(dir, 'r1.txt', 'one\n', 'rebase commit one');
    await commitFile(dir, 'r2.txt', 'two\n', 'rebase commit two');

    const firstCommit = (await execGit(['rev-parse', 'rebased~1'], dir)).stdout.trim();
    const secondCommit = (await execGit(['rev-parse', 'rebased'], dir)).stdout.trim();

    await execGit(['checkout', 'main'], dir);
    await commitFile(dir, 'target-advanced.txt', 'advanced\n', 'target advanced');
    await execGit(['cherry-pick', firstCommit], dir);
    await execGit(['cherry-pick', secondCommit], dir);

    const ancestor = await execGit(['merge-base', '--is-ancestor', 'rebased', 'main'], dir, { ignoreExitCode: true });
    expect(ancestor.exitCode).not.toBe(0);

    expect(await isBranchMergedInto(dir, 'rebased', 'main')).toBe(true);
  });

  it('returns false for an unmerged branch with unique work', async () => {
    await execGit(['checkout', '-b', 'pending'], dir);
    await commitFile(dir, 'pending.txt', 'wip\n', 'wip');
    await execGit(['checkout', 'main'], dir);

    expect(await isBranchMergedInto(dir, 'pending', 'main')).toBe(false);
  });

  it('returns false for missing refs and self-comparison', async () => {
    expect(await isBranchMergedInto(dir, 'nope', 'main')).toBe(false);
    expect(await isBranchMergedInto(dir, 'main', 'nope')).toBe(false);
    expect(await isBranchMergedInto(dir, 'main', 'main')).toBe(false);
  });
});

describe('reapMergedWorktrees', () => {
  let dir;
  beforeEach(async () => { dir = await initRepo(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  // The reaper only considers trees under WORKTREES_DIR (the real CoS data dir)
  // or <repo>/.claude/worktrees — so the test trees live under .claude/worktrees.
  const claudeRoot = (d) => join(d, '.claude', 'worktrees');

  async function addWorktree(d, name, branch, { commit = true, base = 'main' } = {}) {
    const path = join(claudeRoot(d), name);
    await mkdir(claudeRoot(d), { recursive: true });
    await execGit(['worktree', 'add', '-b', branch, path, base], d);
    if (commit) await commitFile(path, `${name}.txt`, `${name}\n`, `${name} work`);
    return path;
  }

  it('reaps a merged + clean worktree (and its branch) but preserves an unmerged one', async () => {
    const mergedPath = await addWorktree(dir, 'merged', 'merged-br');
    const unmergedPath = await addWorktree(dir, 'pending', 'pending-br');

    // Merge only the first branch into main.
    await execGit(['merge', '--no-ff', 'merged-br', '--no-edit'], dir);

    const result = await reapMergedWorktrees(dir, { includeClaudeTrees: true });

    expect(result.reaped.map(r => r.branch)).toContain('merged-br');
    expect(result.reaped.map(r => r.branch)).not.toContain('pending-br');
    expect(result.skipped.find(s => s.path === unmergedPath)?.reason).toBe('unmerged');

    expect(existsSync(mergedPath)).toBe(false);
    expect(existsSync(unmergedPath)).toBe(true);

    const branches = (await execGit(['branch', '--format=%(refname:short)'], dir)).stdout.trim().split('\n');
    expect(branches).not.toContain('merged-br');
    expect(branches).toContain('pending-br');
  });

  it('preserves a merged worktree that has uncommitted changes', async () => {
    const path = await addWorktree(dir, 'dirty', 'dirty-br');
    await execGit(['merge', '--no-ff', 'dirty-br', '--no-edit'], dir);
    // Introduce a real (non-lockfile) uncommitted change in the worktree.
    await writeFile(join(path, 'scratch.txt'), 'unsaved\n');

    const result = await reapMergedWorktrees(dir, { includeClaudeTrees: true });

    expect(result.reaped.map(r => r.branch)).not.toContain('dirty-br');
    expect(result.skipped.find(s => s.path === path)?.reason).toBe('uncommitted');
    expect(existsSync(path)).toBe(true);
  });

  it('preserves a fresh-from-main worktree with uncommitted changes', async () => {
    const path = await addWorktree(dir, 'not-started', 'not-started-br', { commit: false });
    await writeFile(join(path, 'scratch.txt'), 'unsaved\n');

    const result = await reapMergedWorktrees(dir, { includeClaudeTrees: true });

    expect(result.reaped.map(r => r.branch)).not.toContain('not-started-br');
    expect(result.skipped.find(s => s.path === path)?.reason).toBe('uncommitted');
    expect(existsSync(path)).toBe(true);
  });

  it('preserves a merged worktree with lockfile-only uncommitted changes', async () => {
    const path = await addWorktree(dir, 'lockfile-dirty', 'lockfile-dirty-br');
    await execGit(['merge', '--no-ff', 'lockfile-dirty-br', '--no-edit'], dir);
    await writeFile(join(path, 'package-lock.json'), '{}\n');

    const result = await reapMergedWorktrees(dir, { includeClaudeTrees: true });

    expect(result.reaped.map(r => r.branch)).not.toContain('lockfile-dirty-br');
    expect(result.skipped.find(s => s.path === path)?.reason).toBe('uncommitted');
    expect(existsSync(path)).toBe(true);
  });

  it('preserves a locked merged worktree', async () => {
    const path = await addWorktree(dir, 'locked', 'locked-br');
    await execGit(['merge', '--no-ff', 'locked-br', '--no-edit'], dir);
    await execGit(['worktree', 'lock', path], dir);

    const result = await reapMergedWorktrees(dir, { includeClaudeTrees: true });

    expect(result.reaped.map(r => r.branch)).not.toContain('locked-br');
    expect(result.skipped.find(s => s.path === path)?.reason).toBe('locked');
    expect(existsSync(path)).toBe(true);
  });

  it('skips active agents and never touches the primary worktree', async () => {
    const path = await addWorktree(dir, 'agent-active', 'active-br');
    await execGit(['merge', '--no-ff', 'active-br', '--no-edit'], dir);

    const result = await reapMergedWorktrees(dir, {
      includeClaudeTrees: true,
      activeAgentIds: new Set(['agent-active'])
    });

    expect(result.reaped.map(r => r.branch)).not.toContain('active-br');
    expect(result.skipped.find(s => s.path === path)?.reason).toBe('active-agent');
    expect(existsSync(path)).toBe(true);
    // The main repo checkout is never reported as reaped or skipped-with-branch.
    expect(result.reaped.find(r => r.branch === 'main')).toBeUndefined();
  });

  it('does not delete in dryRun mode', async () => {
    const path = await addWorktree(dir, 'dry', 'dry-br');
    await execGit(['merge', '--no-ff', 'dry-br', '--no-edit'], dir);

    const result = await reapMergedWorktrees(dir, { includeClaudeTrees: true, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.reaped.map(r => r.branch)).toContain('dry-br');
    expect(existsSync(path)).toBe(true);
    const branches = (await execGit(['branch', '--format=%(refname:short)'], dir)).stdout.trim().split('\n');
    expect(branches).toContain('dry-br');
  });

  it('excludes .claude trees when includeClaudeTrees is false', async () => {
    const path = await addWorktree(dir, 'excluded', 'excluded-br');
    await execGit(['merge', '--no-ff', 'excluded-br', '--no-edit'], dir);

    const result = await reapMergedWorktrees(dir, { includeClaudeTrees: false });

    expect(result.reaped.map(r => r.branch)).not.toContain('excluded-br');
    expect(result.skipped.find(s => s.path === path)?.reason).toBe('claude-tree-excluded');
    expect(existsSync(path)).toBe(true);
  });
});
