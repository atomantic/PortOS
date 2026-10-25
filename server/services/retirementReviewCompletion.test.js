import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';
import { materializeGitRepo } from '../lib/gitTestRepo.js';
import { execGit } from '../lib/execGit.js';
import { readRetirementCheckoutIdentity } from '../lib/retirementCheckoutObservation.js';

const fixture = vi.hoisted(() => ({ taskFile: null, parent: null, app: null, schedule: null, agents: [], active: [], policy: null, writes: 0, run: null }));
vi.mock('../lib/paths.js', async original => makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('portos-receipt-completion-') }));
vi.mock('./cos.js', () => ({}));
vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn(), cosEvents: { emit: vi.fn() } }));
vi.mock('./apps.js', () => ({ getAppById: async id => id === fixture.app?.id ? fixture.app : null }));
vi.mock('./cosAgentLifecycle.js', () => ({
  getAgentRecord: async id => id === fixture.parent?.id ? fixture.parent : fixture.run,
  getAgent: async () => fixture.run,
  updateAgent: async (_id, patch) => { fixture.run = { ...fixture.run, ...patch, metadata: { ...fixture.run.metadata, ...patch.metadata } }; return fixture.run; },
  completeAgent: async (_id, result) => { fixture.run = { ...fixture.run, status: 'completed', result }; return fixture.run; },
}));
vi.mock('./agentCompletion.js', () => ({ processAgentCompletion: async () => null }));
vi.mock('./codeReview.js', async original => ({ ...await original(), getGoalFidelityConfig: vi.fn(async () => null) }));
vi.mock('./taskTypeHooks.js', async original => ({ ...await original(), isProgrammaticIoTaskType: () => false, getTaskOutputHook: async () => null }));
vi.mock('./agentState.js', async original => ({ ...await original(), getActiveAgentIds: () => fixture.active }));
vi.mock('./cosClaimOwnership.js', async original => ({ ...await original(), readClaimOwnershipAgents: async () => fixture.agents }));
vi.mock('./branchCompletionPolicy.js', async original => ({ ...await original(), readBranchCompletionHold: async () => fixture.policy }));
vi.mock('./taskScheduleStore.js', async original => ({ ...await original(), loadSchedule: async () => fixture.schedule,
  updateSchedule: async mutate => { const output = await mutate(fixture.schedule); return output.result; } }));
vi.mock('./cosTaskStore.js', () => ({
  getTaskById: async () => JSON.parse(await readFile(fixture.taskFile, 'utf8')),
  updateTask: async (_id, patch, _type, options = {}) => {
    const current = JSON.parse(await readFile(fixture.taskFile, 'utf8'));
    if (options.expectedTask && Object.entries(options.expectedTask).some(([key, value]) => !isDeepStrictEqual(current[key], value))) return { statusChanged: true, task: current };
    const next = { ...current, ...patch, metadata: { ...current.metadata, ...patch.metadata } };
    fixture.writes++; await writeFile(fixture.taskFile, JSON.stringify(next)); return next;
  },
}));
const { PATHS } = await import('../lib/paths.js');
const { recordBranchReconcileOutcome, getBranchReconcileOutcome } = await import('./taskSchedule.js');
const { retireInventoriedCheckout } = await import('./heldCheckoutRecovery.js');
const { verifyRetirementReviewCompletion, settleRetirementReviewBeforeSpawn } = await import('./retirementReviewCompletion.js');
afterAll(cleanupTempDataRoots);

let root, repo, path, branch, head, task, release;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'receipt-completion-git-'));
  repo = join(root, 'repo'); branch = 'fix/delivered';
  await materializeGitRepo(repo);
  repo = await realpath(repo); path = join(repo, '.claude', 'worktrees', 'delivered');
  await execGit(['worktree', 'add', '-b', branch, path, 'main'], repo);
  head = (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim();
  release = { path, branch, head, checkoutIdentity: await readRetirementCheckoutIdentity(path), locked: false, lockReason: null };
  fixture.schedule = { tasks: {}, executions: {} }; fixture.agents = []; fixture.active = []; fixture.policy = null; fixture.writes = 0;
  fixture.app = { id: 'fixture-app', repoPath: repo };
  await recordBranchReconcileOutcome(fixture.app.id, { status: 'incomplete', retirementObligations: [{ ...release, reason: 'retirement-review-pending' }] });
  const obligation = (await getBranchReconcileOutcome(fixture.app.id)).retirementObligations[0];
  task = { id: 'cleanup-task', taskType: 'internal', status: 'pending', metadata: {
    totalSpawnCount: 3, failureCount: 2, recoveryOrigin: { subsystem: 'repository-cleanup', parentAgentId: 'original-agent', observation: 'original-observation' },
    retirementReview: { appId: fixture.app.id, release, createdAt: obligation.createdAt },
  } };
  fixture.parent = { id: 'original-agent', status: 'completed', metadata: { sourceWorkspace: repo, workspacePath: path,
    repoCleanupRecoveries: { [branch]: { taskId: task.id, observation: 'original-observation', retirementReview: structuredClone(task.metadata.retirementReview) } } } };
  fixture.run = { id: 'cleanup-run', taskId: task.id, status: 'running', startedAt: new Date().toISOString(), output: [], metadata: { workspacePath: repo } };
  fixture.taskFile = join(root, 'task.json'); await writeFile(fixture.taskFile, JSON.stringify(task));
});
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3 }); });

async function receipt() {
  // Use the supported merged-clean transaction: no archive or shell teardown.
  const result = await retireInventoriedCheckout({ appId: fixture.app.id, release }, { cosDir: PATHS.cos,
    readAgents: async () => [], readPolicies: async () => [] });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, branchDeleted: true });
  expect(result.archiveDir ?? null).toBeNull();
  expect((await getBranchReconcileOutcome(fixture.app.id)).retired[0].archiveDir).toBeNull();
}

describe('assigned cleanup receipt completion (real Git and persisted task)', () => {
  it('retires through the service without a commit, then completes the original retry once without changing budgets', async () => {
    await receipt();
    expect(await verifyRetirementReviewCompletion(task)).toMatchObject({ status: 'verified', release });
    expect((await execGit(['rev-parse', 'HEAD'], repo)).stdout.trim()).toBe(head);
    await Promise.all([settleRetirementReviewBeforeSpawn(task), settleRetirementReviewBeforeSpawn(task)]);
    expect(await settleRetirementReviewBeforeSpawn(task)).toBe(true);
    const current = JSON.parse(await readFile(fixture.taskFile, 'utf8'));
    expect(current).toMatchObject({ status: 'completed', metadata: { totalSpawnCount: 3, failureCount: 2,
      taskOutcome: { status: 'no-action-needed' }, retirementCompletion: { status: 'verified' } } });
    expect(fixture.writes).toBe(1);
    expect((await getBranchReconcileOutcome(fixture.app.id)).retired).toHaveLength(1);
  });

  it.each(['completed', 'no-action-needed'])('uses the real receipt verdict in shared finalization with no source commit (%s)', async status => {
    await receipt();
    const { finalizeAgent } = await import('./agentFinalization.js');
    await finalizeAgent({ agentId: fixture.run.id, task, success: true, exitCode: 0, duration: 100,
      workspacePath: repo, startedAt: Date.parse(fixture.run.startedAt),
      finalSummary: JSON.stringify({ summary: 'Exact target retired.', taskOutcome: { status, reason: 'Service receipt confirmed.' } }) });
    const { getGoalFidelityConfig } = await import('./codeReview.js');
    expect(getGoalFidelityConfig).not.toHaveBeenCalled();
    expect(fixture.run.result).toMatchObject({ success: true, executionSuccess: true, validationPassed: true, taskOutcome: { status } });
    expect(JSON.parse(await readFile(fixture.taskFile, 'utf8'))).toMatchObject({ status: 'completed', metadata: { totalSpawnCount: 3, failureCount: 2 } });
    expect((await execGit(['rev-parse', 'HEAD'], repo)).stdout.trim()).toBe(head);
    expect(await settleRetirementReviewBeforeSpawn(task)).toBe(true);
    expect(fixture.writes).toBe(1);
  });

  it('requires the protected assignment even when writable task metadata names a valid receipt', async () => {
    await receipt();
    task.metadata.retirementReview.createdAt = new Date(Date.parse(task.metadata.retirementReview.createdAt) - 1000).toISOString();
    await writeFile(fixture.taskFile, JSON.stringify(task));
    expect(await verifyRetirementReviewCompletion(task)).toMatchObject({ status: 'unverified', reason: 'cleanup-target-binding-unverified' });
  });

  it('accepts a legacy backlink only with its original independently captured generation', async () => {
    const { readCompletedCheckoutIdentity } = await import('./completedCheckoutEvidence.js');
    const identity = await readCompletedCheckoutIdentity({ repoPath: repo, ...release });
    const capturedAt = new Date().toISOString();
    fixture.parent.startedAt = new Date(Date.now() - 1000).toISOString(); fixture.parent.completedAt = capturedAt;
    fixture.parent.metadata.completedCheckouts = [{ ...identity, version: 1, agentId: fixture.parent.id,
      startedAt: fixture.parent.startedAt, capturedAt }];
    delete fixture.parent.metadata.repoCleanupRecoveries[branch].retirementReview;
    await receipt();
    expect(await verifyRetirementReviewCompletion(task)).toMatchObject({ status: 'verified' });
    fixture.parent.metadata.completedCheckouts[0].incarnation.pointer.ino = 'changed';
    expect(await verifyRetirementReviewCompletion(task)).toMatchObject({ status: 'unverified', reason: 'cleanup-target-binding-unverified' });
  });

  it.each(['missing', 'wrong-generation', 'stale-receipt', 'parent-active', 'unreadable', 'present-checkout', 'registration-only', 'present-ref', 'active-owner', 'human-handoff', 'changed-assignment'])(
    'keeps %s unresolved without a completion write', async reason => {
      await receipt();
      if (reason === 'missing') {
        const outcome = await getBranchReconcileOutcome(fixture.app.id);
        outcome.retired = []; outcome.retirementReceiptEvidence = {};
      }
      if (reason === 'wrong-generation') {
        const outcome = await getBranchReconcileOutcome(fixture.app.id);
        for (const row of Object.values(outcome.retirementReceiptEvidence)) row.checkoutIdentity = 'b'.repeat(64);
        outcome.retired[0].checkoutIdentity = 'b'.repeat(64);
      }
      if (reason === 'stale-receipt') {
        const outcome = await getBranchReconcileOutcome(fixture.app.id);
        for (const row of [...outcome.retired, ...Object.values(outcome.retirementReceiptEvidence)]) row.retiredAt = '2000-01-01T00:00:00Z';
      }
      if (reason === 'parent-active') fixture.active = [fixture.parent.id];
      if (reason === 'unreadable') fixture.agents = null;
      if (reason === 'present-checkout') { await mkdir(path, { recursive: true }); await writeFile(join(path, 'wanted'), 'new generation'); }
      if (reason === 'registration-only') {
        await execGit(['worktree', 'add', '--detach', path, head], repo);
        await rm(path, { recursive: true }); // Fault injection: private registration survives missing working files.
      }
      if (reason === 'present-ref') await execGit(['branch', branch, head], repo);
      if (reason === 'active-owner') fixture.agents = [{ id: 'active', status: 'running', metadata: { sourceWorkspace: repo, worktreeBranch: branch, workspacePath: path } }];
      if (reason === 'human-handoff') fixture.policy = 'pr-completion-human-handoff';
      if (reason === 'changed-assignment') fixture.parent.metadata.repoCleanupRecoveries[branch].taskId = 'another-task';
      expect(await verifyRetirementReviewCompletion(task)).toMatchObject({ status: 'unverified', reason: expect.any(String) });
      expect(await settleRetirementReviewBeforeSpawn(task)).toBe(false);
      expect(fixture.writes).toBe(0);
      expect(JSON.parse(await readFile(fixture.taskFile, 'utf8')).status).toBe('pending');
    });
});
