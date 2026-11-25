/**
 * #14039 — "Run now" on a pending task whose `running` agent record is older
 * than the spawn window. forceSpawnTask used to fall through and report success
 * while prepareAgentSpawn's ownership gate (hasActiveTaskOwner) refused the
 * spawn downstream. It must now settle the holder through the one dead-agent
 * reaper (#18637) and admit only when that shared gate agrees, otherwise answer
 * with a named hold.
 *
 * Drives the real forceSpawnTask and the real hasActiveTaskOwner; the reaper is
 * doubled at the boot hook registry (its own liveness predicate is pinned in
 * agentManagement.test.js) so each case controls whether the holder is proven
 * dead and what its orphan recovery did to the task. Own file because the
 * module-wide state mocks would replace the helpers cos.test.js exercises for
 * real.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const TASK_ID = 'task-stuck';
const HOLDER_ID = 'agent-holder';
const STALE_STARTED_AT = () => new Date(Date.now() - 10 * 60_000).toISOString();

let persisted;
vi.mock('./cosState.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isDaemonRunning: () => true,
  loadState: vi.fn(async () => structuredClone(persisted)),
}));

// `taskAfter` is what the reaper's orphan recovery left the holder's task as;
// null leaves it pending, as a holder that is not the task's latest dispatch does.
const sweep = vi.hoisted(() => ({ provesDead: false, taskAfter: null }));
const releaseDisposition = vi.hoisted(() => vi.fn(async () => null));
vi.mock('../releaseSynchronization.js', async original => ({ ...(await original()), releaseTaskDispatchDisposition: releaseDisposition }));

// A freshly created task: no spawn charged yet, so only ownership decides.
vi.mock('./cosTaskStore.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getTaskById: vi.fn(),
  updateTask: vi.fn(),
}));
vi.mock('../agent/agentProviderResolution.js', () => ({
  resolveAgentProviderAndModel: vi.fn(async () => ({ ok: true, provider: { id: 'cloud-cli', type: 'cli' } })),
}));
vi.mock('./cosLocalEndpointSlots.js', async (importOriginal) => ({
  ...(await importOriginal()),
  localEndpointCapacityError: vi.fn(async () => null),
}));

const { forceSpawnTask } = await import('./cos.js');
const { cosEvents } = await import('./cosEvents.js');
const { getTaskById, updateTask } = await import('./cosTaskStore.js');
const { registerCosOrphanRecoveryHandlers } = await import('../bootHookRegistry.js');

const pendingTask = (id = TASK_ID) => ({ id, status: 'pending', taskType: 'user', metadata: {} });
const cleanupOrphanedAgents = vi.fn(async () => {
  const agent = persisted.agents[HOLDER_ID];
  if (!sweep.provesDead || agent?.status !== 'running') return 0;
  persisted.agents[HOLDER_ID] = { ...agent, status: 'completed', result: { success: false, orphaned: true } };
  if (sweep.taskAfter) vi.mocked(getTaskById).mockResolvedValue(sweep.taskAfter);
  return 1;
});
registerCosOrphanRecoveryHandlers({ cleanupOrphanedAgents, handleOrphanedTask: vi.fn() });
const { MAX_TOTAL_SPAWNS } = await import('../../lib/cos/cosTaskMetadata.js');
const { setUseRunner, useRunner, activeAgents } = await import('../agent/agentState.js');

const originalUseRunner = useRunner;
const holder = (overrides = {}) => ({
  id: HOLDER_ID, taskId: TASK_ID, status: 'running', pid: 4242, startedAt: STALE_STARTED_AT(), ...overrides,
});
const taskReadyEmits = (emit) => emit.mock.calls.filter(([event]) => event === 'task:ready');

let emit;

beforeEach(() => {
  releaseDisposition.mockReset().mockResolvedValue(null);
  setUseRunner(false);
  sweep.provesDead = false;
  sweep.taskAfter = null;
  vi.mocked(getTaskById).mockReset().mockImplementation(async (id) => pendingTask(id));
  persisted = { paused: false, agents: { [HOLDER_ID]: holder() }, config: { maxConcurrentAgents: 1 } };
  emit = vi.spyOn(cosEvents, 'emit');
  cleanupOrphanedAgents.mockClear();
  vi.mocked(updateTask).mockReset();
});

afterEach(() => {
  emit.mockRestore();
  activeAgents.clear();
  setUseRunner(originalUseRunner);
});

describe('forceSpawnTask — stale running holder (#14039)', () => {

  it('answers with a named hold and launches nothing when the holder cannot be proven dead', async () => {
    const result = await forceSpawnTask(TASK_ID);

    expect(cleanupOrphanedAgents).toHaveBeenCalledTimes(1);
    expect(result.success).toBeUndefined();
    expect(result.code).toBe('TASK_OWNER_HELD');
    expect(result.error).toContain(HOLDER_ID);
    expect(taskReadyEmits(emit)).toEqual([]);
    expect(persisted.agents[HOLDER_ID].status).toBe('running');
  });

  it('refuses a retired continuation before reporting a spawn', async () => {
    vi.mocked(getTaskById).mockResolvedValueOnce({ id: TASK_ID, status: 'pending', taskType: 'internal', metadata: { analysisType: 'release-sync' } });
    releaseDisposition.mockResolvedValueOnce('retired-continuation');
    expect(await forceSpawnTask(TASK_ID)).toEqual({ error: 'This release synchronization was retired by an operator.' });
    expect(taskReadyEmits(emit)).toEqual([]);
  });

  it('holds an ambiguous historical release policy before spawning', async () => {
    vi.mocked(getTaskById).mockResolvedValueOnce({ id: TASK_ID, status: 'pending', taskType: 'internal', metadata: { analysisType: 'release-sync' } });
    releaseDisposition.mockResolvedValueOnce('review-policy-unverified');
    expect(await forceSpawnTask(TASK_ID)).toMatchObject({ error: expect.stringContaining('review policy was not captured') });
    expect(taskReadyEmits(emit)).toEqual([]);
  });

  it('retries a holder the reaper settled as dead, in the same call', async () => {
    sweep.provesDead = true;

    const result = await forceSpawnTask(TASK_ID);

    expect(result).toEqual({ success: true, taskId: TASK_ID });
    expect(cleanupOrphanedAgents).toHaveBeenCalledTimes(1);
    expect(taskReadyEmits(emit)).toHaveLength(1);
    // The freed slot counts: at a limit of 1 the zombie no longer blocks capacity.
    expect(persisted.agents[HOLDER_ID].status).toBe('completed');
  });

  // Retiring the holder also runs its orphan recovery, which owns the task's
  // AUTOMATIC retry. The spawn must carry what that recovery wrote (the retry
  // charge, the resume pointer), not the copy read before the sweep.
  it('spawns the task as the orphan recovery requeued it', async () => {
    sweep.provesDead = true;
    sweep.taskAfter = { ...pendingTask(), metadata: { orphanRetryCount: 1, lastOrphanedAgentId: HOLDER_ID, existingBranch: 'cos/task-stuck/agent-holder' } };

    expect(await forceSpawnTask(TASK_ID)).toEqual({ success: true, taskId: TASK_ID });

    expect(taskReadyEmits(emit)).toEqual([['task:ready', sweep.taskAfter]]);
    expect(updateTask).not.toHaveBeenCalled();
  });

  // The backoff paces automatic retries. "Run now" is the user asking for this
  // one, so the block the reaper just wrote for this holder is lifted.
  it('lifts the orphan cooldown the reaper just set and spawns', async () => {
    sweep.provesDead = true;
    const cooling = { ...pendingTask(), status: 'blocked', metadata: {
      orphanRetryCount: 2, lastOrphanedAgentId: HOLDER_ID, lastOrphanedAt: '2026-01-01T00:00:00.000Z',
      blockedCategory: 'orphan-cooldown', blockedReason: 'Orphan retry cooldown (12m remaining)',
      blockedAt: '2026-01-01T00:18:00.000Z', cooldownUntil: '2026-01-01T00:30:00.000Z',
    } };
    sweep.taskAfter = cooling;
    const revived = { ...cooling, status: 'pending', metadata: { orphanRetryCount: 2, lastOrphanedAgentId: HOLDER_ID, lastOrphanedAt: cooling.metadata.lastOrphanedAt } };
    vi.mocked(updateTask).mockResolvedValueOnce(revived);

    expect(await forceSpawnTask(TASK_ID)).toEqual({ success: true, taskId: TASK_ID });

    expect(vi.mocked(updateTask).mock.calls).toEqual([[TASK_ID, {
      status: 'pending',
      metadata: { ...cooling.metadata, blockedReason: undefined, blockedCategory: undefined, blockedAt: undefined, cooldownUntil: undefined },
    }, 'user', { expectedStatus: 'blocked', suppressDequeue: true }]]);
    expect(taskReadyEmits(emit)).toEqual([['task:ready', revived]]);
  });

  it('reports a lost cooldown lift instead of spawning a task that changed underneath it', async () => {
    sweep.provesDead = true;
    sweep.taskAfter = { ...pendingTask(), status: 'blocked', metadata: { lastOrphanedAgentId: HOLDER_ID, blockedCategory: 'orphan-cooldown' } };
    vi.mocked(updateTask).mockResolvedValueOnce({ statusChanged: true });

    expect(await forceSpawnTask(TASK_ID)).toEqual({ error: 'Task changed while its dead agent was being retired' });
    expect(taskReadyEmits(emit)).toEqual([]);
  });

  // Every other outcome is a verdict, not a wait: the retry budget is spent, the
  // dead run had already committed, or the block belongs to someone else.
  it.each([
    ['blocked at the orphan retry ceiling', { status: 'blocked', metadata: { lastOrphanedAgentId: HOLDER_ID, blockedCategory: 'max-retries', blockedReason: 'orphan retries exceeded (3/3)' } },
      `Agent ${HOLDER_ID} is no longer running and its task is now blocked (orphan retries exceeded (3/3))`],
    ['completed from the dead run\'s own commit', { status: 'completed', metadata: {} },
      `Agent ${HOLDER_ID} is no longer running and its task is now completed`],
    ['cooling down for a different agent', { status: 'blocked', metadata: { lastOrphanedAgentId: 'agent-other', blockedCategory: 'orphan-cooldown', blockedReason: 'Orphan retry cooldown (5m remaining)' } },
      `Agent ${HOLDER_ID} is no longer running and its task is now blocked (Orphan retry cooldown (5m remaining))`],
  ])('reports a task the recovery left %s and launches nothing', async (_label, after, error) => {
    sweep.provesDead = true;
    sweep.taskAfter = { ...pendingTask(), ...after };

    expect(await forceSpawnTask(TASK_ID)).toEqual({ error });

    expect(updateTask).not.toHaveBeenCalled();
    expect(taskReadyEmits(emit)).toEqual([]);
  });

  it('reports a task deleted while its holder was being retired', async () => {
    sweep.provesDead = true;
    vi.mocked(getTaskById).mockResolvedValueOnce(pendingTask()).mockResolvedValueOnce(null);

    expect(await forceSpawnTask(TASK_ID)).toEqual({ error: 'Task not found' });
    expect(taskReadyEmits(emit)).toEqual([]);
  });

  it('holds while an in-process owner is still finishing, even after its record completed', async () => {
    persisted.agents = {};
    activeAgents.set(HOLDER_ID, { taskId: TASK_ID });

    const result = await forceSpawnTask(TASK_ID);

    expect(result.code).toBe('TASK_OWNER_HELD');
    expect(taskReadyEmits(emit)).toEqual([]);
    // No running record means nothing for the sweep to settle.
    expect(cleanupOrphanedAgents).not.toHaveBeenCalled();
  });

  it('keeps refusing a holder still inside the spawn window without sweeping', async () => {
    persisted.agents[HOLDER_ID] = holder({ startedAt: new Date().toISOString() });

    const result = await forceSpawnTask(TASK_ID);

    expect(result.error).toBe(`Agent ${HOLDER_ID} is already running this task`);
    expect(cleanupOrphanedAgents).not.toHaveBeenCalled();
    expect(taskReadyEmits(emit)).toEqual([]);
  });

  it('refuses to spawn a preflight progress card even with an explicit budget reset', async () => {
    vi.mocked(getTaskById).mockResolvedValueOnce({ id: 'preflight-demand-1', status: 'in_progress',
      metadata: { preflight: { requestId: 'demand-1' } } });
    const result = await forceSpawnTask('preflight-demand-1', { resetSpawnBudget: true });
    expect(result.error).toMatch(/preflight progress cards cannot be spawned/i);
    expect(taskReadyEmits(emit)).toEqual([]);
    expect(cleanupOrphanedAgents).not.toHaveBeenCalled();
  });
});

// The spawn budget is one counter. "Run now" refuses at the cap instead of
// reporting a spawn the dispatcher then blocks, and an explicit reset is the one
// way past it.
describe('forceSpawnTask — spawn budget', () => {
  const queued = (metadata = {}, status = 'pending') => ({ id: TASK_ID, status, taskType: 'user', priority: 'MEDIUM', description: 'Retained work', metadata });
  const atCap = { totalSpawnCount: String(MAX_TOTAL_SPAWNS), failureCount: '2' };

  beforeEach(() => { persisted.agents = {}; });

  it('refuses Run now at the spawn cap, names the reset, and admits a task one spawn below it', async () => {
    vi.mocked(getTaskById).mockResolvedValueOnce(queued(atCap));
    expect(await forceSpawnTask(TASK_ID)).toEqual({ code: 'SPAWN_BUDGET_EXHAUSTED',
      error: `Spawn budget exhausted (${MAX_TOTAL_SPAWNS}/${MAX_TOTAL_SPAWNS}) — reset the spawn budget to run this task again` });
    expect(taskReadyEmits(emit)).toEqual([]);

    vi.mocked(getTaskById).mockResolvedValueOnce(queued({ totalSpawnCount: MAX_TOTAL_SPAWNS - 1 }));
    expect(await forceSpawnTask(TASK_ID)).toEqual({ success: true, taskId: TASK_ID });
    expect(updateTask).not.toHaveBeenCalled();
  });

  it.each([['at the cap', atCap], ['with nothing charged', {}]])('an explicit reset zeroes the count %s under the inactive-owner fence, then spawns the saved task', async (_label, metadata) => {
    const task = queued(metadata);
    const saved = { ...task, metadata: { failureCount: metadata.failureCount } };
    vi.mocked(getTaskById).mockResolvedValueOnce(task);
    vi.mocked(updateTask).mockResolvedValueOnce(saved);

    expect(await forceSpawnTask(TASK_ID, { resetSpawnBudget: true })).toEqual({ success: true, taskId: TASK_ID });

    expect(vi.mocked(updateTask).mock.calls).toEqual([[TASK_ID, { metadata: { totalSpawnCount: undefined } }, 'user', {
      expectedStatus: 'pending', expectedTask: { description: task.description, priority: task.priority, metadata: task.metadata },
      recoveryOwner: { id: 'explicit-spawn-budget-reset', startedAt: null, requireInactive: true },
      spawnBudgetOperation: { kind: 'reset', requireInactive: true }, suppressDequeue: true, preserveRetryBudget: true,
    }]]);
    expect(taskReadyEmits(emit)).toEqual([['task:ready', { ...saved, taskType: 'user' }]]);
  });

  it('resets a blocked task whose stopped runs were archived without a resume pointer, and holds an in_progress one', async () => {
    const blocked = queued({ ...atCap, blockedCategory: 'max-spawns' }, 'blocked');
    vi.mocked(getTaskById).mockResolvedValueOnce(blocked);
    vi.mocked(updateTask).mockResolvedValueOnce({ ...blocked, status: 'pending', metadata: { failureCount: '2' } });
    expect(await forceSpawnTask(TASK_ID, { resetSpawnBudget: true })).toEqual({ success: true, taskId: TASK_ID });
    expect(vi.mocked(updateTask).mock.calls).toEqual([[TASK_ID, { status: 'pending', metadata: { totalSpawnCount: undefined } }, 'user', {
      expectedStatus: 'blocked', expectedTask: { description: blocked.description, priority: blocked.priority, metadata: blocked.metadata },
      recoveryOwner: { id: 'explicit-spawn-budget-reset', startedAt: null, requireInactive: true },
      spawnBudgetOperation: { kind: 'reset', requireInactive: true }, suppressDequeue: true, preserveRetryBudget: true,
    }]]);

    vi.mocked(updateTask).mockClear();
    vi.mocked(getTaskById).mockResolvedValueOnce(queued(atCap, 'in_progress'));
    expect(await forceSpawnTask(TASK_ID, { resetSpawnBudget: true })).toEqual({
      error: 'No stopped run of this task is left in agent history; inspect its checkout before retrying' });
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('refuses an explicit reset while a live agent owns the stopped task, or once the store finds it changed', async () => {
    persisted.agents = { [HOLDER_ID]: holder() };
    vi.mocked(getTaskById).mockResolvedValueOnce(queued(atCap, 'in_progress'));
    expect(await forceSpawnTask(TASK_ID, { resetSpawnBudget: true })).toEqual({ error: `Agent ${HOLDER_ID} still owns this task` });

    persisted.agents = {};
    vi.mocked(getTaskById).mockResolvedValueOnce(queued(atCap));
    vi.mocked(updateTask).mockResolvedValueOnce({ statusChanged: true });
    expect(await forceSpawnTask(TASK_ID, { resetSpawnBudget: true })).toEqual({ error: 'Task or ownership changed before spawn budget reset' });

    expect(vi.mocked(updateTask)).toHaveBeenCalledTimes(1);
    expect(taskReadyEmits(emit)).toEqual([]);
  });
});
