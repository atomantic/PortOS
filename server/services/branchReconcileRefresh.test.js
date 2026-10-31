import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execGit } from '../lib/execGit.js';
import { materializeGitRepo, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const getApp = vi.hoisted(() => vi.fn());
const owners = vi.hoisted(() => vi.fn(async () => []));
vi.mock('../lib/paths.js', async importOriginal => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-refresh-inventory-'),
}));
vi.mock('./apps.js', () => ({ getAppById: getApp }));
vi.mock('./cosClaimOwnership.js', () => ({ readClaimOwnershipAgents: owners }));
vi.mock('./agentState.js', () => ({ getActiveAgentIds: () => new Set() }));
vi.mock('./userTimezone.js', () => ({ getUserTimezone: async () => 'UTC' }));
vi.mock('./supersededLedger.js', async importOriginal => ({ ...await importOriginal(), readVerdictLedger: async () => [] }));

import { PATHS } from '../lib/paths.js';
import { getBranchReconcileOutcome, recordBranchReconcileOutcome } from './branchReconcileOutcome.js';
import { refreshBranchReconcileInventory } from './branchReconcileRefresh.js';

describe.skipIf(SKIP_HEAVY_INTEGRATION)('branch reconciliation inventory refresh (real Git)', () => {
  let scratch;
  let repoPath;
  beforeAll(async () => {
    scratch = realpathSync(await mkdtemp(join(tmpdir(), 'portos-refresh-git-')));
    repoPath = join(scratch, 'repo');
    await mkdir(repoPath);
    await materializeGitRepo(repoPath);
    await execGit(['branch', 'release'], repoPath);
    getApp.mockResolvedValue({ id: 'example', repoPath });
  });
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
    await cleanupTempDataRoots();
  });

  it('replaces stale local and remote inventory while retaining missing-source evidence without changing Git or dispatching work', async () => {
    const missing = { branch: 'fix/old', path: join(scratch, 'missing'), head: 'a'.repeat(40), locked: false, lockReason: null, reason: 'checkout-retained' };
    await recordBranchReconcileOutcome('example', { status: 'incomplete', remaining: [missing, { branch: 'peer-old', reason: 'remote-branch-held' }] });
    const refs = (await execGit(['show-ref'], repoPath)).stdout;
    await writeFile(join(repoPath, 'private-untracked.txt'), 'preserve this content');
    const result = await refreshBranchReconcileInventory('example');
    expect(result.outcome).toMatchObject({ status: 'incomplete',
      remaining: [{ ...missing, reason: 'retirement-provenance-unverified', checkoutMissing: true }],
      retirementObligations: [{ ...missing, reason: 'retirement-provenance-unverified' }],
      remoteInventory: { reaped: [], reported: [] }, observedAt: expect.any(String),
    });
    expect((await execGit(['show-ref'], repoPath)).stdout).toBe(refs);
    expect(await readFile(join(repoPath, 'private-untracked.txt'), 'utf8')).toBe('preserve this content');
    const schedule = JSON.parse(await readFile(join(PATHS.cos, 'task-schedule.json'), 'utf8'));
    expect(schedule.onDemandRequests || []).toEqual([]);
    expect(schedule.executions['task:branch-reconcile'].perApp.example.lastRun).toBeFalsy();

    await execGit(['branch', 'fix/current'], repoPath);
    const current = await refreshBranchReconcileInventory('example');
    expect(current.outcome.remaining).toEqual(expect.arrayContaining([expect.objectContaining({ branch: 'fix/current', reason: 'cleanup-disabled' })]));
    expect((await execGit(['branch', '--list', 'fix/current'], repoPath)).stdout).toContain('fix/current');
  });

  it('preserves the last scan on unreadable ownership and rejects unknown targets', async () => {
    const before = await getBranchReconcileOutcome('example');
    owners.mockResolvedValueOnce(null);
    await expect(refreshBranchReconcileInventory('example')).rejects.toMatchObject({ status: 503 });
    expect(await getBranchReconcileOutcome('example')).toEqual(before);
    getApp.mockResolvedValueOnce(null);
    await expect(refreshBranchReconcileInventory('missing')).rejects.toMatchObject({ status: 404 });
  });

  it('retains a merged missing-source obligation until its retirement is verified', async () => {
    getApp.mockImplementation(async id => ['example', 'settled-app'].includes(id) ? { id, repoPath } : null);
    await execGit(['branch', '-D', 'fix/current'], repoPath).catch(() => null);
    const head = (await execGit(['rev-parse', 'HEAD'], repoPath)).stdout.trim();

    const integrated = { branch: 'claim/issue-settled', path: join(scratch, 'integrated'), head, locked: false, lockReason: null, reason: 'checkout-retained' };
    await recordBranchReconcileOutcome('settled-app', { status: 'incomplete', remaining: [integrated] });

    const result = await refreshBranchReconcileInventory('settled-app');
    expect(result.outcome).toMatchObject({ status: 'incomplete',
      retirementObligations: [{ ...integrated, reason: 'retirement-provenance-unverified' }],
      remaining: [{ ...integrated, reason: 'retirement-provenance-unverified' }],
    });
    expect(result.outcome.retired || []).toEqual([]);
  });
});
