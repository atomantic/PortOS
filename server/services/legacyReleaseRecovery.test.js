import { beforeEach, expect, it, vi } from 'vitest';
import { retirementCheckoutIdentityFromPointer } from '../lib/retirementCheckoutObservation.js';
import { legacyRecoveryDigest } from '../lib/releaseSynchronization.js';

const f = vi.hoisted(() => ({ outcome: null, archive: null, forge: null, live: [], present: false, trees: [], remote: new Map(), current: null }));
vi.mock('node:fs/promises', async original => {
  const actual = await original();
  return { ...actual, realpath: async path => path.startsWith('/example/') ? path : actual.realpath(path) };
});
vi.mock('./completedCheckoutEvidence.js', async original => ({ ...await original(), readCompletedCheckoutIdentity: async () => f.current }));
vi.mock('./apps.js', () => ({ getAppById: async () => ({ id: 'app', repoPath: '/example/repo' }) }));
vi.mock('./taskSchedule.js', () => ({ getBranchReconcileOutcome: async () => f.outcome }));
vi.mock('./cosState.js', () => ({ readAgentsStateForSafetyCheck: async () => ({ trusted: true, agents: Object.fromEntries(f.live.map(a => [a.id, a])) }) }));
vi.mock('./heldCheckoutRecovery.js', () => ({ inspectLegacyReleaseArchive: async () => {
  if (!f.archive) throw new Error('archive-unavailable');
  return f.archive;
} }));
vi.mock('./heldCheckoutReview.js', () => ({ readRetirementForgeEvidence: async () => f.forge }));
vi.mock('./repoCleanupObservation.js', () => ({ readCheckoutPathPresence: async () => f.present, readLocalBranchPresence: async () => f.present }));
vi.mock('./worktreeManager.js', () => ({ listWorktrees: async () => f.trees }));
vi.mock('./branchReconcile.js', () => ({ listRemoteHeads: async () => f.remote }));
vi.mock('../lib/execGit.js', () => ({ execGit: async () => ({ stdout: 'git@example:repo\n' }) }));

import { inspectLegacyPublisher } from './legacyReleaseRecovery.js';

let entry, publisher, capture, receipt;
beforeEach(() => {
  const identity = 'a'.repeat(64), pointer = { dev: '1', ino: '2', birthtimeNs: '3' };
  const publication = { identity, status: 'verified', repository: 'example/repo', candidateHead: 'b'.repeat(40),
    promotionMerge: 'c'.repeat(40), promotionPrNumber: 12 };
  capture = { version: 1, agentId: 'publisher', startedAt: '2026-01-01T00:00:00Z', capturedAt: '2026-01-01T00:01:00Z',
    repoPath: '/example/repo', path: '/example/candidate', branch: 'candidate', head: publication.candidateHead,
    incarnation: { pointer, gitdir: { path: '/example/repo/.git/worktrees/candidate', ...pointer } } };
  publisher = { id: 'publisher', taskId: 'source', startedAt: capture.startedAt, completedAt: '2026-01-01T00:02:00Z', status: 'completed',
    metadata: { releasePublication: publication, completedCheckouts: [capture] } };
  entry = { identity, owner: { agentId: publisher.id, taskId: publisher.taskId, startedAt: publisher.startedAt, workspace: capture.repoPath },
    publication, task: { metadata: { app: 'app' } } };
  receipt = { path: capture.path, branch: capture.branch, head: capture.head, checkoutIdentity: retirementCheckoutIdentityFromPointer(pointer),
    archiveDir: '/example/archives/a', retiredAt: '2026-01-01T00:04:00Z', branchDeleted: true };
  f.outcome = { retired: [receipt] };
  f.archive = { archiveDir: receipt.archiveDir, archivedAt: '2026-01-01T00:03:00Z', evidenceDigest: 'd'.repeat(64),
    lifecycle: { version: 1, branch: 'candidate', origin: 'git@example:repo', base: 'release', prUrl: 'https://github.com/example/repo/pull/12',
      reviewedHead: capture.head, status: 'clean' }, recheck: async () => true };
  f.forge = { repository: 'github.com/example/repo', prUrl: 'https://github.com/example/repo/pull/12', prHead: capture.head,
    mergeCommit: publication.promotionMerge, targetBranch: 'release', scopeProof: 'exact-delivered-head' };
  f.current = capture; f.live = []; f.present = false; f.trees = [{ path: '/example/repo', branch: 'refs/heads/main' }]; f.remote = new Map();
});

it('recovers an already retired generation only from the original capture, matching preserved review and service receipt', async () => {
  const proof = await inspectLegacyPublisher(entry, [publisher]);
  expect(proof.evidence).toMatchObject({ identity: entry.identity, capture, review: { reviewedHead: capture.head }, candidateInspection: 'unverified', retirement: receipt,
    archive: { evidenceDigest: 'd'.repeat(64) } });
  expect(await inspectLegacyPublisher(entry, [publisher])).toMatchObject({ digest: proof.digest });
  const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().reverse().map(key => [key, reorder(value[key])])) : value;
  expect(legacyRecoveryDigest(reorder(proof.evidence))).toBe(proof.digest);
  expect(entry.publication).toEqual(publisher.metadata.releasePublication);
});

it('retains missing, replaced, ambiguous and actively owned candidates', async () => {
  publisher.metadata.completedCheckouts = [];
  await expect(inspectLegacyPublisher(entry, [publisher])).rejects.toMatchObject({ code: 'legacy-publisher-generation-unverified' });
  publisher.metadata.completedCheckouts = [capture, { ...capture }];
  await expect(inspectLegacyPublisher(entry, [publisher])).rejects.toMatchObject({ code: 'legacy-publisher-generation-unverified' });
  publisher.metadata.completedCheckouts = [capture];
  f.outcome = { retired: [{ ...receipt, checkoutIdentity: 'f'.repeat(64) }] };
  await expect(inspectLegacyPublisher(entry, [publisher])).rejects.toMatchObject({ code: 'legacy-retirement-preservation-unverified' });
  f.outcome = { retired: [receipt] }; f.present = true;
  await expect(inspectLegacyPublisher(entry, [publisher])).rejects.toMatchObject({ code: 'legacy-preservation-unverified' });
  f.present = false;
  f.live = [{ id: 'new-owner', status: 'running', metadata: { isWorktree: true, workspacePath: capture.path, sourceWorkspace: capture.repoPath, worktreeBranch: capture.branch } }];
  await expect(inspectLegacyPublisher(entry, [publisher])).rejects.toMatchObject({ code: 'checkout-conflicting-live-owner' });
});

it('holds missing or mismatched private review and mismatched promotion evidence', async () => {
  f.archive = null;
  await expect(inspectLegacyPublisher(entry, [publisher])).rejects.toThrow('archive-unavailable');
  f.archive = { archiveDir: receipt.archiveDir, archivedAt: '2026-01-01T00:03:00Z', evidenceDigest: 'd'.repeat(64), lifecycle: null, recheck: async () => true };
  await expect(inspectLegacyPublisher(entry, [publisher])).rejects.toMatchObject({ code: 'legacy-review-lifecycle-unverified' });
  f.forge.prHead = 'f'.repeat(40);
  await expect(inspectLegacyPublisher(entry, [publisher])).rejects.toMatchObject({ code: 'legacy-promotion-pr-mismatch' });
});


it('binds an existing preserved locked checkout and later requires its exact service retirement', async () => {
  f.present = true;
  const lock = { locked: true, lockReason: 'publisher retained' };
  f.trees.push({ path: capture.path, branch: `refs/heads/${capture.branch}`, head: capture.head, ...lock });
  const preservationReceipt = { status: 'preserved', archiveDir: receipt.archiveDir, incarnation: capture.incarnation, preparedAt: '2026-01-01T00:03:30Z' };
  f.outcome = { remaining: [{ path: capture.path, branch: capture.branch, head: capture.head, checkoutIdentity: receipt.checkoutIdentity, ...lock }],
    retirementObligations: [{ path: capture.path, branch: capture.branch, head: capture.head, checkoutIdentity: receipt.checkoutIdentity,
      checkoutIncarnation: capture.incarnation, createdAt: '2026-01-01T00:02:30Z', preservationReceipt }] };
  const proof = await inspectLegacyPublisher(entry, [publisher]);
  expect(proof.evidence).toMatchObject({ mode: 'present', preservation: { receipt: preservationReceipt, lock } });
  expect(proof.retirement).toBeNull();
  entry.legacyRecovery = { version: 1, kind: 'legacy-publisher', digest: proof.digest, evidence: proof.evidence, acceptedAt: '2026-01-01T00:05:00Z' };
  f.current = { ...capture, incarnation: { ...capture.incarnation, pointer: { ...capture.incarnation.pointer, ino: '99' } } };
  await expect(inspectLegacyPublisher(entry, [publisher])).rejects.toMatchObject({ code: 'legacy-checkout-generation-changed' });
  f.current = capture; f.present = false; f.trees = [f.trees[0]];
  f.outcome = { retired: [{ ...receipt, archiveDir: null }] };
  const after = await inspectLegacyPublisher(entry, [publisher]);
  expect(after.digest).toBe(proof.digest);
  expect(after.retirement).toMatchObject({ checkoutIdentity: receipt.checkoutIdentity, archiveDir: null });
  f.outcome = { retired: [] };
  await expect(inspectLegacyPublisher(entry, [publisher])).rejects.toMatchObject({ code: 'legacy-retirement-preservation-unverified' });
});


it('preserves a lifecycle recording an earlier revision without claiming inspection of the candidate', async () => {
  f.archive.lifecycle.reviewedHead = 'e'.repeat(40);
  const proof = await inspectLegacyPublisher(entry, [publisher]);
  expect(proof.evidence).toMatchObject({ review: { reviewedHead: 'e'.repeat(40) }, candidateInspection: 'unverified' });
});
