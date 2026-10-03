/** Real separate-repository fixtures for the public scheduled cleanup consumer. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, realpathSync } from 'fs';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join, relative } from 'path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { materializeGitRepo, resetGitWorktreeSandbox, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';
import { PATHS } from '../lib/fileUtils.js';
import { execGit } from '../lib/execGit.js';
import { cleanupOrphanedWorktrees } from './worktreeManager.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-external-cleanup-'),
}));
const fault = vi.hoisted(() => ({ command: null, cwd: null, successfulMatches: 0, calls: [] }));
vi.mock('../lib/execGit.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execGit: async (args, cwd, options) => {
    fault.calls.push({ args, cwd });
    if (args[0] === fault.command && (!fault.cwd || cwd === fault.cwd)) {
      if (fault.successfulMatches > 0) {
        fault.successfulMatches--;
        return actual.execGit(args, cwd, options);
      }
      if (options?.ignoreExitCode) return { stdout: '', stderr: 'fixture read failure', exitCode: 1 };
      throw new Error('fixture read failure');
    }
    return actual.execGit(args, cwd, options);
  } };
});

const root = () => realpathSync(lazyTempDataRoot('portos-external-cleanup-'));
let primary;
let external;
let initialHead;
async function addTree(name, { committed = false, detached = false } = {}) {
  const path = join(PATHS.worktrees, name);
  await execGit(['worktree', 'add', ...(detached ? ['--detach'] : ['-b', name]), path, 'main'], external);
  if (committed) {
    await writeFile(join(path, 'recovery.txt'), `recover ${name}\n`);
    await execGit(['add', '.'], path);
    await execGit(['commit', '-m', 'fixture recovery work'], path);
  }
  return path;
}
async function branchExists(branch) {
  return (await execGit(['show-ref', '--verify', `refs/heads/${branch}`], external, { ignoreExitCode: true })).exitCode === 0;
}

describe.skipIf(SKIP_HEAVY_INTEGRATION)('external orphan cleanup recovery policy', () => {
  beforeAll(async () => {
    primary = join(root(), 'primary');
    external = join(root(), 'managed-app');
    await materializeGitRepo(primary);
    await materializeGitRepo(external);
    await mkdir(PATHS.worktrees, { recursive: true });
    initialHead = (await execGit(['rev-parse', 'HEAD'], external)).stdout.trim();
  });
  beforeEach(async () => {
    fault.command = null;
    fault.cwd = null;
    fault.successfulMatches = 0;
    await resetGitWorktreeSandbox(external, initialHead);
    await rm(PATHS.worktrees, { recursive: true, force: true });
    await mkdir(PATHS.worktrees, { recursive: true });
    fault.calls = [];
  });
  afterAll(cleanupTempDataRoots);

  it('retains dirty, unmerged, locked, detached, active, human and non-agent work while reclaiming merged clean work', async () => {
    const dirty = await addTree('agent-dirty');
    await writeFile(join(dirty, 'private-recovery.txt'), 'dirty recovery\n');
    const unmerged = await addTree('agent-unmerged', { committed: true });
    const locked = await addTree('agent-locked');
    await writeFile(join(locked, 'private-recovery.txt'), 'locked recovery\n');
    await execGit(['worktree', 'lock', locked], external);
    const detached = await addTree('agent-detached', { detached: true });
    const active = await addTree('agent-active');
    const human = await addTree('claim-issue-42');
    const nonAgent = await addTree('other-work');
    const merged = await addTree('agent-merged', { committed: true });
    await execGit(['merge', '--no-ff', 'agent-merged', '--no-edit'], external);

    expect(await cleanupOrphanedWorktrees(primary, new Set(['agent-active']))).toBe(1);
    for (const path of [dirty, unmerged, locked, detached, active, human, nonAgent]) expect(existsSync(path)).toBe(true);
    expect(await readFile(join(dirty, 'private-recovery.txt'), 'utf8')).toBe('dirty recovery\n');
    expect(await readFile(join(locked, 'private-recovery.txt'), 'utf8')).toBe('locked recovery\n');
    expect(await branchExists('agent-unmerged')).toBe(true);
    expect(existsSync(merged)).toBe(false);
    expect(await branchExists('agent-merged')).toBe(false);
  });

  it('resolves a relative .git pointer through Git rather than assuming an absolute parent path', async () => {
    const path = await addTree('agent-relative');
    const pointer = (await readFile(join(path, '.git'), 'utf8')).replace(/^gitdir: /, '').trim();
    await writeFile(join(path, '.git'), `gitdir: ${relative(realpathSync(path), pointer)}\n`);
    expect(await cleanupOrphanedWorktrees(primary, new Set())).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  it('retains recovery files when the parent repository disappears or the git pointer is unreadable', async () => {
    const missingParent = join(root(), 'missing-app');
    await materializeGitRepo(missingParent);
    const missing = join(PATHS.worktrees, 'agent-missing-parent');
    await execGit(['worktree', 'add', '-b', 'agent-missing-parent', missing, 'main'], missingParent);
    const unreadable = await addTree('agent-unreadable');
    await writeFile(join(unreadable, '.git'), 'unreadable registration\n');
    await rm(missingParent, { recursive: true, force: true });
    expect(await cleanupOrphanedWorktrees(primary, new Set())).toBe(0);
    expect(existsSync(missing)).toBe(true);
    expect(existsSync(unreadable)).toBe(true);
  });

  it.each(['status', 'rev-parse', 'worktree'])('preserves recovery when the %s read fails', async command => {
    const path = await addTree('agent-read-failure');
    fault.command = command;
    fault.cwd = path;
    expect(await cleanupOrphanedWorktrees(primary, new Set())).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(await branchExists('agent-read-failure')).toBe(true);
  });

  it.each([0, 1])('does not treat failed cherry probe %s with empty stdout as merge evidence', async successfulMatches => {
    const path = await addTree('agent-cherry-failure', { committed: true });
    fault.command = 'cherry';
    fault.successfulMatches = successfulMatches;
    expect(await cleanupOrphanedWorktrees(primary, new Set())).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(await branchExists('agent-cherry-failure')).toBe(true);
  });

  it('never bypasses a Git removal refusal with recursive deletion or branch removal', async () => {
    const path = await addTree('agent-remove-refused');
    fault.command = 'worktree';
    fault.cwd = external;
    expect(await cleanupOrphanedWorktrees(primary, new Set())).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(fault.calls.some(({ args }) => args[0] === 'branch' && args[1] === '-D')).toBe(false);
  });

  it('holds all external agent work when liveness cannot be established', async () => {
    const path = await addTree('agent-unknown-liveness');
    expect(await cleanupOrphanedWorktrees(primary, null)).toBe(0);
    expect(existsSync(path)).toBe(true);
  });
});
