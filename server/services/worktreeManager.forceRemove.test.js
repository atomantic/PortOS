import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, rm, writeFile, lstat, mkdir } from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { materializeGitRepo, resetGitWorktreeSandbox, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';

// Failure injection over REAL git and a REAL filesystem: a test opts one Git
// call into rejecting or acquiring a real lock before executing it. The
// assertions then look at the surviving directory and registration, not at the
// order the mocks were called in.
const injected = vi.hoisted(() => ({ gitFails: () => false }));
vi.mock('../lib/execGit.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    execGit: vi.fn(async (args, ...rest) => (await injected.gitFails(args)
      ? Promise.reject(new Error(`injected git failure: ${args.slice(0, 2).join(' ')}`))
      : actual.execGit(args, ...rest))),
  };
});

import { execGit } from '../lib/execGit.js';
import { forceRemoveWorktreeDir, WORKTREE_ADD_TIMEOUT_MS } from './worktreeManager.js';

describe.skipIf(SKIP_HEAVY_INTEGRATION)('forceRemoveWorktreeDir', () => {
  let repo;
  let safePath;
  let initialHead;
  let n = 0;

  beforeAll(async () => {
    safePath = realpathSync(await mkdtemp(join(tmpdir(), 'portos-force-remove-')));
    await materializeGitRepo(safePath, { identity: { email: 'test@example.com', name: 'Test' } });
    repo = (await execGit(['rev-parse', '--show-toplevel'], safePath)).stdout.trim() || safePath;
    initialHead = (await execGit(['rev-parse', 'HEAD'], repo)).stdout.trim();
  });
  beforeEach(async () => {
    injected.gitFails = () => false;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await resetGitWorktreeSandbox(repo, initialHead, safePath);
  });
  afterAll(async () => {
    await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  async function addWorktree() {
    const path = join(repo, '.claude', 'worktrees', `wt-${++n}`);
    await mkdir(join(repo, '.claude', 'worktrees'), { recursive: true });
    await execGit(['worktree', 'add', '-b', `br-${n}`, path, 'main'], repo);
    return (await execGit(['rev-parse', '--show-toplevel'], path)).stdout.trim() || path;
  }
  const registered = async (path) =>
    (await execGit(['worktree', 'list', '--porcelain'], repo)).stdout.split(/\r?\n/)
      .some(line => line.startsWith('worktree ') && line.slice(9).replace(/\\/g, '/') === path.replace(/\\/g, '/'));

  it('removes a clean worktree and verifies both its directory and registration are gone', async () => {
    const path = await addWorktree();
    const outcome = await forceRemoveWorktreeDir(repo, path, { verifyRemoval: async () => null });
    expect(outcome).toMatchObject({ removed: true, directory: 'absent', registration: 'absent', warning: null });
    expect(execGit).toHaveBeenCalledWith(
      ['worktree', 'remove', path, '--force'], repo, { timeout: WORKTREE_ADD_TIMEOUT_MS }
    );
    expect(existsSync(path)).toBe(false);
    expect(await registered(path)).toBe(false);
  });

  it('reports an already-removed directory with a stale registration as removed once pruned', async () => {
    const path = await addWorktree();
    await rm(path, { recursive: true, force: true });
    expect(await registered(path)).toBe(true);
    const outcome = await forceRemoveWorktreeDir(repo, path);
    expect(outcome.removed).toBe(true);
    expect(await registered(path)).toBe(false);
  });

  it('treats an already-clean state (no directory, no registration) as removed', async () => {
    const path = await addWorktree();
    await forceRemoveWorktreeDir(repo, path);
    expect((await forceRemoveWorktreeDir(repo, path)).removed).toBe(true);
  });

  it.each([false, true])('preserves surviving contents after Git refusal even with a fresh guard (%s)', async (guarded) => {
    const path = await addWorktree();
    await writeFile(join(path, 'keep.txt'), 'still here\n');
    injected.gitFails = (args) => args[0] === 'worktree' && args[1] === 'remove';

    const outcome = await forceRemoveWorktreeDir(repo, path, { label: 'test cleanup', ...(guarded ? { verifyRemoval: async () => null } : {}) });

    expect(outcome).toMatchObject({ removed: false, directory: 'present', registration: 'registered' });
    expect(outcome.warning).toMatch(/cleanup incomplete/);
    expect(outcome.warning).toContain(path);
    expect(outcome.warning).toMatch(/directory still present/);
    expect(outcome.warning).toMatch(/registration still registered/);
    expect(outcome.warning).toMatch(/retryable/);
    expect(outcome.reason).toBe('worktree-removal-refused');
    // The checkout genuinely survived — the report is not a guess.
    expect(existsSync(join(path, 'keep.txt'))).toBe(true);
    expect(await registered(path)).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('cleanup incomplete'));
  });

  // Callers retire only merged deliveries or throwaway checkouts: ignored files go with them.
  it('discards ignored files with the checkout', async () => {
    const path = await addWorktree();
    await writeFile(join(repo, '.git', 'info', 'exclude'), '*.png\n');
    const outcome = await forceRemoveWorktreeDir(repo, path, {
      beforeMutation: () => writeFile(join(path, 'reference.png'), 'generated image'),
    });
    expect(outcome.removed).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(await registered(path)).toBe(false);
  });

  it('preserves a locked directory and registration', async () => {
    const path = await addWorktree();
    await execGit(['worktree', 'lock', path], repo);
    const outcome = await forceRemoveWorktreeDir(repo, path);
    expect(outcome).toMatchObject({ removed: false, directory: 'present', registration: 'registered', reason: 'worktree-locked' });
    expect(existsSync(path)).toBe(true);
    expect(await registered(path)).toBe(true);
  });

  it('preserves a lock acquired during the fallback ownership check', async () => {
    const path = await addWorktree();
    await writeFile(join(path, 'keep.txt'), 'preserve\n');
    injected.gitFails = (args) => args[0] === 'worktree' && args[1] === 'remove';
    let checks = 0;
    const outcome = await forceRemoveWorktreeDir(repo, path, { verifyRemoval: async () => {
      if (++checks === 2) await execGit(['worktree', 'lock', path], repo);
      return null;
    } });
    expect(outcome).toMatchObject({ removed: false, reason: 'worktree-locked' });
    expect(existsSync(join(path, 'keep.txt'))).toBe(true);
    expect(await registered(path)).toBe(true);
  });

  it('lets Git protect a lock acquired after the final safety read', async () => {
    const path = await addWorktree();
    injected.gitFails = async args => {
      if (args[0] === 'worktree' && args[1] === 'remove') await execGit(['worktree', 'lock', path], repo);
      return false;
    };
    const outcome = await forceRemoveWorktreeDir(repo, path, { verifyRemoval: async () => null });
    expect(outcome).toMatchObject({ removed: false, reason: 'worktree-locked' });
    expect(existsSync(path)).toBe(true);
    expect(await registered(path)).toBe(true);
  });

  it('never reads an unverifiable registration as success', async () => {
    const path = await addWorktree();
    // An unreadable registry is not authority to remove a checkout.
    injected.gitFails = (args) => args[0] === 'worktree' && args[1] === 'list';
    const outcome = await forceRemoveWorktreeDir(repo, path);
    expect(existsSync(path)).toBe(true);
    expect(outcome).toMatchObject({ removed: false, directory: 'present', registration: 'unknown' });
    expect(outcome.warning).toMatch(/registration unverified/);
  });

  it('never throws, and bounds the error excerpt carried in the warning', async () => {
    const path = await addWorktree();
    injected.gitFails = (args) => args[0] === 'worktree';
    const outcome = await forceRemoveWorktreeDir(repo, path);
    expect(outcome.removed).toBe(false);
    expect(outcome.warning.length).toBeLessThan(600);
    await expect(lstat(path)).resolves.toBeTruthy();
  });

  it('label gates the remove-failure log; absent label stays silent', async () => {
    const path = await addWorktree();
    injected.gitFails = (args) => args[0] === 'worktree' && args[1] === 'remove';
    await forceRemoveWorktreeDir(repo, path, { label: 'Remove failed for agent-1' });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('⚠️ Remove failed for agent-1: injected git failure'));

    console.log.mockClear();
    const second = await addWorktree();
    await forceRemoveWorktreeDir(repo, second); // no label
    expect(console.log).not.toHaveBeenCalled();
  });

  it("log:'all' gates the prune failure log, and `subject` names them", async () => {
    const path = await addWorktree();
    await rm(path, { recursive: true, force: true });
    injected.gitFails = (args) => args[0] === 'worktree' && (args[1] === 'remove' || args[1] === 'prune');
    await forceRemoveWorktreeDir(repo, path, { label: 'L', verifyRemoval: async () => null });
    expect(console.log).toHaveBeenCalledTimes(1); // default log:'remove' → only the remove line

    console.log.mockClear();
    await forceRemoveWorktreeDir(repo, path, { label: 'L', log: 'all', subject: 'agent-42', verifyRemoval: async () => null });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Worktree prune failed for agent-42'));
  });
});
