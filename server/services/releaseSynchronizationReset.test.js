import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execGit } from '../lib/execGit.js';
import { lazyTempDataRoot, makePathsProxy, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';
import { RELEASE_SYNC_OBLIGATIONS } from '../lib/releaseSynchronization.js';

vi.mock('../lib/fileUtils.js', async original => makePathsProxy(await original(), { dataRoot: lazyTempDataRoot('release-sync-reset-') }));
const ownership = vi.hoisted(() => ({ agents: [], active: [], runner: [], task: null, updates: [], updateResult: null, inventory: [], current: true }));
vi.mock('../lib/retirementCheckoutObservation.js', async original => ({ ...(await original()), isCurrentRetirementCheckout: async () => ownership.current }));
vi.mock('./cosClaimOwnershipState.js', () => ({
  withClaimOwnershipLock: work => work(), readClaimOwnershipAgents: async () => ownership.agents,
}));
vi.mock('./agentState.js', () => ({ getActiveAgentIds: () => ownership.active }));
vi.mock('./cosRunnerClient.js', () => ({ getActiveAgentsFromRunner: async () => ownership.runner }));
vi.mock('./branchReconcileOutcome.js', () => ({ getBranchReconcileOutcome: async () => ({ remaining: ownership.inventory }) }));
vi.mock('./branchCompletionPolicy.js', () => ({ readBranchCompletionPolicies: async () => [] }));
vi.mock('./cosTaskStore.js', () => ({ getTaskById: async id => ownership.task?.id === id ? ownership.task : null,
  updateTask: async (id, patch) => { ownership.updates.push({ id, patch }); if (ownership.updateResult) return ownership.updateResult;
    ownership.task = { ...ownership.task, ...patch }; return ownership.task; },
  addTask: async () => { throw new Error('Unexpected retired continuation registration'); } }));

import { readReleaseSynchronizationOutbox, saveReleaseSynchronization } from './releaseSynchronizationStore.js';
import { resetReleaseSynchronization, releaseTaskDispatchDisposition, retainReleaseSynchronizationReview, recoverReleaseSynchronizationHandoffs } from './releaseSynchronization.js';

afterAll(cleanupTempDataRoots);
beforeEach(() => { ownership.agents = []; ownership.active = []; ownership.runner = []; ownership.task = null; ownership.updates = []; ownership.updateResult = null; ownership.inventory = []; ownership.current = true; });
const fixture = identity => ({ version: 1, identity,
  owner: { agentId: 'publisher', taskId: 'original', startedAt: '2026-01-01T00:00:00Z', workspace: tmpdir() },
  publication: { identity, status: 'verified', tag: 'v1.2.3' },
  task: { id: `task-release-sync-${identity}`, metadata: { app: 'example', analysisType: 'release-sync', releaseSynchronization: { identity } } },
  obligations: Object.fromEntries(RELEASE_SYNC_OBLIGATIONS.map(key => [key, { status: 'pending' }])), checkouts: [],
  registeredAt: '2026-01-01T00:00:00Z', attempts: 0, lastAttemptAt: null, blocker: null, retryAt: null,
  synchronization: { status: 'blocked', attempts: 1, checkedAt: '2026-01-01T00:00:00Z',
    verifiedAt: null, retryAt: null, blocker: 'publisher-candidate-checkout-unverified' } });

it('retires only the selected stale checkpoint without claiming historical success', async () => {
  const identity = 'a'.repeat(64), entry = fixture(identity), reason = 'Start a fresh release from main';
  await saveReleaseSynchronization(entry);
  const task = { metadata: { app: 'example', analysisType: 'do-release' } };
  const checkout = { path: '/example/old', branch: 'old', head: 'b'.repeat(40), checkoutIdentity: 'c'.repeat(64) };
  ownership.task = { ...entry.task, status: 'pending' };
  expect(await releaseTaskDispatchDisposition(task)).toBe('wait-for-synchronization');
  await expect(resetReleaseSynchronization(identity, reason, 'local-operator', [checkout])).rejects.toThrow('current inventory');
  ownership.inventory = [checkout];
  ownership.current = false;
  await expect(resetReleaseSynchronization(identity, reason, 'local-operator', [checkout])).rejects.toThrow('changed since the inventory');
  ownership.current = true;
  const receipt = await resetReleaseSynchronization(identity, reason, 'local-operator', [checkout]);
  expect(receipt).toMatchObject({ identity, reason, previousStatus: 'blocked', previousBlocker: 'publisher-candidate-checkout-unverified' });
  expect(ownership.task.status).toBe('blocked');
  expect(await resetReleaseSynchronization(identity, reason, 'local-operator', [checkout])).toEqual(receipt);
  await expect(resetReleaseSynchronization(identity, 'Different decision', 'local-operator')).rejects.toThrow('different operator reset');
  const saved = (await readReleaseSynchronizationOutbox()).publications[identity];
  expect(saved.synchronization).toEqual(entry.synchronization);
  expect(saved.obligations).toEqual(entry.obligations);
  expect(await releaseTaskDispatchDisposition(task)).toBeNull();
  expect(await releaseTaskDispatchDisposition(saved.task)).toBe('retired-continuation');
  const release = { repoPath: tmpdir(), ...checkout };
  expect(await retainReleaseSynchronizationReview(release)).toBe(true);
  for (const changed of [{ checkoutIdentity: 'd'.repeat(64) }, { branch: 'another' }, { head: 'e'.repeat(40) }]) {
    expect(await retainReleaseSynchronizationReview({ ...release, ...changed })).toBe(true);
  }
  await expect(saveReleaseSynchronization({ ...saved, operatorReset: undefined })).rejects.toThrow('immutable ownership');
  const other = fixture('d'.repeat(64));
  await saveReleaseSynchronization(other);
  expect(await releaseTaskDispatchDisposition(task)).toBe('wait-for-synchronization');
  await resetReleaseSynchronization(other.identity, reason, 'local-operator');
});

it('refuses to reset while a release or synchronization for the repository is active', async () => {
  const identity = 'e'.repeat(64);
  await saveReleaseSynchronization(fixture(identity));
  ownership.agents = [{ id: 'active-release', status: 'running', metadata: { taskAnalysisType: 'do-release', workspacePath: tmpdir() } }];
  await expect(resetReleaseSynchronization(identity, 'Start a fresh release', 'local-operator')).rejects.toThrow('still active');
  ownership.agents[0].status = 'completed'; ownership.active = ['active-release'];
  await expect(resetReleaseSynchronization(identity, 'Start a fresh release', 'local-operator')).rejects.toThrow('still active');
  ownership.agents = []; ownership.active = ['dispatching'];
  await expect(resetReleaseSynchronization(identity, 'Start a fresh release', 'local-operator')).rejects.toThrow('Agent ownership is unavailable');
  ownership.active = [];
  ownership.agents = [{ id: 'publisher', taskId: 'original', status: 'completed', metadata: { useRunner: true } }];
  ownership.runner = [{ id: 'publisher', liveness: 'pty', processActive: true }];
  await expect(resetReleaseSynchronization(identity, 'Start a fresh release', 'local-operator')).rejects.toThrow('still active');
  ownership.agents[0].metadata = { executionMode: 'runner' };
  await expect(resetReleaseSynchronization(identity, 'Start a fresh release', 'local-operator')).rejects.toThrow('still active');
  ownership.agents = [{ id: 'another-release', status: 'completed', metadata: { taskAnalysisType: 'do-release', useRunner: true, workspacePath: tmpdir() } }];
  ownership.runner = [{ id: 'another-release', liveness: 'pty', processActive: true }];
  await expect(resetReleaseSynchronization(identity, 'Start a fresh release', 'local-operator')).rejects.toThrow('still active');
  ownership.runner = [];
  ownership.agents = null;
  await expect(resetReleaseSynchronization(identity, 'Start a fresh release', 'local-operator')).rejects.toThrow('ownership is unavailable');
  ownership.agents = [];
  await resetReleaseSynchronization(identity, 'Start a fresh release', 'local-operator');
});

it('retains the reset and retries parking when the task changed during the write', async () => {
  const identity = '2'.repeat(64), entry = fixture(identity), reason = 'Start from main';
  await saveReleaseSynchronization(entry);
  ownership.task = { ...entry.task, status: 'pending' };
  ownership.updateResult = { statusChanged: true, task: { ...entry.task, status: 'in_progress' } };
  await expect(resetReleaseSynchronization(identity, reason, 'local-operator')).rejects.toThrow('checkpoint was recorded');
  expect((await readReleaseSynchronizationOutbox()).publications[identity].operatorReset.reason).toBe(reason);
  ownership.updateResult = null;
  await recoverReleaseSynchronizationHandoffs([]);
  expect(ownership.task.status).toBe('blocked');
  await resetReleaseSynchronization(identity, reason, 'local-operator');
});

it('does not recreate an unregistered retired continuation', async () => {
  const identity = 'f'.repeat(64), entry = { ...fixture(identity), registeredAt: null };
  await saveReleaseSynchronization(entry);
  await resetReleaseSynchronization(identity, 'Start from main', 'local-operator');
  expect(await releaseTaskDispatchDisposition(entry.task)).toBe('retired-continuation');
  await recoverReleaseSynchronizationHandoffs([]);
  const saved = (await readReleaseSynchronizationOutbox()).publications[identity];
  expect(saved.registeredAt).toBeNull();
  expect(saved.synchronization).toEqual(entry.synchronization);
});

it('recognizes a live release in a linked worktree and holds on unreadable repository identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'portos-reset-repo-'));
  const repo = join(root, 'repo'), checkout = join(root, 'checkout'), other = join(root, 'not-a-repo');
  try {
    await mkdir(repo); await mkdir(other);
    await execGit(['init', '-b', 'main'], repo);
    await execGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial'], repo);
    await execGit(['worktree', 'add', '-b', 'release-active', checkout], repo);
    const identity = '1'.repeat(64), entry = fixture(identity);
    entry.owner.workspace = repo;
    await saveReleaseSynchronization(entry);
    ownership.agents = [{ id: 'other-release', status: 'running', metadata: { taskAnalysisType: 'do-release', workspacePath: checkout } }];
    await expect(resetReleaseSynchronization(identity, 'Start from main', 'local-operator')).rejects.toThrow('still active');
    ownership.agents[0].metadata.workspacePath = other;
    await expect(resetReleaseSynchronization(identity, 'Start from main', 'local-operator')).rejects.toThrow('still active');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
