import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';
vi.mock('../lib/paths.js', async original => makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('runtime-verification-') }));
afterAll(cleanupTempDataRoots);
const facts = vi.hoisted(() => ({ boot: 'b'.repeat(40), integrated: 'c'.repeat(40),
  owner: { id: 'agent-example', taskId: 'sys-example', status: 'completed', metadata: {} },
  trusted: true, running: false, forge: true, ancestor: false }));
vi.mock('./cosState.js', async () => ({
  loadState: vi.fn(async () => ({ agents: {} })),
  withStateLock: (await import('../lib/fileWriteQueue.js')).createFileWriteQueue(),
  readAgentsStateForSafetyCheck: vi.fn(async () => ({ trusted: facts.trusted,
    agents: facts.running ? { sibling: { taskId: 'sys-example', status: 'running' } } : {} })),
}));
vi.mock('./cosAgentLifecycle.js', () => ({ getAgentRecord: vi.fn(async () => facts.owner) }));
vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn(), cosEvents: { emit: vi.fn() } }));
vi.mock('./settings.js', () => ({ getSettingsWithStatus: vi.fn(async () => ({ corrupt: false, settings: { autoUpdate: { enabled: false } } })) }));
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
import { addTask, getTaskById, updateTask, reviveBlockedTask, __resetTaskCache, sweepResolvedFailureTasks } from './cosTaskStore.js';
import { __resetCosTaskRepository } from './cosTaskRepository.js';
import { cosEvents } from './cosEvents.js';
import { normalizeTaskOutcome } from '../lib/agentOutcome.js';
import { execGh } from './github.js';

const outcome = () => normalizeTaskOutcome({ status: 'blocked', reason: 'The fix must be running before verification.',
  recovery: { mode: 'runtime', prUrl: 'https://github.com/example/PortOS/pull/123', requiredCommit: 'a'.repeat(40) } });
async function park({ ready = true } = {}) {
  const task = await addTask({ id: 'sys-example', description: 'Verify merged fix', priority: 'MEDIUM', status: 'in_progress', metadata: {
    isInvestigation: true, lastSpawnedAt: '2026-01-01T00:00:00Z', totalSpawnCount: 4, failureCount: 2,
    orphanRetryCount: 1, existingBranch: 'claim/issue-123', resumeWorktreePath: '/example/worktree',
  } }, 'internal', { raw: true });
  await updateTask(task.id, await resolveRuntimeVerificationUpdate(task, outcome(), 'agent-example'), 'internal');
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
    const update = await resolveRuntimeVerificationUpdate({ id: 'sys-example', metadata: {} }, request, 'agent-example');
    expect(update).toMatchObject({ status: 'blocked', metadata: { blockedReason: expect.stringContaining('unreadable or invalid') } });
    expect(update.metadata.runtimeVerification.integratedCommit).toBeUndefined();
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
