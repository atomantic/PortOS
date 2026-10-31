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
import * as gitExecution from '../lib/execGit.js';
import {
  materializeGitRepo,
  resetGitSandbox,
  resetGitWorktreeSandbox,
  SKIP_HEAVY_INTEGRATION,
} from '../lib/gitTestRepo.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
const lockWriteFault = vi.hoisted(() => ({ path: null }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, open: async (path, ...args) => {
    const handle = await actual.open(path, ...args);
    if (path === lockWriteFault.path) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async bytes => {
        await write(bytes.subarray(0, 8));
        throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' });
      };
    }
    return handle;
  } };
});
vi.mock('../lib/paths.js', async importOriginal => makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-reap-archives-') }));
afterAll(cleanupTempDataRoots);
import { PATHS } from '../lib/paths.js';
import { PATHS as FILE_PATHS } from '../lib/fileUtils.js';
import { hasBranchMergeEvidence, getStatus, getStatusPorcelain } from './git.js';
import { reapMergedWorktrees, cleanupOrphanedWorktrees, deleteCompletedLocalBranch, readWorktreeStatus } from './worktreeManager.js';
vi.mock('./branchCompletionPolicy.js', () => ({ readBranchCompletionHold: async () => null }));
vi.mock('./cosState.js', () => ({ readAgentsStateForSafetyCheck: async () => ({ trusted: true, agents: {} }) }));

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

async function archiveIds() {
  return readdir(join(PATHS.cos, 'branch-retirement-archives')).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
}

const refGone = (repo, branch) => execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo, { ignoreExitCode: true })
  .then(result => result.exitCode !== 0);

describe.skipIf(SKIP_HEAVY_INTEGRATION)('local completed ref retirement', () => {
  let dir;
  beforeEach(async () => { ({ dir } = await initRepo()); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  it('deletes the ref and its settings without an archive, and a reused name does not inherit them', async () => {
    const branch = 'claim/issue-42.topic';
    await execGit(['branch', branch], dir);
    const head = (await execGit(['rev-parse', branch], dir)).stdout.trim();
    await execGit(['remote', 'add', 'origin', '.'], dir);
    await execGit(['update-ref', 'refs/remotes/origin/main', head], dir);
    for (const [key, value] of [
      ['remote', 'origin'], ['merge', 'refs/heads/old'], ['rebase', 'true'],
      ['pushRemote', 'origin'], ['description', 'first line\nsecond line'], ['mergeOptions', '--no-ff'], ['mergeOptions', '--no-edit'],
    ]) await execGit(['config', '--add', `branch.${branch}.${key}`, value], dir);
    await execGit(['config', 'branch.other.remote', 'keep'], dir);
    await execGit(['config', `branch.${branch}.child.remote`, 'also-keep'], dir);
    const before = await archiveIds();
    expect(await deleteCompletedLocalBranch(dir, branch, head)).toBe(true);
    expect(await archiveIds()).toEqual(before);
    expect(await refGone(dir, branch)).toBe(true);
    expect((await execGit(['config', 'branch.other.remote'], dir)).stdout.trim()).toBe('keep');
    expect((await execGit(['config', `branch.${branch}.child.remote`], dir)).stdout.trim()).toBe('also-keep');
    const fresh = join(dir, 'fresh');
    await execGit(['worktree', 'add', '--no-track', '-b', branch, fresh, 'origin/main'], dir);
    expect((await execGit(['config', '--get-regexp', '^branch\\.claim/issue-42\\.topic\\.[^.]+$'], fresh, { ignoreExitCode: true })).exitCode).toBe(1);
    expect((await execGit(['rev-parse', '--verify', '@{upstream}'], fresh, { ignoreExitCode: true })).exitCode).not.toBe(0);
    await execGit(['branch', '--track', 'explicit', 'origin/main'], dir);
    expect((await execGit(['config', 'branch.explicit.merge'], dir)).stdout.trim()).toBe('refs/heads/main');
  });

  it('still deletes the ref when configuration changes before the receiver runs', async () => {
    await execGit(['branch', 'done'], dir);
    await execGit(['config', 'branch.done.remote', 'old'], dir);
    const head = (await execGit(['rev-parse', 'done'], dir)).stdout.trim();
    const before = await archiveIds();
    expect(await deleteCompletedLocalBranch(dir, 'done', head, {
      beforeMutation: () => execGit(['config', 'branch.done.remote', 'new'], dir),
    })).toBe(true);
    expect(await refGone(dir, 'done')).toBe(true);
    expect((await execGit(['config', '--get', 'branch.done.remote'], dir, { ignoreExitCode: true })).exitCode).not.toBe(0);
    expect(await archiveIds()).toEqual(before);
  });

  it('preserves configuration when the receiver recreates the deleted branch at the same head', async () => {
    await execGit(['branch', 'done'], dir);
    await execGit(['config', 'branch.done.remote', 'keep'], dir);
    const head = (await execGit(['rev-parse', 'done'], dir)).stdout.trim();
    const common = (await execGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir)).stdout.trim();
    await writeFile(join(common, 'hooks', 'post-receive'), `#!/bin/sh\ngit update-ref refs/heads/done ${head}\n`, { mode: 0o755 });
    expect(await deleteCompletedLocalBranch(dir, 'done', head)).toBe(false);
    expect((await execGit(['rev-parse', 'done'], dir)).stdout.trim()).toBe(head);
    expect((await execGit(['config', 'branch.done.remote'], dir)).stdout.trim()).toBe('keep');
  });

  it('removes settings a receiver hook appends while deleting the ref', async () => {
    await execGit(['branch', 'done'], dir);
    await execGit(['config', 'branch.done.remote', 'keep'], dir);
    const head = (await execGit(['rev-parse', 'done'], dir)).stdout.trim();
    const common = (await execGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir)).stdout.trim();
    await writeFile(join(common, 'hooks', 'post-receive'), '#!/bin/sh\ncat >> config <<\'EOF\'\n[branch "done"]\nremote = new\nEOF\n', { mode: 0o755 });
    expect(await deleteCompletedLocalBranch(dir, 'done', head)).toBe(true);
    expect(await refGone(dir, 'done')).toBe(true);
    expect((await execGit(['config', '--get', 'branch.done.remote'], dir, { ignoreExitCode: true })).exitCode).not.toBe(0);
  });

  it('deletes the ref without rewriting an included settings file', async () => {
    await execGit(['branch', 'done'], dir);
    const head = (await execGit(['rev-parse', 'done'], dir)).stdout.trim();
    const included = join(dir, 'branch-settings');
    await writeFile(included, '[branch "done"]\n\tremote = keep\n');
    await execGit(['config', 'include.path', included], dir);
    expect(await deleteCompletedLocalBranch(dir, 'done', head)).toBe(true);
    expect(await refGone(dir, 'done')).toBe(true);
    expect(await readFile(included, 'utf8')).toBe('[branch "done"]\n\tremote = keep\n');
  });

  it('retains configuration on an uncertain receiver outcome', async () => {
    await execGit(['branch', 'done'], dir);
    await execGit(['config', 'branch.done.remote', 'keep'], dir);
    const head = (await execGit(['rev-parse', 'done'], dir)).stdout.trim();
    const execute = gitExecution.execGit;
    const receiver = vi.spyOn(gitExecution, 'execGit').mockImplementation((args, ...rest) => args[0] === 'push'
      ? Promise.resolve({ exitCode: null, signal: 'SIGTERM', terminated: true, stdout: '', stderr: '' })
      : execute(args, ...rest));
    try { expect(await deleteCompletedLocalBranch(dir, 'done', head)).toBe(false); }
    finally { receiver.mockRestore(); }
    expect((await execGit(['rev-parse', 'done'], dir)).stdout.trim()).toBe(head);
    expect((await execGit(['config', 'branch.done.remote'], dir)).stdout.trim()).toBe('keep');
  });

  it('deletes the ref without taking an archive lock when config.lock cannot be written by node', async () => {
    await execGit(['branch', 'done'], dir);
    await execGit(['config', 'branch.done.remote', 'keep'], dir);
    const head = (await execGit(['rev-parse', 'done'], dir)).stdout.trim();
    const common = (await execGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir)).stdout.trim();
    const before = await archiveIds();
    lockWriteFault.path = join(common, 'config.lock');
    try { expect(await deleteCompletedLocalBranch(dir, 'done', head)).toBe(true); }
    finally { lockWriteFault.path = null; }
    expect(await refGone(dir, 'done')).toBe(true);
    expect(await archiveIds()).toEqual(before);
  });

  it('deletes the ref even when another writer holds config.lock', async () => {
    await execGit(['branch', 'done'], dir);
    await execGit(['config', 'branch.done.remote', 'keep'], dir);
    const head = (await execGit(['rev-parse', 'done'], dir)).stdout.trim();
    const common = (await execGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir)).stdout.trim();
    const before = await archiveIds();
    await writeFile(join(common, 'config.lock'), 'another writer');
    expect(await deleteCompletedLocalBranch(dir, 'done', head)).toBe(true);
    expect(await refGone(dir, 'done')).toBe(true);
    expect(await archiveIds()).toEqual(before);
  });

  it('lets Git keep the ref when another writer holds its ref lock', async () => {
    await execGit(['branch', 'done'], dir);
    await execGit(['config', 'branch.done.remote', 'keep'], dir);
    const head = (await execGit(['rev-parse', 'done'], dir)).stdout.trim();
    const common = (await execGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir)).stdout.trim();
    await writeFile(join(common, 'refs', 'heads', 'done.lock'), 'another writer');
    expect(await deleteCompletedLocalBranch(dir, 'done', head)).toBe(false);
    expect((await execGit(['rev-parse', 'done'], dir)).stdout.trim()).toBe(head);
    expect((await execGit(['config', 'branch.done.remote'], dir)).stdout.trim()).toBe('keep');
  });

  it('uses an exact-head lease and native holder refusal for a late attachment', async () => {
    await execGit(['branch', 'done'], dir);
    await execGit(['config', 'branch.done.remote', 'keep'], dir);
    const head = (await execGit(['rev-parse', 'done'], dir)).stdout.trim();
    const path = join(dir, 'late-holder');
    await execGit(['worktree', 'add', path, 'done'], dir);
    expect(await deleteCompletedLocalBranch(dir, 'done', head)).toBe(false);
    expect((await execGit(['rev-parse', 'done'], dir)).stdout.trim()).toBe(head);
    expect((await execGit(['config', 'branch.done.remote'], dir)).stdout.trim()).toBe('keep');
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

  it('deletes the branch and its reflog without an archive', async () => {
    await execGit(['checkout', '-b', 'done'], dir);
    await commitFile(dir, 'history.txt', 'original evidence', 'original commit');
    await writeFile(join(dir, 'history.txt'), 'amended evidence');
    await execGit(['add', 'history.txt'], dir);
    await execGit(['commit', '--amend', '-m', 'amended commit'], dir);
    const head = (await execGit(['rev-parse', 'HEAD'], dir)).stdout.trim();
    await execGit(['checkout', 'main'], dir);
    const common = (await execGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir)).stdout.trim();
    const reflog = join(common, 'logs', 'refs', 'heads', 'done');
    expect(existsSync(reflog)).toBe(true);
    const before = await archiveIds();
    expect(await deleteCompletedLocalBranch(dir, 'done', head)).toBe(true);
    expect(existsSync(reflog)).toBe(false);
    expect(await refGone(dir, 'done')).toBe(true);
    expect(await archiveIds()).toEqual(before);
  });

  it('deletes the branch even when a reflog entry names a missing object', async () => {
    await execGit(['branch', 'done'], dir);
    const head = (await execGit(['rev-parse', 'done'], dir)).stdout.trim();
    const common = (await execGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir)).stdout.trim();
    const log = join(common, 'logs', 'refs', 'heads', 'done');
    await writeFile(log, `${'b'.repeat(40)} ${head} Test <test@example.com> 1 +0000\tmissing historical object\n`);
    const before = await archiveIds();
    expect(await deleteCompletedLocalBranch(dir, 'done', head)).toBe(true);
    expect(await refGone(dir, 'done')).toBe(true);
    expect(await archiveIds()).toEqual(before);
  });

  it('preserves the repository receiver deletion policy', async () => {
    await execGit(['branch', 'done'], dir);
    await execGit(['config', 'branch.done.remote', 'keep'], dir);
    const head = (await execGit(['rev-parse', 'done'], dir)).stdout.trim();
    await execGit(['config', 'receive.denyDeletes', 'true'], dir);
    expect(await deleteCompletedLocalBranch(dir, 'done', head)).toBe(false);
    expect((await execGit(['rev-parse', 'done'], dir)).stdout.trim()).toBe(head);
    expect((await execGit(['config', 'branch.done.remote'], dir)).stdout.trim()).toBe('keep');
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

  it('reaps a merged checkout together with its ignored files', async () => {
    const mergedPath = await addWorktree(dir, 'ignored-output', 'ignored-output-br');
    await execGit(['merge', '--no-ff', 'ignored-output-br', '--no-edit'], dir);
    await writeFile(join(dir, '.git', 'info', 'exclude'), '*.png\n');
    await writeFile(join(mergedPath, 'reference.png'), 'generated image');
    const reaped = await reapMergedWorktrees(dir, { includeClaudeTrees: true });
    expect(reaped.reaped.map(r => r.branch), JSON.stringify(reaped.skipped)).toContain('ignored-output-br');
    expect(existsSync(mergedPath)).toBe(false);
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
  it('holds a merged + clean gh-pages worktree in local reaping', async () => {
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
  });

  // Keep the two public cleanup boundaries independently bounded without
  // combining both real-Git workflows under one test's 30-second budget.
  it('holds a merged + clean gh-pages worktree in external cleanup', async () => {
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
