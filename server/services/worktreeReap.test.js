/**
 * Integration tests for merge-verified worktree reaping.
 *
 * These exercise REAL git (in a throwaway temp repo) rather than mirroring the
 * logic inline, because the squash-merge detection in hasBranchMergeEvidence relies
 * on git's own `commit-tree` + `cherry` patch-id behavior — a hand-mirrored copy
 * wouldn't catch git-version quirks, and that detection is the safety gate the
 * reaper trusts before deleting anything.
 *
 * Repos are copied from the shared `gitTestRepo.js` template. The whole file
 * is excluded from `npm run test:fast` (`VITEST_FAST=1`).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, readdir, mkdir, chmod, lstat, readlink, utimes, rename } from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { execGit } from '../lib/execGit.js';
import {
  materializeGitRepo,
  resetGitSandbox,
  resetGitWorktreeSandbox,
  SKIP_HEAVY_INTEGRATION,
} from '../lib/gitTestRepo.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
vi.mock('../lib/paths.js', async importOriginal => makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-reap-archives-') }));
afterAll(cleanupTempDataRoots);
import { PATHS } from '../lib/paths.js';
import { PATHS as FILE_PATHS } from '../lib/fileUtils.js';
import { preserveBranchRetirement } from '../lib/branchRetirementArchive.js';
import { hasBranchMergeEvidence, getStatus, getStatusPorcelain } from './git.js';
import { reapMergedWorktrees, cleanupOrphanedWorktrees, deleteCompletedLocalBranch, readWorktreeStatus } from './worktreeManager.js';
vi.mock('./branchCompletionPolicy.js', () => ({ readBranchCompletionHold: async () => null }));
vi.mock('./cosState.js', () => ({ readAgentsStateForSafetyCheck: async () => ({ trusted: true, agents: {} }) }));
const archiveGate = vi.hoisted(() => ({ beforeArchive: null }));
vi.mock('./heldCheckoutRecovery.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, preserveMergedCheckout: async (...args) => {
    await archiveGate.beforeArchive?.();
    return actual.preserveMergedCheckout(...args);
  } };
});
import { withClaimOwnershipLock, checkoutRetirementFenceReason } from './cosClaimOwnershipState.js';

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

// Reading metadata excludes atime, which a filesystem may update on reads.
async function snapshotTree(root) {
  const rows = [];
  const walk = async (path, relative) => {
    const info = await lstat(path, { bigint: true });
    rows.push({ path: relative, mode: info.mode, ino: info.ino, mtime: info.mtimeNs, ctime: info.ctimeNs,
      content: info.isFile() ? createHash('sha256').update(await readFile(path)).digest('hex')
        : info.isSymbolicLink() ? await readlink(path) : null });
    if (info.isDirectory()) {
      for (const child of (await readdir(path)).sort()) await walk(join(path, child), `${relative}/${child}`);
    }
  };
  await walk(root, '');
  return rows;
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

describe.skipIf(SKIP_HEAVY_INTEGRATION)('local completed ref retirement', () => {
  let dir;
  beforeEach(async () => { ({ dir } = await initRepo()); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  it('uses an exact-head lease and native holder refusal for a late attachment', async () => {
    await execGit(['branch', 'done'], dir);
    const head = (await execGit(['rev-parse', 'done'], dir)).stdout.trim();
    const path = join(dir, 'late-holder');
    await execGit(['worktree', 'add', path, 'done'], dir);
    expect(await deleteCompletedLocalBranch(dir, 'done', head)).toBe(false);
    expect((await execGit(['rev-parse', 'done'], dir)).stdout.trim()).toBe(head);
    await execGit(['worktree', 'remove', path], dir);
    expect(await deleteCompletedLocalBranch(dir, 'done', head)).toBe(true);
  });

  it('retains a branch that advanced after the merge proof', async () => {
    await execGit(['branch', 'done'], dir);
    const head = (await execGit(['rev-parse', 'done'], dir)).stdout.trim();
    await commitFile(dir, 'new.txt', 'new work', 'new work');
    const advanced = (await execGit(['rev-parse', 'HEAD'], dir)).stdout.trim();
    await execGit(['update-ref', 'refs/heads/done', advanced, head], dir);
    expect(await deleteCompletedLocalBranch(dir, 'done', head)).toBe(false);
    expect((await execGit(['rev-parse', 'done'], dir)).stdout.trim()).toBe(advanced);
  });

  it('retains protected and custom default refs even without holders', async () => {
    await execGit(['branch', 'release'], dir);
    await execGit(['branch', 'trunk'], dir);
    const head = (await execGit(['rev-parse', 'HEAD'], dir)).stdout.trim();
    await execGit(['update-ref', 'refs/remotes/origin/trunk', head], dir);
    await execGit(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk'], dir);
    for (const branch of ['release', 'trunk']) {
      expect(await deleteCompletedLocalBranch(dir, branch, head)).toBe(false);
      expect((await execGit(['rev-parse', branch], dir)).stdout.trim()).toBe(head);
    }
  });

  it('retains a ref when the repository default cannot be established', async () => {
    await execGit(['branch', '-m', 'main', 'trunk'], dir);
    await execGit(['branch', 'done'], dir);
    const head = (await execGit(['rev-parse', 'done'], dir)).stdout.trim();
    expect(await deleteCompletedLocalBranch(dir, 'done', head)).toBe(false);
    expect((await execGit(['rev-parse', 'done'], dir)).stdout.trim()).toBe(head);
  });

  it('preserves the full shared branch reflog and orphaned historical commit objects without a checkout', async () => {
    await execGit(['checkout', '-b', 'done'], dir);
    await commitFile(dir, 'history.txt', 'original evidence', 'original commit');
    const original = (await execGit(['rev-parse', 'HEAD'], dir)).stdout.trim();
    await writeFile(join(dir, 'history.txt'), 'amended evidence');
    await execGit(['add', 'history.txt'], dir);
    await execGit(['commit', '--amend', '-m', 'amended commit'], dir);
    const head = (await execGit(['rev-parse', 'HEAD'], dir)).stdout.trim();
    await execGit(['checkout', 'main'], dir);
    const common = (await execGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir)).stdout.trim();
    const reflog = join(common, 'logs', 'refs', 'heads', 'done');
    const evidence = await readFile(reflog);
    expect(await deleteCompletedLocalBranch(dir, 'done', head)).toBe(true);
    expect(existsSync(reflog)).toBe(false);
    const archiveRoot = join(PATHS.cos, 'branch-retirement-archives');
    const archives = await Promise.all((await readdir(archiveRoot)).map(async id => ({
      path: join(archiveRoot, id), manifest: JSON.parse(await readFile(join(archiveRoot, id, 'manifest.json'), 'utf8')),
    })));
    const archive = archives.find(entry => entry.manifest.repoPath === dir && entry.manifest.expectedHead === head);
    expect(archive).toBeDefined();
    expect(await readFile(join(archive.path, 'reflog'))).toEqual(evidence);
    expect(archive.manifest.recoveryHeads).toEqual(expect.arrayContaining([original, head]));
    const restored = join(dir, 'restored.git');
    await execGit(['init', '--bare', restored], dir);
    await execGit(['--git-dir', restored, 'fetch', join(archive.path, 'commits.bundle'), '+refs/*:refs/*'], dir);
    expect((await execGit(['--git-dir', restored, 'show', `${original}:history.txt`], dir)).stdout).toBe('original evidence');
    expect((await execGit(['--git-dir', restored, 'show', `${head}:history.txt`], dir)).stdout).toBe('amended evidence');
  });

  it('retains the branch when a reflog recovery object is missing', async () => {
    await execGit(['branch', 'done'], dir);
    const head = (await execGit(['rev-parse', 'done'], dir)).stdout.trim();
    const common = (await execGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir)).stdout.trim();
    const log = join(common, 'logs', 'refs', 'heads', 'done');
    await writeFile(log, `${'b'.repeat(40)} ${head} Test <test@example.com> 1 +0000\tmissing historical object\n`);
    expect(await deleteCompletedLocalBranch(dir, 'done', head)).toBe(false);
    expect((await execGit(['rev-parse', 'done'], dir)).stdout.trim()).toBe(head);
    expect(await readFile(log, 'utf8')).toContain('missing historical object');
  });

  it('refuses a changed shared reflog even when the branch tip is unchanged', async () => {
    await execGit(['branch', 'done'], dir);
    const head = (await execGit(['rev-parse', 'done'], dir)).stdout.trim();
    const common = (await execGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir)).stdout.trim();
    const preserved = await preserveBranchRetirement(dir, common, 'done', head);
    expect(await preserved.verify()).toBe(true);
    const log = join(common, 'logs', 'refs', 'heads', 'done');
    await writeFile(log, `${await readFile(log, 'utf8')}${head} ${head} Test <test@example.com> 1 +0000\tnew recovery evidence\n`);
    expect(await preserved.verify()).toBe(false);
    expect((await execGit(['rev-parse', 'done'], dir)).stdout.trim()).toBe(head);
  });

  it.each(['reflog', 'commits.bundle', 'manifest.json'])('refuses an archive whose %s changes before retirement', async name => {
    await execGit(['branch', 'done'], dir);
    const head = (await execGit(['rev-parse', 'done'], dir)).stdout.trim();
    const common = (await execGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir)).stdout.trim();
    const preserved = await preserveBranchRetirement(dir, common, 'done', head);
    await writeFile(join(preserved.archiveDir, name), 'changed after archival');
    expect(await preserved.verify()).toBe(false);
    expect((await execGit(['rev-parse', 'done'], dir)).stdout.trim()).toBe(head);
  });

  it('holds the branch on archive storage failure', async () => {
    await execGit(['branch', 'done'], dir);
    const head = (await execGit(['rev-parse', 'done'], dir)).stdout.trim();
    const common = (await execGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir)).stdout.trim();
    const blocked = join(dir, 'not-a-directory');
    await writeFile(blocked, 'keep');
    await expect(preserveBranchRetirement(dir, common, 'done', head, { cosDir: blocked })).rejects.toThrow();
    expect((await execGit(['rev-parse', 'done'], dir)).stdout.trim()).toBe(head);
  });

  it('preserves the repository receiver deletion policy', async () => {
    await execGit(['branch', 'done'], dir);
    const head = (await execGit(['rev-parse', 'done'], dir)).stdout.trim();
    await execGit(['config', 'receive.denyDeletes', 'true'], dir);
    expect(await deleteCompletedLocalBranch(dir, 'done', head)).toBe(false);
    expect((await execGit(['rev-parse', 'done'], dir)).stdout.trim()).toBe(head);
  });
});

describe.skipIf(SKIP_HEAVY_INTEGRATION)('hasBranchMergeEvidence', () => {
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
  afterAll(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  it('detects a normal (--no-ff) merge', async () => {
    await execGit(['checkout', '-b', 'feat'], dir);
    await commitFile(dir, 'feat.txt', 'work\n', 'feat work');
    await execGit(['checkout', 'main'], dir);
    await execGit(['merge', '--no-ff', 'feat', '--no-edit'], dir);

    expect(await hasBranchMergeEvidence(dir, 'feat', 'main')).toBe(true);
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

    const before = await snapshotTree(dir);
    const ownedScratch = await mkdtemp(join(tmpdir(), 'portos-probe-observe-'));
    const useTemp = path => {
      for (const key of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(key, path);
    };
    try {
      useTemp(ownedScratch);
      expect(await Promise.all(Array.from({ length: 3 }, () => hasBranchMergeEvidence(dir, 'squashed', 'main'))))
        .toEqual([true, true, true]);
      expect(await snapshotTree(dir)).toEqual(before);
      expect((await readdir(ownedScratch)).filter(name => name.startsWith('portos-merge-probe-'))).toEqual([]);

      // Allocation and post-allocation Git failures must not establish evidence,
      // leak scratch, or fall back to writing synthetic objects in the real repo.
      useTemp(join(dir, 'missing-temp-root'));
      expect(await hasBranchMergeEvidence(dir, 'squashed', 'main')).toBe(false);
      useTemp(ownedScratch);
      vi.stubEnv('GIT_AUTHOR_NAME', '');
      expect(await hasBranchMergeEvidence(dir, 'squashed', 'main')).toBe(false);
      expect(await snapshotTree(dir)).toEqual(before);
      expect((await readdir(ownedScratch)).filter(name => name.startsWith('portos-merge-probe-'))).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      await rm(ownedScratch, { recursive: true, force: true });
    }
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

    expect(await hasBranchMergeEvidence(dir, 'rebased', 'main')).toBe(true);
  });

  it('returns false for an unmerged branch with unique work', async () => {
    await execGit(['checkout', '-b', 'pending'], dir);
    await commitFile(dir, 'pending.txt', 'wip\n', 'wip');
    await execGit(['checkout', 'main'], dir);

    expect(await hasBranchMergeEvidence(dir, 'pending', 'main')).toBe(false);
  });

  it('returns false for missing refs and self-comparison', async () => {
    expect(await hasBranchMergeEvidence(dir, 'nope', 'main')).toBe(false);
    expect(await hasBranchMergeEvidence(dir, 'main', 'nope')).toBe(false);
    expect(await hasBranchMergeEvidence(dir, 'main', 'main')).toBe(false);
  });
});

describe.skipIf(SKIP_HEAVY_INTEGRATION)('read-only inspection of initialized linked checkouts', () => {
  let root;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    root = null;
  });

  it('keeps private indexes and directories unchanged while reporting fresh parent/submodule dirt', async () => {
    root = await mkdtemp(join(tmpdir(), 'portos-status-readonly-'));
    const repo = join(root, process.platform === 'win32' ? 'repo space;name' : 'repo space:quoted"name');
    const moduleRepo = join(root, 'module');
    const checkout = join(root, 'linked');
    await materializeGitRepo(repo);
    await materializeGitRepo(moduleRepo);
    await execGit(['-c', 'protocol.file.allow=always', 'submodule', 'add', moduleRepo, 'lib/module'], repo);
    await execGit(['commit', '-am', 'add fixture module'], repo);
    await execGit(['checkout', '-b', 'squashed'], repo);
    await commitFile(repo, 'first.txt', 'one\n', 'first');
    await commitFile(repo, 'second.txt', 'two\n', 'second');
    await execGit(['checkout', 'main'], repo);
    await execGit(['merge', '--squash', 'squashed'], repo);
    await execGit(['commit', '-m', 'combined'], repo);
    await execGit(['worktree', 'add', '--detach', checkout, 'squashed'], repo);
    await execGit(['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init'], checkout);
    const admin = (await execGit(['rev-parse', '--absolute-git-dir'], checkout)).stdout.trim();
    const moduleAdmin = (await execGit(['rev-parse', '--absolute-git-dir'], join(checkout, 'lib/module'))).stdout.trim();
    const sharedObjects = join(root, 'shared objects');
    const alternate = join(root, 'alternate objects');
    await rename(join(repo, '.git/objects'), sharedObjects);
    await mkdir(join(repo, '.git/objects/info'), { recursive: true });
    await mkdir(join(alternate, 'info'), { recursive: true });
    await writeFile(join(repo, '.git/objects/info/alternates'), `${alternate}\n`);
    await writeFile(join(alternate, 'info/alternates'), `${sharedObjects}\n`);
    const files = [join(checkout, 'initial.txt'), join(checkout, 'lib/module/initial.txt')];

    // Reproduce why an apparently read-only status can change preservation
    // evidence: stale stat caches are refreshed through index.lock by default.
    for (const file of files) await utimes(file, new Date('2001-01-01'), new Date('2001-01-01'));
    const indexesBefore = await Promise.all([admin, moduleAdmin].map(path => readFile(join(path, 'index'))));
    await execGit(['status', '--porcelain', '--ignore-submodules=none'], checkout,
      { env: { ...process.env, GIT_OPTIONAL_LOCKS: '1' } });
    const indexesAfter = await Promise.all([admin, moduleAdmin].map(path => readFile(join(path, 'index'))));
    for (let i = 0; i < indexesBefore.length; i++) expect(indexesAfter[i]).not.toEqual(indexesBefore[i]);

    for (const file of files) await utimes(file, new Date('2002-01-01'), new Date('2002-01-01'));
    const before = await snapshotTree(root);
    expect((await getStatus(checkout)).clean).toBe(true);
    expect(await getStatusPorcelain(checkout)).toBe('');
    expect(await readWorktreeStatus(checkout)).toBe('');
    try {
      vi.stubEnv('GIT_OBJECT_DIRECTORY', join(moduleAdmin, 'objects'));
      expect(await hasBranchMergeEvidence(checkout, 'squashed', 'main')).toBe(true);
    } finally { vi.unstubAllEnvs(); }
    expect(await snapshotTree(root)).toEqual(before);

    await writeFile(files[0], 'changed parent\n');
    await writeFile(files[1], 'changed module\n');
    await writeFile(join(checkout, 'untracked.txt'), 'preserve me\n');
    const dirtyBefore = await snapshotTree(root);
    const status = await getStatus(checkout);
    expect(status.clean).toBe(false);
    expect(status.files.map(file => file.path)).toEqual(expect.arrayContaining(['initial.txt', 'lib/module', 'untracked.txt']));
    for (const result of [await getStatusPorcelain(checkout), await readWorktreeStatus(checkout)]) {
      expect(result).toContain(' M initial.txt');
      expect(result).toContain(' M lib/module');
      expect(result).toContain('?? untracked.txt');
    }
    expect(await snapshotTree(root)).toEqual(dirtyBefore);
  });
});

describe.skipIf(SKIP_HEAVY_INTEGRATION)('reapMergedWorktrees', () => {
  let dir;
  let safePath;
  // One root OUTSIDE the repo for the managed-root refusal case, torn down
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
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(externalRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

  // #12682: the archive ran inside the shared ownership lock and starved every
  // claim-ownership check queued behind it.
  it('archives with the ownership queue free while fencing only the reaped checkout', async () => {
    const mergedPath = await addWorktree(dir, 'fenced', 'fenced-br');
    await execGit(['merge', '--no-ff', 'fenced-br', '--no-edit'], dir);
    let started;
    let resume;
    const archiving = new Promise(resolve => { started = resolve; });
    archiveGate.beforeArchive = () => new Promise(resolve => { resume = resolve; started(); });
    try {
      const reaping = reapMergedWorktrees(dir, { includeClaudeTrees: true });
      await archiving;
      expect(await withClaimOwnershipLock(() => 'settled')).toBe('settled');
      expect(checkoutRetirementFenceReason({ repoPath: dir, branch: 'fenced-br' })).toBe('checkout-retirement-reserved');
      expect(checkoutRetirementFenceReason({ repoPath: dir, branch: 'unrelated-br' })).toBe(null);
      resume();
      expect((await reaping).reaped.map(r => r.branch)).toContain('fenced-br');
    } finally {
      archiveGate.beforeArchive = null;
    }
    expect(existsSync(mergedPath)).toBe(false);
    expect(checkoutRetirementFenceReason({ repoPath: dir, branch: 'fenced-br' })).toBe(null);
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

  // A checkout git cannot remove (here: its parent directory is read-only) is not a
  // reap — it must not be counted, and its branch must not be deleted out from
  // under the surviving checkout (#9909).
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'holds a merged worktree whose removal fails instead of counting it as reaped',
    async () => {
      const path = await addWorktree(dir, 'stuck', 'stuck-br');
      await execGit(['merge', '--no-ff', 'stuck-br', '--no-edit'], dir);
      await chmod(claudeRoot(dir), 0o555);

      let result;
      try {
        result = await reapMergedWorktrees(dir, { includeClaudeTrees: true });
      } finally {
        await chmod(claudeRoot(dir), 0o755);
      }

      expect(result.reaped.map(r => r.branch)).not.toContain('stuck-br');
      // Git removed its registration before failing to remove the directory.
      // The fallback cannot prove the surviving directory is still our holder.
      expect(skipReason(result, path)).toBe('worktree-holder-changed');
      expect(result.skipped.find(entry => entry.path === path).warning).toMatch(/cleanup incomplete/);
      expect(existsSync(path)).toBe(true);
      const branches = (await execGit(['branch', '--format=%(refname:short)'], dir)).stdout.trim().split('\n');
      expect(branches).toContain('stuck-br');
    },
  );

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

  it('preserves a merged worktree outside the managed roots', async () => {
    const path = await addExternalWorktree(dir, 'loose', 'loose-br');
    await execGit(['merge', '--no-ff', 'loose-br', '--no-edit'], dir);

    const result = await reapMergedWorktrees(dir, { includeClaudeTrees: true });
    // A bare `expected undefined` says the path matched no skip entry but not
    // why; this reproduces only on Windows, so the CI log is the sole place to
    // read it.
    const context = () => [
      `wanted path = ${JSON.stringify(path)}`,
      `skipped = ${JSON.stringify(result.skipped)}`,
      `reaped = ${JSON.stringify(result.reaped)}`,
    ].join('\n');
    expect(result.reaped.map(r => r.branch), context()).not.toContain('loose-br');
    expect(skipReason(result, path), context()).toBe('worktree-unmanaged-location');
    expect(existsSync(path)).toBe(true);
  });

  // A registration git already considers prunable used to fail `git status` in a
  // missing cwd and be skipped, pinning its branch behind a directory that no
  // longer exists — the "clean merged" action could then never clear it.
  it('reaps a merged branch whose worktree directory is already gone', async () => {
    const path = await addWorktree(dir, 'vanished', 'vanished-br');
    await execGit(['merge', '--no-ff', 'vanished-br', '--no-edit'], dir);
    await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

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

  // gh-pages is a publishing branch. Both sweeps used to copy the protected
  // list and drop it, so a clean merged checkout was archived and removed.
  // The disposable sibling is the same shape on an unprotected name, so a
  // sweep that protected every branch would fail here too.
  it('holds a merged + clean gh-pages worktree in both reapers', async () => {
    const pagesPath = await addWorktree(dir, 'pages', 'gh-pages');
    const disposablePath = await addWorktree(dir, 'disposable', 'disposable-br');
    await execGit(['merge', '--no-ff', 'gh-pages', '--no-edit'], dir);
    await execGit(['merge', '--no-ff', 'disposable-br', '--no-edit'], dir);

    const reaped = await reapMergedWorktrees(dir, { includeClaudeTrees: true });
    expect(reaped.reaped.map(r => r.branch)).not.toContain('gh-pages');
    expect(skipReason(reaped, pagesPath)).toBe('protected');
    expect(existsSync(pagesPath)).toBe(true);
    expect(reaped.reaped.map(r => r.branch)).toContain('disposable-br');
    expect(existsSync(disposablePath)).toBe(false);

    // cleanupExternalRepoWorktrees only admits agent-* dirs under the shared
    // worktrees root, and that root must be the temp one both PATHS see.
    expect(PATHS.worktrees).toContain('portos-reap-archives-');
    expect(FILE_PATHS.worktrees).toBe(PATHS.worktrees);
    const managedApp = join(externalRoot, 'managed-app');
    await materializeGitRepo(managedApp, { identity: { email: 'test@example.com', name: 'Test' } });
    await mkdir(PATHS.worktrees, { recursive: true });
    const externalPages = join(PATHS.worktrees, 'agent-pages');
    const externalDisposable = join(PATHS.worktrees, 'agent-disposable');
    try {
      await execGit(['worktree', 'add', '-b', 'gh-pages', externalPages, 'main'], managedApp);
      await execGit(['worktree', 'add', '-b', 'disposable-br', externalDisposable, 'main'], managedApp);
      await commitFile(externalPages, 'pages.txt', 'pages\n', 'pages work');
      await commitFile(externalDisposable, 'disposable.txt', 'disposable\n', 'disposable work');
      await execGit(['merge', '--no-ff', 'gh-pages', '--no-edit'], managedApp);
      await execGit(['merge', '--no-ff', 'disposable-br', '--no-edit'], managedApp);

      const cleaned = await cleanupOrphanedWorktrees(dir, new Set(), { claimOwners: { agents: [] } });
      expect(cleaned).toBe(1);
      expect(existsSync(externalPages)).toBe(true);
      expect((await execGit(['show-ref', '--verify', 'refs/heads/gh-pages'], managedApp, { ignoreExitCode: true })).exitCode).toBe(0);
      expect(existsSync(externalDisposable)).toBe(false);
      expect((await execGit(['show-ref', '--verify', 'refs/heads/disposable-br'], managedApp, { ignoreExitCode: true })).exitCode).not.toBe(0);
    } finally {
      await rm(PATHS.worktrees, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(managedApp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
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
