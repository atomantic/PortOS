/** Real separate-repository fixtures for the public scheduled cleanup consumer. */
// test-memo: git-fixture — git only ever runs in repositories this suite creates under the temp directory (docs/TEST_MEMO_GIT_FIXTURES.md).
// Git/filesystem are synthetic in this suite; real durable admission has its own boundary tests.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { mkdir, open, readFile, rm, symlink, unlink, writeFile } from 'fs/promises';
import { join, relative } from 'path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { materializeGitRepo, resetGitWorktreeSandbox, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';
import { PATHS } from '../lib/fileUtils.js';
import { execGit } from '../lib/execGit.js';
import { cleanupOrphanedWorktrees } from './worktreeManager.js';
import { createTestPhaseDiagnostics } from '../../lib/testPhaseDiagnostics.js';


vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, realpathSync: Object.assign(
    path => fault.pathAlias && (path === fault.aliasTarget || path === fault.pathAlias) ? path : actual.realpathSync(path),
    { native: actual.realpathSync.native },
  ) };
});

vi.mock('../lib/fileUtils.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-external-cleanup-'),
}));
// Shared branch reflog archives import the leaf paths module directly.
vi.mock('../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-external-cleanup-'),
}));
const fault = vi.hoisted(() => ({ command: null, subcommand: null, cwd: null, successfulMatches: 0, pathAlias: null, aliasTarget: null, registrationPath: null, onGit: null, calls: [] }));
vi.mock('../lib/execGit.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execGit: async (args, cwd, options) => {
    fault.calls.push({ args, cwd });
    fault.onGit?.(args, cwd);
    if (args[0] === fault.command && (!fault.subcommand || args[1] === fault.subcommand) && (!fault.cwd || cwd === fault.cwd)) {
      if (fault.successfulMatches > 0) {
        fault.successfulMatches--;
        return actual.execGit(args, cwd, options);
      }
      if (options?.ignoreExitCode) return { stdout: '', stderr: 'fixture read failure', exitCode: 1 };
      throw new Error('fixture read failure');
    }
    const result = await actual.execGit(args, cwd, options);
    // Model Git's expanded path spelling where Node retains a filesystem alias
    // (Windows 8.3 paths). Both names address the same real disposable checkout.
    if (fault.pathAlias && args[0] === 'worktree' && args[1] === 'list') {
      result.stdout = result.stdout.replaceAll(fault.registrationPath.replace(/\\/g, '/'), fault.pathAlias.replace(/\\/g, '/'));
    }
    if (fault.pathAlias && cwd === fault.aliasTarget && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      result.stdout = fault.pathAlias.replace(/\\/g, '/') + '\n';
    }
    return result;
  } };
});

const root = () => realpathSync(lazyTempDataRoot('portos-external-cleanup-'));
// An empty agent registry; omitting it reads this sandbox's missing state.json,
// which fails closed and holds every tree.
const NO_OWNERS = { claimOwners: { agents: [] } };
let primary;
let external;
let initialHead;
// Per-test phase evidence (quiet unless the test fails). Only the relative-pointer case
// labels its steps; the reset phase times the shared sandbox setup it depends on.
let phase;
async function addTree(name, { committed = false, detached = false, branch = name } = {}) {
  const path = join(PATHS.worktrees, name);
  await execGit(['worktree', 'add', ...(detached ? ['--detach'] : ['-b', branch]), path, 'main'], external);
  if (committed) {
    await writeFile(join(path, 'recovery.txt'), `recover ${name}\n`);
    await execGit(['add', '.'], path);
    await execGit(['commit', '-m', 'fixture recovery work'], path);
  }
  return path;
}
// Git marks .git pointers hidden on Windows. Reopening with "w" can fail even
// when the file is writable; "r+" edits the existing file without recreating it.
async function rewriteGitPointer(worktreePath, content) {
  const handle = await open(join(worktreePath, '.git'), 'r+');
  try {
    await handle.writeFile(content);
    await handle.truncate(Buffer.byteLength(content));
  } finally {
    await handle.close();
  }
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
  beforeEach(async ({ onTestFailed }) => {
    phase = createTestPhaseDiagnostics(onTestFailed);
    fault.command = null;
    fault.subcommand = null;
    fault.cwd = null;
    fault.successfulMatches = 0;
    fault.pathAlias = null;
    fault.aliasTarget = null;
    fault.registrationPath = null;
    fault.onGit = null;
    await phase('reset-sandbox', async () => {
      await resetGitWorktreeSandbox(external, initialHead);
      await rm(PATHS.worktrees, { recursive: true, force: true });
      await mkdir(PATHS.worktrees, { recursive: true });
    });
    // Retirement reads durable completion policy independently of the supplied
    // owner snapshot. Missing state is unknown, not a known-empty registry.
    await writeFile(join(PATHS.cos, 'state.json'), JSON.stringify({ agents: {} }));
    fault.calls = [];
  });
  // Join fixture-owned work a timed-out test abandoned before its temp root is removed.
  afterEach(async () => { await phase.settle(); });
  afterAll(cleanupTempDataRoots);

  // Every other hold (detached, active, human, non-agent, protected, unknown liveness)
  // is a pure case in branchRetirementDecision.test.js; this keeps one real
  // retire next to the destructive holds that need a real tree to be destructive.
  it('retains dirty, unmerged and locked work while reclaiming merged clean work', async () => {
    const dirty = await addTree('agent-dirty');
    await writeFile(join(dirty, 'private-recovery.txt'), 'dirty recovery\n');
    const unmerged = await addTree('agent-unmerged', { committed: true });
    const locked = await addTree('agent-locked');
    await writeFile(join(locked, 'private-recovery.txt'), 'locked recovery\n');
    await execGit(['worktree', 'lock', locked], external);
    const merged = await addTree('agent-merged', { committed: true });
    await execGit(['merge', '--no-ff', 'agent-merged', '--no-edit'], external);
    const log = vi.spyOn(console, 'log');

    expect(await cleanupOrphanedWorktrees(primary, new Set(), NO_OWNERS)).toBe(1);
    // The removal names the checkout and the evidence that admitted it (#16618).
    const removals = log.mock.calls.map(([line]) => String(line)).filter(line => line.includes('Removed external worktree'));
    log.mockRestore();
    expect(removals).toEqual([expect.stringMatching(/^🌳 Removed external worktree .*agent-merged \(branch agent-merged @ [0-9a-f]{12}, repo .*\): branch head contained in /)]);
    for (const path of [dirty, unmerged, locked]) expect(existsSync(path)).toBe(true);
    expect(await readFile(join(dirty, 'private-recovery.txt'), 'utf8')).toBe('dirty recovery\n');
    expect(await readFile(join(locked, 'private-recovery.txt'), 'utf8')).toBe('locked recovery\n');
    expect(await branchExists('agent-unmerged')).toBe(true);
    expect(existsSync(merged)).toBe(false);
    expect(await branchExists('agent-merged')).toBe(false);
  });

  // #16618: the sweep reads only the shared worktrees root, so a fresh `/do:next` sibling
  // claim (zero own commits, clean, contained in main by ancestry) of either repository
  // is never a candidate, whatever its merge evidence.
  it('never considers a fresh sibling claim checkout outside the worktrees root', async () => {
    const siblings = [[primary, 'next-issue-1'], [external, 'next-issue-2']].map(([repo, name]) => ({ repo, name, path: join(root(), name) }));
    for (const { repo, name, path } of siblings) await execGit(['worktree', 'add', '-b', `next/${name}`, path, 'main'], repo);
    try {
      expect(await cleanupOrphanedWorktrees(primary, new Set(), NO_OWNERS)).toBe(0);
      for (const { repo, name, path } of siblings) {
        expect(existsSync(join(path, '.git'))).toBe(true);
        expect((await execGit(['show-ref', '--verify', `refs/heads/next/${name}`], repo, { ignoreExitCode: true })).exitCode).toBe(0);
      }
    } finally {
      for (const { repo, path } of siblings) await execGit(['worktree', 'remove', '--force', path], repo, { ignoreExitCode: true });
    }
  });

  it('matches Git registration spelling when Node retains another alias for the same checkout', async () => {
    const path = await addTree('agent-path-alias');
    const aliasRoot = join(root(), 'git-spelling');
    await mkdir(aliasRoot, { recursive: true });
    const alias = join(aliasRoot, 'agent-path-alias');
    await symlink(path, alias, 'junction');
    fault.registrationPath = (await execGit(['rev-parse', '--show-toplevel'], path)).stdout.trim();
    fault.aliasTarget = path;
    fault.pathAlias = alias;
    expect(await cleanupOrphanedWorktrees(primary, new Set(), NO_OWNERS)).toBe(1);
    expect(existsSync(path)).toBe(false);
    expect(await branchExists('agent-path-alias')).toBe(false);
    await unlink(alias);
  });

  // One tree for two Git-native contracts: Git (not the .git file's spelling)
  // locates the parent, and ignored output is discarded with a merged checkout.
  it('resolves a relative .git pointer through Git and discards ignored files with a merged checkout', async () => {
    const path = await phase('setup-worktree', () => addTree('agent-relative', { committed: true }));
    await execGit(['merge', '--no-ff', 'agent-relative', '--no-edit'], external);
    await writeFile(join(external, '.git', 'info', 'exclude'), '*.png\n');
    await writeFile(join(path, 'reference.png'), 'generated image');
    await phase('rewrite-pointer', async () => {
      const pointer = (await readFile(join(path, '.git'), 'utf8')).replace(/^gitdir: /, '').trim();
      await rewriteGitPointer(path, `gitdir: ${relative(realpathSync(path), pointer)}\n`);
    });
    expect(await phase('cleanup-resolution', () => cleanupOrphanedWorktrees(primary, new Set(), NO_OWNERS))).toBe(1);
    await phase('verify-removal', async () => {
      expect(existsSync(path)).toBe(false);
      expect(await branchExists('agent-relative')).toBe(false);
    });
  });

  it('retains recovery files when the parent repository disappears or the git pointer is unreadable', async () => {
    const missingParent = join(root(), 'missing-app');
    await materializeGitRepo(missingParent);
    const missing = join(PATHS.worktrees, 'agent-missing-parent');
    await execGit(['worktree', 'add', '-b', 'agent-missing-parent', missing, 'main'], missingParent);
    const unreadable = await addTree('agent-unreadable');
    await rewriteGitPointer(unreadable, 'unreadable registration\n');
    await rm(missingParent, { recursive: true, force: true });
    expect(await cleanupOrphanedWorktrees(primary, new Set(), NO_OWNERS)).toBe(0);
    expect(existsSync(missing)).toBe(true);
    expect(existsSync(unreadable)).toBe(true);
  });

  it('preserves recovery when the status read fails', async () => {
    const path = await addTree('agent-read-failure');
    fault.command = 'status';
    fault.cwd = path;
    expect(await cleanupOrphanedWorktrees(primary, new Set(), NO_OWNERS)).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(await branchExists('agent-read-failure')).toBe(true);
  });

  it('does not treat a failed cherry probe with empty stdout as merge evidence', async () => {
    const path = await addTree('agent-cherry-failure', { committed: true });
    fault.command = 'cherry';
    expect(await cleanupOrphanedWorktrees(primary, new Set(), NO_OWNERS)).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(await branchExists('agent-cherry-failure')).toBe(true);
  });

  it('never bypasses a Git removal refusal with recursive deletion or branch removal', async () => {
    const path = await addTree('agent-remove-refused');
    // Match the Git operation, not the cwd: cleanup runs it from the path Git
    // itself reports for the parent repo, whose spelling differs on Windows.
    fault.command = 'worktree';
    fault.subcommand = 'remove';
    expect(await cleanupOrphanedWorktrees(primary, new Set(), NO_OWNERS)).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(fault.calls.some(({ args }) => args[0] === 'branch' && args[1] === '-D')).toBe(false);
  });

  it('keeps the worktree and branch of an agent dispatched while the pass is inspecting its tree', async () => {
    const path = await addTree('agent-dispatched');
    const live = new Set();
    // Registration lands after every pre-lock ownership read — while the pass
    // reads the tree's status (#11858) — so only the in-lock re-read can see it.
    fault.onGit = (args, cwd) => { if (args[0] === 'status' && cwd === path) live.add('agent-dispatched'); };
    expect(await cleanupOrphanedWorktrees(primary, () => new Set(live), NO_OWNERS)).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(await branchExists('agent-dispatched')).toBe(true);
  });

  it('keeps a checkout whose head moved while the pass was inspecting it', async () => {
    const path = await addTree('agent-moved-head', { committed: true });
    await execGit(['merge', '--no-ff', 'agent-moved-head', '--no-edit'], external);
    // Fires on the ownership section's registration read of the parent, after the
    // scan listed (and admitted) the old head, so only that fresh read sees the new one.
    let moved = false;
    let scanned = false;
    fault.onGit = (args) => {
      if (args[0] === 'merge-base') scanned = true;
      if (moved || !scanned || args[0] !== 'worktree' || args[1] !== 'list') return;
      moved = true;
      execFileSync('git', ['commit', '--allow-empty', '-m', 'late agent work'], { cwd: path });
    };
    expect(await cleanupOrphanedWorktrees(primary, new Set(), NO_OWNERS)).toBe(0);
    expect(moved).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(await branchExists('agent-moved-head')).toBe(true);
  });

  it('keeps a worktree a registered agent works in even when live liveness omits it', async () => {
    const path = await addTree('agent-registered');
    const owners = { claimOwners: { agents: [{ id: 'agent-registered', status: 'running', workspacePath: path, sourceWorkspace: external }] } };
    expect(await cleanupOrphanedWorktrees(primary, () => new Set(), owners)).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(await branchExists('agent-registered')).toBe(true);
  });

  it('retains merged work when durable completion policy is unreadable despite an empty owner snapshot', async () => {
    const path = await addTree('agent-policy-unreadable');
    // Agent records are cos_agents rows (#12738); the agent index is the durable policy input left on disk.
    await mkdir(join(PATHS.cos, 'agents'), { recursive: true });
    await writeFile(join(PATHS.cos, 'agents', 'index.json'), '{');
    expect(await cleanupOrphanedWorktrees(primary, new Set(), NO_OWNERS)).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(await branchExists('agent-policy-unreadable')).toBe(true);
  });
});
