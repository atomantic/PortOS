import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'fs/promises';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
import { MAINTENANCE_SEQUENCE_TYPES, MAINTENANCE_TASK_ORDER } from '../lib/maintenanceSequence.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-maintenance-run-' });
vi.mock('../lib/fileUtils.js', async () => makeProxy(await vi.importActual('../lib/fileUtils.js')));

const state = vi.hoisted(() => ({ tasks: [], requests: [], invoked: [], dispatch: null, probe: null }));
vi.mock('./cosState.js', () => ({ loadState: vi.fn(async () => ({ agents: {} })) }));
vi.mock('./cosTaskStore.js', () => ({ getAllTasks: vi.fn(async () => ({ cos: { tasks: state.tasks }, user: { tasks: [] } })) }));
vi.mock('./taskSchedule.js', () => ({ getOnDemandRequests: vi.fn(async () => state.requests) }));
vi.mock('./apps.js', () => ({ getAppById: vi.fn(async (id) => (id === 'app-1' ? { id, name: 'Example App' } : null)) }));
vi.mock('./providers.js', () => ({ getProviderById: vi.fn(async (id) => (id === 'codex' ? { id, type: 'cli', command: 'codex', enabled: true } : null)) }));
vi.mock('./scheduledHandlers/providerPick.js', () => ({ resolveBurnProvider: vi.fn(async ({ job, family }) => (job.providerId === 'codex' && family.id === 'codex' ? { id: 'codex' } : null)) }));
vi.mock('./quotaBurnInvoke.js', () => ({
  getQuotaBurnTaskCatalog: vi.fn(async () => ({ builtin: {}, custom: {} })),
  invokeQuotaBurnStep: vi.fn(async (call) => {
    state.invoked.push(call);
    return state.dispatch || { dispatched: true, summary: `ran ${call.step.taskRef.taskType}`, awaiting: { requestId: `demand-${state.invoked.length}` } };
  }),
}));
vi.mock('./quotaBurnSequence.js', async (importActual) => ({
  ...(await importActual()),
  probeSequenceDrain: vi.fn(async (job) => state.probe || { job }),
}));
// The independence claim, made checkable: the plan store is never consulted.
vi.mock('./quotaBurnStore.js', () => ({ getQuotaBurnConfig: vi.fn(async () => { throw new Error('quota burn config must not be read'); }) }));

const { getQuotaBurnConfig } = await import('./quotaBurnStore.js');
const { invokeQuotaBurnStep } = await import('./quotaBurnInvoke.js');
const {
  startMaintenanceRun, stopMaintenanceRun, resumeMaintenanceRun, evaluateMaintenanceRun, getMaintenanceRun, listMaintenanceRuns,
  __onMaintenanceAgentSpawned, __onMaintenanceAgentCompleted, __retryMaintenanceRuns, __resetMaintenanceRunScheduler,
} = await import('./maintenanceRun.js');

const start = () => startMaintenanceRun({ appId: 'app-1', providerId: 'codex', model: 'gpt-5', effort: 'high' });
const agentFor = (run, index, success = true) => ({
  taskId: `task-${index}`,
  result: { success },
  metadata: { taskQuotaBurnFamily: run.familyId, taskQuotaBurnStepId: run.steps[index].id, taskQuotaBurnMaintenanceRunId: run.id },
});
const dispatchedTypes = () => state.invoked.map((call) => call.step.taskRef.taskType);

beforeEach(async () => {
  vi.clearAllMocks();
  __resetMaintenanceRunScheduler();
  await rm(join(tempRoot, 'cos', 'maintenance-runs.json'), { force: true });
  Object.assign(state, { tasks: [], requests: [], invoked: [], dispatch: null, probe: null });
});
afterAll(cleanup);

describe('manual maintenance run', () => {
  it('walks the whole ladder to completion on agent completions and drain probes, never touching the burn plan', async () => {
    const { run, result } = await start();
    expect(result).toMatchObject({ dispatched: true, taskType: 'better-structural-drift' });
    expect(run).toMatchObject({ status: 'running', familyId: 'codex', active: { stepId: run.steps[0].id, requestId: 'demand-1' } });
    expect(run.steps.map((step) => step.taskRef.taskType)).toEqual(MAINTENANCE_SEQUENCE_TYPES);
    expect(invokeQuotaBurnStep).toHaveBeenCalledWith(expect.objectContaining({
      maintenanceRunId: run.id, family: { id: 'codex' },
      step: expect.objectContaining({ runOnce: true, taskRef: { kind: 'builtin', taskType: 'better-structural-drift', appId: 'app-1' }, overrides: { providerId: 'codex', model: 'gpt-5', effort: 'high', params: { fileIssues: true } } }),
    }));

    // The audit finishes → the drain is probed → the backlog is actionable → a claim goes out.
    await __onMaintenanceAgentCompleted(agentFor(run, 0));
    expect(dispatchedTypes()).toEqual(['better-structural-drift', 'claim-issue']);
    expect((await getMaintenanceRun(run.id)).completed).toHaveProperty(run.steps[0].id);
    // The claim finishes with issues left → the drain repeats, ignoring the task that just finished.
    await __onMaintenanceAgentCompleted(agentFor(run, 1));
    expect(dispatchedTypes()).toEqual(['better-structural-drift', 'claim-issue', 'claim-issue']);
    // Backlog empty → the drain is done and the next audit goes out in the same evaluation.
    state.probe = { drained: true };
    await __onMaintenanceAgentCompleted(agentFor(run, 1));
    expect(dispatchedTypes().at(-1)).toBe('simplify');
    expect((await getMaintenanceRun(run.id)).completed).toHaveProperty(run.steps[1].id);

    // Finish every remaining audit; every drain reports empty.
    for (let index = 2; index < run.steps.length; index += 2) await __onMaintenanceAgentCompleted(agentFor(run, index));
    const finished = await getMaintenanceRun(run.id);
    expect(finished).toMatchObject({ status: 'completed', reason: 'maintenance sequence complete', active: null });
    expect(Object.keys(finished.completed)).toHaveLength(run.steps.length);
    expect(dispatchedTypes().filter((type) => type !== 'claim-issue')).toEqual(MAINTENANCE_SEQUENCE_TYPES.filter((type) => type !== 'claim-issue'));
    expect(getQuotaBurnConfig).not.toHaveBeenCalled();
  });

  it('holds on its own queued, running or blocked work and on a failed audit, then retries once the hold clears', async () => {
    const { run } = await start();
    state.requests = [{ id: 'demand-1', taskType: 'better-structural-drift', burn: { maintenanceRunId: run.id } }];
    expect(await evaluateMaintenanceRun(run.id)).toMatchObject({ dispatched: false, reason: expect.stringContaining('demand-1') });
    state.requests = [];
    state.tasks = [{ id: 'task-0', status: 'in_progress', metadata: { quotaBurnFamily: 'codex', quotaBurnMaintenanceRunId: run.id } }];
    expect(await evaluateMaintenanceRun(run.id)).toMatchObject({ dispatched: false, reason: 'waiting for in progress task task-0' });
    // A failed audit completes nothing; its blocked task is the hold the user sees.
    state.tasks[0].status = 'blocked';
    await __onMaintenanceAgentCompleted(agentFor(run, 0, false));
    expect((await getMaintenanceRun(run.id)).completed).toEqual({});
    expect((await getMaintenanceRun(run.id)).reason).toBe('waiting for blocked task task-0');
    expect(state.invoked).toHaveLength(1);
    // Another run's task on the same family is not this run's business.
    state.tasks = [{ id: 'other', status: 'in_progress', metadata: { quotaBurnFamily: 'codex' } }];
    state.dispatch = { dispatched: false, reason: 'an on-demand run of "better-structural-drift" is already queued' };
    await __retryMaintenanceRuns();
    expect((await getMaintenanceRun(run.id)).reason).toMatch(/already queued/);
    state.dispatch = null;
    await __retryMaintenanceRuns();
    expect(state.invoked).toHaveLength(3);
    expect((await getMaintenanceRun(run.id)).active.stepId).toBe(run.steps[0].id);
  });

  it('stops without recalling work, resumes from its ledger, and refuses a second run for the same app', async () => {
    const { run } = await start();
    await expect(start()).rejects.toMatchObject({ status: 409, code: 'MAINTENANCE_RUN_ACTIVE' });
    await __onMaintenanceAgentCompleted(agentFor(run, 0));
    const stopped = await stopMaintenanceRun(run.id);
    expect(stopped).toMatchObject({ status: 'stopped', reason: 'stopped by the user' });
    expect(await __onMaintenanceAgentCompleted(agentFor(run, 1))).toEqual({ skipped: 'stopped' });
    expect(await __retryMaintenanceRuns()).toBeUndefined();
    expect(state.invoked).toHaveLength(2);
    const { run: resumed, result } = await resumeMaintenanceRun(run.id);
    expect(resumed.status).toBe('running');
    expect(resumed.completed).toHaveProperty(run.steps[0].id);
    expect(result).toMatchObject({ dispatched: true, taskType: 'claim-issue' });
    expect((await listMaintenanceRuns()).map((entry) => entry.id)).toEqual([run.id]);
  });

  it('lets a Stop or a completion that lands mid-evaluation win over the stale walk snapshot', async () => {
    const { run } = await start();
    // A completion arrives while a sweep is mid-walk holding on the in-flight task.
    state.tasks = [{ id: 'task-0', status: 'in_progress', metadata: { quotaBurnFamily: 'codex', quotaBurnMaintenanceRunId: run.id } }];
    const sweep = evaluateMaintenanceRun(run.id);
    const completion = __onMaintenanceAgentCompleted(agentFor(run, 0));
    await Promise.all([sweep, completion]);
    const afterCompletion = await getMaintenanceRun(run.id);
    expect(afterCompletion.completed).toHaveProperty(run.steps[0].id);
    expect(dispatchedTypes()).toEqual(['better-structural-drift', 'claim-issue']);
    // A Stop clicked while a dispatch is in flight sticks: the walk cannot write
    // the snapshot status back over it.
    state.tasks = [];
    // Wait for the walk to actually reach its dispatch before issuing the Stop —
    // the walk awaits several reads first, and how long those take is not ours.
    let finishDispatch;
    const dispatchStarted = new Promise((started) => {
      invokeQuotaBurnStep.mockImplementationOnce(() => new Promise((resolve) => { finishDispatch = resolve; started(); }));
    });
    const walk = evaluateMaintenanceRun(run.id);
    await dispatchStarted;
    const stop = stopMaintenanceRun(run.id);
    finishDispatch({ dispatched: true, summary: 'ran', awaiting: { requestId: 'demand-late' } });
    await Promise.all([walk, stop]);
    expect(await getMaintenanceRun(run.id)).toMatchObject({ status: 'stopped', active: { requestId: 'demand-late' } });
    expect(await evaluateMaintenanceRun(run.id)).toEqual({ skipped: 'stopped' });
  });

  it('records a walk that throws as the hold reason instead of leaving a phantom running record', async () => {
    invokeQuotaBurnStep.mockRejectedValueOnce(new Error('schedule unreadable'));
    const { run, result } = await start();
    expect(result).toEqual({ dispatched: false, reason: 'schedule unreadable' });
    expect(run).toMatchObject({ status: 'running', reason: 'schedule unreadable' });
  });

  it('refuses an unknown app or a provider outside every subscription family before writing anything', async () => {
    await expect(startMaintenanceRun({ appId: 'nope', providerId: 'codex', model: 'gpt-5' })).rejects.toMatchObject({ status: 400, code: 'MAINTENANCE_RUN_APP_UNAVAILABLE' });
    await expect(startMaintenanceRun({ appId: 'app-1', providerId: 'ollama', model: 'llama' })).rejects.toMatchObject({ status: 400, code: 'MAINTENANCE_RUN_PROVIDER_UNAVAILABLE' });
    expect(await listMaintenanceRuns()).toEqual([]);
    expect(state.invoked).toEqual([]);
  });
});

// Regression: queued maintenance must identify its real agent immediately and
// publish persisted transitions, without waiting for the retry sweep.
it('publishes queued, running, and completed progress with the active agent link identity', async () => {
  const { cosEvents } = await import('./cosEvents.js');
  const updates = [];
  const listener = run => updates.push(run);
  cosEvents.on('maintenance:updated', listener);
  const { run } = await start();
  expect(updates.at(-1).active.status).toBe('queued');
  await __onMaintenanceAgentSpawned({ ...agentFor(run, 0), id: 'agent-example' });
  expect(await getMaintenanceRun(run.id)).toMatchObject({ active: { agentId: 'agent-example', status: 'running' } });
  expect(updates.at(-1).active.agentId).toBe('agent-example');
  await __onMaintenanceAgentCompleted(agentFor(run, 0));
  expect(updates.at(-1).completed).toHaveProperty(run.steps[0].id);
  expect(updates.at(-1).active).not.toHaveProperty('agentId');
  cosEvents.off('maintenance:updated', listener);
});

it('runs fixes consecutively and drains remaining issues only after documentation', async () => {
  const { run } = await startMaintenanceRun({ appId: 'app-1', providerId: 'codex', model: 'gpt-5', mode: 'fix' });
  expect(run.steps.map(step => step.taskRef.taskType)).toEqual([...MAINTENANCE_TASK_ORDER, 'claim-issue']);
  for (let index = 0; index < MAINTENANCE_TASK_ORDER.length; index++) {
    expect(state.invoked.at(-1).step.overrides.params).toEqual({ fileIssues: false });
    await __onMaintenanceAgentCompleted(agentFor(run, index));
  }
  expect(dispatchedTypes()).toEqual([...MAINTENANCE_TASK_ORDER, 'claim-issue']);
  await __onMaintenanceAgentCompleted(agentFor(run, MAINTENANCE_TASK_ORDER.length));
  expect(dispatchedTypes().slice(-2)).toEqual(['claim-issue', 'claim-issue']);
  state.probe = { drained: true };
  await __onMaintenanceAgentCompleted(agentFor(run, MAINTENANCE_TASK_ORDER.length));
  expect(await getMaintenanceRun(run.id)).toMatchObject({ status: 'completed' });
});
