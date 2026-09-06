/**
 * The shared quota-burn invocation path.
 *
 * Every collaborator this module reaches is a service with its own storage, so
 * they are doubled and the module's OWN contract is what is under test: which
 * reference shape routes where, which gate refuses with which reason, what the
 * effective settings resolve to, and what provenance reaches the queue. The
 * doubles record their calls so the two negative contracts that matter most —
 * "a probe writes nothing" and "a burn does not inherit the manual endpoint's
 * privileges" — are asserted directly rather than inferred.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = {
  schedule: {},
  apps: [],
  appOverrides: {},
  features: {},
  jobs: [],
  providers: [],
  onDemandRequests: [],
  inFlightJobIds: [],
  agents: {},
  improveEnabled: true,
  cosStateReadable: true,
  triggered: [],
  triggerResult: null,
  added: [],
  addResult: null,
  handlerCalls: [],
  handlerPending: { count: 3, detail: '3 entries', context: { scanned: true } },
  handlerRun: { dispatched: true, summary: 'rendered 3' },
  generated: null,
};

vi.mock('./taskScheduleStore.js', () => ({
  loadSchedule: vi.fn(async () => ({ tasks: state.schedule, onDemandRequests: state.onDemandRequests })),
}));

vi.mock('./apps.js', () => ({
  getActiveApps: vi.fn(async () => state.apps.map((app) => ({ ...app, taskTypeOverrides: state.appOverrides[app.id] || {} }))),
}));

vi.mock('./cosJobScheduler.js', () => ({
  isJobFireInFlight: vi.fn((jobId) => state.inFlightJobIds.includes(jobId)),
}));

// `lib/autonomousJobTask.js` is deliberately NOT doubled: it is a pure
// projection, and the point of sharing it is that the burn lane cannot drop a
// key the generator emits — a double would assert nothing.
vi.mock('./autonomousJobs.js', () => ({
  getAllJobs: vi.fn(async () => state.jobs),
  generateTaskFromJob: vi.fn(async (job) => (state.generated = {
    id: `${job.id}-gen`,
    description: `Run ${job.name}`,
    priority: 'MEDIUM',
    autoApprove: job.autonomyLevel === 'yolo',
    metadata: { autonomousJob: true, jobId: job.id, prompt: 'do the work', app: job.appId || undefined },
  })),
}));

vi.mock('./providers.js', () => ({
  getAllProviders: vi.fn(async () => state.providers),
}));

vi.mock('./cosState.js', () => ({
  loadState: vi.fn(async () => (state.cosStateReadable ? { agents: state.agents } : null)),
  isImprovementEnabled: vi.fn(() => state.improveEnabled),
}));

vi.mock('./cosTaskStore.js', () => ({
  addTask: vi.fn(async (task, taskType, options) => {
    state.added.push({ task, taskType, options });
    return state.addResult ?? { id: 'sys-1', ...task };
  }),
}));

vi.mock('./taskSchedule.js', () => ({
  // The schedule's own memoized gate, doubled at the same altitude the catalog
  // consumes it — one call per distinct feature id, absent feature => enabled.
  createFeatureGate: vi.fn(() => async (config) => !config?.feature || state.features[config.feature] !== false),
  getOnDemandRequests: vi.fn(async () => state.onDemandRequests),
  triggerOnDemandTask: vi.fn(async (taskType, appId, options) => {
    state.triggered.push({ taskType, appId, options });
    return state.triggerResult ?? { id: 'demand-1', taskType, appId, ...options };
  }),
}));

vi.mock('./scheduledHandlers/index.js', () => ({
  countScheduledHandlerPending: vi.fn(async (args) => {
    state.handlerCalls.push({ op: 'count', ...args });
    return state.handlerPending;
  }),
  runScheduledHandler: vi.fn(async (args) => {
    state.handlerCalls.push({ op: 'run', ...args });
    return state.handlerRun;
  }),
}));

const {
  countQuotaBurnStepPending,
  effectiveSettings,
  getQuotaBurnTaskCatalog,
  invokeQuotaBurnStep,
  isBurnEligibleCustomJob,
  resolveQuotaBurnStep,
} = await import('./quotaBurnInvoke.js');
const { normalizeQuotaBurnJob } = await import('../lib/quotaBurnConfig.js');
const { addTask } = await import('./cosTaskStore.js');

const grok = { id: 'grok', reservePercent: 0, maxDispatchesPerWindow: -1 };
const candidate = { limitingResetAt: 1700000000000 };

const step = (raw) => normalizeQuotaBurnJob({ id: 'step-1', enabled: true, ...raw });

beforeEach(() => {
  state.schedule = {
    ux: { enabled: true, providerId: null, model: 'saved-model', effort: 'medium', taskMetadata: { fileIssues: true, depth: 'full' } },
    'pr-reviewer': { enabled: true, taskMetadata: {} },
    'universe-bible-images': { enabled: true, providerId: null, model: null, effort: null, taskMetadata: { maxEntries: 5 } },
    'jira-sprint-manager': { enabled: true, feature: 'jira', taskMetadata: {} },
    'model-comparison-refresh': { enabled: true, taskMetadata: {} },
  };
  state.apps = [{ id: 'app-1', name: 'Example App' }];
  state.appOverrides = { 'app-1': { ux: { enabled: true }, 'pr-reviewer': { enabled: true } } };
  state.features = {};
  state.jobs = [
    { id: 'job-a', name: 'Nightly sweep', type: 'agent', enabled: true, autonomyLevel: 'yolo', appId: 'app-1', providerId: null, model: null, effort: null, taskMetadata: { useWorktree: true } },
    { id: 'job-manual', name: 'Needs a human', type: 'agent', enabled: true, autonomyLevel: 'manager' },
    { id: 'job-shell', name: 'Disk check', type: 'shell', enabled: true, autonomyLevel: 'yolo' },
    { id: 'job-script', name: 'Catalog refresh', type: 'script', enabled: true, autonomyLevel: 'yolo' },
  ];
  state.providers = [
    { id: 'grok-cli', command: '/usr/local/bin/grok', type: 'cli', enabled: true },
    { id: 'grok-tui', command: '/usr/local/bin/grok', type: 'tui', enabled: true },
    { id: 'codex-tui', command: '/usr/local/bin/codex', type: 'tui', enabled: true },
  ];
  state.onDemandRequests = [];
  state.inFlightJobIds = [];
  state.agents = {};
  state.improveEnabled = true;
  state.cosStateReadable = true;
  state.triggered = [];
  state.triggerResult = null;
  state.added = [];
  state.addResult = null;
  state.handlerCalls = [];
  state.handlerPending = { count: 3, detail: '3 entries', context: { scanned: true } };
  state.handlerRun = { dispatched: true, summary: 'rendered 3' };
  state.generated = null;
  vi.clearAllMocks();
});

describe('getQuotaBurnTaskCatalog', () => {
  it('carries the instance-feature verdict beside the user switch, not folded into it', async () => {
    // Two switches, two fields: the shared ladder needs them apart to say WHICH
    // one is off, and a task whose feature is disabled is still `enabled: true`.
    expect((await getQuotaBurnTaskCatalog()).builtin['jira-sprint-manager'])
      .toMatchObject({ enabled: true, featureEnabled: true, feature: 'jira' });
    state.features.jira = false;
    expect((await getQuotaBurnTaskCatalog()).builtin['jira-sprint-manager'])
      .toMatchObject({ enabled: true, featureEnabled: false });
  });

  it('lists only the apps that have a built-in type switched on', async () => {
    state.apps = [{ id: 'app-1' }, { id: 'app-2' }];
    const { builtin } = await getQuotaBurnTaskCatalog();
    expect(builtin.ux.appIds).toEqual(['app-1']);
  });

  it('marks shell and script jobs ineligible and agent jobs eligible', async () => {
    const { custom } = await getQuotaBurnTaskCatalog();
    expect(custom['job-a'].eligible).toBe(true);
    expect(custom['job-shell'].eligible).toBe(false);
    expect(custom['job-script'].eligible).toBe(false);
  });

  it('treats a job written before `type` existed as an agent job', () => {
    expect(isBurnEligibleCustomJob({ id: 'legacy' })).toBe(true);
  });
});

describe('resolved effective settings', () => {
  it('layers the step overrides over the task\'s saved settings and merges params', async () => {
    const resolved = await resolveQuotaBurnStep(step({
      taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' },
      overrides: { model: 'burn-model', params: { depth: 'shallow' } },
    }));
    expect(resolved.effective).toEqual({
      providerId: null,
      model: 'burn-model',
      effort: 'medium',
      // `depth` overridden, `fileIssues` inherited — an override replaces one key,
      // never the whole saved bag.
      params: { fileIssues: true, depth: 'shallow' },
    });
  });

  it('inherits every unset override', () => {
    expect(effectiveSettings({ overrides: {} }, { providerId: 'p', model: 'm', effort: 'e', taskMetadata: { a: 1 } }))
      .toEqual({ providerId: 'p', model: 'm', effort: 'e', params: { a: 1 } });
  });
});

describe('refusal paths', () => {
  const refuse = async (raw, family = grok) =>
    invokeQuotaBurnStep({ step: step(raw), family, candidate });

  const dispatchedNothing = () => {
    expect(state.triggered).toHaveLength(0);
    expect(state.added).toHaveLength(0);
    expect(state.handlerCalls.filter((call) => call.op === 'run')).toHaveLength(0);
  };

  it('refuses a disabled task type', async () => {
    state.schedule.ux.enabled = false;
    const result = await refuse({ taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } });
    expect(result).toEqual({ dispatched: false, reason: expect.stringContaining('is disabled') });
    dispatchedNothing();
  });

  // The instance-feature gate is its OWN rung now rather than being folded into
  // `enabled`: telling a user to re-enable a task whose toggle is already on
  // sends them to the wrong switch, so the ladder names the feature instead.
  it('refuses a task whose instance feature is off, naming the feature', async () => {
    state.features.jira = false;
    const result = await refuse({ taskRef: { kind: 'builtin', taskType: 'jira-sprint-manager' } });
    expect(result.dispatched).toBe(false);
    expect(result.reason).toContain("requires the 'jira' feature");
    dispatchedNothing();
  });

  it('refuses a built-in reference this install does not ship', async () => {
    const result = await refuse({ taskRef: { kind: 'builtin', taskType: 'not-a-task' } });
    expect(result.reason).toContain("Unknown task type 'not-a-task'");
    dispatchedNothing();
  });

  it('refuses a managed-app type with no app named, and an install-wide type with one', async () => {
    expect((await refuse({ taskRef: { kind: 'builtin', taskType: 'pr-reviewer' } })).reason)
      .toContain('requires a managed app target');
    expect((await refuse({ taskRef: { kind: 'builtin', taskType: 'model-comparison-refresh', appId: 'app-1' } })).reason)
      .toContain('requires an install-wide target');
    dispatchedNothing();
  });

  it('refuses an app the type is not configured for', async () => {
    const result = await refuse({ taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-9' } });
    expect(result.reason).toContain("is not enabled for app 'app-9'");
    dispatchedNothing();
  });

  it('refuses a dangling custom-job reference', async () => {
    const result = await refuse({ taskRef: { kind: 'custom', jobId: 'job-gone' } });
    expect(result.reason).toContain('no longer exists');
    dispatchedNothing();
  });

  it('refuses a custom job that would need a human to approve it', async () => {
    const result = await refuse({ taskRef: { kind: 'custom', jobId: 'job-manual' } });
    expect(result.reason).toContain('needs approval to run');
    expect(result.reason).toContain('manager');
    dispatchedNothing();
  });

  it('refuses a shell job, which spends no provider quota at all', async () => {
    const result = await refuse({ taskRef: { kind: 'custom', jobId: 'job-shell' } });
    expect(result.reason).toContain('cannot be invoked by a quota burn');
    dispatchedNothing();
  });

  it('refuses a provider pin belonging to another family', async () => {
    const result = await refuse({
      taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' },
      overrides: { providerId: 'codex-tui' },
    });
    expect(result.reason).toContain('does not belong to the grok family');
    dispatchedNothing();
  });

  it('refuses when the burning family has no enabled CLI/TUI provider', async () => {
    state.providers = [{ id: 'codex-tui', command: '/usr/local/bin/codex', type: 'tui', enabled: true }];
    const result = await refuse({ taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } });
    expect(result.reason).toContain('no enabled CLI/TUI provider in the grok family');
    dispatchedNothing();
  });

  it('still refuses an ineligible or unapproved task under force', async () => {
    // `force` means "past the QUOTA gates" (window / reserve / cap / denial) and
    // nothing more — eligibility and approval are facts about whether the work
    // may run at all, which no amount of user intent changes.
    const forced = (raw) => invokeQuotaBurnStep({ step: step(raw), family: grok, candidate, force: true });
    expect((await forced({ taskRef: { kind: 'custom', jobId: 'job-shell' } })).dispatched).toBe(false);
    expect((await forced({ taskRef: { kind: 'custom', jobId: 'job-manual' } })).reason).toContain('needs approval');
    state.schedule.ux.enabled = false;
    expect((await forced({ taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } })).reason).toContain('is disabled');
    dispatchedNothing();
  });

  it('refuses when the catalog could not be read, rather than running on overrides alone', async () => {
    // An empty catalog is what a transient store failure degrades to. Display
    // tolerates it (the plan is not orphaned); dispatch must not — with no saved
    // record to inherit from, the work would silently become something else.
    const result = await invokeQuotaBurnStep({
      step: step({ taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }),
      family: grok,
      candidate,
      catalog: {},
    });
    expect(result.reason).toContain('could not be read');
    dispatchedNothing();
  });

  // Both the custom and the programmatic lane run WITHOUT reaching
  // `triggerOnDemandTask`, which is where the built-in lane inherits this gate.
  // Every other way those two fire is gated on it, so a burn that ignored it
  // would be the one path that spends a subscription while the user has CoS
  // improvement switched off.
  it('refuses the custom and programmatic lanes while master Improve is off', async () => {
    state.improveEnabled = false;
    expect((await refuse({ taskRef: { kind: 'custom', jobId: 'job-a' } })).reason).toContain('Improvement is disabled');
    expect((await refuse({ taskRef: { kind: 'builtin', taskType: 'universe-bible-images' } })).reason).toContain('Improvement is disabled');
    dispatchedNothing();
  });

  it('fails closed when CoS state cannot be read at all', async () => {
    state.cosStateReadable = false;
    expect((await refuse({ taskRef: { kind: 'custom', jobId: 'job-a' } })).reason).toContain('could not be read');
    dispatchedNothing();
  });

  // A forced run of a NAMED step skips the probe (the click IS the selection),
  // so the duplicate checks have to live on the RUN path too. The built-in lane
  // has no backstop at all — `triggerOnDemandTask` appends unconditionally — so
  // without this two clicks queue the same task twice and charge the cap twice.
  it('refuses a duplicate even under force, on both agent lanes', async () => {
    state.onDemandRequests = [{ id: 'demand-0', taskType: 'ux', appId: 'app-1' }];
    state.inFlightJobIds = ['job-a'];
    const forced = (raw) => invokeQuotaBurnStep({ step: step(raw), family: grok, candidate, force: true });

    expect((await forced({ taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } })).reason)
      .toContain('already queued');
    expect((await forced({ taskRef: { kind: 'custom', jobId: 'job-a' } })).reason)
      .toContain('already in flight');
    dispatchedNothing();
  });

  it('refuses an un-migrated legacy step rather than guessing a reference for it', async () => {
    const result = await refuse({ jobType: 'agent-prompt', params: { appId: 'app-1', prompt: 'go' } });
    expect(result.reason).toContain('waiting to be migrated');
    dispatchedNothing();
  });
});

describe('built-in agent task invocation', () => {
  const uxStep = () => step({
    taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' },
    overrides: { effort: 'high' },
  });

  it('routes through the schedule\'s on-demand lane with quota-burn provenance', async () => {
    const result = await invokeQuotaBurnStep({ step: uxStep(), family: grok, candidate });
    expect(result.dispatched).toBe(true);
    expect(state.triggered).toEqual([{
      taskType: 'ux',
      appId: 'app-1',
      options: {
        origin: 'quota-burn',
        burn: {
          family: 'grok',
          stepId: 'step-1',
          limitingResetAt: candidate.limitingResetAt,
          // The RESOLVED provider, and the family's TUI at that — an unpinned
          // step must not fall through to whatever the daemon is running.
          overrides: { providerId: 'grok-tui', model: 'saved-model', effort: 'high' },
        },
      },
    }]);
    // Canonical generation owns the task; nothing is queued behind its back.
    expect(state.added).toHaveLength(0);
  });

  it('reports the schedule\'s own refusal verbatim instead of dispatching', async () => {
    state.triggerResult = { error: 'Improvement is disabled — enable it in CoS → Config to run on-demand tasks' };
    const result = await invokeQuotaBurnStep({ step: uxStep(), family: grok, candidate });
    expect(result).toEqual({ dispatched: false, reason: state.triggerResult.error });
  });

  // #6379. This is the ONLY lane whose acceptance is asynchronous — an engine
  // may still refuse the request — so it has to say so, or the runner charges
  // the window for work that never starts.
  it('names the request it is awaiting, so the runner reserves instead of charging', async () => {
    const result = await invokeQuotaBurnStep({ step: uxStep(), family: grok, candidate });
    expect(result.awaiting).toEqual({ requestId: 'demand-1' });
  });
});

describe('custom app job invocation', () => {
  const jobStep = () => step({ taskRef: { kind: 'custom', jobId: 'job-a' }, overrides: { model: 'burn-model' } });

  it('queues through the job\'s own generator with the step\'s overrides and burn provenance', async () => {
    const result = await invokeQuotaBurnStep({ step: jobStep(), family: grok, candidate });
    expect(result.dispatched).toBe(true);
    expect(state.added).toHaveLength(1);
    const [{ task, taskType, options }] = state.added;
    expect(taskType).toBe('internal');
    expect(options).toEqual({ suppressDequeue: true });
    expect(task).toMatchObject({
      // Carried by the shared `generatedJobTaskFields` projection…
      jobId: 'job-a',
      autonomousJob: true,
      app: 'app-1',
      // …and overridden by the burn's own posture.
      provider: 'grok-tui',
      model: 'burn-model',
      quotaBurnFamily: 'grok',
      quotaBurnStepId: 'step-1',
      quotaBurnLimitingResetAt: candidate.limitingResetAt,
    });
    // Accepted on return — the task is queued right here — so there is nothing
    // for the runner to wait on and it charges the window directly (#6379).
    expect(result.awaiting).toBeUndefined();
    expect(result.detail.taskId).toBe('sys-1');
  });

  it('does NOT inherit the manual endpoint\'s approval bypass, force-spawn or revive', async () => {
    await invokeQuotaBurnStep({ step: jobStep(), family: grok, candidate });
    const [{ task }] = state.added;
    // The manual endpoint hardcodes `approvalRequired: false`; a burn derives it
    // from the job's own autonomy level (gated to `yolo`, so it lands false
    // legitimately) — the value is the same here, the SOURCE is the contract.
    expect(task.approvalRequired).toBe(false);
    expect(addTask).toHaveBeenCalledTimes(1);
    // The absence of a call is only assertable by reading the source. Comments
    // are stripped first, or the module header explaining WHY it must not use
    // these would defeat the guard — and `./cos.js` is checked too, since it is
    // the only module either escalation could come from.
    const code = (await import('fs'))
      .readFileSync(new URL('./quotaBurnInvoke.js', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    // The stripper must not have blanked the file — without this the two
    // negative assertions below pass on an empty string.
    expect(code).toMatch(/triggerOnDemandTask\s*\(/);
    expect(code).not.toMatch(/forceSpawnTask\s*\(/);
    expect(code).not.toMatch(/reviveBlockedTask\s*\(/);
    expect(code).not.toContain("'./cos.js'");
  });

  it('declines rather than reviving when a blocked twin already exists', async () => {
    state.addResult = { id: 'sys-9', duplicate: true, status: 'blocked' };
    const result = await invokeQuotaBurnStep({ step: jobStep(), family: grok, candidate });
    expect(result).toEqual({ dispatched: false, reason: expect.stringContaining('already blocked') });
  });
});

describe('programmatic handler invocation', () => {
  const imagesStep = () => step({
    taskRef: { kind: 'builtin', taskType: 'universe-bible-images' },
    overrides: { params: { maxEntries: 2 } },
  });

  it('runs the shared handler inline, pinned to the burning family', async () => {
    const context = { scanned: true };
    const result = await invokeQuotaBurnStep({ step: imagesStep(), family: grok, candidate, context, force: true });
    expect(result).toEqual(state.handlerRun);
    expect(state.handlerCalls).toEqual([{
      op: 'run',
      taskType: 'universe-bible-images',
      params: { maxEntries: 2 },
      job: { providerId: null, model: null, effort: null, params: { maxEntries: 2 } },
      family: grok,
      context,
      force: true,
    }]);
    // No task, no request: PortOS performs this work itself.
    expect(state.added).toHaveLength(0);
    expect(state.triggered).toHaveLength(0);
  });

  it('reports the handler\'s own backlog count and hands its context back', async () => {
    const pending = await countQuotaBurnStepPending({ step: imagesStep(), family: grok });
    expect(pending).toEqual(state.handlerPending);
  });
});

describe('countPending contract', () => {
  it('reports one ready unit for an eligible built-in agent task', async () => {
    const pending = await countQuotaBurnStepPending({
      step: step({ taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }),
      family: grok,
    });
    expect(pending.count).toBe(1);
    expect(pending.detail).toContain('ux');
  });

  it('reports one ready unit for an eligible custom job', async () => {
    const pending = await countQuotaBurnStepPending({
      step: step({ taskRef: { kind: 'custom', jobId: 'job-a' } }),
      family: grok,
    });
    expect(pending.count).toBe(1);
  });

  it('reports zero with a reason for an already-queued built-in run', async () => {
    state.onDemandRequests = [{ id: 'demand-0', taskType: 'ux', appId: 'app-1' }];
    const pending = await countQuotaBurnStepPending({
      step: step({ taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }),
      family: grok,
    });
    expect(pending).toEqual({ count: 0, detail: 'an on-demand run of "ux" is already queued' });
  });

  it('reports zero with a reason while a run of the custom job is already in flight', async () => {
    // Through the scheduler's OWN admission predicate, which also covers the
    // spawn window this module cannot see.
    state.inFlightJobIds = ['job-a'];
    const pending = await countQuotaBurnStepPending({
      step: step({ taskRef: { kind: 'custom', jobId: 'job-a' } }),
      family: grok,
    });
    expect(pending).toEqual({ count: 0, detail: 'a run of "Nightly sweep" is already in flight' });
  });

  it('reports zero with a reason for a disabled, dangling or ineligible reference', async () => {
    state.jobs = state.jobs.map((job) => (job.id === 'job-a' ? { ...job, enabled: false } : job));
    const disabled = await countQuotaBurnStepPending({ step: step({ taskRef: { kind: 'custom', jobId: 'job-a' } }), family: grok });
    expect(disabled).toEqual({ count: 0, detail: expect.stringContaining('is disabled') });

    const dangling = await countQuotaBurnStepPending({ step: step({ taskRef: { kind: 'custom', jobId: 'nope' } }), family: grok });
    expect(dangling).toEqual({ count: 0, detail: expect.stringContaining('no longer exists') });
  });

  it('probes without writing, enqueuing, or calling a provider', async () => {
    const steps = [
      step({ taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }),
      step({ taskRef: { kind: 'custom', jobId: 'job-a' } }),
      step({ taskRef: { kind: 'builtin', taskType: 'universe-bible-images' } }),
    ];
    for (const one of steps) await countQuotaBurnStepPending({ step: one, family: grok });
    expect(state.added).toHaveLength(0);
    expect(state.triggered).toHaveLength(0);
    // The one handler call a probe may make is the handler's OWN probe, which
    // carries the same no-side-effects contract.
    expect(state.handlerCalls.every((call) => call.op === 'count')).toBe(true);
  });
});
