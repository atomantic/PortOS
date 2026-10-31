import { pinPlatform } from '../lib/testHelper.js';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { lazyTempDataRoot, makePathsProxy, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

const f = vi.hoisted(() => ({ agents: [], pr: null, review: null, reviews: [], checks: [], receipts: [],
  present: true, busy: false, unavailable: false, ancestor: true, quality: null, qualityFile: null, failSave: false,
  missingSyncAncestry: false, retirementUnavailable: false, liveAgents: null, liveTrusted: true,
  forgeCalls: 0 }));
vi.mock('../lib/fileUtils.js', async original => {
  const actual = await original();
  return makePathsProxy(actual, { dataRoot: lazyTempDataRoot('release-sync-verifier-'), overrides: {
    atomicWrite: async (path, value) => {
      if (f.failSave && path.endsWith('release-synchronization.json')) throw new Error('synthetic outbox write failure');
      return actual.atomicWrite(path, value);
    },
  } });
});
vi.mock('node:fs/promises', async original => {
  const actual = await original();
  // Native node:path keeps the host dialect even while process.platform is pinned.
  // Map only synthetic fixture paths back to their POSIX keys; real I/O stays native.
  const fixturePath = path => typeof path === 'string' ? path.replaceAll('\\', '/').replace(/^[a-z]:/i, '') : path;
  return { ...actual, realpath: async path => typeof path === 'string' && fixturePath(path).startsWith('/example/')
    ? fixturePath(path) : actual.realpath(path) };
});
vi.mock('./cosState.js', () => ({ loadState: async () => ({ agents: {} }), withStateLock: createFileWriteQueue(),
  readAgentsStateForSafetyCheck: async () => ({ trusted: f.liveTrusted,
    agents: Object.fromEntries((f.liveAgents || f.agents).map(agent => [agent.id, agent])) }) }));
vi.mock('./instanceIdentity.js', () => ({ getInstanceId: async () => 'example-instance', UNKNOWN_INSTANCE_ID: 'unknown' }));
vi.mock('./codeReview.js', () => ({ getCodeReviewDefaults: async () => ({}), resolveReviewLoopOptions: async () => ({
  reviewers: ['codex'], usernames: ['example-reviewer'], optionalReviewers: [], reviewerApplies: false }) }));
vi.mock('./branchCompletionPolicy.js', () => ({ readBranchCompletionPolicies: vi.fn(async () => structuredClone(f.agents)) }));
vi.mock('./apps.js', () => ({ getAppById: async () => ({ id: 'example-app', repoPath: '/example/repo' }) }));
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: async () => ({ host: 'github.com', fullName: 'example/repo' }) }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: async () => ({}) }));
vi.mock('../lib/execGit.js', () => ({ execGit: async () => ({ stdout: f.pr.head.sha }) }));
vi.mock('./completedCheckoutEvidence.js', async original => ({ ...await original(), readCompletedCheckoutIdentity: async row =>
  f.present ? { ...row, incarnation: f.agents[1].metadata.checkoutSeeds[0].incarnation } : null }));
vi.mock('../lib/localReviewLifecycle.js', () => ({ localReviewLifecycle: async path => path === '/example/publisher-checkout'
  ? { reusable: false, legacyPublished: true, receipt: null } : f.review || { reusable: false, receipt: null } }));
vi.mock('../lib/localReviewAttribution.js', () => ({ localReviewAttributionLabels: async () => [] }));
vi.mock('../lib/windowsAgentProcess.js', () => ({ readWindowsAgentSettlement: async agent => {
  if (f.busy) throw Object.assign(new Error('synthetic unavailable native proof'), { code: 'WINDOWS_AGENT_PROCESS_UNVERIFIED' });
  return { owner: { agentId: agent.id, startedAt: agent.startedAt }, active: 0 };
} }));
vi.mock('../lib/processCwdProbe.js', () => ({ hasProcessCwdInside: async () => f.busy }));
vi.mock('./repoCleanupObservation.js', () => ({ readCheckoutPathPresence: async () => f.present, readLocalBranchPresence: async () => f.present }));
vi.mock('./branchReconcileOutcome.js', () => ({ getBranchReconcileOutcome: async () => {
  if (f.retirementUnavailable) throw new Error('synthetic retirement transport failure');
  return { retired: f.receipts };
} }));
vi.mock('./shell.js', () => ({ listAllSessions: () => [] }));
vi.mock('./worktreeManager.js', () => ({ listWorktrees: async () => [{ path: '/example/repo', branch: 'refs/heads/main' }] }));
vi.mock('./branchReconcile.js', () => ({ listRemoteHeads: async () => new Map() }));
vi.mock('./appQualityFederation.js', () => ({ buildQualitySnapshot: async () => f.quality }));
vi.mock('./github.js', () => ({ execGh: async args => {
  f.forgeCalls++;
  if (f.unavailable) throw new Error('synthetic forge transport failure');
  const path = args.at(-1).replace(/^repos\/example\/repo\/?/, '');
  let result;
  if (path === '') result = { full_name: 'example/repo', default_branch: 'main', owner: { login: 'example' } };
  else if (path === 'git/ref/heads/main') result = { object: { type: 'commit', sha: 'e'.repeat(40) } };
  else if (path.startsWith('pulls?')) result = [[f.pr]];
  else if (path === 'pulls/42') result = f.pr;
  else if (path === 'pulls/42/reviews?per_page=100') result = [f.reviews];
  else if (path.startsWith('compare/')) result = { status: f.ancestor
    && !(f.missingSyncAncestry && path === `compare/${f.pr.head.sha}...${'e'.repeat(40)}`) ? 'ahead' : 'diverged', merge_base_commit: { sha: path.slice(8, 48) } };
  else if (path.startsWith('contents/.quality.json?')) result = f.qualityFile;
  else throw new Error(`Unexpected synthetic forge endpoint: ${path}`);
  return JSON.stringify(result);
} }));

import { addTask, getTaskById, updateTask } from './cosTaskStore.js';
import { readBranchCompletionPolicies } from './branchCompletionPolicy.js';
import { ensureReleaseSynchronization, verifyReleaseSynchronizationTask, recoverReleaseSynchronizationHandoffs, retainReleaseSynchronizationReview,
  releaseTaskDispatchDisposition } from './releaseSynchronization.js';
import { readReleaseSynchronizationOutbox, saveReleaseSynchronization } from './releaseSynchronizationStore.js';
import { projectTaskReleaseMilestones } from './releaseSynchronizationProjection.js';
import { retirementCheckoutIdentityFromPointer } from '../lib/retirementCheckoutObservation.js';
import { cosEvents } from './cosEvents.js';
import { classifyQualitySnapshot, qualityFileFromWireSnapshot } from './appQualitySnapshotFormat.js';
import { PATHS } from '../lib/fileUtils.js';

let restorePlatform;
afterEach(() => restorePlatform?.());
afterAll(cleanupTempDataRoots);
let identity, taskId, publication;
const getReleaseSynchronization = async key => (await readReleaseSynchronizationOutbox()).publications[key];
beforeEach(async () => {
  await rm(join(PATHS.cos, 'release-synchronization.json'), { force: true });
  f.forgeCalls = 0;
  f.liveAgents = null;
  f.liveTrusted = true;
  // POSIX settlement is the default contract; the native Windows test overrides it.
  restorePlatform = pinPlatform('darwin');
  f.failSave = false;
  identity = (await import('node:crypto')).randomBytes(32).toString('hex');
  const source = await addTask({ description: `Release example ${identity}`, app: 'example-app' });
  publication = { identity, status: 'verified', synchronizationHandoffVersion: 1, repository: 'example/repo', tag: `v1.2.3-${identity}`,
    candidateHead: 'a'.repeat(40), candidateBranch: 'codex/release-publisher', promotionPrNumber: 12, promotionMerge: 'b'.repeat(40), publishedAt: '2026-01-01T01:00:00Z' };
  const publisherPointer = { dev: '1', ino: '5', birthtimeNs: '3' };
  const publisherSeed = { version: 1, agentId: `publisher-${identity}`, startedAt: '2026-01-01T00:00:00Z', seededAt: '2026-01-01T00:00:01Z',
    repoPath: '/example/repo', path: '/example/publisher-checkout', branch: publication.candidateBranch, repository: publisherPointer, checkout: publisherPointer,
    incarnation: { pointer: publisherPointer, gitdir: { path: '/example/repo/.git/worktrees/publisher', ...publisherPointer } } };
  const publisher = { id: `publisher-${identity}`, taskId: source.id, startedAt: '2026-01-01T00:00:00Z', status: 'completed', completedAt: '2026-01-01T01:01:00Z',
    metadata: { workspacePath: '/example/repo', releasePublication: publication, checkoutSeeds: [publisherSeed],
      completedCheckouts: [{ ...publisherSeed, version: 2, head: publication.candidateHead, capturedAt: '2026-01-01T01:00:50Z' }] } };
  ({ taskId } = await ensureReleaseSynchronization(publisher));
  const pointer = { dev: '1', ino: '2', birthtimeNs: '3' };
  const seed = { version: 1, agentId: `sync-${identity}`, startedAt: '2026-01-01T01:02:00Z', seededAt: '2026-01-01T01:02:01Z',
    repoPath: '/example/repo', path: '/example/sync-checkout', branch: 'cos/example/issue-42/example', repository: pointer, checkout: pointer,
    incarnation: { pointer, gitdir: { path: '/example/repo/.git/worktrees/example', ...pointer } } };
  f.pr = { number: 42, merged: true, merged_at: '2026-01-01T01:10:00Z', merge_commit_sha: 'd'.repeat(40),
    head: { sha: 'c'.repeat(40), ref: seed.branch, repo: { full_name: 'example/repo' } }, base: { ref: 'main', repo: { full_name: 'example/repo' } } };
  f.agents = [publisher, { id: seed.agentId, taskId, startedAt: seed.startedAt, status: 'running',
    metadata: { workspacePath: seed.path, sourceWorkspace: seed.repoPath, isWorktree: true, worktreeBranch: seed.branch,
      checkoutSeeds: [seed] } }];
  f.review = { reusable: true, receipt: { version: 1, status: 'clean', reviewedHead: 'c'.repeat(40), prUrl: 'https://github.com/example/repo/pull/42' } };
  f.reviews = [{ id: 1, user: { login: 'example-reviewer' }, commit_id: f.pr.head.sha, state: 'APPROVED', submitted_at: '2026-01-01T01:08:00Z' }];
  f.checks = [{ name: 'CI Gate', status: 'completed', conclusion: 'success', completed_at: '2026-01-01T01:09:00Z' }];
  f.receipts = [];
  f.present = true;
  f.busy = false;
  f.unavailable = false;
  f.ancestor = true;
  f.missingSyncAncestry = false;
  f.retirementUnavailable = false;
  f.quality = { schemaVersion: 1, repository: 'f'.repeat(64), measurements: [] };
});

async function finishExecution({ retain = true } = {}) {
  const agent = f.agents[1], seed = agent.metadata.checkoutSeeds[0];
  const publisherSeed = f.agents[0].metadata.checkoutSeeds[0];
  if (retain) expect(await retainReleaseSynchronizationReview({ branch: publisherSeed.branch, path: publisherSeed.path, head: publication.candidateHead,
    checkoutIdentity: retirementCheckoutIdentityFromPointer(publisherSeed.incarnation.pointer) })).toBe(true);
  agent.status = 'completed';
  agent.completedAt = '2026-01-01T01:12:00Z';
  agent.result = { success: true, summary: 'Everything is synchronized' };
  agent.metadata.completedCheckouts = [{ ...seed, version: 2, head: f.pr.head.sha, capturedAt: '2026-01-01T01:11:00Z' }];
  f.receipts = [{ branch: seed.branch, path: seed.path, head: f.pr.head.sha, branchDeleted: true, archiveDir: null,
    checkoutIdentity: retirementCheckoutIdentityFromPointer(seed.incarnation.pointer), retiredAt: '2026-01-01T01:13:00Z' },
  { branch: publisherSeed.branch, path: publisherSeed.path, head: publication.candidateHead, branchDeleted: true, archiveDir: null,
    checkoutIdentity: retirementCheckoutIdentityFromPointer(publisherSeed.incarnation.pointer), retiredAt: '2026-01-01T01:13:00Z' }];
  f.present = false;
}

it('preserves an already-verified synchronization without a publisher seed and allows unrelated checkouts to retire', async () => {
  await finishExecution();
  expect((await verifyReleaseSynchronizationTask(taskId)).status).toBe('verified');
  const valid = await getReleaseSynchronization(identity);
  const legacyIdentity = (await import('node:crypto')).randomBytes(32).toString('hex');
  const source = await addTask({ description: 'Legacy publisher', app: 'example-app' });
  const legacyPublication = { ...publication, identity: legacyIdentity, tag: `v9.9.9-${legacyIdentity}` };
  delete legacyPublication.candidateBranch; // old publication receipts did not store this field
  const publisher = { ...f.agents[0], id: `old-${legacyIdentity}`, taskId: source.id,
    metadata: { workspacePath: '/example/repo', releasePublication: legacyPublication } };
  const legacyTask = (await ensureReleaseSynchronization(publisher)).taskId;
  const old = await getReleaseSynchronization(legacyIdentity);
  old.synchronization = valid.synchronization;
  old.obligations = valid.obligations;
  await saveReleaseSynchronization(old);
  f.agents = [publisher, { ...f.agents[1], taskId: legacyTask }];
  const projected = projectTaskReleaseMilestones({ id: legacyTask, metadata: {} }, old);
  expect(projected.metadata.releasePublication).toEqual(old.publication);
  expect(projected.metadata.releaseSynchronization).toMatchObject({ status: 'verified' });
  expect(await releaseTaskDispatchDisposition({ metadata: { analysisType: 'do-release', app: 'example-app' } })).toBeNull();
  expect(await retainReleaseSynchronizationReview({ repoPath: '/example/repo', branch: 'some-unknown-branch', path: '/example/publisher-checkout', head: publication.candidateHead })).toBe(true);
  expect(await verifyReleaseSynchronizationTask(legacyTask)).toMatchObject({ status: 'verified', blocker: null });
  expect((await getReleaseSynchronization(legacyIdentity)).publication).toEqual(old.publication);
});


it('treats an accepted archive-backed legacy recovery as an unseeded publication', async () => {
  await finishExecution();
  const syncAgent = f.agents[1];
  const id = '9'.repeat(64);
  const source = await addTask({ description: 'Old publisher', app: 'example-app' });
  const legacyPublication = { ...publication, identity: id, tag: `v9.9.9-${id}` };
  delete legacyPublication.candidateBranch;
  const oldSeed = f.agents[0].metadata.checkoutSeeds[0];
  const capture = { version: 1, agentId: 'old-publisher', startedAt: oldSeed.startedAt, capturedAt: '2026-01-01T01:00:50Z',
    repoPath: oldSeed.repoPath, path: oldSeed.path, branch: oldSeed.branch, head: legacyPublication.candidateHead, incarnation: oldSeed.incarnation };
  const publisher = { ...f.agents[0], id: capture.agentId, taskId: source.id,
    metadata: { workspacePath: capture.repoPath, releasePublication: legacyPublication, completedCheckouts: [capture] } };
  const legacyTask = (await ensureReleaseSynchronization(publisher)).taskId;
  syncAgent.taskId = legacyTask;
  f.agents = [publisher, syncAgent];
  // Receipt shape written by installs that still had checkout archives.
  const legacyRecovery = { version: 1, kind: 'legacy-publisher', digest: '1'.repeat(64), acceptedAt: '2026-01-01T02:00:00Z',
    evidence: { identity: id, capture, mode: 'present', archive: { archiveDir: '/example/archive/candidate' } } };
  await saveReleaseSynchronization({ ...await getReleaseSynchronization(id), legacyRecovery });
  expect(await verifyReleaseSynchronizationTask(legacyTask)).toMatchObject({ status: 'blocked', blocker: 'publisher-candidate-checkout-unverified' });
  const saved = await getReleaseSynchronization(id);
  expect(saved.legacyRecovery).toEqual(legacyRecovery);
  expect(projectTaskReleaseMilestones({ id: legacyTask, metadata: {} }, saved).metadata.releaseSynchronization.nextAction).toContain('operator reset');
  // The captured checkout no longer holds retirement on the old recovery's behalf.
  expect(await retainReleaseSynchronizationReview({ repoPath: capture.repoPath, path: capture.path, branch: capture.branch, head: capture.head,
    checkoutIdentity: retirementCheckoutIdentityFromPointer(capture.incarnation.pointer) })).toBe(true);
});

it('allows unrelated checkouts to retire when an unseeded publisher exists without blocking claim branches', async () => {
  const id = '6'.repeat(64), source = await addTask({ description: 'Primary checkout publisher', app: 'example-app' });
  const legacyPublication = { ...publication, identity: id, tag: `v6.6.6-${id}` };
  delete legacyPublication.candidateBranch;
  const publisher = { ...f.agents[0], id: 'primary-publisher', taskId: source.id,
    metadata: { workspacePath: '/example/repo', releasePublication: legacyPublication } };
  const legacyTask = (await ensureReleaseSynchronization(publisher)).taskId;
  f.agents[1].taskId = legacyTask;
  f.agents.push(publisher);
  const release = { repoPath: '/example/repo', path: '/example/other-checkout', branch: 'claim/issue-42', head: 'f'.repeat(40), checkoutIdentity: '1'.repeat(64) };
  expect(await retainReleaseSynchronizationReview(release)).toBe(true);
  const syncSeed = f.agents[1].metadata.checkoutSeeds[0];
  expect(await retainReleaseSynchronizationReview({ ...release, branch: syncSeed.branch, path: syncSeed.path,
    checkoutIdentity: retirementCheckoutIdentityFromPointer(syncSeed.incarnation.pointer) })).toBe(false);
});

it('requires the publisher private-review observation as well as both exact retirement receipts', async () => {
  await finishExecution({ retain: false });
  await verifyReleaseSynchronizationTask(taskId);
  expect((await getReleaseSynchronization(identity)).obligations.retirement.blocker).toBe('publisher-private-review-unretained');
  const seed = f.agents[0].metadata.checkoutSeeds[0];
  expect(await retainReleaseSynchronizationReview({ branch: seed.branch, path: seed.path, head: publication.candidateHead,
    checkoutIdentity: retirementCheckoutIdentityFromPointer(seed.incarnation.pointer) })).toBe(true);
  const saved = await getReleaseSynchronization(identity);
  expect(saved.obligations.retirement.evidence.publisherReview).toMatchObject({ receipt: null, models: [], head: publication.candidateHead });
  expect((await verifyReleaseSynchronizationTask(taskId)).status).toBe('verified');
});

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
    await finishExecution();
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
    expect(events.filter(change => change.action === 'release-synchronization')).toHaveLength(4);
  } finally { cosEvents.off('tasks:changed', listener); }
});

it('accepts provider-confirmed merge without a second review, CI or admission certificate', async () => {
  await finishExecution();
  f.review = null;
  f.reviews = [];
  f.checks = [{ conclusion: 'failure' }];
  await verifyReleaseSynchronizationTask(taskId);
  const saved = await getReleaseSynchronization(identity);
  expect(saved.synchronization.status).toBe('verified');
  for (const name of ['localReview', 'hostedReview', 'requiredCi', 'mergeAdmission']) {
    expect(saved.obligations[name]).toMatchObject({ status: 'verified', evidence: { authority: 'hosting-provider', headSha: f.pr.head.sha } });
  }
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
  expect((await getReleaseSynchronization(identity)).obligations.requiredCi.status).toBe('verified');
  f.checks = green;
  await finishExecution();
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

it('does not reopen confirmed delivery when review history changes after merge', async () => {
  f.reviews.push({ ...f.reviews[0], id: 2, state: 'COMMENTED', submitted_at: '2026-01-01T01:08:30Z' });
  await verifyReleaseSynchronizationTask(taskId);
  expect((await getReleaseSynchronization(identity)).obligations.hostedReview.status).toBe('verified');
  f.reviews.push({ ...f.reviews[0], id: 3, state: 'CHANGES_REQUESTED', submitted_at: '2026-01-01T01:09:00Z' });
  await verifyReleaseSynchronizationTask(taskId);
  expect((await getReleaseSynchronization(identity)).obligations.hostedReview.status).toBe('verified');
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

it('keeps compact historical completions out of live ownership checks while refusing an unreadable current registry', async () => {
  await finishExecution();
  f.liveAgents = [...f.agents];
  f.agents.push({ id: 'historical-compact-record', agentId: 'historical-compact-record',
    taskId: 'old-task', completedAt: '2025-12-01T00:00:00Z', exitCode: 0, success: true });
  f.liveTrusted = false;
  expect((await verifyReleaseSynchronizationTask(taskId)).blocker).toBe('checkout-ownership-unreadable');
  f.liveTrusted = true;
  expect((await verifyReleaseSynchronizationTask(taskId)).status).toBe('verified');
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
  await finishExecution();
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

it('withholds retirement until provider-confirmed merge and retains each checkout generation', async () => {
  f.pr.merged = false;
  const seed = f.agents[1].metadata.checkoutSeeds[0];
  const release = { branch: seed.branch, path: seed.path, head: f.pr.head.sha,
    checkoutIdentity: retirementCheckoutIdentityFromPointer(seed.incarnation.pointer) };
  f.review = null;
  expect(await retainReleaseSynchronizationReview(release)).toBe(false);
  f.review = { reusable: true, receipt: { status: 'clean', reviewedHead: f.pr.head.sha } };
  expect(await retainReleaseSynchronizationReview(release)).toBe(false);
  f.pr.head.sha = '8'.repeat(40);
  f.pr.merged = true;
  f.review = null;
  expect(await retainReleaseSynchronizationReview({ ...release, head: f.pr.head.sha })).toBe(true);
  const saved = await getReleaseSynchronization(identity);
  expect(saved.obligations.localReview).toMatchObject({ status: 'verified', evidence: { headSha: f.pr.head.sha, authority: 'hosting-provider' } });
  expect(saved.obligations.hostedReview.status).toBe('verified');
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
  expect((await getReleaseSynchronization(identity)).obligations.retirement.evidence.checkouts).toHaveLength(3);
});

it('does not publish verification or lose original evidence when its durable write fails', async () => {
  await verifyReleaseSynchronizationTask(taskId);
  await finishExecution();
  const prior = await getReleaseSynchronization(identity);
  f.failSave = true;
  await expect(verifyReleaseSynchronizationTask(taskId)).rejects.toThrow('synthetic outbox write failure');
  expect(await getReleaseSynchronization(identity)).toEqual(prior);
  f.failSave = false;
  expect((await verifyReleaseSynchronizationTask(taskId)).status).toBe('verified');
});

it('refuses a squash-shaped result that contains the promotion but loses the synchronization head ancestry', async () => {
  f.missingSyncAncestry = true;
  await verifyReleaseSynchronizationTask(taskId);
  const saved = await getReleaseSynchronization(identity);
  expect(saved.obligations.synchronizationPr.blocker).toBe('synchronization-head-not-on-development');
  expect(saved.obligations.releaseAncestry.status).toBe('verified');
  expect(saved.synchronization.status).toBe('blocked');
});

it('retains complete retirement receipts on an unreadable follow-up while another obligation is blocked', async () => {
  await verifyReleaseSynchronizationTask(taskId);
  await finishExecution();
  const approval = f.reviews;
  f.reviews = [];
  await verifyReleaseSynchronizationTask(taskId);
  const prior = (await getReleaseSynchronization(identity)).obligations.retirement;
  expect(prior.status).toBe('verified');
  expect(prior.evidence.receipts).toHaveLength(2);
  f.retirementUnavailable = true;
  await verifyReleaseSynchronizationTask(taskId);
  expect((await getReleaseSynchronization(identity)).obligations.retirement).toEqual(prior);
  f.reviews = approval;
  expect((await verifyReleaseSynchronizationTask(taskId)).status).toBe('verified');
});

it('requires Windows native tree proof independently of completed task prose and binds it to retained checkout generations', async () => {
  restorePlatform();
  restorePlatform = pinPlatform('win32');
  await verifyReleaseSynchronizationTask(taskId);
  await finishExecution();
  f.busy = true;
  await verifyReleaseSynchronizationTask(taskId);
  let saved = await getReleaseSynchronization(identity);
  expect(saved.obligations.processSettlement).toMatchObject({ status: 'blocked', blocker: 'WINDOWS_AGENT_PROCESS_UNVERIFIED' });
  expect(saved.publication).toEqual(publication);
  expect(saved.obligations.retirement.status).not.toBe('verified');
  f.busy = false;
  expect(await verifyReleaseSynchronizationTask(taskId)).toMatchObject({ status: 'verified', blocker: null });
  saved = await getReleaseSynchronization(identity);
  expect(saved.obligations.processSettlement.evidence.receipts).toHaveLength(2);
  expect(saved.obligations.processSettlement.evidence.checkouts.find(row => row.agentId === f.agents[1].id).checkoutIdentity)
    .toBe(retirementCheckoutIdentityFromPointer(f.agents[1].metadata.checkoutSeeds[0].incarnation.pointer));
});
