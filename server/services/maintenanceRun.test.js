import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'fs/promises';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
import { MAINTENANCE_SEQUENCE_TYPES, MAINTENANCE_TASK_ORDER } from '../lib/maintenanceSequence.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-maintenance-run-' });
vi.mock('../lib/fileUtils.js', async () => makeProxy(await vi.importActual('../lib/fileUtils.js')));

const state = vi.hoisted(() => ({ tasks: [], requests: [], invoked: [], dispatch: null, probe: null, inapplicable: {} }));
// Applicability is decided by the repository scan (covered in
// appQualitySchedule.test.js); here only the run's reaction to a verdict matters.
vi.mock('./appQualitySchedule.js', () => ({ inapplicableAuditReason: vi.fn(async (_appId, taskType) => state.inapplicable[taskType] || null) }));
vi.mock('./cosState.js', () => ({ loadState: vi.fn(async () => ({ agents: {} })) }));
vi.mock('./cosTaskStore.js', () => ({ getAllTasks: vi.fn(async () => ({ cos: { tasks: state.tasks }, user: { tasks: [] } })) }));
vi.mock('./taskSchedule.js', () => ({ getOnDemandRequests: vi.fn(async () => state.requests) }));
vi.mock('./apps.js', () => ({ getAppById: vi.fn(async (id) => (id === 'app-1' ? { id, name: 'Example App' } : null)) }));
// The registry a run's provider gate resolves against. `opencode-tui` belongs to
// no subscription family — the case #7416 is about — and `off-tui` is the
// registered-but-disabled control.
const PROVIDERS = [
  { id: 'codex', type: 'cli', command: 'codex', enabled: true },
  { id: 'claude', type: 'cli', command: 'claude', enabled: true },
  { id: 'opencode-tui', type: 'tui', command: 'opencode', enabled: true },
  { id: 'off-tui', type: 'tui', command: 'opencode', enabled: false },
];
vi.mock('./providers.js', () => ({
  getProviderById: vi.fn(async (id) => PROVIDERS.find((provider) => provider.id === id) || null),
  getAllProviders: vi.fn(async () => PROVIDERS),
}));
// The REAL resolver over that registry, not a hand-rolled stand-in: the whole
// point of these cases is which pins the shared gate accepts, and a double would
// only assert what the double was told.
vi.mock('./scheduledHandlers/providerPick.js', async (importActual) => await importActual());
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
  updateMaintenanceStep, startMaintenanceRun, stopMaintenanceRun, resumeMaintenanceRun, evaluateMaintenanceRun, getMaintenanceRun, listMaintenanceRuns,
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
  Object.assign(state, { tasks: [], requests: [], invoked: [], dispatch: null, probe: null, inapplicable: {} });
});
afterAll(cleanup);

describe('manual maintenance run', () => {
  // The regression: a refused request would leave the step pending, so the run
  // re-dispatched an audit that could never apply on every evaluation.
  it('completes an inapplicable audit as skipped without dispatching it, then moves on', async () => {
    state.inapplicable = { 'mobile-responsive': 'no user interface found in this repository' };
    const { run } = await startMaintenanceRun({ appId: 'app-1', providerId: 'codex', model: 'gpt-5', taskTypes: ['mobile-responsive', 'security'] });
    expect(dispatchedTypes()).toEqual(['security']);
    const stored = await getMaintenanceRun(run.id);
    expect(stored.completed[run.steps[0].id]).toBeTruthy();
    expect(stored.skipped).toEqual({ [run.steps[0].id]: 'no user interface found in this repository' });
    await __onMaintenanceAgentCompleted(agentFor(run, 1));
    expect(await getMaintenanceRun(run.id)).toMatchObject({
      status: 'completed',
      reason: 'maintenance sequence complete — skipped 1 check that does not apply to this repository',
    });
  });

  it.each(['file-issues', 'fix'])('runs only selected quality checks in %s mode with pinned overrides', async (mode) => {
    const { run } = await startMaintenanceRun({ appId: 'app-1', providerId: 'codex', model: 'gpt-5', effort: 'high', mode, taskTypes: ['security', 'documentation'] });
    expect(run.steps.map(step => step.taskRef.taskType)).toEqual(['security', 'documentation']);
    for (const step of run.steps) {
      expect(step.drain).toBe(false);
      expect(step.overrides).toMatchObject({ providerId: 'codex', model: 'gpt-5', effort: 'high', params: { fileIssues: mode === 'file-issues' } });
    }
    await __onMaintenanceAgentCompleted(agentFor(run, 0));
    await __onMaintenanceAgentCompleted(agentFor(run, 1));
    expect(dispatchedTypes()).toEqual(['security', 'documentation']);
    expect((await getMaintenanceRun(run.id)).status).toBe('completed');
  });

  it('dispatches an edited stage through its own provider family', async () => {
    const { run } = await start();
    await updateMaintenanceStep(run.id, run.steps[1].id, { providerId: 'claude', model: 'example-model', effort: 'low' });
    await __onMaintenanceAgentCompleted(agentFor(run, 0));
    expect(state.invoked.at(-1)).toMatchObject({ family: { id: 'claude' }, step: { overrides: { providerId: 'claude', effort: 'low' } } });
  });

  it('persists pending stage settings and dispatches them without changing other stages', async () => {
    const { run } = await start();
    const settings = { providerId: 'codex', model: 'example-model', effort: null };
    const updated = await updateMaintenanceStep(run.id, run.steps[1].id, settings);
    expect(updated.steps[0]).toEqual(run.steps[0]);
    expect((await getMaintenanceRun(run.id)).steps[1].overrides).toEqual({ ...run.steps[1].overrides, ...settings });
    await __onMaintenanceAgentCompleted(agentFor(run, 0));
    expect(state.invoked.at(-1).step.overrides).toMatchObject(settings);
    await expect(updateMaintenanceStep(run.id, run.steps[0].id, settings)).rejects.toMatchObject({ status: 409 });
    await expect(updateMaintenanceStep(run.id, run.steps[1].id, settings)).rejects.toMatchObject({ status: 409 });
    await expect(updateMaintenanceStep(run.id, run.steps[2].id, { ...settings, providerId: 'missing' })).rejects.toMatchObject({ status: 400 });
    await stopMaintenanceRun(run.id);
    await expect(updateMaintenanceStep(run.id, run.steps[2].id, settings)).rejects.toMatchObject({ status: 409 });
  });

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

  it('a relaunched step neither completes nor settles the run', async () => {
    // Relaunch retires the step's agent with `success: false` and requeues the
    // SAME task on another provider, so the step is still in flight. Evaluating
    // here would report it as a hold the user must retry or dismiss, for work that
    // is already on its way back out. The continuation's own completion advances
    // the run; `retryMaintenanceRuns` is the backstop if it never lands.
    const { run } = await start();
    const relaunched = {
      ...agentFor(run, 0, false),
      result: { success: false, resumed: true, resumedTaskId: 'task-0', error: 'Relaunched by user on codex' },
    };

    expect(await __onMaintenanceAgentCompleted(relaunched)).toBeNull();

    const after = await getMaintenanceRun(run.id);
    expect(after.completed).toEqual({});
    expect(after.active.stepId).toBe(run.steps[0].id);
    // Nothing new dispatched — only the step that was already running.
    expect(state.invoked).toHaveLength(1);
  });

  it('re-evaluates the run immediately when a stranded pause is retired with no continuation queued (#7469)', async () => {
    // `retireStrandedPausedAgents` (server/services/agentManagement.js) also
    // stamps `resumed: true` — on a pause whose task is gone or moved on — but
    // with NO `resumedTaskId`, because nothing was requeued. Reading that as a
    // handoff the same way a relaunch is read made this listener return `null`
    // and wait forever for a continuation that will never complete; the run
    // advanced only once the `retryMaintenanceRuns` backstop eventually swept
    // it. The step's underlying task is gone (not merely blocked), so a correct
    // fix re-evaluates now and re-dispatches the step immediately.
    const { run } = await start();
    const stranded = {
      ...agentFor(run, 0, false),
      result: { success: false, resumed: true, error: 'Pause retired — its task task-0 no longer exists' },
    };

    await __onMaintenanceAgentCompleted(stranded);

    expect(state.invoked).toHaveLength(2);
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

  it('refuses an unknown app, and an unregistered or disabled provider, before writing anything', async () => {
    await expect(startMaintenanceRun({ appId: 'nope', providerId: 'codex', model: 'gpt-5' })).rejects.toMatchObject({ status: 400, code: 'MAINTENANCE_RUN_APP_UNAVAILABLE' });
    for (const providerId of ['not-registered', 'off-tui']) {
      await expect(startMaintenanceRun({ appId: 'app-1', providerId, model: 'llama' })).rejects.toMatchObject({ status: 400, code: 'MAINTENANCE_RUN_PROVIDER_UNAVAILABLE' });
    }
    expect(await listMaintenanceRuns()).toEqual([]);
    expect(state.invoked).toEqual([]);
  });

  // #7416. The picker offers every enabled process provider, but the dispatch
  // path required a subscription family end to end, so "Run now" on an OpenCode
  // TUI or a local-model wrapper failed with MAINTENANCE_RUN_PROVIDER_UNAVAILABLE.
  describe('a provider outside every subscription family', () => {
    it('starts a run and dispatches it unfamilied, crediting no window', async () => {
      const { run, result } = await startMaintenanceRun({ appId: 'app-1', providerId: 'opencode-tui', model: 'local-model' });
      expect(result).toMatchObject({ dispatched: true, taskType: 'better-structural-drift' });
      expect(run).toMatchObject({ status: 'running', familyId: null, claimFamilyId: null });
      expect(state.invoked.at(-1)).toMatchObject({
        maintenanceRunId: run.id,
        family: { id: null, unfamilied: true },
        step: expect.objectContaining({ overrides: expect.objectContaining({ providerId: 'opencode-tui' }) }),
      });
    });

    it('accepts a per-step edit onto one, without the step inheriting the run\'s family', async () => {
      // The regression a truthiness fallback reintroduces: a step whose own
      // family is legitimately null would read as "nothing recorded, inherit",
      // pick up `codex`, and then be refused for not belonging to it.
      const { run } = await start();
      await updateMaintenanceStep(run.id, run.steps[1].id, { providerId: 'opencode-tui', model: 'local-model', effort: null });
      await __onMaintenanceAgentCompleted(agentFor(run, 0));
      expect(state.invoked.at(-1)).toMatchObject({
        family: { id: null, unfamilied: true },
        step: { overrides: { providerId: 'opencode-tui' } },
      });
    });

    it('accepts it as the claim handler while the audits stay on their own family', async () => {
      const { run } = await startMaintenanceRun({ appId: 'app-1', providerId: 'codex', model: 'gpt-5', claimHandler: { providerId: 'opencode-tui', model: 'local-model', effort: null } });
      expect(run).toMatchObject({ familyId: 'codex', claimFamilyId: null });
      expect(state.invoked.at(-1).family).toEqual({ id: 'codex' });
      await __onMaintenanceAgentCompleted(agentFor(run, 0));
      expect(state.invoked.at(-1)).toMatchObject({
        family: { id: null, unfamilied: true },
        step: { drain: true, overrides: expect.objectContaining({ providerId: 'opencode-tui' }) },
      });
    });
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
    expect(state.invoked.at(-1).step.overrides.params).toEqual({ fileIssues: false, useWorktree: true, openPR: true });
    await __onMaintenanceAgentCompleted(agentFor(run, index));
  }
  expect(dispatchedTypes()).toEqual([...MAINTENANCE_TASK_ORDER, 'claim-issue']);
  await __onMaintenanceAgentCompleted(agentFor(run, MAINTENANCE_TASK_ORDER.length));
  expect(dispatchedTypes().slice(-2)).toEqual(['claim-issue', 'claim-issue']);
  state.probe = { drained: true };
  await __onMaintenanceAgentCompleted(agentFor(run, MAINTENANCE_TASK_ORDER.length));
  expect(await getMaintenanceRun(run.id)).toMatchObject({ status: 'completed' });
});

it('files findings consecutively and finishes without claiming when claims are disabled', async () => {
  const { run } = await startMaintenanceRun({ appId: 'app-1', providerId: 'codex', model: 'gpt-5', mode: 'file-issues', claimBetweenAudits: false, claimHandler: { providerId: 'unavailable', model: 'example' } });
  expect(run.steps.map(step => step.taskRef.taskType)).toEqual(MAINTENANCE_TASK_ORDER);
  for (let index = 0; index < run.steps.length; index++) {
    expect(state.invoked.at(-1).step.overrides.params.fileIssues).toBe(index < run.steps.length - 1);
    await __onMaintenanceAgentCompleted(agentFor(run, index));
  }
  expect(dispatchedTypes()).toEqual(MAINTENANCE_TASK_ORDER);
  expect(await getMaintenanceRun(run.id)).toMatchObject({ status: 'completed' });
  expect((await listMaintenanceRuns())[0].steps).toHaveLength(7);
});

// A different subscription family must survive storage and dispatch, including
// repeated claim passes, without changing the audit pins.
it('dispatches claims with their own provider family, model and effort', async () => {
  const claimHandler = { providerId: 'claude', model: 'sonnet', effort: 'low' };
  const { run } = await startMaintenanceRun({ appId: 'app-1', providerId: 'codex', model: 'gpt-5', effort: 'high', claimHandler });
  expect((await getMaintenanceRun(run.id)).steps[1].overrides).toEqual({ ...claimHandler, params: {} });
  await evaluateMaintenanceRun(run.id, { completeStepId: run.steps[0].id });
  await evaluateMaintenanceRun(run.id);
  expect(state.invoked.slice(1)).toHaveLength(2);
  for (const call of state.invoked.slice(1)) expect(call).toMatchObject({ family: { id: 'claude' }, step: { overrides: claimHandler } });
  state.probe = { drained: true };
  await evaluateMaintenanceRun(run.id);
  expect(state.invoked.at(-1)).toMatchObject({ family: { id: 'codex' }, step: { overrides: { providerId: 'codex', model: 'gpt-5', effort: 'high' } } });
});

it('rejects an unavailable claim provider before starting any work', async () => {
  await expect(startMaintenanceRun({ appId: 'app-1', providerId: 'codex', claimHandler: { providerId: 'unavailable', model: 'example' } })).rejects.toMatchObject({ code: 'MAINTENANCE_RUN_PROVIDER_UNAVAILABLE' });
  expect(state.invoked).toEqual([]);
});

it('dispatches independent quality runs while another run is pending and resumes them independently', async () => {
  const { run: ladder } = await start();
  state.requests = [{ id: 'demand-1', burn: { maintenanceRunId: ladder.id } }];
  const { run: security } = await startMaintenanceRun({ appId: 'app-1', providerId: 'codex', taskTypes: ['security'] });
  const { run: performance } = await startMaintenanceRun({ appId: 'app-1', providerId: 'codex', taskTypes: ['performance'], mode: 'fix' });
  expect(dispatchedTypes()).toEqual(['better-structural-drift', 'security', 'performance']);
  await stopMaintenanceRun(security.id);
  expect((await getMaintenanceRun(performance.id)).status).toBe('running');
  expect((await resumeMaintenanceRun(security.id)).run.status).toBe('running');
  await __onMaintenanceAgentCompleted(agentFor(performance, 0));
  expect((await getMaintenanceRun(performance.id)).status).toBe('completed');
  expect((await getMaintenanceRun(security.id)).status).toBe('running');
  expect((await getMaintenanceRun(ladder.id)).completed).toEqual({});
});
