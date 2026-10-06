/**
 * Worktree ownership through branch-reconcile's real cleanup boundary (#10270).
 *
 * A checkout freshly cut from the default branch is clean and an ancestor of
 * it, so the merged-branch cleanup used to retire it — and its branch — while
 * the process that created it was still running. These tests drive `reconcile`
 * against a real throwaway repository (no origin, so no forge is consulted) to
 * pin that only PortOS-managed roots are retired unattended, while the
 * operator's explicit merged-branch cleanup keeps its wider reach.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execGit } from '../lib/execGit.js';
import { materializeGitRepo, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';

// Keep the run hermetic: the verdict ledger otherwise reads this install's
// real CoS data directory.
vi.mock('./supersededLedger.js', async (importOriginal) => ({
  ...await importOriginal(),
  readVerdictLedger: async () => [],
}));

const { reconcile } = await import('./branchReconcile.js');
const { deleteMergedBranches } = await import('./git.js');

const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(SKIP_HEAVY_INTEGRATION)('branch-reconcile worktree ownership (real git)', () => {
  let scratch;
  let repo;
  let external;

  beforeEach(async () => {
    scratch = realpathSync(await mkdtemp(join(tmpdir(), 'portos-reconcile-own-')));
    const safeRepo = join(scratch, 'repo');
    await mkdir(safeRepo);
    await materializeGitRepo(safeRepo, { identity: { email: 'test@example.com', name: 'Test' } });
    repo = (await execGit(['rev-parse', '--show-toplevel'], safeRepo)).stdout.trim() || safeRepo;
    external = join(scratch, 'elsewhere');
    await mkdir(external);
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /** A clean checkout of a new branch at main — "merged" by ancestry alone. */
  async function addTree(path, branch, { ageMs = 0 } = {}) {
    await execGit(['worktree', 'add', '-b', branch, path, 'main'], repo);
    if (ageMs) {
      const then = new Date(Date.now() - ageMs);
      await utimes(path, then, then);
    }
    return path;
  }

  const branches = async () => (await execGit(['branch', '--format=%(refname:short)'], repo)).stdout.trim().split('\n');

  it('retires inactive managed trees but never a fresh or old unmanaged one', async () => {
    const claudeRoot = join(repo, '.claude', 'worktrees');
    await mkdir(claudeRoot, { recursive: true });
    const fresh = await addTree(join(external, 'release-preparation'), 'release-prep/v9.9.9');
    const old = await addTree(join(external, 'old-workspace'), 'old-workspace', { ageMs: 30 * DAY });
    const staleClaim = await addTree(join(claudeRoot, 'claim-issue-5'), 'claim/issue-5', { ageMs: 30 * DAY });
    const lockedClaim = await addTree(join(claudeRoot, 'claim-issue-6'), 'claim/issue-6', { ageMs: 30 * DAY });
    await execGit(['worktree', 'lock', lockedClaim], repo);
    const dirtyClaim = await addTree(join(claudeRoot, 'claim-issue-7'), 'claim/issue-7');
    await writeFile(join(dirtyClaim, 'wip.txt'), 'unsaved\n');
    await utimes(dirtyClaim, new Date(Date.now() - 30 * DAY), new Date(Date.now() - 30 * DAY));

    const result = await reconcile(repo, { activeAgentIds: new Set() });
    const reasonFor = (branch) => result.skipped.find((s) => s.branch === branch)?.reason;
    const context = JSON.stringify({ cleaned: result.cleaned, skipped: result.skipped });

    // Unmanaged: held at any age, checkout AND branch intact.
    expect(reasonFor('release-prep/v9.9.9'), context).toBe('worktree-unmanaged-location');
    expect(reasonFor('old-workspace'), context).toBe('worktree-unmanaged-location');
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(old)).toBe(true);

    // Managed: an abandoned claim is still retired; a lock or real work holds.
    expect(result.cleaned, context).toContain('claim/issue-5');
    expect(existsSync(staleClaim)).toBe(false);
    expect(reasonFor('claim/issue-6'), context).toBe('worktree-locked');
    expect(existsSync(lockedClaim)).toBe(true);
    expect(result.cleaned, context).not.toContain('claim/issue-7');
    expect(existsSync(dirtyClaim)).toBe(true);

    const left = await branches();
    expect(left).toEqual(expect.arrayContaining(['release-prep/v9.9.9', 'old-workspace', 'claim/issue-6', 'claim/issue-7']));
    expect(left).not.toContain('claim/issue-5');
  });

  it('leaves the operator-initiated merged-branch cleanup able to remove an unmanaged tree', async () => {
    const loose = await addTree(join(external, 'loose'), 'loose-br', { ageMs: 30 * DAY });

    const held = await reconcile(repo, { activeAgentIds: new Set() });
    expect(held.skipped.find((s) => s.branch === 'loose-br')?.reason).toBe('worktree-unmanaged-location');

    const operator = await deleteMergedBranches(repo, { activeAgentIds: new Set() });
    expect(operator.deleted.map((d) => d.name), JSON.stringify(operator)).toContain('loose-br');
    expect(existsSync(loose)).toBe(false);
    expect(await branches()).not.toContain('loose-br');
  });
});
