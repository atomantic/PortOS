/** Persisted receipt arrival/replay, using real Git absence and owner gates. */
import { beforeEach, afterEach, afterAll, describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const fixture = vi.hoisted(() => ({ repo: null, agents: [] }));
vi.mock('../lib/fileUtils.js', async importOriginal => {
  const { makePathsProxy, lazyTempDataRoot } = await import('../lib/mockPathsDataRoot.js');
  return makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-receipt-placeholder-') });
});
vi.mock('./apps.js', async importOriginal => ({ ...await importOriginal(), getAppById: async () => ({ repoPath: fixture.repo }) }));
vi.mock('./cosClaimOwnership.js', async importOriginal => ({ ...await importOriginal(), readClaimOwnershipAgents: async () => fixture.agents }));
import { PATHS } from '../lib/fileUtils.js';
import { cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';
import { execGit } from '../lib/execGit.js';
import { recordHeldCheckoutRetirement, getBranchReconcileInventory } from './taskSchedule.js';

let root, row, receipt;
const appId = 'synthetic-app';
const schedulePath = join(PATHS.cos, 'task-schedule.json');
const git = async (...args) => (await execGit(args, fixture.repo)).stdout.trim();
const outcomeFrom = schedule => schedule.executions['task:branch-reconcile'].perApp[appId].branchReconcileOutcome;
const persisted = async () => JSON.parse(await readFile(schedulePath, 'utf8'));
async function seed({ receipts = [], observation = row } = {}) {
  await writeFile(schedulePath, JSON.stringify({ version: 2, retirementPolicyVersion: 2, tasks: {}, templates: [],
    executions: { 'task:branch-reconcile': { perApp: { [appId]: { branchReconcileOutcome: {
      status: 'incomplete', remaining: [observation], retirementObligations: [observation], retired: receipts,
      legacyRetirementTransition: { version: 1, observations: [], resolutions: [] },
    } } } } } }));
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'portos-placeholder-git-'));
  fixture.repo = join(root, 'repo'); fixture.agents = [];
  await mkdir(fixture.repo); await mkdir(PATHS.cos, { recursive: true });
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.test');
  await writeFile(join(fixture.repo, 'base.txt'), 'base\n'); await git('add', '.'); await git('commit', '-m', 'base');
  row = { branch: 'feature/synthetic', reason: 'retirement-provenance-unverified', createdAt: '2026-01-01T00:00:00.000Z' };
  receipt = { branch: row.branch, path: join(root, 'finished-checkout'), head: await git('rev-parse', 'HEAD'),
    checkoutIdentity: 'b'.repeat(64), branchDeleted: true, archiveDir: null, retiredAt: '2026-01-02T00:00:00.000Z' };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
afterAll(cleanupTempDataRoots);

describe('stale branch-only retirement placeholders', () => {
  it('settles receipt arrival and idempotent replay without changing the deletion timestamp or duplicating its audit', async () => {
    await seed();
    await recordHeldCheckoutRetirement(appId, receipt);
    const first = outcomeFrom(await persisted());
    expect(first.retirementObligations).toEqual([]); expect(first.remaining).toEqual([]);
    expect(first.retired[0].settledPlaceholders).toEqual([{ observation: row, settledAt: expect.any(String) }]);
    const originalRetiredAt = first.retired[0].retiredAt;
    const schedule = await persisted(); outcomeFrom(schedule).remaining = [row]; outcomeFrom(schedule).retirementObligations = [row];
    await writeFile(schedulePath, JSON.stringify(schedule));
    await recordHeldCheckoutRetirement(appId, receipt);
    const replay = outcomeFrom(await persisted());
    expect(replay.remaining).toEqual([]); expect(replay.retirementObligations).toEqual([]);
    expect(replay.retired[0].retiredAt).toBe(originalRetiredAt);
    expect(replay.retired[0].settledPlaceholders).toHaveLength(1);
    expect(replay.legacyRetirementTransition).toEqual({ version: 1, observations: [], resolutions: [] });
  });
  it('recovers persisted receipt evidence on inventory read after restart without replaying deletion or rewriting its timestamp', async () => {
    await seed({ receipts: [receipt] });
    const repaired = await getBranchReconcileInventory(appId);
    expect(repaired.remaining).toEqual([]); expect(repaired.retirementObligations).toEqual([]);
    expect(repaired.retired[0]).toMatchObject({ retiredAt: receipt.retiredAt, settledPlaceholders: [{ observation: row }] });
    const before = await readFile(schedulePath, 'utf8');
    await getBranchReconcileInventory(appId);
    expect(await readFile(schedulePath, 'utf8')).toBe(before);
    expect(await git('status', '--porcelain')).toBe('');
  });
  it.each(['ambiguous', 'recreated-branch', 'recreated-path', 'active-owner', 'human-handoff', 'new-generation', 'newer-placeholder', 'missing-receipt', 'unreadable-owners', 'locked-placeholder', 'nonreceipt'])(
    'retains real or ambiguous unfinished evidence: %s', async scenario => {
      const receipts = [receipt]; const observation = { ...row };
      if (scenario === 'ambiguous') receipts.push({ ...receipt, checkoutIdentity: 'c'.repeat(64) });
      if (scenario === 'recreated-branch') await git('branch', row.branch);
      if (scenario === 'recreated-path') { await mkdir(receipt.path); await writeFile(join(receipt.path, 'new-work.txt'), 'unique work\n'); }
      if (['active-owner', 'human-handoff'].includes(scenario)) fixture.agents = [{ id: 'synthetic-owner', status: scenario === 'active-owner' ? 'running' : 'completed',
        metadata: { claimBranches: [row.branch], ...(scenario === 'human-handoff' && { prCompletionPolicy: 'leave-open' }) } }];
      if (scenario === 'new-generation') observation.checkoutIdentity = 'c'.repeat(64);
      if (scenario === 'newer-placeholder') observation.createdAt = '2026-01-03T00:00:00.000Z';
      if (scenario === 'missing-receipt') receipts.length = 0;
      if (scenario === 'unreadable-owners') fixture.agents = null;
      if (scenario === 'locked-placeholder') observation.locked = true;
      if (scenario === 'nonreceipt') receipt.branchDeleted = false;
      await seed({ receipts, observation });
      const result = await getBranchReconcileInventory(appId);
      expect(result.retirementObligations).toContainEqual(expect.objectContaining(observation));
      expect(result.retired?.some(value => value.settledPlaceholders?.length)).toBe(false);
      if (scenario === 'recreated-path') expect(await readFile(join(receipt.path, 'new-work.txt'), 'utf8')).toBe('unique work\n');
    });
});
