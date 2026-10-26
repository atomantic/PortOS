import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execGit } from '../lib/execGit.js';
import { planListSave } from '../lib/cosTaskRows.js';
import { parseSentinelPayload } from '../lib/agentSentinel.js';
import { cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';
const fixture = vi.hoisted(() => ({ agents: {}, forge: null, denyProof: false }));
vi.mock('../lib/paths.js', async original => {
  const { makePathsProxy, lazyTempDataRoot } = await import('../lib/mockPathsDataRoot.js');
  return makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('portos-investigation-wait-') });
});
vi.mock('./cosState.js', async () => ({ loadState: async () => ({ agents: fixture.agents }),
  withStateLock: (await import('../lib/fileWriteQueue.js')).createFileWriteQueue() }));
vi.mock('./cos.js', () => ({ isRunning: () => false }));
vi.mock('./notifications.js', () => ({ removeByMetadata: async () => 0 }));
vi.mock('./heldCheckoutReview.js', () => ({ readRetirementForgeEvidence: async () => {
  if (fixture.denyProof) throw new Error('forge unavailable');
  return fixture.forge;
} }));
const { _createInvestigationDependencyWait } = await import('./investigationDependencyWait.js');
const repository = await import('./cosTaskRepository.js');
const { getAllTasks, getTaskById, updateTask, __resetTaskCache } = await import('./cosTaskStore.js');
const { cosEvents } = await import('./cosEvents.js');
let root, sha, time, tasks, instanceId, owned, pointer;
const at = '2026-01-01T00:00:00.000Z';
const tuple = { claimedBy: 'local', claimedAt: at, lastSpawnedAt: at, totalSpawnCount: '2' };
const owner = (id, taskId) => ({ id, taskId, status: 'running', startedAt: at,
  metadata: { instanceId: 'local', sourceWorkspace: root, workspacePath: join(root, id), worktreeBranch: id,
    completionTaskDispatch: { taskId, taskType: 'internal', expected: Object.entries(tuple) } } });
const seed = async row => {
  const source = 'internal';
  const current = await repository.loadTaskWorkingSet(source);
  const next = [...current.rows.map(entry => entry.task).filter(task => task.id !== row.id), row];
  await repository.applyTaskListSave(source, { ...planListSave({ previous: current.rows, next, source }), expectedVersions: { [source]: current.version } });
  __resetTaskCache();
};
const makeService = (overrides = {}) => _createInvestigationDependencyWait({ now: () => time, read: getAllTasks,
  instance: async () => instanceId, agent: async id => fixture.agents[id], released: async () => !owned,
  records: async () => Object.values(fixture.agents),
  pointer: async source => pointer ? { existingBranch: source.metadata.worktreeBranch,
    resumeWorktreePath: source.metadata.workspacePath, resumedFromAgentId: source.id } : null, ...overrides });
const request = () => parseSentinelPayload(JSON.stringify({ summary: 'Existing fix owns the dependency.', taskOutcome: {
  status: 'incomplete', reason: 'Waiting for the verified root fix, then recheck the original failure.',
  recovery: { mode: 'dependency-wait', ownerTaskId: 'sys-dependency', ownerAgentId: 'agent-owner', prUrl: 'https://github.com/example/repo/pull/1' },
} })).taskOutcome;
const wait = async () => {
  const service = makeService();
  const task = await getTaskById('sys-investigation');
  const patch = await service.resolve(task, request(), 'agent-investigator');
  await updateTask(task.id, patch, 'internal', patch.dependencyWaitContext);
  fixture.agents['agent-investigator'].status = 'completed';
  return service;
};
const complete = async (agentId = 'agent-owner') => {
  const agent = fixture.agents[agentId];
  agent.status = 'completed'; agent.completedAt = agent.startedAt;
  agent.result = { success: true, validationPassed: true, taskOutcome: { status: 'completed', reason: 'Exact merged code verified.' } };
  agent.metadata.completedCheckouts = [{ version: 1, agentId: agent.id, startedAt: agent.startedAt, capturedAt: agent.completedAt,
    repoPath: root, path: agent.metadata.workspacePath, branch: agent.metadata.worktreeBranch, head: sha }];
  await updateTask('sys-dependency', { status: 'completed' }, 'internal');
};
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'portos-investigation-git-'));
  await execGit(['init', '--initial-branch=main'], root);
  await execGit(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '--allow-empty', '-m', 'root fix'], root);
  sha = (await execGit(['rev-parse', 'HEAD'], root)).stdout.trim();
  await mkdir(join(root, 'agent-investigator')); await mkdir(join(root, 'agent-owner'));
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); await cleanupTempDataRoots(); });
beforeEach(async () => {
  repository.__resetCosTaskRepository(); __resetTaskCache();
  time = Date.parse(at); instanceId = 'local'; owned = false; pointer = true;
  fixture.denyProof = false;
  fixture.forge = { prHead: sha, mergeCommit: sha, defaultHead: sha, scopeProof: 'exact-delivered-head' };
  fixture.agents = { 'agent-investigator': owner('agent-investigator', 'sys-investigation'),
    'agent-owner': owner('agent-owner', 'sys-dependency'), 'agent-original': { ...owner('agent-original', 'sys-original'), status: 'completed' } };
  tasks = [
    { id: 'sys-original', description: 'Original red CI', priority: 'MEDIUM', status: 'blocked', metadata: {
      blockedCategory: 'task-recovery-exhausted', failureCount: '3', totalSpawnCount: '3', deliveryDecisionAgentId: 'agent-original' } },
    { id: 'sys-investigation', description: 'Investigate original', priority: 'HIGH', status: 'in_progress', metadata: {
      ...tuple, isInvestigation: true, blockedSystemRecovery: true, preserveOriginalBudget: true, affectedTasks: ['sys-original'],
      failureCount: '2', lastErrorCategory: 'task-incomplete', lastFailureAt: at } },
    { id: 'sys-dependency', description: 'Fix the root code', priority: 'HIGH', status: 'in_progress', metadata: { ...tuple } },
  ];
  for (const task of tasks) await seed(task);
});
describe('investigation dependency wait through persisted task events', () => {
  it.each(['verified', 'unrelated', 'foreign', 'different-task', 'different-branch'])('carries progress through only a verified same-task registered successor: %s', async mode => {
    const service = await wait();
    const predecessor = fixture.agents['agent-owner'];
    predecessor.status = 'completed'; predecessor.completedAt = at;
    predecessor.result = { resumed: true, resumedTaskId: 'sys-dependency', success: false };
    const later = '2026-01-01T00:00:01.000Z';
    const charged = { ...tuple, claimedAt: later, lastSpawnedAt: later, totalSpawnCount: '3' };
    const successor = owner('agent-successor', 'sys-dependency');
    successor.startedAt = later;
    successor.metadata = { ...successor.metadata, resumedFromAgentId: predecessor.id,
      workspacePath: predecessor.metadata.workspacePath, worktreeBranch: predecessor.metadata.worktreeBranch,
      completionTaskDispatch: { taskId: successor.taskId, taskType: 'internal', expected: Object.entries(charged) } };
    if (mode === 'unrelated') delete successor.metadata.resumedFromAgentId;
    if (mode === 'foreign') successor.metadata.instanceId = 'foreign';
    if (mode === 'different-task') successor.taskId = 'sys-other';
    if (mode === 'different-branch') successor.metadata.worktreeBranch = 'another-branch';
    fixture.agents[successor.id] = successor;
    await updateTask('sys-dependency', { metadata: charged }, 'internal');
    await complete(successor.id);
    expect(await service.reconcile()).toEqual({ resumed: mode === 'verified' ? ['sys-investigation'] : [] });
    expect((await getTaskById('sys-investigation')).metadata.failureCount).toBe('2');
    expect((await getTaskById('sys-original')).metadata.failureCount).toBe('3');
  });

  it.each(['verified', 'marker-only', 'no-capture'])('uses current exact server delivery proof without rewriting the historical failed execution: %s', async mode => {
    const service = await wait(); await complete();
    const owner = fixture.agents['agent-owner'];
    owner.result = { success: false, validationPassed: null, taskOutcome: { status: 'incomplete', reason: 'Original execution did not finish delivery.' } };
    owner.metadata.repoStateVerification = { status: 'completed', deliveryVerified: true };
    const captured = owner.metadata.completedCheckouts[0];
    if (mode !== 'marker-only') owner.metadata.cleanupOutcomes = { exact: { status: 'verified',
      branch: captured.branch, path: captured.path, committedIntegrationVerified: true } };
    if (mode === 'no-capture') owner.metadata.completedCheckouts = [];
    expect(await service.reconcile()).toEqual({ resumed: mode === 'verified' ? ['sys-investigation'] : [] });
    expect(owner.result.success).toBe(false);
    expect((await getTaskById('sys-original')).status).toBe('blocked');
  });

  it('joins without success/failure charges, survives restart, then wakes once after verified merged delivery', async () => {
    const original = await getTaskById('sys-original');
    const service = await wait();
    expect((await getTaskById('sys-investigation'))).toMatchObject({ status: 'blocked', metadata: {
      failureCount: '2', totalSpawnCount: '2', blockedCategory: 'internal-dependency',
      taskOutcome: { status: 'incomplete', recovery: { mode: 'dependency-wait' } } } });
    expect(await service.reconcile()).toEqual({ resumed: [] });
    const restarted = makeService(); const unbind = restarted.bind(cosEvents);
    try {
      await complete();
      await vi.waitFor(async () => expect((await getTaskById('sys-investigation')).status).toBe('pending'));
      expect((await getTaskById('sys-investigation')).metadata).toMatchObject({ failureCount: '2', totalSpawnCount: '2',
        lastErrorCategory: 'task-incomplete', existingBranch: 'agent-investigator',
        investigationDependencyWait: { phase: 'ready', proof: { head: sha, mergeCommit: sha } } });
      expect(await restarted.reconcile()).toEqual({ resumed: [] });
      expect(await makeService().reconcile()).toEqual({ resumed: [] });
      expect(await getTaskById('sys-original')).toEqual(original);
    } finally { unbind(); }
  });
  it('coalesces concurrent completion observations with task-store CAS and preserves a committed wake across a crash', async () => {
    await wait(); await complete();
    const observations = await Promise.all([makeService().reconcile(), makeService().reconcile()]);
    expect(observations.flatMap(row => row.resumed)).toEqual(['sys-investigation']);
    expect((await getTaskById('sys-investigation')).metadata.failureCount).toBe('2');
    expect(await makeService().reconcile()).toEqual({ resumed: [] });
  });

  it('backs off unreadable proof without provider work and retries the same obligation after restart', async () => {
    const service = await wait(); await complete(); fixture.denyProof = true;
    expect(await service.reconcile()).toEqual({ resumed: [] });
    const state = (await getTaskById('sys-investigation')).metadata.investigationDependencyWait;
    expect(state.checks).toBe(1);
    expect(await makeService().reconcile()).toEqual({ resumed: [] });
    fixture.denyProof = false; time += 60001;
    expect(await makeService().reconcile()).toEqual({ resumed: ['sys-investigation'] });
    expect((await getTaskById('sys-investigation')).metadata.failureCount).toBe('2');
  });

  it.each(['foreign', 'other-dispatch', 'incomplete-dispatch', 'other-repository', 'self', 'cycle', 'human', 'permission', 'malformed'])('refuses an unverified dependency without charging or claiming a correction: %s', async mode => {
    if (mode === 'foreign') fixture.agents['agent-owner'].metadata.instanceId = 'foreign';
    if (mode === 'other-dispatch') fixture.agents['agent-owner'].metadata.completionTaskDispatch.expected[1] = ['claimedAt', 'other'];
    if (mode === 'incomplete-dispatch') fixture.agents['agent-owner'].metadata.completionTaskDispatch.expected.pop();
    if (mode === 'other-repository') fixture.agents['agent-owner'].metadata.sourceWorkspace = tmpdir();
    if (mode === 'cycle') await updateTask('sys-dependency', { metadata: { investigationDependencyWait: { ownerTaskId: 'sys-investigation' } } }, 'internal');
    if (mode === 'human') await updateTask('sys-dependency', { metadata: { blocker: 'Operator holds this work' } }, 'internal');
    if (mode === 'permission') await updateTask('sys-original', { metadata: { lastErrorCategory: 'permission-denied' } }, 'internal');
    const outcome = request();
    if (mode === 'self') outcome.recovery.ownerTaskId = 'sys-investigation';
    if (mode === 'malformed') outcome.recovery.prUrl = 'not a URL';
    const result = await makeService().resolve(await getTaskById('sys-investigation'), outcome, 'agent-investigator');
    expect(result).toMatchObject({ status: 'blocked', metadata: { blockedCategory: 'internal-dependency-unverified', failureCount: '2' } });
    expect(result.metadata.investigationDependencyWait).toBeUndefined();
    expect((await getTaskById('sys-dependency')).status).toBe('in_progress');
  });
  it.each(['status-only', 'unreadable-forge', 'different-head', 'not-integrated', 'exhausted', 'missing-pointer', 'active-source', 'new-dispatch', 'original-active'])('preserves the wait and budgets when completion is not admissible: %s', async mode => {
    const service = await wait();
    await complete();
    if (mode === 'status-only') fixture.agents['agent-owner'].result.success = false;
    if (mode === 'unreadable-forge') fixture.denyProof = true;
    if (mode === 'different-head') fixture.forge.prHead = 'f'.repeat(40);
    if (mode === 'not-integrated') fixture.forge.mergeCommit = 'f'.repeat(40);
    if (mode === 'exhausted') await updateTask('sys-investigation', { metadata: { failureCount: '3' } }, 'internal');
    if (mode === 'missing-pointer') pointer = false;
    if (mode === 'active-source') owned = true;
    if (mode === 'original-active') await updateTask('sys-original', { status: 'in_progress' }, 'internal');
    if (mode === 'new-dispatch') await updateTask('sys-dependency', { metadata: { totalSpawnCount: '3' } }, 'internal');
    expect(await service.reconcile()).toEqual({ resumed: [] });
    expect((await getTaskById('sys-investigation')).status).toBe('blocked');
    if (mode !== 'original-active') expect((await getTaskById('sys-original')).metadata.failureCount).toBe('3');
    const after = (await getTaskById('sys-investigation')).metadata.investigationDependencyWait;
    expect(await makeService().reconcile()).toEqual({ resumed: [] });
    expect((await getTaskById('sys-investigation')).metadata.investigationDependencyWait).toEqual(after);
  });
});
