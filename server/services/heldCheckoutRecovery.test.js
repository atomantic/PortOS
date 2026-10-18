/**
 * Scoped retirement of held checkouts through real Git (#12002): a release
 * binds to the exact inventory row, every unique byte is archived before any
 * mutation, and an ownership change or archive failure leaves the checkout,
 * its lock and its branch as found.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, symlink } from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execGit } from '../lib/execGit.js';
import { materializeGitRepo, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';

const SYMLINKS = process.platform !== 'win32';
const injected = vi.hoisted(() => ({ policies: [], schedule: null, app: null }));

vi.mock('./branchCompletionPolicy.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readBranchCompletionHold: input => actual.readBranchCompletionHold(input, {
    readPolicies: async () => injected.policies,
  }) };
});
vi.mock('./taskScheduleStore.js', async (importOriginal) => ({
  ...await importOriginal(),
  loadSchedule: async () => injected.schedule,
  updateSchedule: async (mutate) => (await mutate(injected.schedule)).result,
}));
vi.mock('./apps.js', () => ({ getAppById: async (id) => (injected.app?.id === id ? injected.app : null) }));

const { retireInventoriedCheckout, heldCheckoutArchiveRoot } = await import('./heldCheckoutRecovery.js');
const { recordBranchReconcileOutcome, getBranchReconcileOutcome } = await import('./taskSchedule.js');

describe.skipIf(SKIP_HEAVY_INTEGRATION)('held checkout recovery (real git)', () => {
  let scratch;
  let repo;
  let external;
  let cosDir;
  const noOwners = async () => [];

  beforeEach(async () => {
    Object.assign(injected, { policies: [], schedule: { executions: {} }, app: { id: 'app-1', repoPath: null } });
    scratch = realpathSync(await mkdtemp(join(tmpdir(), 'portos-held-checkout-')));
    const safeRepo = join(scratch, 'repo');
    await mkdir(safeRepo);
    await materializeGitRepo(safeRepo, { identity: { email: 'test@example.com', name: 'Test' } });
    repo = (await execGit(['rev-parse', '--show-toplevel'], safeRepo)).stdout.trim() || safeRepo;
    external = join(scratch, 'elsewhere');
    cosDir = join(scratch, 'cos');
    await mkdir(external);
    injected.app.repoPath = repo;
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /** A locked checkout outside the managed roots holding unique uncommitted work. */
  async function heldCheckout(name, { branch = null, lockReason = 'synthetic external owner' } = {}) {
    const path = join(external, name);
    await execGit(['worktree', 'add', ...(branch ? ['-b', branch, path] : ['--detach', path]), 'main'], repo);
    await writeFile(join(path, '.gitignore'), 'ignored.txt\nlinked\n');
    await writeFile(join(path, 'initial.txt'), 'tracked edit\n');
    await writeFile(join(path, 'untracked.txt'), 'untracked work\n');
    await writeFile(join(path, 'ignored.txt'), 'ignored work\n');
    // Windows runners may lack symlink privilege; the archive contract is the same.
    if (SYMLINKS) await symlink('../shared-target', join(path, 'linked'));
    await execGit(['worktree', 'lock', '--reason', lockReason, path], repo);
    const gitPath = (await execGit(['rev-parse', '--show-toplevel'], path)).stdout.trim();
    const head = (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim();
    return { path, release: { path: gitPath, head, branch, locked: true, lockReason } };
  }

  const registered = async (path) => (await execGit(['worktree', 'list', '--porcelain'], repo)).stdout.includes(`worktree ${path}`);
  const lockText = async (path) => (await execGit(['worktree', 'list', '--porcelain'], repo)).stdout
    .split('\n\n').find(block => block.startsWith(`worktree ${path}\n`))?.match(/^locked ?(.*)$/m)?.[1] ?? null;
  /** The operator confirms a row the last sweep persisted. */
  async function retire(release, opts = {}) {
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...release, reason: 'worktree-locked' }] });
    return retireInventoriedCheckout({ appId: 'app-1', release }, { cosDir, readAgents: noOwners, ...opts });
  }
  const archives = async () => (existsSync(heldCheckoutArchiveRoot(cosDir)) ? readdir(heldCheckoutArchiveRoot(cosDir)) : []);

  it('archives tracked, untracked, ignored and symlinked content, then retires a locked detached checkout', async () => {
    const { path, release } = await heldCheckout('detached-held');

    const result = await retire(release);

    expect(result).toMatchObject({ ok: true, branchDeleted: false });
    expect(existsSync(path)).toBe(false);
    expect(await registered(release.path)).toBe(false);
    const manifest = JSON.parse(await readFile(join(result.archiveDir, 'manifest.json'), 'utf8'));
    expect(manifest.release).toEqual(release);
    expect(manifest.captured.files.map(file => file.path).sort()).toEqual(['.gitignore', 'ignored.txt', 'untracked.txt']);
    expect(manifest.captured.symlinks).toEqual(SYMLINKS ? [{ path: 'linked', target: '../shared-target' }] : []);
    expect(await readFile(join(result.archiveDir, 'files', 'ignored.txt'), 'utf8')).toBe('ignored work\n');
    expect(await readFile(join(result.archiveDir, 'worktree.diff'), 'utf8')).toContain('+tracked edit');
  });

  it('retires a merged branch checkout and its branch, and drops it from the persisted inventory', async () => {
    const { path, release } = await heldCheckout('branch-held', { branch: 'feature/held' });
    await recordBranchReconcileOutcome('app-1', {
      status: 'incomplete', reason: 'holds-remaining', nextAction: 'Recover held checkouts.',
      remaining: [{ ...release, managed: false, reason: 'worktree-locked' }, { branch: 'other', reason: 'actionable' }],
    });

    const result = await retireInventoriedCheckout({ appId: 'app-1', release }, { cosDir, readAgents: noOwners });

    expect(result).toMatchObject({ ok: true, branchDeleted: true });
    expect(existsSync(path)).toBe(false);
    expect((await execGit(['branch', '--list', 'feature/held'], repo)).stdout.trim()).toBe('');
    const outcome = await getBranchReconcileOutcome('app-1');
    expect(outcome.status).toBe('incomplete');
    expect(outcome.remaining).toEqual([{ branch: 'other', reason: 'actionable' }]);
    expect(outcome.retired[0]).toMatchObject({ path: release.path, branch: 'feature/held', branchDeleted: true, archiveDir: result.archiveDir });
  });

  it('refuses a release that does not name a row of the last inventory', async () => {
    const { path, release } = await heldCheckout('not-inventoried');
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...release, lockReason: 'older lock text' }] });

    expect(await retireInventoriedCheckout({ appId: 'app-1', release }, { cosDir, readAgents: noOwners }))
      .toEqual({ ok: false, reason: 'release-not-in-inventory' });
    expect(existsSync(path)).toBe(true);
  });

  it.each([
    ['a changed lock', async (path) => {
      await execGit(['worktree', 'unlock', path], repo);
      await execGit(['worktree', 'lock', '--reason', 'new owner took over', path], repo);
    }, 'checkout-lock-changed'],
    ['a moved HEAD', async (path) => {
      await writeFile(join(path, 'next.txt'), 'more\n');
      await execGit(['add', 'next.txt'], path);
      await execGit(['commit', '-m', 'chore: synthetic owner commit'], path);
    }, 'checkout-head-changed'],
  ])('treats %s since the inventory as an ownership change', async (_label, change, reason) => {
    const { path, release } = await heldCheckout('changed-owner');
    await change(path);

    expect(await retire(release)).toEqual({ ok: false, reason });
    expect(existsSync(join(path, 'ignored.txt'))).toBe(true);
    expect(await archives()).toEqual([]);
  });

  it('keeps the checkout, its content and its original lock when an owner appears after the archive', async () => {
    const { path, release } = await heldCheckout('owner-arrives', { lockReason: 'handoff pending' });
    let reads = 0;
    // Clear for the pre-archive check; a live run occupies the checkout by the removal recheck.
    const readAgents = async () => (++reads === 1 ? [] : [{ id: 'agent-live', status: 'running', workspacePath: release.path }]);

    const result = await retire(release, { readAgents });

    expect(result).toMatchObject({ ok: false, reason: 'claim-owner-active' });
    expect(await registered(release.path)).toBe(true);
    expect(await lockText(release.path)).toBe('handoff pending');
    for (const name of ['initial.txt', 'untracked.txt', 'ignored.txt']) expect(existsSync(join(path, name))).toBe(true);
    expect(existsSync(join(result.archiveDir, 'manifest.json'))).toBe(true);
  });

  it('keeps everything and leaves no partial archive when the archive cannot be completed', async () => {
    const { path, release } = await heldCheckout('archive-fails');
    // A nested repository is listed without its files, so it cannot be archived faithfully.
    await mkdir(join(path, 'nested'));
    await execGit(['init', '-q'], join(path, 'nested'));

    const result = await retire(release);

    expect(result).toMatchObject({ ok: false, reason: 'archive-failed' });
    expect(await lockText(release.path)).toBe('synthetic external owner');
    expect(existsSync(join(path, 'nested', '.git'))).toBe(true);
    expect(await archives()).toEqual([]);
  });

  it('refuses unmerged work and a manual completion handoff before archiving anything', async () => {
    const unmerged = await heldCheckout('unmerged');
    await execGit(['worktree', 'unlock', unmerged.path], repo);
    await execGit(['commit', '--allow-empty', '-m', 'feat: synthetic unmerged work'], unmerged.path);
    const head = (await execGit(['rev-parse', 'HEAD'], unmerged.path)).stdout.trim();
    expect(await retire({ ...unmerged.release, head, locked: false, lockReason: null }))
      .toEqual({ ok: false, reason: 'not-merged-on-recheck' });

    const handoff = await heldCheckout('handoff', { branch: 'feature/handoff' });
    injected.policies = [{ id: 'agent-done', status: 'completed', startedAt: '2026-01-01T00:00:00.000Z',
      metadata: { sourceWorkspace: repo, worktreeBranch: 'feature/handoff', prCompletionPolicy: 'leave-open' } }];
    expect(await retire(handoff.release))
      .toEqual({ ok: false, reason: 'pr-completion-human-handoff' });
    expect(existsSync(handoff.path)).toBe(true);
    expect(await archives()).toEqual([]);
  });
});
