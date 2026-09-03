/**
 * Integration tests for merge-verified worktree reaping.
 *
 * These exercise REAL git (in a throwaway temp repo) rather than mirroring the
 * logic inline, because the squash-merge detection in isBranchMergedInto relies
 * on git's own `commit-tree` + `cherry` patch-id behavior — a hand-mirrored copy
 * wouldn't catch git-version quirks, and that detection is the safety gate the
 * reaper trusts before deleting anything.
 *
 * Repos are copied from the shared `gitTestRepo.js` template. The whole file
 * is excluded from `npm run test:fast` (`VITEST_FAST=1`).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execGit } from '../lib/execGit.js';
import {
  materializeGitRepo,
  resetGitSandbox,
  resetGitWorktreeSandbox,
  SKIP_HEAVY_INTEGRATION,
} from '../lib/gitTestRepo.js';
import { isBranchMergedInto } from './git.js';
import { reapMergedWorktrees } from './worktreeManager.js';

/**
 * Why `wantedPath` was skipped, matched separator-insensitively — `skipped[].path`
 * is git's POSIX output while these tests build paths with `join()`. See the
 * WORKTREES_DIR comment in worktreeManager.js for the full failure mode.
 */
function skipReason(result, wantedPath) {
  const posix = (p) => (p || '').replace(/\\/g, '/');
  return result.skipped.find((s) => posix(s.path) === posix(wantedPath))?.reason;
}

async function commitFile(dir, name, content, message) {
  await writeFile(join(dir, name), content);
  await execGit(['add', '.'], dir);
  await execGit(['commit', '-m', message], dir);
}

/**
 * @returns {Promise<{dir: string, safePath: string}>} `dir` is the repo root
 *   spelled the way git itself reports it — needed for the reaper's own
 *   `startsWith()` location checks and our path assertions (see below).
 *   `safePath` is the plain `mkdtemp()` path, still in whatever spelling
 *   `os.tmpdir()` uses — pass THIS to resetGitSandbox()/resetGitWorktreeSandbox()'s
 *   `assertTempPath` check, since on Windows it and `dir` can disagree (8.3
 *   short form `RUNNER~1` vs git's long form `runneradmin`) in a way nothing
 *   but git itself can bridge.
 */
async function initRepo() {
  // realpath-resolve: on macOS mkdtemp returns a /var symlink while
  // `git worktree list` records the canonical /private/var path, which would
  // break the reaper's startsWith() location checks and our path assertions.
  const safePath = realpathSync(await mkdtemp(join(tmpdir(), 'portos-reap-')));
  await materializeGitRepo(safePath, { identity: { email: 'test@example.com', name: 'Test' } });
  // Adopt git's spelling of the root. `git worktree list` reports paths the way
  // git normalized them, and the reaper's containment check compares those
  // against a root derived from this value — so any disagreement (8.3 short
  // names like C:\\Users\\RUNNER~1, drive-letter case) makes every worktree look
  // like it lives somewhere unmanaged and nothing is reaped.
  const dir = (await execGit(['rev-parse', '--show-toplevel'], safePath)).stdout.trim() || safePath;
  return { dir, safePath };
}

describe.skipIf(SKIP_HEAVY_INTEGRATION)('isBranchMergedInto', () => {
  let dir;
  let safePath;
  let initialHead;
  // One real repo for the whole describe, reset in place between tests
  // instead of a fresh mkdtemp + materializeGitRepo (fs.cp) + rm per test
  // (#5902) — the slow part on a Windows filesystem is that copy/delete
  // cycle, not the handful of git commands each test runs.
  beforeAll(async () => {
    ({ dir, safePath } = await initRepo());
    initialHead = (await execGit(['rev-parse', 'HEAD'], dir)).stdout.trim();
  });
  beforeEach(async () => { await resetGitSandbox({ repo: dir, initialHead, assertPath: safePath }); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

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

describe.skipIf(SKIP_HEAVY_INTEGRATION)('reapMergedWorktrees', () => {
  let dir;
  let safePath;
  // One root OUTSIDE the repo for the includeUnmanagedTrees cases, torn down
  // alongside the repo so a held tree can't leak out of the run.
  let externalRoot;
  let initialHead;

  // One real repo (and one external root) for the whole describe, reset in
  // place between tests via resetGitWorktreeSandbox() instead of a fresh
  // mkdtemp + materializeGitRepo (fs.cp) + rm per test (#5902) — the reset
  // tears down every `git worktree add` checkout a test grew (including a
  // locked one), wherever it lives, so externalRoot is naturally emptied
  // back out along with dir's own `.claude/worktrees` trees.
  beforeAll(async () => {
    ({ dir, safePath } = await initRepo());
    externalRoot = realpathSync(await mkdtemp(join(tmpdir(), 'portos-reap-ext-')));
    initialHead = (await execGit(['rev-parse', 'HEAD'], dir)).stdout.trim();
  });
  beforeEach(async () => { await resetGitWorktreeSandbox(dir, initialHead, safePath); });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  });

  // The reaper only considers trees under WORKTREES_DIR (the real CoS data dir)
  // or <repo>/.claude/worktrees — so the test trees live under .claude/worktrees.
  const claudeRoot = (d) => join(d, '.claude', 'worktrees');

  /**
   * Adopt git's spelling of a worktree PortOS just created, the same way
   * `initRepo` adopts git's spelling of the repo root, and by the same means:
   * ask git. The reaper reports paths as `git worktree list` recorded them, and
   * on Windows that is the LONG form (`C:/Users/runneradmin/...`) while
   * `mkdtemp` + `realpathSync` hand back the 8.3 short form
   * (`C:\\Users\\RUNNER~1\\...`) — realpath does not expand short names. Comparing
   * the two matched nothing, so `skipReason` returned undefined and the
   * assertion read as "the tree was never held" when it had been held correctly.
   * A string comparison cannot bridge that (no casing rule turns `RUNNER~1` into
   * `runneradmin`); only git can.
   */
  async function gitWorktreePath(worktreePath) {
    const { stdout } = await execGit(['rev-parse', '--show-toplevel'], worktreePath);
    return stdout.trim() || worktreePath;
  }

  /** A worktree in a directory PortOS never created — the unmanaged case. */
  async function addExternalWorktree(d, name, branch) {
    const requested = join(externalRoot, name);
    await execGit(['worktree', 'add', '-b', branch, requested, 'main'], d);
    const path = await gitWorktreePath(requested);
    await commitFile(path, `${name}.txt`, `${name}\n`, `${name} work`);
    return path;
  }

  async function addWorktree(d, name, branch, { commit = true, base = 'main' } = {}) {
    const requested = join(claudeRoot(d), name);
    await mkdir(claudeRoot(d), { recursive: true });
    await execGit(['worktree', 'add', '-b', branch, requested, base], d);
    const path = await gitWorktreePath(requested);
    if (commit) await commitFile(path, `${name}.txt`, `${name}\n`, `${name} work`);
    return path;
  }

  it('reaps a merged + clean worktree (and its branch) but preserves an unmerged one', async () => {
    const mergedPath = await addWorktree(dir, 'merged', 'merged-br');
    const unmergedPath = await addWorktree(dir, 'pending', 'pending-br');

    // Merge only the first branch into main.
    await execGit(['merge', '--no-ff', 'merged-br', '--no-edit'], dir);

    const result = await reapMergedWorktrees(dir, { includeClaudeTrees: true });

    expect(
      result.reaped.map(r => r.branch),
      `nothing reaped; skipped = ${JSON.stringify(result.skipped)}`,
    ).toContain('merged-br');
    expect(result.reaped.map(r => r.branch)).not.toContain('pending-br');
    expect(skipReason(result, unmergedPath)).toBe('unmerged');

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
    expect(skipReason(result, path)).toBe('uncommitted');
    expect(existsSync(path)).toBe(true);
  });

  it('preserves a fresh-from-main worktree with uncommitted changes', async () => {
    const path = await addWorktree(dir, 'not-started', 'not-started-br', { commit: false });
    await writeFile(join(path, 'scratch.txt'), 'unsaved\n');

    const result = await reapMergedWorktrees(dir, { includeClaudeTrees: true });

    expect(result.reaped.map(r => r.branch)).not.toContain('not-started-br');
    expect(skipReason(result, path)).toBe('uncommitted');
    expect(existsSync(path)).toBe(true);
  });

  it('preserves a merged worktree with lockfile-only uncommitted changes', async () => {
    const path = await addWorktree(dir, 'lockfile-dirty', 'lockfile-dirty-br');
    await execGit(['merge', '--no-ff', 'lockfile-dirty-br', '--no-edit'], dir);
    await writeFile(join(path, 'package-lock.json'), '{}\n');

    const result = await reapMergedWorktrees(dir, { includeClaudeTrees: true });

    expect(result.reaped.map(r => r.branch)).not.toContain('lockfile-dirty-br');
    expect(skipReason(result, path)).toBe('uncommitted');
    expect(existsSync(path)).toBe(true);
  });

  it('preserves a locked merged worktree', async () => {
    const path = await addWorktree(dir, 'locked', 'locked-br');
    await execGit(['merge', '--no-ff', 'locked-br', '--no-edit'], dir);
    await execGit(['worktree', 'lock', path], dir);

    const result = await reapMergedWorktrees(dir, { includeClaudeTrees: true });

    expect(result.reaped.map(r => r.branch)).not.toContain('locked-br');
    expect(skipReason(result, path)).toBe('worktree-locked');
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
    expect(skipReason(result, path)).toBe('worktree-active-agent');
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

  // This reaper knows only "merged + clean", which is equally true of a claim a
  // human paused ten minutes ago. Reclaiming one turns on idle time AND on
  // whether the branch was provably shipped — both computed by branchReconcile,
  // not here — so it deliberately passes neither `allowStaleClaim` nor an age
  // and a claim tree is always skipped. Asserted through the real reaper, so a
  // later change to its roots or gate options cannot quietly lose the skip.
  it('never reaps a human /claim worktree, even merged + clean', async () => {
    const claimPath = await addWorktree(dir, 'claim-issue-42', 'claim/issue-42');
    const agentPath = await addWorktree(dir, 'agent-abc12345', 'cos/task-1/agent-abc12345');
    await execGit(['merge', '--no-ff', 'claim/issue-42', '--no-edit'], dir);
    await execGit(['merge', '--no-ff', 'cos/task-1/agent-abc12345', '--no-edit'], dir);

    const result = await reapMergedWorktrees(dir, { includeClaudeTrees: true });

    // The equally merged+clean agent tree IS reaped, so the claim skip is the
    // claim policy and not some unrelated gate refusing both.
    expect(result.reaped.map(r => r.branch)).toContain('cos/task-1/agent-abc12345');
    expect(result.reaped.map(r => r.branch)).not.toContain('claim/issue-42');
    expect(skipReason(result, claimPath)).toBe('worktree-human-claim');
    expect(existsSync(claimPath)).toBe(true);
    expect(existsSync(agentPath)).toBe(false);
  });

  // The user-initiated "clean merged branches" action reaps whatever worktree
  // pins a merged branch, wherever it lives — otherwise the button re-offers the
  // same branch forever. Widening WHERE we look must not widen WHAT we accept,
  // which is why the claim tree below is still held.
  it('reaps an unmanaged-location worktree only when includeUnmanagedTrees is set', async () => {
    const path = await addExternalWorktree(dir, 'loose', 'loose-br');
    await execGit(['merge', '--no-ff', 'loose-br', '--no-edit'], dir);

    const withoutOptIn = await reapMergedWorktrees(dir, { includeClaudeTrees: true });
    // A bare `expected undefined` says the path matched no skip entry but not
    // why; this reproduces only on Windows, so the CI log is the sole place to
    // read it. Same style as the sibling assertion below.
    const context = () => [
      `wanted path = ${JSON.stringify(path)}`,
      `skipped = ${JSON.stringify(withoutOptIn.skipped)}`,
      `reaped = ${JSON.stringify(withoutOptIn.reaped)}`,
    ].join('\n');
    expect(withoutOptIn.reaped.map(r => r.branch), context()).not.toContain('loose-br');
    expect(skipReason(withoutOptIn, path), context()).toBe('worktree-unmanaged-location');
    expect(existsSync(path)).toBe(true);

    const withOptIn = await reapMergedWorktrees(dir, { includeUnmanagedTrees: true });
    expect(
      withOptIn.reaped.map(r => r.branch),
      `nothing reaped; skipped = ${JSON.stringify(withOptIn.skipped)}`,
    ).toContain('loose-br');
    expect(existsSync(path)).toBe(false);
  });

  // Dropping the location check must not drop the claim hold with it.
  it('still refuses a human /claim tree under includeUnmanagedTrees', async () => {
    const claimPath = await addExternalWorktree(dir, 'claim-issue-7', 'claim/issue-7');
    await execGit(['merge', '--no-ff', 'claim/issue-7', '--no-edit'], dir);

    const result = await reapMergedWorktrees(dir, { includeUnmanagedTrees: true });

    expect(result.reaped.map(r => r.branch)).toEqual([]);
    expect(skipReason(result, claimPath)).toBe('worktree-human-claim');
    expect(existsSync(claimPath)).toBe(true);
  });

  // A registration git already considers prunable used to fail `git status` in a
  // missing cwd and be skipped, pinning its branch behind a directory that no
  // longer exists — the "clean merged" action could then never clear it.
  it('reaps a merged branch whose worktree directory is already gone', async () => {
    const path = await addWorktree(dir, 'vanished', 'vanished-br');
    await execGit(['merge', '--no-ff', 'vanished-br', '--no-edit'], dir);
    await rm(path, { recursive: true, force: true });

    const result = await reapMergedWorktrees(dir, { includeClaudeTrees: true });

    expect(
      result.reaped.map(r => r.branch),
      `nothing reaped; skipped = ${JSON.stringify(result.skipped)}`,
    ).toContain('vanished-br');
    const branches = (await execGit(['branch', '--format=%(refname:short)'], dir)).stdout.trim().split('\n');
    expect(branches).not.toContain('vanished-br');
    const listed = (await execGit(['worktree', 'list', '--porcelain'], dir)).stdout;
    expect(listed).not.toContain('vanished');
  });

  it('holds a merged + clean tree whose branch is in excludeBranches', async () => {
    const path = await addWorktree(dir, 'spoken-for', 'spoken-for-br');
    await execGit(['merge', '--no-ff', 'spoken-for-br', '--no-edit'], dir);

    const result = await reapMergedWorktrees(dir, {
      includeClaudeTrees: true,
      excludeBranches: new Set(['spoken-for-br'])
    });

    expect(result.reaped.map(r => r.branch)).not.toContain('spoken-for-br');
    expect(skipReason(result, path)).toBe('protected');
    expect(existsSync(path)).toBe(true);
  });

  it('excludes .claude trees when includeClaudeTrees is false', async () => {
    const path = await addWorktree(dir, 'excluded', 'excluded-br');
    await execGit(['merge', '--no-ff', 'excluded-br', '--no-edit'], dir);

    const result = await reapMergedWorktrees(dir, { includeClaudeTrees: false });

    expect(result.reaped.map(r => r.branch)).not.toContain('excluded-br');
    expect(skipReason(result, path)).toBe('claude-tree-excluded');
    expect(existsSync(path)).toBe(true);
  });
});
