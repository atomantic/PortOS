import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { lazyTempDataRoot, makePathsProxy, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

const f = vi.hoisted(() => ({ agents: [], pr: null, review: null, reviews: [], checks: [], receipts: [],
  present: true, busy: false, unavailable: false, ancestor: true, quality: null, qualityFile: null, failSave: false }));
vi.mock('../lib/fileUtils.js', async original => {
  const actual = await original();
  return makePathsProxy(actual, { dataRoot: lazyTempDataRoot('release-sync-verifier-'), overrides: {
    atomicWrite: async (path, value) => {
      if (f.failSave && path.endsWith('release-synchronization.json')) throw new Error('synthetic outbox write failure');
      return actual.atomicWrite(path, value);
    },
  } });
});
vi.mock('./cosState.js', () => ({ loadState: async () => ({ agents: {} }), withStateLock: createFileWriteQueue() }));
vi.mock('./instanceIdentity.js', () => ({ getInstanceId: async () => 'example-instance', UNKNOWN_INSTANCE_ID: 'unknown' }));
vi.mock('./codeReview.js', () => ({ getCodeReviewDefaults: async () => ({}), resolveReviewLoopOptions: async () => ({
  reviewers: ['codex'], usernames: ['example-reviewer'], optionalReviewers: [], reviewerApplies: false }) }));
vi.mock('./branchCompletionPolicy.js', () => ({ readBranchCompletionPolicies: async () => structuredClone(f.agents) }));
vi.mock('./apps.js', () => ({ getAppById: async () => ({ id: 'example-app', repoPath: '/example/repo' }) }));
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: async () => ({ host: 'github.com', fullName: 'example/repo' }) }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: async () => ({}) }));
vi.mock('../lib/execGit.js', () => ({ execGit: async () => ({ stdout: f.pr.head.sha }) }));
vi.mock('./completedCheckoutEvidence.js', async original => ({ ...await original(), readCompletedCheckoutIdentity: async row =>
  f.present ? { ...row, incarnation: f.agents[1].metadata.checkoutSeeds[0].incarnation } : null }));
vi.mock('../lib/localReviewLifecycle.js', () => ({ localReviewLifecycle: async () => f.review || { reusable: false, receipt: null } }));
vi.mock('../lib/processCwdProbe.js', () => ({ hasProcessCwdInside: async () => f.busy }));
vi.mock('./repoCleanupObservation.js', () => ({ readCheckoutPathPresence: async () => f.present, readLocalBranchPresence: async () => f.present }));
vi.mock('./taskSchedule.js', () => ({ getBranchReconcileOutcome: async () => ({ retired: f.receipts }) }));
vi.mock('./shell.js', () => ({ listAllSessions: () => [] }));
vi.mock('./worktreeManager.js', () => ({ listWorktrees: async () => [{ path: '/example/repo', branch: 'refs/heads/main' }] }));
vi.mock('./branchReconcile.js', () => ({ listRemoteHeads: async () => new Map() }));
vi.mock('./mergeGateAudit.js', () => ({ readHeadCheckRuns: async () => f.checks }));
vi.mock('./appQualityFederation.js', () => ({ buildQualitySnapshot: async () => f.quality }));
vi.mock('./github.js', () => ({ execGh: async args => {
  if (f.unavailable) throw new Error('synthetic forge transport failure');
  const path = args.at(-1).replace(/^repos\/example\/repo\/?/, '');
  let result;
  if (path === '') result = { full_name: 'example/repo', default_branch: 'main', owner: { login: 'example' } };
  else if (path === 'git/ref/heads/main') result = { object: { type: 'commit', sha: 'e'.repeat(40) } };
  else if (path.startsWith('pulls?')) result = [[f.pr]];
  else if (path === 'pulls/42') result = f.pr;
  else if (path === 'pulls/42/reviews?per_page=100') result = [f.reviews];
  else if (path.startsWith('compare/')) result = { status: f.ancestor ? 'ahead' : 'diverged', merge_base_commit: { sha: path.slice(8, 48) } };
  else if (path.startsWith('contents/.quality.json?')) result = f.qualityFile;
  else throw new Error(`Unexpected synthetic forge endpoint: ${path}`);
  return JSON.stringify(result);
} }));

import { addTask, getTaskById, updateTask } from './cosTaskStore.js';
import { ensureReleaseSynchronization, verifyReleaseSynchronizationTask, recoverReleaseSynchronizationHandoffs, retainReleaseSynchronizationReview } from './releaseSynchronization.js';
import { readReleaseSynchronizationOutbox } from './releaseSynchronizationStore.js';
import { retirementCheckoutIdentityFromPointer } from '../lib/retirementCheckoutObservation.js';
import { cosEvents } from './cosEvents.js';
import { classifyQualitySnapshot, qualityFileFromWireSnapshot } from './appQualitySnapshotFormat.js';

afterAll(cleanupTempDataRoots);
let identity, taskId, publication;
const getReleaseSynchronization = async key => (await readReleaseSynchronizationOutbox()).publications[key];
beforeEach(async () => {
  f.failSave = false;
  identity = (await import('node:crypto')).randomBytes(32).toString('hex');
  const source = await addTask({ description: `Release example ${identity}`, app: 'example-app' });
  publication = { identity, status: 'verified', synchronizationHandoffVersion: 1, repository: 'example/repo', tag: `v1.2.3-${identity}`,
    candidateHead: 'a'.repeat(40), promotionMerge: 'b'.repeat(40), publishedAt: '2026-01-01T01:00:00Z' };
  const publisher = { id: `publisher-${identity}`, taskId: source.id, startedAt: '2026-01-01T00:00:00Z', status: 'completed', completedAt: '2026-01-01T01:01:00Z',
    metadata: { workspacePath: '/example/repo', releasePublication: publication } };
  ({ taskId } = await ensureReleaseSynchronization(publisher));
  const pointer = { dev: '1', ino: '2', birthtimeNs: '3' };
  const seed = { version: 1, agentId: `sync-${identity}`, startedAt: '2026-01-01T01:02:00Z', seededAt: '2026-01-01T01:02:01Z',
    repoPath: '/example/repo', path: '/example/sync-checkout', branch: 'cos/example/issue-42/example', repository: pointer, checkout: pointer,
    incarnation: { pointer, gitdir: { path: '/example/repo/.git/worktrees/example', ...pointer } } };
  f.pr = { number: 42, merged: true, merged_at: '2026-01-01T01:10:00Z', merge_commit_sha: 'd'.repeat(40),
    head: { sha: 'c'.repeat(40), ref: seed.branch, repo: { full_name: 'example/repo' } }, base: { ref: 'main', repo: { full_name: 'example/repo' } } };
  f.agents = [publisher, { id: seed.agentId, taskId, startedAt: seed.startedAt, status: 'running',
    metadata: { workspacePath: seed.path, sourceWorkspace: seed.repoPath, isWorktree: true, worktreeBranch: seed.branch,
      checkoutSeeds: [seed], mergeAdmissionHistory: [{ repository: 'github.com/example/repo', outcome: 'merged',
        acquiredAt: '2026-01-01T01:09:50Z', releasedAt: '2026-01-01T01:10:05Z' }] } }];
  f.review = { reusable: true, receipt: { version: 1, status: 'clean', reviewedHead: 'c'.repeat(40), prUrl: 'https://github.com/example/repo/pull/42' } };
  f.reviews = [{ id: 1, user: { login: 'example-reviewer' }, commit_id: f.pr.head.sha, state: 'APPROVED', submitted_at: '2026-01-01T01:08:00Z' }];
  f.checks = [{ name: 'CI Gate', status: 'completed', conclusion: 'success', completed_at: '2026-01-01T01:09:00Z' }];
  f.receipts = [];
  f.present = true;
  f.busy = false;
  f.unavailable = false;
  f.ancestor = true;
  f.quality = { schemaVersion: 1, repository: 'f'.repeat(64), measurements: [] };
});

function finishExecution() {
  const agent = f.agents[1], seed = agent.metadata.checkoutSeeds[0];
  agent.status = 'completed';
  agent.completedAt = '2026-01-01T01:12:00Z';
  agent.result = { success: true, summary: 'Everything is synchronized' };
  agent.metadata.completedCheckouts = [{ ...seed, version: 2, head: f.pr.head.sha, capturedAt: '2026-01-01T01:11:00Z' }];
  f.receipts = [{ branch: seed.branch, path: seed.path, head: f.pr.head.sha, branchDeleted: true, archiveDir: null,
    checkoutIdentity: retirementCheckoutIdentityFromPointer(seed.incarnation.pointer), retiredAt: '2026-01-01T01:13:00Z' }];
  f.present = false;
}

it('persists independent revision proofs before retirement and rejoins the same completed task after restart', async () => {
  const events = [];
  const listener = change => events.push(change);
  cosEvents.on('tasks:changed', listener);
  try {
    await Promise.all([verifyReleaseSynchronizationTask(taskId), verifyReleaseSynchronizationTask(taskId)]);
    let saved = await getReleaseSynchronization(identity);
    expect(saved.synchronization).toMatchObject({ status: 'running', attempts: 2, blocker: null });
    expect(saved.obligations.localReview.status).toBe('verified');
    expect(saved.obligations.requiredCi.evidence.headSha).toBe(f.pr.head.sha);
    finishExecution();
    await updateTask(taskId, { status: 'completed' }, 'internal');
    f.review = null;
    await verifyReleaseSynchronizationTask(taskId);
    saved = await getReleaseSynchronization(identity);
    expect(saved.synchronization.status).toBe('verified');
    expect(saved.publication).toEqual(publication);
    expect(Object.values(saved.obligations).every(value => value.status === 'verified')).toBe(true);
    expect((await ensureReleaseSynchronization(f.agents[0])).taskId).toBe(taskId);
    expect(await getTaskById(taskId)).toMatchObject({ status: 'completed' });
    expect(await verifyReleaseSynchronizationTask(taskId)).toEqual(saved.synchronization);
    expect(events.filter(change => change.action === 'release-synchronization')).toHaveLength(3);
  } finally { cosEvents.off('tasks:changed', listener); }
});

it('refuses successful terminal prose, stale hosted reviews and CI completed after the merge', async () => {
  finishExecution();
  f.reviews[0].commit_id = '0'.repeat(40);
  f.checks[0].completed_at = '2026-01-01T01:11:00Z';
  await verifyReleaseSynchronizationTask(taskId);
  const saved = await getReleaseSynchronization(identity);
  expect(saved.synchronization.status).toBe('blocked');
  expect(saved.obligations.hostedReview.blocker).toBe('required-hosted-review-unverified');
  expect(saved.obligations.requiredCi.blocker).toBe('head-ci-not-green-at-merge');
  expect(saved.obligations.localReview.blocker).toBe('local-review-lifecycle-unverified');
  expect(saved.publication).toEqual(publication);
});

it('retains successful proof and backoff on transport failure, then completes only with exact retirement generation and settled processes', async () => {
  await verifyReleaseSynchronizationTask(taskId);
  const reviewedAt = (await getReleaseSynchronization(identity)).obligations.localReview.verifiedAt;
  f.unavailable = true;
  await verifyReleaseSynchronizationTask(taskId);
  let saved = await getReleaseSynchronization(identity);
  expect(saved.synchronization).toMatchObject({ status: 'blocked', blocker: 'synchronization-evidence-unavailable' });
  expect(Date.parse(saved.synchronization.retryAt)).toBeGreaterThan(Date.parse(saved.synchronization.checkedAt));
  expect(saved.obligations.localReview.verifiedAt).toBe(reviewedAt);
  f.unavailable = false;
  const green = f.checks;
  const ciVerifiedAt = saved.obligations.requiredCi.verifiedAt;
  f.checks = null;
  await verifyReleaseSynchronizationTask(taskId);
  expect((await getReleaseSynchronization(identity)).obligations.requiredCi).toMatchObject({ status: 'verified', verifiedAt: ciVerifiedAt });
  f.checks = [{ ...green[0], conclusion: 'failure' }];
  await verifyReleaseSynchronizationTask(taskId);
  expect((await getReleaseSynchronization(identity)).obligations.requiredCi.status).toBe('blocked');
  f.checks = green;
  finishExecution();
  f.receipts[0].checkoutIdentity = '0'.repeat(64);
  await verifyReleaseSynchronizationTask(taskId);
  expect((await getReleaseSynchronization(identity)).obligations.retirement.blocker).toBe('exact-retirement-receipt-unverified');
  f.receipts[0].checkoutIdentity = retirementCheckoutIdentityFromPointer(f.agents[1].metadata.checkoutSeeds[0].incarnation.pointer);
  f.busy = true;
  await verifyReleaseSynchronizationTask(taskId);
  expect((await getReleaseSynchronization(identity)).obligations.processSettlement.blocker).toBe('checkout-processes-unsettled');
  f.busy = false;
  expect((await verifyReleaseSynchronizationTask(taskId)).status).toBe('verified');
});

it('keeps an approval through a comment-only review, but honors a subsequent change request on that head', async () => {
  f.reviews.push({ ...f.reviews[0], id: 2, state: 'COMMENTED', submitted_at: '2026-01-01T01:08:30Z' });
  await verifyReleaseSynchronizationTask(taskId);
  expect((await getReleaseSynchronization(identity)).obligations.hostedReview.status).toBe('verified');
  f.reviews.push({ ...f.reviews[0], id: 3, state: 'CHANGES_REQUESTED', submitted_at: '2026-01-01T01:09:00Z' });
  await verifyReleaseSynchronizationTask(taskId);
  expect((await getReleaseSynchronization(identity)).obligations.hostedReview.status).toBe('blocked');
});

it('rejects a conflicting live checkout owner without modifying the dispatch, and never waives missing candidate ancestry', async () => {
  const seed = f.agents[1].metadata.checkoutSeeds[0];
  f.agents.push({ id: 'other-owner', taskId: 'other-task', startedAt: '2026-01-01T01:03:00Z', status: 'running',
    metadata: { isWorktree: true, workspacePath: seed.path, sourceWorkspace: seed.repoPath, worktreeBranch: seed.branch } });
  await verifyReleaseSynchronizationTask(taskId);
  expect((await getReleaseSynchronization(identity)).synchronization.blocker).toBe('checkout-conflicting-live-owner');
  f.agents.pop();
  f.ancestor = false;
  await verifyReleaseSynchronizationTask(taskId);
  const saved = await getReleaseSynchronization(identity);
  expect(saved.obligations.candidateFixes.blocker).toBe('candidate-fixes-not-preserved');
  expect(saved.obligations.releaseAncestry.blocker).toBe('published-ancestry-not-preserved');
  expect((await getTaskById(taskId)).metadata.releaseSynchronization.identity).toBe(identity);
});

it('requires development quality evidence and refreshes it without redoing a successful local review', async () => {
  f.quality = { ...f.quality, measurements: [{ measurementId: 'a'.repeat(64), assessedAt: '2026-01-01T00:00:00Z',
    report: { version: 1, category: 'security', score: 80, worstSeverity: 5, coverage: 'broad', confidence: 'high', scannedFiles: 2, totalFiles: 2 } }] };
  f.qualityFile = { encoding: 'base64', sha: '9'.repeat(40), content: Buffer.from(qualityFileFromWireSnapshot({ ...f.quality, measurements: [] })).toString('base64') };
  await verifyReleaseSynchronizationTask(taskId);
  expect((await getReleaseSynchronization(identity)).obligations.qualitySnapshot.status).toBe('blocked');
  const body = qualityFileFromWireSnapshot(f.quality);
  expect(classifyQualitySnapshot(body).status).toBe('v2');
  f.qualityFile.content = Buffer.from(body).toString('base64');
  finishExecution();
  f.review = null;
  expect((await verifyReleaseSynchronizationTask(taskId)).status).toBe('verified');
});

it('leaves an unstarted continuation pending and respects durable retry times during recovery sweeps', async () => {
  f.agents = [f.agents[0]];
  await verifyReleaseSynchronizationTask(taskId);
  const saved = await getReleaseSynchronization(identity);
  expect(saved.synchronization.status).toBe('pending');
  await recoverReleaseSynchronizationHandoffs(f.agents);
  expect((await getReleaseSynchronization(identity)).synchronization.attempts).toBe(saved.synchronization.attempts);
});

it('withholds retirement without local proof, then retains the completed PR delivery phase across later hosted-review heads', async () => {
  f.pr.merged = false;
  const seed = f.agents[1].metadata.checkoutSeeds[0];
  const release = { branch: seed.branch, path: seed.path, head: f.pr.head.sha,
    checkoutIdentity: retirementCheckoutIdentityFromPointer(seed.incarnation.pointer) };
  f.review = null;
  expect(await retainReleaseSynchronizationReview(release)).toBe(false);
  f.review = { reusable: true, receipt: { status: 'clean', reviewedHead: f.pr.head.sha } };
  expect(await retainReleaseSynchronizationReview(release)).toBe(true);
  f.pr.head.sha = '8'.repeat(40);
  f.pr.merged = true;
  f.review = null;
  expect(await retainReleaseSynchronizationReview({ ...release, head: f.pr.head.sha })).toBe(true);
  const saved = await getReleaseSynchronization(identity);
  expect(saved.obligations.localReview).toMatchObject({ status: 'verified', evidence: { headSha: release.head,
    receipt: { reviewedHead: release.head } } });
  expect(saved.obligations.hostedReview.status).toBe('blocked');
  const owner = f.agents[1];
  owner.status = 'completed';
  owner.completedAt = '2026-01-01T01:12:00Z';
  owner.metadata.completedCheckouts = [{ ...seed, version: 2, head: f.pr.head.sha, capturedAt: '2026-01-01T01:11:00Z' }];
  const nextSeed = structuredClone(seed);
  Object.assign(nextSeed, { agentId: `resumed-${identity}`, startedAt: '2026-01-01T01:14:00Z', seededAt: '2026-01-01T01:14:01Z' });
  nextSeed.incarnation.pointer.ino = '4';
  f.agents.push({ id: nextSeed.agentId, taskId, startedAt: nextSeed.startedAt, status: 'running',
    metadata: { ...owner.metadata, checkoutSeeds: [nextSeed], completedCheckouts: [] } });
  expect(await retainReleaseSynchronizationReview({ ...release, head: f.pr.head.sha,
    checkoutIdentity: retirementCheckoutIdentityFromPointer(nextSeed.incarnation.pointer) })).toBe(true);
  expect((await getReleaseSynchronization(identity)).obligations.retirement.evidence.checkouts).toHaveLength(2);
});

it('does not publish verification or lose original evidence when its durable write fails', async () => {
  await verifyReleaseSynchronizationTask(taskId);
  const prior = await getReleaseSynchronization(identity);
  finishExecution();
  f.failSave = true;
  await expect(verifyReleaseSynchronizationTask(taskId)).rejects.toThrow('synthetic outbox write failure');
  expect(await getReleaseSynchronization(identity)).toEqual(prior);
  f.failSave = false;
  expect((await verifyReleaseSynchronizationTask(taskId)).status).toBe('verified');
});
