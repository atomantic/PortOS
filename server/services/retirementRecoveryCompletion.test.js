import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';
import { materializeGitRepo } from '../lib/gitTestRepo.js';
import { execGit } from '../lib/execGit.js';
import { readCompletedCheckoutIdentity } from './completedCheckoutEvidence.js';
import { readRetirementCheckoutIdentity } from '../lib/retirementCheckoutObservation.js';
import { listWorktrees } from './worktreeManager.js';

vi.mock('../lib/paths.js', async original => makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('portos-retirement-completion-') }));
afterAll(cleanupTempDataRoots);
const store = vi.hoisted(() => ({ task: null, parent: null, agent: null, schedule: null, app: null, owners: [], unreadable: false }));
vi.mock('./apps.js', () => ({ getAppById: vi.fn(async id => id === store.app.id ? store.app : null) }));
vi.mock('./taskScheduleStore.js', async importOriginal => ({
  ...(await importOriginal()),
  loadSchedule: async () => { if (store.unreadable) throw new Error('synthetic unreadable receipt'); return store.schedule; },
  updateSchedule: async mutate => (await mutate(store.schedule)).result,
}));
vi.mock('./cosTaskStore.js', () => ({
  getTaskById: vi.fn(async id => id === store.task?.id ? structuredClone(store.task) : null),
  updateTask: vi.fn(async (_id, patch) => {
    store.task = { ...store.task, ...patch, metadata: { ...store.task.metadata, ...patch.metadata } };
    return store.task;
  }),
}));
vi.mock('./cosState.js', async original => ({ ...await original(), loadState: vi.fn(async () => ({ agents: {} })), readAgentsStateForSafetyCheck: async () => ({ trusted: true, agents: {} }) }));
vi.mock('./instanceIdentity.js', () => ({ ensureInstanceId: vi.fn(async () => 'example-instance') }));
vi.mock('./cosClaimOwnership.js', async original => ({
  ...await original(), readClaimOwnershipAgents: vi.fn(async () => store.owners),
}));
vi.mock('./branchCompletionPolicy.js', async original => ({
  ...await original(), readBranchCompletionPolicies: vi.fn(async () => []),
}));
vi.mock('./cosAgentLifecycle.js', () => ({
  getAgent: vi.fn(async () => store.agent),
  getAgentRecord: vi.fn(async id => id === store.parent?.id ? store.parent : store.agent),
  updateAgent: vi.fn(async (_id, patch) => {
    store.agent.metadata = { ...store.agent.metadata, ...patch.metadata };
    return store.agent;
  }),
  completeAgent: vi.fn(async (_id, result) => { store.agent.status = 'completed'; store.agent.result = result; return store.agent; }),
  recordCleanupOutcome: vi.fn(async (_id, outcome) => { store.agent.metadata.cleanupOutcome = outcome; return true; }),
}));
vi.mock('./agentCompletion.js', () => ({ processAgentCompletion: vi.fn(async () => null) }));
vi.mock('./agentCompletionCleanup.js', () => ({ removeCompletionSentinel: vi.fn(async () => {}) }));
vi.mock('./agentRunTracking.js', () => ({ completeAgentRun: vi.fn(async () => null) }));
vi.mock('./codeReview.js', async original => ({ ...await original(), getGoalFidelityConfig: vi.fn(async () => null) }));
vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn(), cosEvents: { emit: vi.fn(), on: vi.fn() } }));

import { PATHS } from '../lib/paths.js';
import { getTaskById, updateTask } from './cosTaskStore.js';
import { completeAgent } from './cosAgentLifecycle.js';
import { getBranchReconcileOutcome, recordBranchReconcileOutcome } from './branchReconcileOutcome.js';
import { retireInventoriedCheckout } from './heldCheckoutRecovery.js';
import { evaluateSuccessCriteria, finalizeAgent, retireDeadAgent } from './agentFinalization.js';
import { prepareAgentSpawn } from './agentSpawnPreparation.js';
import { settleRetirementReviewRun } from './branchReconcileCompletion.js';
import { verifyRetirementRecoveryCompletion } from './retirementRecoveryCompletion.js';

let scratch;
let repo;
let release;
let target;
let startedAt;
let originalHead;
let capturedCheckout;

beforeEach(async () => {
  vi.clearAllMocks();
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = realpathSync(await mkdtemp(join(tmpdir(), 'portos-retirement-flow-')));
  repo = join(scratch, 'repo');
  await mkdir(repo);
  await materializeGitRepo(repo, { identity: { email: 'test@example.com', name: 'Test' } });
  const remote = join(scratch, 'remote.git');
  await execGit(['init', '--bare', remote], repo);
  await execGit(['remote', 'add', 'origin', remote], repo);
  await execGit(['push', 'origin', 'main'], repo);
  const path = join(scratch, 'checkout');
  const branch = 'fix/receipt-example';
  await execGit(['worktree', 'add', '-b', branch, path, 'main'], repo);
  originalHead = (await execGit(['rev-parse', 'HEAD'], repo)).stdout.trim();
  // Production inventory persists Git's path spelling, which can differ from
  // a native Windows path. Prove it names the requested physical checkout.
  const registered = (await listWorktrees(repo)).find(tree => tree.branch === `refs/heads/${branch}`);
  const checkoutIdentity = await readRetirementCheckoutIdentity(path);
  expect(Boolean(registered && checkoutIdentity
    && await readRetirementCheckoutIdentity(registered.path) === checkoutIdentity),
  'Git inventory must identify the fixture checkout').toBe(true);
  release = { branch, path: registered.path, head: originalHead, locked: false, lockReason: null,
    checkoutIdentity, observedAt: new Date().toISOString() };
  Object.assign(store, { app: { id: 'example-app', repoPath: repo }, schedule: { tasks: {}, executions: {} }, owners: [], unreadable: false });
  await recordBranchReconcileOutcome(store.app.id, { status: 'incomplete',
    worktreeInventory: [{ ...release, managed: false }],
    retirementObligations: [{ ...release, reason: 'retirement-review-pending' }] });
  capturedCheckout = await readCompletedCheckoutIdentity({ repoPath: repo, ...release });
  const obligation = (await getBranchReconcileOutcome(store.app.id)).retirementObligations[0];
  target = { appId: store.app.id, release, createdAt: obligation.createdAt };
  startedAt = Date.now();
  store.task = { id: 'sys-receipt-example', taskType: 'internal', status: 'in_progress', description: 'Finish exact cleanup', priority: 'HIGH',
    metadata: { app: store.app.id, isRecovery: true, useWorktree: false, totalSpawnCount: 2, failureCount: 1,
      recoveryOrigin: { subsystem: 'repository-cleanup', parentAgentId: 'example-parent', parentTaskId: 'sys-original', observation: 'b'.repeat(64) },
      retirementReview: target } };
  store.parent = { id: 'example-parent', taskId: 'sys-original', status: 'completed', startedAt: new Date(startedAt - 2000).toISOString(),
    completedAt: new Date(startedAt - 1).toISOString(), metadata: {
    repoStateRecoveries: { [branch]: { taskId: store.task.id, branch, repoPath: repo, retirementReview: structuredClone(target) } },
  } };
  store.agent = { id: 'example-recovery', taskId: store.task.id, startedAt: new Date(startedAt).toISOString(), status: 'running',
    metadata: { workspacePath: repo, ...store.task.metadata } };
});
afterAll(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); });

async function retire() {
  const result = await retireInventoriedCheckout({ appId: store.app.id, release }, {
    cosDir: join(scratch, 'cos'), readAgents: async () => [],
  });
  // Keep native registration failures actionable without publishing temporary paths.
  const diagnostics = result.ok ? null : await listWorktrees(repo).then(trees => ({
    checkoutExists: existsSync(release.path),
    registrations: trees.map(tree => ({
      branchMatches: tree.branch === `refs/heads/${release.branch}`,
      headMatches: tree.head === release.head,
      pathExists: existsSync(tree.path),
      resolvedPathMatches: resolve(tree.path) === resolve(release.path),
      caseFoldedPathMatches: resolve(tree.path).toLowerCase() === resolve(release.path).toLowerCase(),
      quotedPath: tree.path.startsWith('"'),
    })),
  }), error => ({ registrationError: error.code || error.name }));
  expect(result, JSON.stringify({ result, diagnostics })).toMatchObject({ ok: true, branchDeleted: true });
  expect(existsSync(release.path)).toBe(false);
}

async function finish(report, mode = 'direct') {
  const envelope = { summary: 'Exact retirement finished.', taskOutcome: { status: report, reason: 'Service retirement complete.' } };
  if (mode === 'recovered') {
    await mkdir(PATHS.cosAgents, { recursive: true });
    await writeFile(join(repo, `.agent-done-${store.agent.id}`), JSON.stringify(envelope));
    return retireDeadAgent({ agent: store.agent, task: store.task, success: true, exitCode: 0, duration: 1 });
  }
  return finalizeAgent({ agentId: store.agent.id, task: store.task, success: true, exitCode: 0, duration: 1,
    workspacePath: repo, startedAt, finalSummary: JSON.stringify(envelope), outputBuffer: '', recovery: mode === 'runner' });
}

describe('retirement recovery public completion flow', () => {
  it.each(['completed', 'no-action-needed'])('settles %s with a real retirement receipt, no new commit, and no repeat spawn', async report => {
    await retire();
    await finish(report);
    expect(store.agent.result).toMatchObject({ success: true, validationPassed: true, taskOutcome: { status: report } });
    expect(store.task.status).toBe('completed');
    expect(await settleRetirementReviewRun(store.agent)).toEqual({ verified: true });
    expect(store.agent.metadata.cleanupOutcome).toMatchObject({ status: 'verified', reason: 'retirement-receipt-verified' });
    expect(await prepareAgentSpawn(store.task)).toBeNull();
    expect(completeAgent).toHaveBeenCalledTimes(1);
    expect((await execGit(['rev-parse', 'HEAD'], repo)).stdout.trim()).toBe(originalHead);
    expect(store.task.metadata).toMatchObject({ totalSpawnCount: 2, failureCount: 1 });
  });

  it.each(['runner', 'recovered'])('uses the same receipt verdict for %s completion', async mode => {
    await retire();
    await finish('no-action-needed', mode);
    expect(store.agent.result).toMatchObject({ success: true, validationPassed: true, taskOutcome: { status: 'no-action-needed' } });
    expect(await settleRetirementReviewRun(store.agent)).toEqual({ verified: true });
  });

  it('settles an already-retired queued retry before spawn-budget rejection without rewriting its failed run', async () => {
    await retire();
    const failedRun = { success: false, validationPassed: false, taskOutcome: { status: 'incomplete', reason: 'Delivery checks did not pass.' } };
    store.agent.result = structuredClone(failedRun);
    store.agent.status = 'completed';
    store.task.status = 'pending';
    store.task.metadata.totalSpawnCount = 999;
    expect(await prepareAgentSpawn(store.task)).toBeNull();
    expect(store.task.status).toBe('completed');
    expect(store.task.metadata).toMatchObject({ totalSpawnCount: 999, failureCount: 1, retirementCompletion: { status: 'verified' } });
    expect(store.agent.result).toEqual(failedRun);
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(getTaskById).toHaveBeenCalled();
  });

  it.each(['missing', 'mismatching-head', 'stale-generation', 'unreadable', 'checkout', 'recreated-checkout', 'local-ref', 'remote-ref', 'active-owner', 'unbound', 'handoff'])('retains %s evidence gaps despite a success summary and unrelated primary commits', async fault => {
    await retire();
    const outcome = store.schedule.executions['task:branch-reconcile'].perApp[store.app.id].branchReconcileOutcome;
    if (fault === 'missing') { outcome.retired = []; outcome.retirementReceiptEvidence = {}; }
    if (fault === 'mismatching-head' || fault === 'stale-generation') {
      for (const row of [...outcome.retired, ...Object.values(outcome.retirementReceiptEvidence || {})]) {
        row[fault === 'mismatching-head' ? 'head' : 'checkoutIdentity'] = 'c'.repeat(fault === 'mismatching-head' ? 40 : 64);
      }
    }
    if (fault === 'unreadable') store.unreadable = true;
    if (fault === 'checkout') await mkdir(release.path);
    if (fault === 'recreated-checkout') await execGit(['worktree', 'add', '-b', release.branch, release.path, 'main'], repo);
    if (fault === 'local-ref' || fault === 'remote-ref') await execGit(['branch', release.branch, originalHead], repo);
    if (fault === 'remote-ref') {
      await execGit(['push', 'origin', release.branch], repo);
      await execGit(['branch', '-d', release.branch], repo);
    }
    if (fault === 'active-owner') store.owners = [{ id: 'example-owner', status: 'running', metadata: { sourceWorkspace: repo, claimBranches: [release.branch] } }];
    if (fault === 'unbound') store.parent.metadata = {};
    if (fault === 'handoff') store.parent.metadata.prCompletionPolicy = 'leave-open';
    await execGit(['commit', '--allow-empty', '-m', 'test: unrelated activity'], repo);
    const proof = await verifyRetirementRecoveryCompletion(store.task);
    expect(proof).toMatchObject({ status: 'unverified', reason: expect.any(String) });
    await finish('completed');
    expect(store.agent.result).toMatchObject({ success: false, validationPassed: false, taskOutcome: { status: 'incomplete', reason: proof.reason } });
    expect(store.task.status).not.toBe('completed');
    expect(await settleRetirementReviewRun(store.agent)).toEqual({ verified: false });
    expect(store.agent.metadata.cleanupOutcome.status).toBe('blocked');
  });


  it('recognizes an existing recovery only through its original reservation and captured physical generation', async () => {
    expect(capturedCheckout).not.toBeNull();
    await retire();
    const origin = store.task.metadata.recoveryOrigin;
    store.parent.metadata = {
      repoCleanupRecoveries: { [release.branch]: { taskId: store.task.id, observation: origin.observation } },
      completedCheckouts: [{ ...capturedCheckout, version: 1, agentId: store.parent.id, startedAt: store.parent.startedAt,
        capturedAt: store.parent.completedAt }],
    };
    const proof = await verifyRetirementRecoveryCompletion(store.task);
    expect(proof, proof.reason).toMatchObject({ status: 'verified' });
    // Path equivalence must survive removal, without reopening the checkout.
    const receipt = store.parent.metadata.completedCheckouts[0];
    receipt.path = `${capturedCheckout.path}/.`;
    const equivalentPath = await verifyRetirementRecoveryCompletion(store.task);
    expect(equivalentPath, equivalentPath.reason).toMatchObject({ status: 'verified' });
    receipt.path = `${capturedCheckout.path}-different`;
    expect(await verifyRetirementRecoveryCompletion(store.task)).toMatchObject({ status: 'unverified' });
    receipt.path = capturedCheckout.path;
    store.parent.metadata.repoCleanupRecoveries[release.branch].taskId = 'sys-different-task';
    expect(await verifyRetirementRecoveryCompletion(store.task)).toMatchObject({ status: 'unverified' });
  });

  it('leaves a queued recovery with newly-added delivery work for a fresh dequeue', async () => {
    await retire();
    store.task.status = 'pending';
    const queued = structuredClone(store.task);
    store.task.metadata.recoveryMergeTarget = { branch: release.branch, url: 'https://github.com/example/repo/pull/1' };
    expect(await prepareAgentSpawn(queued)).toBeNull();
    expect(updateTask).not.toHaveBeenCalled();
    expect(store.task.status).toBe('pending');
  });

  it('does not spawn after the fenced task update loses to a concurrent edit', async () => {
    await retire();
    store.task.status = 'pending';
    updateTask.mockResolvedValueOnce({ statusChanged: true, task: { status: 'blocked' } });
    expect(await prepareAgentSpawn(store.task)).toBeNull();
    expect(store.task.status).toBe('pending');
    expect(completeAgent).not.toHaveBeenCalled();
    expect(updateTask).toHaveBeenCalledWith(store.task.id, expect.objectContaining({ status: 'completed' }), 'internal',
      expect.objectContaining({ expectedStatus: 'pending', expectedTask: expect.any(Object), recoveryOwner: {
        id: store.parent.id, startedAt: store.parent.startedAt,
      } }));
  });

  it('keeps delivery repair and ordinary code tasks on their applicable commit gates', async () => {
    await retire();
    store.task.metadata.recoveryMergeTarget = { branch: release.branch, url: 'https://github.com/example/repo/pull/1' };
    expect(await verifyRetirementRecoveryCompletion(store.task)).toMatchObject({ status: 'verified' });
    expect(await settleRetirementReviewRun(store.agent)).toEqual({ verified: true });
    expect(await evaluateSuccessCriteria({ task: store.task, workspacePath: repo, startedAt: Date.now() + 1000, success: true })).toBe(false);
  });
});
