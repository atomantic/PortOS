import { afterAll, expect, it, vi } from 'vitest';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { lazyTempDataRoot, makePathsProxy, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async original => makePathsProxy(await original(), { dataRoot: lazyTempDataRoot('release-sync-workflow-') }));
vi.mock('./cosState.js', () => ({ loadState: async () => ({ agents: {} }), withStateLock: createFileWriteQueue() }));
vi.mock('./instanceIdentity.js', () => ({ getInstanceId: async () => 'example-instance', UNKNOWN_INSTANCE_ID: 'unknown' }));
vi.mock('./codeReview.js', () => ({ getCodeReviewDefaults: async () => ({}),
  resolveReviewLoopOptions: async () => ({ reviewers: ['codex'], optionalReviewers: [], reviewerEfforts: { codex: 'high' }, reviewerApplies: false, reviewStopMode: 'on-clean' }) }));

import { addTask, getTaskById, updateTask } from './cosTaskStore.js';
import { ensureReleaseSynchronization, releaseTaskDispatchDisposition } from './releaseSynchronization.js';
import { readReleaseSynchronizationOutbox, saveReleaseSynchronization } from './releaseSynchronizationStore.js';

afterAll(cleanupTempDataRoots);

it('registers and rejoins a real task-store continuation with its frozen review policy and evolving execution evidence', async () => {
  const source = await addTask({ description: 'Release an example app', app: 'example-app' });
  const publication = { status: 'verified', synchronizationHandoffVersion: 1, identity: 'd'.repeat(64), tag: 'v1.2.3', repository: 'example/repo' };
  const publisher = { id: 'example-publisher', taskId: source.id, startedAt: '2026-01-01T00:00:00Z', status: 'running',
    metadata: { taskAnalysisType: 'do-release', workspacePath: '/example/repository', releasePublication: publication } };
  const [first, duplicate] = await Promise.all([ensureReleaseSynchronization(publisher), ensureReleaseSynchronization(publisher)]);
  expect(duplicate).toEqual(first);
  const task = await getTaskById(first.taskId);
  expect(task).toMatchObject({ taskType: 'internal', status: 'pending', metadata: { reviewers: ['codex'], optionalReviewers: [], reviewerApplies: 'false' } });
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
  await saveReleaseSynchronization(entry);
  expect(await releaseTaskDispatchDisposition(nextRelease)).toBeNull();
});
