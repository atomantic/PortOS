/** Persisted receipt arrival/replay, using real Git absence and owner gates. */
import { beforeEach, afterEach, afterAll, describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const fixture = vi.hoisted(() => ({ repo: null, agents: [], beforeLock: null, ownerReads: 0 }));
vi.mock('../lib/fileUtils.js', async importOriginal => {
  const { makePathsProxy, lazyTempDataRoot } = await import('../lib/mockPathsDataRoot.js');
  return makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-receipt-placeholder-') });
});
vi.mock('./apps.js', async importOriginal => ({ ...await importOriginal(), getAppById: async () => ({ repoPath: fixture.repo }) }));
vi.mock('./cosClaimOwnership.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual,
    readClaimOwnershipAgents: async () => { fixture.ownerReads++; return fixture.agents; },
    withClaimOwnershipLock: callback => actual.withClaimOwnershipLock(async () => {
      if (fixture.beforeLock) await fixture.beforeLock();
      return callback();
    }),
  };
});
import { PATHS } from '../lib/fileUtils.js';
import { cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';
import { execGit } from '../lib/execGit.js';
import { recordHeldCheckoutRetirement, getBranchReconcileInventory } from './branchReconcileOutcome.js';

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
  fixture.repo = join(root, 'repo'); fixture.agents = []; fixture.beforeLock = null; fixture.ownerReads = 0;
  await mkdir(fixture.repo); await mkdir(PATHS.cos, { recursive: true });
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.test');
  await writeFile(join(fixture.repo, 'base.txt'), 'base\n'); await git('add', '.'); await git('commit', '-m', 'base');
  row = { branch: 'feature/synthetic', reason: 'retirement-provenance-unverified', createdAt: '2026-01-01T00:00:00.000Z' };
  receipt = { branch: row.branch, path: join(root, 'finished-checkout'), head: await git('rev-parse', 'HEAD'),
    checkoutIdentity: 'b'.repeat(64), branchDeleted: true, archiveDir: null, retiredAt: '2026-01-02T00:00:00.000Z' };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
afterAll(cleanupTempDataRoots);

function expectAbsentHistory(result, observation) {
  expect(result.retirementObligations).not.toContainEqual(expect.objectContaining(observation));
  expect(result.legacyRetirementTransition.resolutions).toContainEqual(expect.objectContaining({
    observation, removalVerified: false,
    evidence: { kind: 'current-local-absence', deliveryVerified: false, preservationVerified: false },
  }));
}

describe('stale branch-only retirement placeholders', () => {
  it('settles a path-only observation without reading an unrelated owners missing branch policy', async () => {
    const observation = { path: join(root, 'absent-detached-checkout'), head: receipt.head,
      reason: row.reason, createdAt: row.createdAt };
    fixture.agents = [{ id: 'unrelated-owner', status: 'completed', metadata: {
      sourceWorkspace: fixture.repo, workspacePath: join(root, 'another-checkout'), prCompletionPolicy: 'leave-open',
    } }];
    await seed({ observation });
    const result = await getBranchReconcileInventory(appId);
    expectAbsentHistory(result, observation);
  });

  it('rechecks receipt-recorded paths inside the owner lock before settling absence', async () => {
    receipt.branchDeleted = false; // Not eligible for stronger receipt binding.
    await seed({ receipts: [receipt] });
    fixture.beforeLock = async () => {
      await mkdir(receipt.path); await writeFile(join(receipt.path, 'unique.txt'), 'new owner work');
    };
    const result = await getBranchReconcileInventory(appId);
    expect(result.retirementObligations).toContainEqual(row);
    expect(result.legacyRetirementTransition.resolutions).toEqual([]);
    expect(await readFile(join(receipt.path, 'unique.txt'), 'utf8')).toBe('new owner work');
  });

  it('does not read owners or worktrees when no observation is eligible', async () => {
    await seed();
    const schedule = await persisted();
    const outcome = outcomeFrom(schedule); outcome.remaining = []; outcome.retirementObligations = [];
    await writeFile(schedulePath, JSON.stringify(schedule));
    await getBranchReconcileInventory(appId);
    expect(fixture.ownerReads).toBe(0);
  });

  it.each([
    { scenario: 'after', finalizedAt: '2026-01-06T00:00:00.000Z', binds: true },
    { scenario: 'before', finalizedAt: '2026-01-04T00:00:00.000Z', binds: false },
  ])('binds branch-only observations only when ref finalization is $scenario the observation', async ({ finalizedAt, binds }) => {
    const observation = { ...row, createdAt: '2026-01-05T00:00:00.000Z' };
    receipt.branchFinalizedAt = finalizedAt;
    receipt.branchFinalization = { kind: 'observed-absent' };
    await seed({ receipts: [receipt], observation });
    const result = await getBranchReconcileInventory(appId);
    expect(result.remaining).toEqual([]); expect(result.retirementObligations).toEqual([]);
    if (binds) {
      expect(result.retired).toEqual([{ ...receipt, settledObservations: [{ observation, settledAt: expect.any(String) }] }]);
      expect(result.legacyRetirementTransition.resolutions).toEqual([]);
    } else {
      expect(result.retired).toEqual([receipt]);
      expectAbsentHistory(result, observation);
    }
  });

  it.each(['settled', 'older-receipt', 'recreated', 'ambiguous', 'different-path'])(
    'keeps verified receipt binding distinct from absent historical source: %s', async scenario => {
      const observation = { ...row, path: receipt.path, head: row.branch,
        createdAt: '2026-01-03T00:00:00.000Z' };
      if (scenario !== 'older-receipt') receipt.retiredAt = '2026-01-04T00:00:00.000Z';
      const receipts = [receipt];
      if (scenario === 'recreated') { await mkdir(receipt.path); await writeFile(join(receipt.path, 'unique.txt'), 'unfinished work'); }
      if (scenario === 'ambiguous') receipts.push({ ...receipt, checkoutIdentity: 'c'.repeat(64) });
      if (scenario === 'different-path') observation.path = join(root, 'other-checkout');
      await seed({ receipts, observation });
      const result = await getBranchReconcileInventory(appId);
      if (scenario === 'settled') {
        expect(result.remaining).toEqual([]); expect(result.retirementObligations).toEqual([]);
        expect(result.retired[0]).toMatchObject({ retiredAt: receipt.retiredAt, settledObservations: [{ observation }] });
        const saved = await readFile(schedulePath, 'utf8');
        await getBranchReconcileInventory(appId);
        expect(await readFile(schedulePath, 'utf8')).toBe(saved);
      } else if (scenario === 'recreated') expect(result.retirementObligations).toContainEqual(expect.objectContaining(observation));
      else {
        expectAbsentHistory(result, observation);
        expect(result.retired[0]).toEqual(receipt);
      }
      if (scenario === 'recreated') expect(await readFile(join(receipt.path, 'unique.txt'), 'utf8')).toBe('unfinished work');
    });

  it('settles receipt arrival and idempotent replay without changing the deletion timestamp or duplicating its audit', async () => {
    await seed();
    await recordHeldCheckoutRetirement(appId, receipt);
    const first = outcomeFrom(await persisted());
    expect(first.retirementObligations).toEqual([]); expect(first.remaining).toEqual([]);
    expect(first.retired[0].settledObservations).toEqual([{ observation: row, settledAt: expect.any(String) }]);
    const originalRetiredAt = first.retired[0].retiredAt;
    const schedule = await persisted(); outcomeFrom(schedule).remaining = [row]; outcomeFrom(schedule).retirementObligations = [row];
    await writeFile(schedulePath, JSON.stringify(schedule));
    await recordHeldCheckoutRetirement(appId, receipt);
    const replay = outcomeFrom(await persisted());
    expect(replay.remaining).toEqual([]); expect(replay.retirementObligations).toEqual([]);
    expect(replay.retired[0].retiredAt).toBe(originalRetiredAt);
    expect(replay.retired[0].settledObservations).toHaveLength(1);
    expect(replay.legacyRetirementTransition).toEqual({ version: 1, observations: [], resolutions: [] });
  });
  it('recovers persisted receipt evidence on inventory read after restart without replaying deletion or rewriting its timestamp', async () => {
    await seed({ receipts: [receipt] });
    const repaired = await getBranchReconcileInventory(appId);
    expect(repaired.remaining).toEqual([]); expect(repaired.retirementObligations).toEqual([]);
    expect(repaired.retired[0]).toMatchObject({ retiredAt: receipt.retiredAt, settledObservations: [{ observation: row }] });
    const before = await readFile(schedulePath, 'utf8');
    await getBranchReconcileInventory(appId);
    expect(await readFile(schedulePath, 'utf8')).toBe(before);
    expect(await git('status', '--porcelain')).toBe('');
  });
  it('retains receipt audit limits and records excess absent observations without claiming deletion', async () => {
    receipt.settledObservations = Array.from({ length: 999 }, (_, i) => ({ observation: { ...row, branch: `feature/prior-${i}` }, settledAt: receipt.retiredAt }));
    await seed({ receipts: [receipt] });
    const second = { ...row, createdAt: '2026-01-01T00:00:01.000Z' };
    const schedule = await persisted();
    outcomeFrom(schedule).remaining.push(second); outcomeFrom(schedule).retirementObligations.push(second);
    await writeFile(schedulePath, JSON.stringify(schedule));
    const result = await getBranchReconcileInventory(appId);
    expect(result.retired[0].settledObservations).toHaveLength(1000);
    expectAbsentHistory(result, second);
  });

  it.each(['moved', 'progressed', 'old-path-recreated', 'unrelated-head'])(
    'binds only the same absent physical generation to its actual receipt: %s', async scenario => {
      const observation = { ...row, path: join(root, 'previous-location'), head: receipt.head, checkoutIdentity: receipt.checkoutIdentity };
      if (scenario === 'progressed') {
        await writeFile(join(fixture.repo, 'later.txt'), 'delivered continuation\n'); await git('add', '.'); await git('commit', '-m', 'later');
        receipt.head = await git('rev-parse', 'HEAD');
      }
      if (scenario === 'unrelated-head') {
        await git('checkout', '--orphan', 'independent'); await git('rm', '-rf', '.');
        await writeFile(join(fixture.repo, 'independent.txt'), 'different history\n'); await git('add', '.'); await git('commit', '-m', 'independent');
        receipt.head = await git('rev-parse', 'HEAD'); await git('checkout', 'main'); await git('branch', '-D', 'independent');
      }
      if (scenario === 'old-path-recreated') { await mkdir(observation.path); await writeFile(join(observation.path, 'new.txt'), 'unique work\n'); }
      await seed({ receipts: [receipt], observation });
      const result = await getBranchReconcileInventory(appId);
      if (['moved', 'progressed'].includes(scenario)) {
        expect(result.remaining).toEqual([]); expect(result.retirementObligations).toEqual([]);
        expect(result.retired[0]).toMatchObject({ retiredAt: receipt.retiredAt, settledObservations: [{ observation }] });
      } else if (scenario === 'unrelated-head') {
        expectAbsentHistory(result, observation);
        expect(result.retired[0].settledObservations).toBeUndefined();
      } else {
        expect(result.retirementObligations).toContainEqual(expect.objectContaining(observation));
        if (scenario === 'old-path-recreated') expect(await readFile(join(observation.path, 'new.txt'), 'utf8')).toBe('unique work\n');
      }
    });

  it.each(['ambiguous', 'recreated-branch', 'recreated-path', 'active-owner', 'human-handoff', 'new-generation', 'newer-placeholder', 'missing-receipt', 'unreadable-owners', 'locked-placeholder', 'nonreceipt', 'invalid-archive'])(
    'retains live holds and audits absent ambiguous history: %s', async scenario => {
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
      if (scenario === 'invalid-archive') receipt.archiveDir = '';
      await seed({ receipts, observation });
      const result = await getBranchReconcileInventory(appId);
      if (['ambiguous', 'new-generation', 'newer-placeholder', 'missing-receipt', 'nonreceipt', 'invalid-archive'].includes(scenario)) expectAbsentHistory(result, observation);
      else expect(result.retirementObligations).toContainEqual(expect.objectContaining(observation));
      expect(result.retired?.some(value => value.settledObservations?.length)).toBe(false);
      if (scenario === 'recreated-path') expect(await readFile(join(receipt.path, 'new-work.txt'), 'utf8')).toBe('unique work\n');
    });
});
