import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';
vi.mock('../lib/paths.js', async original => makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('runtime-verification-') }));
afterAll(cleanupTempDataRoots);
const facts = vi.hoisted(() => ({ boot: 'b'.repeat(40), integrated: 'c'.repeat(40),
  owner: { id: 'agent-example', taskId: 'sys-example', status: 'completed', metadata: {} },
  trusted: true, running: false, forge: true, ancestor: false }));
vi.mock('./cosState.js', async () => ({
  loadState: vi.fn(async () => ({ agents: facts.running ? { sibling: { id: 'sibling', taskId: 'sys-example', status: 'running' } } : {} })),
  withStateLock: (await import('../lib/fileWriteQueue.js')).createFileWriteQueue(),
  readAgentsStateForSafetyCheck: vi.fn(async () => ({ trusted: facts.trusted,
    agents: facts.running ? { sibling: { taskId: 'sys-example', status: 'running' } } : {} })),
}));
vi.mock('./cosAgentLifecycle.js', () => ({ getAgentRecord: vi.fn(async () => facts.owner) }));
vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn(), cosEvents: { emit: vi.fn() } }));
vi.mock('./settings.js', async original => ({ ...(await original()), getSettingsWithStatus: vi.fn(async () => ({ corrupt: false, settings: { autoUpdate: { enabled: false } } })) }));
vi.mock('./installState.js', () => ({ getBootCommit: () => facts.boot }));
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: vi.fn(async () => ({ isGithub: true, host: 'github.com', fullName: 'example/PortOS' })) }));
vi.mock('./github.js', () => ({ execGh: vi.fn(async args => {
  if (!facts.forge) throw new Error('Unavailable');
  return JSON.stringify(args[0] === 'pr'
    ? { state: 'MERGED', url: 'https://github.com/example/PortOS/pull/123', headRefOid: 'a'.repeat(40), mergeCommit: { oid: facts.integrated }, baseRefName: 'main' }
    : { defaultBranchRef: { name: 'main' } });
}) }));
vi.mock('../lib/execGit.js', () => ({ execGit: vi.fn(async args => {
  if (args[0] === 'rev-parse') return { stdout: 'd'.repeat(40), exitCode: 0 };
  if (args[0] === 'merge-base') return { exitCode: args[3] === facts.boot ? (facts.ancestor ? 0 : 1) : 0 };
  return { stdout: '', exitCode: 0 };
}) }));
vi.mock('./agentWorktreeCleanup.js', () => ({ releaseRetryHold: vi.fn(async ({ task, agentId }) => {
  const { updateTask } = await import('./cosTaskStore.js');
  await updateTask(task.id, { metadata: { runtimeVerificationReadyAgentId: agentId } }, task.taskType);
}) }));

import { resolveRuntimeVerificationUpdate, sweepRuntimeVerifications } from './runtimeVerification.js';
import { addTask, getTaskById, updateTask, deleteTask, reviveBlockedTask, __resetTaskCache, sweepResolvedFailureTasks } from './cosTaskStore.js';
import { __resetCosTaskRepository } from './cosTaskRepository.js';
import { cosEvents } from './cosEvents.js';
import { normalizeTaskOutcome } from '../lib/agentOutcome.js';
import { execGh } from './github.js';

const outcome = () => normalizeTaskOutcome({ status: 'blocked', reason: 'The fix must be running before verification.',
  recovery: { mode: 'runtime', prUrl: 'https://github.com/example/PortOS/pull/123', requiredCommit: 'a'.repeat(40) } });
async function runningTask() {
  const task = await addTask({ id: 'sys-example', description: 'Verify merged fix', priority: 'MEDIUM', status: 'in_progress', metadata: {
    isInvestigation: true, lastSpawnedAt: '2026-01-01T00:00:00Z', totalSpawnCount: 4, failureCount: 2,
    orphanRetryCount: 1, existingBranch: 'claim/issue-123', resumeWorktreePath: '/example/worktree',
  } }, 'internal', { raw: true });
  facts.owner.metadata.completionTaskDispatch = { taskId: task.id, taskType: 'internal',
    expected: ['claimedBy', 'claimedAt', 'lastSpawnedAt', 'totalSpawnCount'].map(key => [key, task.metadata[key] ?? null]) };
  return task;
}
async function park({ ready = true } = {}) {
  const task = await runningTask();
  const update = await resolveRuntimeVerificationUpdate({ ...task, metadata: { totalSpawnCount: 0 } }, outcome(), 'agent-example');
  await updateTask(task.id, update, 'internal', update.runtimeRecoveryContext);
  if (ready) await updateTask(task.id, { metadata: { runtimeVerificationReadyAgentId: 'agent-example' } }, 'internal');
  return getTaskById(task.id);
}

beforeEach(() => {
  __resetCosTaskRepository(); __resetTaskCache(); vi.clearAllMocks();
  Object.assign(facts, { boot: 'b'.repeat(40), integrated: 'c'.repeat(40), ancestor: false, forge: true, trusted: true, running: false,
    owner: { id: 'agent-example', taskId: 'sys-example', status: 'completed', metadata: {} } });
});

describe('persisted runtime continuation', () => {
  it('parks stale code without budget changes, expiry, generic revival or affected-task completion', async () => {
    const task = await park();
    expect(task).toMatchObject({ status: 'blocked', metadata: { blockedCategory: 'runtime-verification', failureCount: '2', totalSpawnCount: '4' } });
    expect(task).not.toHaveProperty('runtimeRecoveryContext');
    expect(task.metadata).not.toHaveProperty('runtimeRecoveryContext');
    expect(JSON.stringify(cosEvents.emit.mock.calls)).not.toContain('runtimeRecoveryContext');
    expect(task.metadata.blockedReason).toContain('Automatic updates are disabled');
    expect(await reviveBlockedTask(task.id)).toMatchObject({ error: expect.stringContaining('Runtime verification') });
    await sweepResolvedFailureTasks({ now: Date.now() + 60 * 86400000 });
    expect(await sweepRuntimeVerifications()).toEqual({ resumed: [] });
    expect(await getTaskById(task.id)).toMatchObject({ status: 'blocked', metadata: { existingBranch: 'claim/issue-123', failureCount: '2' } });
  });

  it('resumes the same task exactly once through concurrent sweeps and cache reload, retaining its budget and checkout', async () => {
    await park();
    facts.ancestor = true;
    __resetTaskCache(); // the persisted record, not process-local continuation state
    cosEvents.emit.mockClear();
    const results = await Promise.all([sweepRuntimeVerifications(), sweepRuntimeVerifications()]);
    expect(results.flatMap(r => r.resumed)).toEqual(['sys-example']);
    const task = await getTaskById('sys-example');
    expect(task).toMatchObject({ status: 'pending', metadata: { failureCount: '2', totalSpawnCount: '4', orphanRetryCount: '1',
      existingBranch: 'claim/issue-123', resumeWorktreePath: '/example/worktree',
      runtimeVerification: { status: 'resumed', integratedCommit: 'c'.repeat(40), bootCommit: facts.boot } } });
    expect(cosEvents.emit.mock.calls.filter(([name, e]) => name === 'tasks:changed' && e.action === 'unblocked')).toHaveLength(1);
    __resetTaskCache();
    expect(await sweepRuntimeVerifications()).toEqual({ resumed: [] });
  });

  it('charges an already satisfied runtime request to bounded delivery recovery instead of granting another boot continuation', async () => {
    const task = await runningTask();
    facts.ancestor = true;
    const update = await resolveRuntimeVerificationUpdate(task, outcome(), 'agent-example');
    await updateTask(task.id, update, 'internal', update.runtimeRecoveryContext);
    const retained = await getTaskById(task.id);
    expect(retained).toMatchObject({ status: 'blocked', metadata: { blockedCategory: 'task-recovery-exhausted',
      failureCount: '3', totalSpawnCount: '4', existingBranch: 'claim/issue-123' } });
    expect(retained.metadata.taskOutcome.reason).toContain('already running');
    expect(retained.metadata.runtimeVerification.status).toBe('satisfied');
    expect(retained.metadata.taskOutcome).not.toHaveProperty('recovery');
    expect(await sweepRuntimeVerifications()).toEqual({ resumed: [] });
    // The task write committed, but terminal agent publication was interrupted.
    __resetTaskCache();
    const replay = await resolveRuntimeVerificationUpdate(task, outcome(), 'agent-example');
    expect(replay).toMatchObject({ status: 'blocked', metadata: {
      failureCount: '3', totalSpawnCount: '4', taskOutcome: retained.metadata.taskOutcome } });
    await updateTask(task.id, replay, 'internal', replay.runtimeRecoveryContext);
    expect((await getTaskById(task.id)).metadata.failureCount).toBe('3');
    await updateTask(task.id, { metadata: { totalSpawnCount: 5 } }, 'internal');
    await expect(resolveRuntimeVerificationUpdate(task, outcome(), 'agent-example')).rejects.toThrow('dispatch ownership');
  });

  it('replays an existing stale-boot prerequisite after the update without charging another failure', async () => {
    await park();
    facts.ancestor = true;
    const task = await getTaskById('sys-example');
    const update = await resolveRuntimeVerificationUpdate(task, outcome(), 'agent-example');
    await updateTask(task.id, update, 'internal', update.runtimeRecoveryContext);
    expect(await getTaskById(task.id)).toMatchObject({ status: 'blocked', metadata: {
      blockedCategory: 'runtime-verification', failureCount: '2', totalSpawnCount: '4' } });
    expect(await sweepRuntimeVerifications()).toEqual({ resumed: ['sys-example'] });
  });

  it.each(['unknown-boot', 'unreadable-forge', 'changed-integration', 'live-owner', 'unknown-owners', 'changed-dispatch'])('retains the hold for %s evidence', async kind => {
    await park(); facts.ancestor = true;
    if (kind === 'unknown-boot') facts.boot = null;
    if (kind === 'unreadable-forge') facts.forge = false;
    if (kind === 'changed-integration') facts.integrated = 'e'.repeat(40);
    if (kind === 'live-owner') facts.running = true;
    if (kind === 'unknown-owners') facts.trusted = false;
    if (kind === 'changed-dispatch') await updateTask('sys-example', { metadata: { totalSpawnCount: 5 } }, 'internal');
    expect(await sweepRuntimeVerifications()).toEqual({ resumed: [] });
    expect((await getTaskById('sys-example')).status).toBe('blocked');
  });

  it.each(['undercounted-receipt', 'missing-receipt', 'malformed-receipt'])('does not resume a runtime hold with %s', async kind => {
    await park(); facts.ancestor = true;
    const binding = facts.owner.metadata.completionTaskDispatch;
    if (kind === 'undercounted-receipt') binding.expected = binding.expected.map(([key, value]) => [key, key === 'totalSpawnCount' ? 5 : value]);
    if (kind === 'missing-receipt') delete facts.owner.metadata.completionTaskDispatch;
    if (kind === 'malformed-receipt') binding.expected = null;
    const before = await getTaskById('sys-example');
    expect(await sweepRuntimeVerifications()).toEqual({ resumed: [] });
    expect(await getTaskById('sys-example')).toEqual(before);
  });

  it.each(['owner', 'task edit'])('does not release a runtime hold when a concurrent %s appears during verification', async kind => {
    await park(); facts.ancestor = true;
    const originalForge = execGh.getMockImplementation();
    let entered, release;
    const inspecting = new Promise(resolve => { entered = resolve; });
    const inspection = new Promise(resolve => { release = resolve; });
    execGh.mockImplementationOnce(async (...args) => { entered(); await inspection; return originalForge(...args); });
    const pending = sweepRuntimeVerifications();
    await inspecting;
    if (kind === 'owner') facts.running = true;
    else await updateTask('sys-example', { description: 'Operator revised the objective' }, 'internal');
    const before = await getTaskById('sys-example');
    release();
    expect(await pending).toEqual({ resumed: [] });
    expect(await getTaskById('sys-example')).toEqual(before);
  });

  it('recovers the original resume-pointer handoff after restart before releasing a verified boot', async () => {
    await park({ ready: false }); facts.ancestor = true;
    expect(await sweepRuntimeVerifications()).toEqual({ resumed: [] });
    expect(await sweepRuntimeVerifications()).toEqual({ resumed: ['sys-example'] });
  });

  it.each(['unmerged', 'wrong-commit', 'foreign-repository'])('does not accept %s assertions as merged-fix evidence', async kind => {
    const request = outcome();
    if (kind === 'foreign-repository') request.recovery.prUrl = 'https://github.com/another/project/pull/123';
    if (kind === 'wrong-commit') request.recovery.requiredCommit = 'f'.repeat(40);
    if (kind === 'unmerged') execGh.mockResolvedValueOnce(JSON.stringify({ state: 'OPEN', mergeCommit: null }));
    const task = await runningTask();
    const update = await resolveRuntimeVerificationUpdate(task, request, 'agent-example');
    expect(update).toMatchObject({ status: 'blocked', metadata: { blockedReason: expect.stringContaining('unreadable or invalid') } });
    expect(update.metadata.runtimeVerification.integratedCommit).toBeUndefined();
  });

  it('refuses a predecessor dispatch when a successor has already claimed the task', async () => {
    const task = await runningTask();
    await updateTask(task.id, { metadata: { totalSpawnCount: 5, lastSpawnedAt: '2026-01-02T00:00:00Z' } }, 'internal');
    await expect(resolveRuntimeVerificationUpdate(task, outcome(), 'agent-example')).rejects.toThrow('dispatch ownership');
    expect((await getTaskById(task.id)).status).toBe('in_progress');
  });

  it.each(['description', 'priority', 'manual-blocker', 'new-owner'])('preserves a %s change made during runtime prerequisite inspection', async kind => {
    const task = await runningTask();
    const observed = await getTaskById(task.id);
    const originalForge = execGh.getMockImplementation();
    let entered, release;
    const inspecting = new Promise(resolve => { entered = resolve; });
    const inspection = new Promise(resolve => { release = resolve; });
    execGh.mockImplementationOnce(async (...args) => { entered(); await inspection; return originalForge(...args); });
    const pending = resolveRuntimeVerificationUpdate(task, outcome(), 'agent-example');
    await inspecting;
    if (kind === 'description') await updateTask(task.id, { description: 'Operator revised the objective' }, 'internal');
    if (kind === 'priority') await updateTask(task.id, { priority: 'HIGH' }, 'internal');
    if (kind === 'manual-blocker') await updateTask(task.id, { metadata: { blocker: 'Operator hold' } }, 'internal');
    if (kind === 'new-owner') facts.running = true;
    const retained = await getTaskById(task.id);
    release();
    const update = await pending;
    expect(update.runtimeRecoveryContext.expectedTask).toEqual({ description: observed.description, priority: observed.priority, metadata: observed.metadata });
    expect(await updateTask(task.id, update, 'internal', update.runtimeRecoveryContext)).toMatchObject({ statusChanged: true });
    __resetTaskCache();
    expect(await getTaskById(task.id)).toEqual(retained);
    expect((await getTaskById(task.id)).metadata).not.toHaveProperty('runtimeVerification');
  });

  it.each(['task', 'owner'])('refuses runtime prerequisite publication when its %s is missing', async kind => {
    const task = await runningTask();
    if (kind === 'task') await deleteTask(task.id, 'internal');
    else facts.owner = null;
    await expect(resolveRuntimeVerificationUpdate(task, outcome(), 'agent-example')).rejects.toThrow('dispatch ownership');
    if (kind === 'task') expect(await getTaskById(task.id)).toBeNull();
    else expect((await getTaskById(task.id)).metadata).not.toHaveProperty('runtimeVerification');
  });

  it('retains unreadable integration as a prerequisite without spending another run, then verifies it afresh', async () => {
    facts.forge = false; await park(); facts.ancestor = true;
    expect((await getTaskById('sys-example')).metadata.blockedReason).toContain('unreadable or invalid');
    expect(await sweepRuntimeVerifications()).toEqual({ resumed: [] });
    facts.forge = true;
    expect(await sweepRuntimeVerifications()).toEqual({ resumed: ['sys-example'] });
    expect(execGh).toHaveBeenCalled();
  });
});
