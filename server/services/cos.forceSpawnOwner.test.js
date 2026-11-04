/**
 * #14039 — "Run now" on a pending task whose `running` agent record is older
 * than the spawn window. forceSpawnTask used to fall through and report success
 * while prepareAgentSpawn's ownership gate (hasActiveTaskOwner) refused the
 * spawn downstream. It must now settle the holder through the zombie sweep and
 * admit only when that shared gate agrees, otherwise answer with a named hold.
 *
 * Drives the real forceSpawnTask and the real hasActiveTaskOwner; the zombie
 * sweep is doubled so each case controls whether liveness evidence proves the
 * holder dead. Own file because the module-wide state mocks would replace the
 * helpers cos.test.js exercises for real.
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

const sweep = vi.hoisted(() => ({ provesDead: false }));
const releaseDisposition = vi.hoisted(() => vi.fn(async () => null));
vi.mock('./releaseSynchronization.js', async original => ({ ...(await original()), releaseTaskDispatchDisposition: releaseDisposition }));
vi.mock('./cosAgentLifecycle.js', async (importOriginal) => ({
  ...(await importOriginal()),
  cleanupZombieAgents: vi.fn(async () => {
    const agent = persisted.agents[HOLDER_ID];
    if (!sweep.provesDead || agent?.status !== 'running') return { cleaned: [], count: 0 };
    persisted.agents[HOLDER_ID] = { ...agent, status: 'completed', result: { success: false } };
    return { cleaned: [HOLDER_ID], count: 1 };
  }),
}));

// A freshly created task: a known spawn-budget episode with no dispatch yet,
// so the budget gate (#13948) admits it and only ownership decides.
vi.mock('./cosTaskStore.js', async (importOriginal) => {
  const { newSpawnBudgetEpisode } = await import('./spawnBudgetProof.js');
  return {
    ...(await importOriginal()),
    getTaskById: vi.fn(async (id) => ({
      id, status: 'pending', taskType: 'user', metadata: { spawnBudgetProof: newSpawnBudgetEpisode() },
    })),
  };
});
vi.mock('./agentProviderResolution.js', () => ({
  resolveAgentProviderAndModel: vi.fn(async () => ({ ok: true, provider: { id: 'cloud-cli', type: 'cli' } })),
}));
vi.mock('./cosLocalEndpointSlots.js', async (importOriginal) => ({
  ...(await importOriginal()),
  localEndpointCapacityError: vi.fn(async () => null),
}));

const { forceSpawnTask } = await import('./cos.js');
const { cosEvents } = await import('./cosEvents.js');
const { cleanupZombieAgents } = await import('./cosAgentLifecycle.js');
const { getTaskById } = await import('./cosTaskStore.js');
const { setUseRunner, useRunner, activeAgents } = await import('./agentState.js');

const originalUseRunner = useRunner;
const holder = (overrides = {}) => ({
  id: HOLDER_ID, taskId: TASK_ID, status: 'running', pid: 4242, startedAt: STALE_STARTED_AT(), ...overrides,
});
const taskReadyEmits = (emit) => emit.mock.calls.filter(([event]) => event === 'task:ready');

describe('forceSpawnTask — stale running holder (#14039)', () => {
  let emit;

  beforeEach(() => {
    releaseDisposition.mockReset().mockResolvedValue(null);
    setUseRunner(false);
    sweep.provesDead = false;
    persisted = { paused: false, agents: { [HOLDER_ID]: holder() }, config: { maxConcurrentAgents: 1 } };
    emit = vi.spyOn(cosEvents, 'emit');
    vi.mocked(cleanupZombieAgents).mockClear();
  });

  afterEach(() => {
    emit.mockRestore();
    activeAgents.clear();
    setUseRunner(originalUseRunner);
  });

  it('answers with a named hold and launches nothing when the holder cannot be proven dead', async () => {
    const result = await forceSpawnTask(TASK_ID);

    expect(cleanupZombieAgents).toHaveBeenCalledTimes(1);
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

  it('retries a holder the zombie sweep settled as dead', async () => {
    sweep.provesDead = true;

    const result = await forceSpawnTask(TASK_ID);

    expect(result).toEqual({ success: true, taskId: TASK_ID });
    expect(taskReadyEmits(emit)).toHaveLength(1);
    // The freed slot counts: at a limit of 1 the zombie no longer blocks capacity.
    expect(persisted.agents[HOLDER_ID].status).toBe('completed');
  });

  it('holds while an in-process owner is still finishing, even after its record completed', async () => {
    persisted.agents = {};
    activeAgents.set(HOLDER_ID, { taskId: TASK_ID });

    const result = await forceSpawnTask(TASK_ID);

    expect(result.code).toBe('TASK_OWNER_HELD');
    expect(taskReadyEmits(emit)).toEqual([]);
    // No running record means nothing for the sweep to settle.
    expect(cleanupZombieAgents).not.toHaveBeenCalled();
  });

  it('keeps refusing a holder still inside the spawn window without sweeping', async () => {
    persisted.agents[HOLDER_ID] = holder({ startedAt: new Date().toISOString() });

    const result = await forceSpawnTask(TASK_ID);

    expect(result.error).toBe(`Agent ${HOLDER_ID} is already running this task`);
    expect(cleanupZombieAgents).not.toHaveBeenCalled();
    expect(taskReadyEmits(emit)).toEqual([]);
  });

  it('refuses to spawn a preflight progress card even with an explicit budget reset', async () => {
    vi.mocked(getTaskById).mockResolvedValueOnce({ id: 'preflight-demand-1', status: 'in_progress',
      metadata: { preflight: { requestId: 'demand-1' } } });
    const result = await forceSpawnTask('preflight-demand-1', { resetSpawnBudget: true });
    expect(result.error).toMatch(/preflight progress cards cannot be spawned/i);
    expect(taskReadyEmits(emit)).toEqual([]);
    expect(cleanupZombieAgents).not.toHaveBeenCalled();
  });
});
