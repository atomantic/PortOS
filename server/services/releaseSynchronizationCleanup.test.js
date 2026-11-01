import { beforeEach, describe, expect, it, vi } from 'vitest';
import { publisherCandidateTarget, RELEASE_SYNC_OBLIGATIONS } from '../lib/releaseSynchronization.js';

// Keep the test at the service boundary: all filesystem, policy and retirement
// operations are supplied below and no real task or checkout is touched.
vi.mock('./apps.js', () => ({ getAppById: vi.fn() }));
vi.mock('./worktreeManager.js', () => ({ listWorktrees: vi.fn() }));
vi.mock('./branchReconcileOutcome.js', () => ({ recordBranchReconcileOutcome: vi.fn(), getBranchReconcileOutcome: vi.fn() }));
vi.mock('./heldCheckoutRecovery.js', () => ({ prepareInventoriedCheckoutRetirement: vi.fn(), retireInventoriedCheckout: vi.fn() }));
vi.mock('./branchReconcileRetirement.js', () => ({ assertAutomaticRetirementAllowed: vi.fn() }));
vi.mock('./releaseSynchronization.js', () => ({ retainReleaseSynchronizationReview: vi.fn(), validateLockedPublisherRetirement: vi.fn() }));

import { settleInlineReleaseCheckouts } from './releaseSynchronizationCleanup.js';

const head = 'a'.repeat(40), syncHead = 'b'.repeat(40), identity = 'c'.repeat(64);
let entry, candidate, sync, deps;
beforeEach(() => {
  const pointer = { dev: '1', ino: '2', birthtimeNs: '3' };
  const seed = { version: 1, agentId: 'owner', startedAt: '2026-01-01T00:00:00Z', seededAt: '2026-01-01T00:00:01Z',
    repoPath: '/repo', path: '/candidate', branch: 'codex/release-owner', repository: pointer, checkout: pointer,
    incarnation: { pointer, gitdir: { path: '/repo/.git/worktrees/candidate', ...pointer } } };
  entry = { version: 2, registeredAt: '2026-01-01T00:01:00Z', owner: { agentId: 'owner', taskId: 'task', startedAt: seed.startedAt },
    task: { id: 'task', metadata: { app: 'app' } }, synchronization: { blocker: 'retirement:exact-retirement-receipt-unverified' },
    publication: { identity, repository: 'example/repo', candidateBranch: seed.branch,
      candidateHead: head, promotionPrNumber: 12 }, checkouts: [seed],
    obligations: Object.fromEntries(RELEASE_SYNC_OBLIGATIONS.map(name => [name, { status: 'verified' }])) };
  candidate = publisherCandidateTarget(entry);
  sync = { repoPath: '/repo', path: '/sync', branch: 'codex/release-sync-1', head: syncHead, checkoutIdentity: 'd'.repeat(64), createdAt: '2026-01-01T00:00:02Z' };
  entry.obligations.synchronizationPr.evidence = { prUrl: 'https://github.com/example/repo/pull/42', headSha: syncHead, branch: sync.branch };
  entry.obligations.retirement = { status: 'pending', evidence: { checkouts: [candidate, sync] } };
  deps = {
    getApp: vi.fn(async () => ({ id: 'app', repoPath: '/repo' })),
    listWorktrees: vi.fn(async () => [{ path: '/repo', branch: 'refs/heads/main' },
      { path: candidate.path, branch: `refs/heads/${candidate.branch}`, head, locked: true, lockReason: `Active release candidate ${candidate.branch}` },
      { path: sync.path, branch: `refs/heads/${sync.branch}`, head: syncHead, locked: false, lockReason: null }]),
    readIdentity: vi.fn(async path => path === candidate.path ? candidate.checkoutIdentity : sync.checkoutIdentity),
    getOutcome: vi.fn(async () => null),
    record: vi.fn(async () => ({})), allowed: vi.fn(async () => {}),
    prepare: vi.fn(async ({ release }) => ({ ok: true, review: { digest: 'digest', forge: { prHead: release.head },
      comparison: { disposition: 'integrated', difference: '' } } })),
    retainReview: vi.fn(async () => true), validateLocked: vi.fn(async () => true),
    retire: vi.fn(async (_input, { beforeMutation }) => { await beforeMutation(); return { ok: true, branchDeleted: true }; }),
  };
});

describe('inline release cleanup', () => {
  it('uses the normal inventory, review and retirement gates for both exact delivered heads', async () => {
    expect(await settleInlineReleaseCheckouts(entry, deps)).toEqual({ attempted: true, retired: [candidate.branch, sync.branch], held: [] });
    expect(deps.record).toHaveBeenCalledTimes(2);
    expect(deps.record).toHaveBeenCalledWith('app', expect.objectContaining({
      retirementObligations: [expect.objectContaining({ reason: 'retirement-review-pending', checkoutIdentity: candidate.checkoutIdentity })],
    }));
    expect(deps.prepare.mock.calls.map(([arg]) => arg.prUrl)).toEqual([
      'https://github.com/example/repo/pull/12', 'https://github.com/example/repo/pull/42',
    ]);
    expect(deps.retainReview).toHaveBeenCalledOnce();
    expect(deps.validateLocked).toHaveBeenCalledOnce();
    expect(deps.retire).toHaveBeenCalledTimes(2);
    expect(deps.allowed).toHaveBeenCalledTimes(4);
  });

  it.each(['candidateFixes', 'releaseAncestry', 'synchronizationPr', 'localReview', 'hostedReview', 'requiredCi', 'mergeAdmission', 'qualitySnapshot', 'processSettlement'])
  ('does not attempt cleanup until %s is verified', async name => {
    entry.obligations[name].status = 'pending';
    expect(await settleInlineReleaseCheckouts(entry, deps)).toEqual({ attempted: false });
    expect(deps.retire).not.toHaveBeenCalled();
  });

  it('leaves legacy continuations to their existing cleanup path', async () => {
    entry.version = 1;
    expect(await settleInlineReleaseCheckouts(entry, deps)).toEqual({ attempted: false });
    expect(deps.record).not.toHaveBeenCalled();
  });

  it('does not reuse old delivery receipts when the fresh PR inspection failed', async () => {
    entry.synchronization.blocker = 'synchronization-pr-identity-changed';
    expect(await settleInlineReleaseCheckouts(entry, deps)).toEqual({ attempted: false });
    expect(deps.retire).not.toHaveBeenCalled();
  });

  it('retains a changed physical generation and refuses an unverified review', async () => {
    deps.readIdentity.mockImplementation(async path => path === candidate.path ? 'changed' : sync.checkoutIdentity);
    deps.prepare.mockResolvedValue({ ok: true, review: { digest: 'digest', forge: { prHead: 'f'.repeat(40) },
      comparison: { disposition: 'integrated', difference: '' } } });
    const result = await settleInlineReleaseCheckouts(entry, deps);
    expect(result.held.map(row => row.reason)).toEqual(['release-checkout-generation-changed', 'release-retirement-review-unverified']);
    expect(deps.retire).not.toHaveBeenCalled();
  });

  it('does not unlock a candidate if its settled owner cannot be revalidated', async () => {
    deps.validateLocked.mockResolvedValue(false);
    const result = await settleInlineReleaseCheckouts(entry, deps);
    expect(result.held).toContainEqual({ branch: candidate.branch, reason: 'release-locked-owner-unverified' });
    expect(deps.retire.mock.calls.map(([arg]) => arg.release.branch)).toEqual([sync.branch]);
  });

  it('resumes only a receipt-bound partial checkout retirement after interruption', async () => {
    const trees = await deps.listWorktrees();
    deps.listWorktrees.mockResolvedValue(trees.filter(tree => tree.path !== sync.path));
    const receipt = { ...sync, branchDeleted: false, archiveDir: null, retiredAt: '2026-01-01T02:00:00Z' };
    deps.getOutcome.mockResolvedValue({ retired: [receipt], retirementReceiptEvidence: { same: receipt } });
    const result = await settleInlineReleaseCheckouts(entry, deps);
    expect(result.retired).toEqual([candidate.branch, sync.branch]);
    expect(deps.record).toHaveBeenCalledTimes(1);
    expect(deps.retire).toHaveBeenCalledWith(expect.objectContaining({ release: expect.objectContaining({
      path: sync.path, checkoutIdentity: sync.checkoutIdentity, retiredAt: receipt.retiredAt,
    }) }), expect.any(Object));
  });
});
