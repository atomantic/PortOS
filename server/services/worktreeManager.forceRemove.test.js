import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, rm as realRm, writeFile, lstat, mkdir } from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { materializeGitRepo, resetGitWorktreeSandbox, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';

// Failure injection seams over REAL git and a REAL filesystem: both default to
// the genuine implementation, and a test opts one call into rejecting. The
// assertions then look at the surviving directory and registration, not at the
// order the mocks were called in.
const injected = vi.hoisted(() => ({ gitFails: () => false, rmFails: false }));
vi.mock('../lib/execGit.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    execGit: vi.fn((args, ...rest) => (injected.gitFails(args)
      ? Promise.reject(new Error(`injected git failure: ${args.slice(0, 2).join(' ')}`))
      : actual.execGit(args, ...rest))),
  };
});
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    rm: vi.fn((...args) => (injected.rmFails
      ? Promise.reject(Object.assign(new Error('injected EPERM'), { code: 'EPERM' }))
      : actual.rm(...args))),
  };
});

import { execGit } from '../lib/execGit.js';
import { forceRemoveWorktreeDir } from './worktreeManager.js';

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
    injected.rmFails = false;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await resetGitWorktreeSandbox(repo, initialHead, safePath);
  });
  afterAll(async () => {
    injected.rmFails = false; // the cleanup below goes through the same mocked module
    await realRm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    const outcome = await forceRemoveWorktreeDir(repo, path);
    expect(outcome).toMatchObject({ removed: true, directory: 'absent', registration: 'absent', warning: null });
    expect(existsSync(path)).toBe(false);
    expect(await registered(path)).toBe(false);
  });

  it('falls back to rm + prune when git refuses, and reports the verified result', async () => {
    const path = await addWorktree();
    injected.gitFails = (args) => args[0] === 'worktree' && args[1] === 'remove';
    const outcome = await forceRemoveWorktreeDir(repo, path);
    expect(outcome.removed).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(await registered(path)).toBe(false);
  });

  it('reports an already-removed directory with a stale registration as removed once pruned', async () => {
    const path = await addWorktree();
    await realRm(path, { recursive: true, force: true });
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

  it('returns an incomplete outcome with an actionable warning when git removal AND rm both fail', async () => {
    const path = await addWorktree();
    await writeFile(join(path, 'keep.txt'), 'still here\n');
    injected.gitFails = (args) => args[0] === 'worktree' && args[1] === 'remove';
    injected.rmFails = true;

    const outcome = await forceRemoveWorktreeDir(repo, path, { label: 'test cleanup' });

    expect(outcome).toMatchObject({ removed: false, directory: 'present', registration: 'registered' });
    expect(outcome.warning).toMatch(/cleanup incomplete/);
    expect(outcome.warning).toContain(path);
    expect(outcome.warning).toMatch(/directory still present/);
    expect(outcome.warning).toMatch(/registration still registered/);
    expect(outcome.warning).toMatch(/retryable/);
    expect(outcome.warning).toContain('injected EPERM');
    // The checkout genuinely survived — the report is not a guess.
    expect(existsSync(join(path, 'keep.txt'))).toBe(true);
    expect(await registered(path)).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('cleanup incomplete'));
  });

  it('keeps a locked registration visible: the directory is removed but the outcome is incomplete', async () => {
    const path = await addWorktree();
    await execGit(['worktree', 'lock', path], repo);
    const outcome = await forceRemoveWorktreeDir(repo, path);
    expect(outcome).toMatchObject({ removed: false, directory: 'absent', registration: 'registered' });
    expect(existsSync(path)).toBe(false);
    expect(await registered(path)).toBe(true);
  });

  it('never reads an unverifiable registration as success', async () => {
    const path = await addWorktree();
    // Git removal works, but the follow-up verification cannot read the registry.
    injected.gitFails = (args) => args[0] === 'worktree' && args[1] === 'list';
    const outcome = await forceRemoveWorktreeDir(repo, path);
    expect(existsSync(path)).toBe(false);
    expect(outcome).toMatchObject({ removed: false, directory: 'absent', registration: 'unknown' });
    expect(outcome.warning).toMatch(/registration unverified/);
  });

  it('never throws, and bounds the error excerpt carried in the warning', async () => {
    const path = await addWorktree();
    injected.gitFails = (args) => args[0] === 'worktree';
    injected.rmFails = true;
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

  it("log:'all' gates the rm + prune sub-failure logs, and `subject` names them", async () => {
    const path = await addWorktree();
    injected.gitFails = (args) => args[0] === 'worktree' && (args[1] === 'remove' || args[1] === 'prune');
    injected.rmFails = true;
    await forceRemoveWorktreeDir(repo, path, { label: 'L' });
    expect(console.log).toHaveBeenCalledTimes(1); // default log:'remove' → only the remove line

    console.log.mockClear();
    await forceRemoveWorktreeDir(repo, path, { label: 'L', log: 'all', subject: 'agent-42' });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Manual rm failed for worktree agent-42'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Worktree prune failed for agent-42'));
  });
});
