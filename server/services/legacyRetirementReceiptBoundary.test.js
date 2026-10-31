import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execGit } from '../lib/execGit.js';
import { materializeGitRepo, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';
import { markLegacyRetirements } from '../lib/legacyRetirementTransition.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { readRetirementCheckoutIdentity } from '../lib/retirementCheckoutObservation.js';

const getApp = vi.hoisted(() => vi.fn());
vi.mock('../lib/paths.js', async importOriginal => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-receipt-boundary-'),
}));
vi.mock('./apps.js', () => ({ getAppById: getApp }));
vi.mock('./cosClaimOwnership.js', () => ({ readClaimOwnershipAgents: async () => [], withClaimOwnershipLock: work => work() }));
vi.mock('./agentState.js', () => ({ getActiveAgentIds: () => new Set() }));
vi.mock('./userTimezone.js', () => ({ getUserTimezone: async () => 'UTC' }));
vi.mock('./supersededLedger.js', async importOriginal => ({ ...await importOriginal(), readVerdictLedger: async () => [] }));

import { getBranchReconcileInventory, getBranchReconcileOutcome, recordBranchReconcileOutcome } from './branchReconcileOutcome.js';
import { updateSchedule } from './taskScheduleStore.js';

describe.skipIf(SKIP_HEAVY_INTEGRATION)('retirement receipt reconciliation through persisted inventory', () => {
  let scratch, repoPath;
  beforeAll(async () => {
    scratch = realpathSync(await mkdtemp(join(tmpdir(), 'portos-receipt-git-')));
    repoPath = join(scratch, 'repo');
    await mkdir(repoPath);
    await materializeGitRepo(repoPath);
    getApp.mockImplementation(async id => ({ id, repoPath }));
  });
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
    await cleanupTempDataRoots();
  });

  it('does not bind a reused checkout observation to an earlier generation receipt', async () => {
    const branch = 'fix/reused-path';
    const path = join(scratch, 'reused-path');
    await execGit(['worktree', 'add', '-b', branch, path, 'main'], repoPath);
    const head = (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim();
    const oldIdentity = await readRetirementCheckoutIdentity(path);
    await execGit(['worktree', 'remove', path], repoPath);
    await execGit(['branch', '-d', branch], repoPath);
    await execGit(['worktree', 'add', '-b', branch, path, 'main'], repoPath);
    const newIdentity = await readRetirementCheckoutIdentity(path);
    expect(newIdentity).not.toBe(oldIdentity);
    await execGit(['worktree', 'remove', path], repoPath);
    await execGit(['branch', '-d', branch], repoPath);

    const observation = { branch, path, head: branch, reason: 'retirement-provenance-unverified',
      createdAt: '2026-01-02T00:00:00.000Z', observedAt: '2026-01-03T00:00:00.000Z' };
    const receipt = { branch, path, head, checkoutIdentity: oldIdentity, branchDeleted: true, archiveDir: null, retiredAt: '2026-01-01T00:00:00.000Z' };
    const seed = async (appId, serviceReceipt, row = observation) => {
      const outcome = { status: 'incomplete', remaining: [row], retirementObligations: [row], retired: [serviceReceipt] };
      markLegacyRetirements(outcome);
      await recordBranchReconcileOutcome(appId, { status: 'incomplete', remaining: [] });
      await updateSchedule(schedule => {
        schedule.executions['task:branch-reconcile'].perApp[appId].branchReconcileOutcome = outcome;
        return { result: true, changed: true };
      });
    };
    await seed('generation-app', receipt);

    const result = await getBranchReconcileInventory('generation-app');
    expect(result.retired).toEqual([receipt]);
    expect(result.retirementObligations).toEqual([]);
    expect(result.legacyRetirementTransition.resolutions).toMatchObject([{
      observation, disposition: 'local-cleanup-not-required', removalVerified: false,
      evidence: { kind: 'current-local-absence', deliveryVerified: false, preservationVerified: false },
    }]);
    expect(await getBranchReconcileOutcome('generation-app')).toEqual(result);

    // A later service receipt can still bind the pre-existing observation.
    const laterReceipt = { ...receipt, checkoutIdentity: newIdentity, retiredAt: '2026-01-04T00:00:00.000Z' };
    await seed('later-generation-app', laterReceipt);
    const bound = await getBranchReconcileInventory('later-generation-app');
    expect(bound.retired).toEqual([{ ...laterReceipt, settledObservations: [{ observation, settledAt: expect.any(String) }] }]);
    expect(bound.retirementObligations).toEqual([]);
    expect(bound.legacyRetirementTransition.resolutions).toEqual([]);

    // A branch-only observation also cannot identify the generation whose ref
    // was finalized before it was seen, even when the old receipt is unique.
    const refObservation = { branch, reason: 'retirement-provenance-unverified',
      createdAt: '2026-01-02T00:00:00.000Z', observedAt: '2026-01-03T00:00:00.000Z' };
    const finalized = { ...receipt, branchFinalization: { kind: 'deleted' }, branchFinalizedAt: '2026-01-01T01:00:00.000Z' };
    await seed('old-finalization-app', finalized, refObservation);
    const refResult = await getBranchReconcileInventory('old-finalization-app');
    expect(refResult.retired).toEqual([finalized]);
    expect(refResult.legacyRetirementTransition.resolutions).toMatchObject([{
      observation: refObservation, disposition: 'local-cleanup-not-required', removalVerified: false,
      evidence: { kind: 'current-local-absence', deliveryVerified: false, preservationVerified: false },
    }]);

    // A finalization after the observation may settle the branch-only record.
    const laterFinalized = { ...finalized, branchFinalizedAt: '2026-01-04T00:00:00.000Z' };
    await seed('later-finalization-app', laterFinalized, refObservation);
    const finalizedResult = await getBranchReconcileInventory('later-finalization-app');
    expect(finalizedResult.retired).toEqual([{ ...laterFinalized, settledObservations: [{ observation: refObservation, settledAt: expect.any(String) }] }]);
    expect(finalizedResult.legacyRetirementTransition.resolutions).toEqual([]);
  });
});
