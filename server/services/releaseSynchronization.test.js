import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { lazyTempDataRoot, makePathsProxy, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';
import { retirementCheckoutIdentityFromPointer } from '../lib/retirementCheckoutObservation.js';

vi.mock('../lib/fileUtils.js', async original => makePathsProxy(await original(), { dataRoot: lazyTempDataRoot('release-sync-workflow-') }));
vi.mock('./cosState.js', () => ({ loadState: async () => ({ agents: {} }), withStateLock: createFileWriteQueue() }));
const settlement = vi.hoisted(() => vi.fn(async () => true));
vi.mock('./releaseProcessSettlement.js', () => ({ publisherProcessesSettled: settlement }));
vi.mock('./branchCompletionPolicy.js', () => ({ readBranchCompletionPolicies: async () => [] }));
vi.mock('./instanceIdentity.js', () => ({ getInstanceId: async () => 'example-instance', UNKNOWN_INSTANCE_ID: 'unknown' }));
const policy = vi.hoisted(() => ({ app: {}, reviews: {} }));
vi.mock('./apps.js', () => ({ getAppById: async () => policy.app }));
vi.mock('./codeReview.js', () => ({ getCodeReviewDefaults: async () => ({}),
  resolveReviewLoopOptions: async () => structuredClone(policy.reviews) }));

import { addTask, getTaskById, updateTask } from './cosTaskStore.js';
import { ensureReleaseSynchronization, recoverReleaseSynchronizationHandoffs, releaseTaskDispatchDisposition, validateLockedPublisherRetirement } from './releaseSynchronization.js';
import { readReleaseSynchronizationOutbox, saveReleaseSynchronization } from './releaseSynchronizationStore.js';

import { inlinePrLifecycleSection, buildInlineReviewLoopSection } from './promptSections/completion.js';
import { buildLocalReviewLoopSection } from './promptSections/reviewLifecycle.js';
import { resolvePrCompletion } from '../lib/prDisposition.js';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { PATHS, atomicWrite } from '../lib/fileUtils.js';

const promptOptions = { providerType: 'cli', providerId: 'codex', providerCommand: 'codex',
  leanMode: false, worktreeInfo: { branchName: 'sync', baseBranch: 'main' } };
const renderDelivery = task => {
  const section = inlinePrLifecycleSection(task, promptOptions);
  const reviewPolicy = { ...task.metadata, forgeReviewerUsernames: task.metadata.usernames };
  return { section, local: section === 'review-loop' ? buildLocalReviewLoopSection({
    taskId: task.id, branchName: 'sync', baseBranch: 'main', reviewPolicy }) : '',
  hosted: section ? buildInlineReviewLoopSection({ taskId: task.id, branchName: 'sync',
    runsReviewLoop: section === 'review-loop', reviewPolicy }) : '' };
};
beforeEach(() => {
  policy.app = { id: 'example-app', defaultPrCompletion: 'review-then-merge' };
  policy.reviews = { reviewers: ['codex', 'copilot'], usernames: [], optionalReviewers: ['codex'],
    reviewerModels: { codex: 'gpt-6.1-terra' }, reviewerMaxRounds: { codex: 3 },
    reviewerEfforts: { codex: 'high' }, reviewerApplies: false, reviewStopMode: 'on-clean' };
});
afterAll(cleanupTempDataRoots);

it('registers and rejoins a real task-store continuation with its frozen review policy and evolving execution evidence', async () => {
  const source = await addTask({ description: 'Release an example app', app: 'example-app' });
  const publication = { status: 'verified', synchronizationHandoffVersion: 1, identity: 'd'.repeat(64), tag: 'v1.2.3', repository: 'example/repo',
    candidateBranch: 'codex/release-publisher', candidateHead: 'a'.repeat(40), promotionPrNumber: 12 };
  const pointer = { dev: '1', ino: '2', birthtimeNs: '3' };
  const seed = { version: 1, agentId: 'example-publisher', startedAt: '2026-01-01T00:00:00Z', seededAt: '2026-01-01T00:00:01Z',
    repoPath: '/example/repository', path: '/example/publisher', branch: publication.candidateBranch, repository: pointer, checkout: pointer,
    incarnation: { pointer, gitdir: { path: '/example/repository/.git/worktrees/publisher', ...pointer } } };
  const publisher = { id: 'example-publisher', taskId: source.id, startedAt: '2026-01-01T00:00:00Z', status: 'running',
    metadata: { taskAnalysisType: 'do-release', workspacePath: '/example/repository', releasePublication: publication, checkoutSeeds: [seed] } };
  const [first, duplicate] = await Promise.all([ensureReleaseSynchronization(publisher), ensureReleaseSynchronization(publisher)]);
  expect(duplicate).toEqual(first);
  const task = await getTaskById(first.taskId);
  expect(task).toMatchObject({ taskType: 'internal', status: 'pending', metadata: { reviewers: ['codex', 'copilot'], optionalReviewers: ['codex'], reviewerApplies: 'false', prCompletion: 'review-then-merge' } });
  const rendered = renderDelivery(task);
  expect(rendered.section).toBe('review-loop');
  expect(rendered.local).toContain('gpt-6.1-terra');
  expect(rendered.local).toContain('codex[gpt-6.1-terra]~opt~max=3');
  expect(rendered.local).toMatch(/optional/i);
  expect(rendered.hosted).toMatch(/Copilot/i);
  const frozen = (await readReleaseSynchronizationOutbox()).publications[publication.identity].task;
  policy.app.defaultPrCompletion = 'merge-on-green';
  policy.reviews = { reviewers: [], optionalReviewers: [] };
  await recoverReleaseSynchronizationHandoffs([]);
  expect((await readReleaseSynchronizationOutbox()).publications[publication.identity].task).toEqual(frozen);
  expect(renderDelivery(await getTaskById(task.id))).toEqual(rendered);
  await updateTask(task.id, { status: 'in_progress', metadata: { totalSpawnCount: 1, reviewLoopPRUrl: 'https://github.com/example/repo/pull/42' } }, 'internal');
  expect(await ensureReleaseSynchronization(publisher)).toEqual(first);
  expect((await getTaskById(task.id)).metadata.reviewLoopPRUrl).toBe('https://github.com/example/repo/pull/42');
  expect((await readReleaseSynchronizationOutbox()).publications[publication.identity].obligations.requiredCi.status).toBe('pending');

  // Registration survives a restart/re-read without requiring a fictitious
  // release-sync schedule. A changed task cannot borrow that exemption.
  const saved = await getTaskById(first.taskId);
  expect(await releaseTaskDispatchDisposition(saved)).toBe('registered-continuation');
  expect(await releaseTaskDispatchDisposition({ ...saved, id: 'another-task' })).toBeNull();
  expect(await releaseTaskDispatchDisposition({ ...saved, metadata: { ...saved.metadata, app: 'another-app' } })).toBeNull();

  // main may still carry 1.2.2 after 1.2.3 publishes. Do not start another
  // daily release/version selection until the existing synchronization settles.
  const nextRelease = { metadata: { analysisType: 'do-release', app: 'example-app' } };
  expect(await releaseTaskDispatchDisposition(nextRelease)).toBe('wait-for-synchronization');
  expect(await releaseTaskDispatchDisposition({ metadata: { analysisType: 'do-release', app: 'other-app' } })).toBeNull();
  const entry = (await readReleaseSynchronizationOutbox()).publications[publication.identity];
  entry.synchronization = { status: 'verified', attempts: 1, checkedAt: '2026-01-01T02:00:00Z',
    verifiedAt: '2026-01-01T02:00:00Z', retryAt: null, blocker: null };
  for (const name of Object.keys(entry.obligations)) entry.obligations[name] = {
    status: 'verified', verifiedAt: '2026-01-01T02:00:00Z', evidence: { source: 'test-fixture' } };
  entry.obligations.retirement.evidence.publisherReview = { branch: seed.branch, path: seed.path, head: publication.candidateHead,
    checkoutIdentity: retirementCheckoutIdentityFromPointer(pointer), prUrl: 'https://github.com/example/repo/pull/12', receipt: null, models: [] };
  const target = { agentId: seed.agentId, repoPath: seed.repoPath, branch: seed.branch, path: seed.path, head: publication.candidateHead,
    checkoutIdentity: retirementCheckoutIdentityFromPointer(pointer), createdAt: seed.seededAt };
  entry.obligations.retirement.evidence.checkouts = [target];
  entry.obligations.retirement.evidence.receipts = [{ ...target, branchDeleted: true, archiveDir: null, retiredAt: '2026-01-01T01:00:00Z' }];
  await saveReleaseSynchronization(entry);
  expect(await releaseTaskDispatchDisposition(nextRelease)).toBeNull();
  const locked = { ...target, locked: true, lockReason: 'fixture lock' };
  expect(await validateLockedPublisherRetirement(locked)).toBe(true);
  settlement.mockResolvedValueOnce(false);
  expect(await validateLockedPublisherRetirement(locked)).toBe(false);
  expect(await validateLockedPublisherRetirement({ ...locked, checkoutIdentity: 'different-generation' })).toBe(false);
  entry.obligations.retirement.evidence.publisherReview = null;
  await saveReleaseSynchronization(entry);
  expect(await validateLockedPublisherRetirement(locked)).toBe(false);
});


it.each([
  [{ prCompletion: 'merge-on-green' }, 'review-then-merge', 'merge-on-green', 'merge-gate'],
  [{ prCompletion: 'review-then-merge' }, 'merge-on-green', 'review-then-merge', 'review-loop'],
  [{ prCompletion: 'leave-open' }, 'review-then-merge', 'leave-open', null],
  [{ reviewLoop: true }, undefined, 'review-then-merge', 'review-loop'],
  [{ reviewLoop: false }, undefined, 'merge-on-green', 'merge-gate'],
  [{ reviewLoop: false }, 'review-then-merge', 'review-then-merge', 'review-loop'],
  [{ reviewLoopLeaveOpen: true }, 'review-then-merge', 'leave-open', null],
  [{}, 'leave-open', 'leave-open', null],
])('freezes source %j against app %s through delivery', async (metadata, appDefault, expected, section) => {
  policy.app.defaultPrCompletion = appDefault;
  const source = await addTask({ description: `Release policy fixture ${randomBytes(8).toString('hex')}`, app: 'example-app', metadata });
  const publication = { status: 'verified', synchronizationHandoffVersion: 1, identity: randomBytes(32).toString('hex'),
    tag: `v1.2.3-${randomBytes(8).toString('hex')}`, repository: 'example/repo' };
  const publisher = { id: 'policy-publisher', taskId: source.id, startedAt: '2026-01-01T00:00:00Z',
    metadata: { workspacePath: '/example/repo', releasePublication: publication } };
  const { taskId } = await ensureReleaseSynchronization(publisher);
  const saved = await getTaskById(taskId);
  expect(resolvePrCompletion(saved.metadata)).toBe(expected);
  expect(inlinePrLifecycleSection(saved, promptOptions)).toBe(section);
});

it('retains an empty reviewer roster and holds ambiguous old entries without changing immutable evidence or budgets', async () => {
  policy.reviews = { reviewers: [], optionalReviewers: [] };
  const source = await addTask({ description: 'Legacy release fixture', app: 'example-app' });
  const publication = { status: 'verified', synchronizationHandoffVersion: 1, identity: randomBytes(32).toString('hex'),
    tag: `v1.2.3-${randomBytes(8).toString('hex')}`, repository: 'example/repo' };
  const publisher = { id: 'legacy-publisher', taskId: source.id, startedAt: '2026-01-01T00:00:00Z',
    metadata: { workspacePath: '/example/repo', releasePublication: publication } };
  const { taskId } = await ensureReleaseSynchronization(publisher);
  expect((await getTaskById(taskId)).metadata.reviewers).toEqual([]);
  const old = (await readReleaseSynchronizationOutbox()).publications[publication.identity];
  delete old.task.metadata.prCompletion;
  // Seed the on-disk shape an older version wrote; the normal store correctly
  // refuses rewriting an existing continuation's frozen metadata.
  const outbox = await readReleaseSynchronizationOutbox();
  outbox.publications[publication.identity] = old;
  await atomicWrite(join(PATHS.cos, 'release-synchronization.json'), outbox);
  await updateTask(taskId, { metadata: { totalSpawnCount: 2, reviewLoopPRUrl: 'https://github.com/example/repo/pull/42' } }, 'internal');
  const taskBefore = await getTaskById(taskId);
  expect(await releaseTaskDispatchDisposition(taskBefore)).toBe('review-policy-unverified');
  await expect(ensureReleaseSynchronization(publisher)).rejects.toMatchObject({ code: 'RELEASE_SYNC_REVIEW_POLICY_UNVERIFIED' });
  await recoverReleaseSynchronizationHandoffs([]);
  const retained = (await readReleaseSynchronizationOutbox()).publications[publication.identity];
  expect(retained).toMatchObject({ task: old.task, publication: old.publication, owner: old.owner,
    checkouts: old.checkouts, attempts: old.attempts });
  expect(await getTaskById(taskId)).toEqual(taskBefore);
  // Explicit legacy toggles remain usable without consulting current app defaults.
  old.task.metadata.reviewLoop = 'true';
  outbox.publications[publication.identity] = old;
  await atomicWrite(join(PATHS.cos, 'release-synchronization.json'), outbox);
  expect(await releaseTaskDispatchDisposition({ ...taskBefore, metadata: {
    ...old.task.metadata, idempotencyKey: taskBefore.metadata.idempotencyKey } })).toBe('registered-continuation');
});
