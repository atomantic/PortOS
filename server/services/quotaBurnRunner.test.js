import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const now = Date.now();
const resetsAt = new Date(now + 2 * 3600_000).toISOString();

// Every task type and custom job the fixtures reference, so the availability
// resolver stamps a runnable step rather than 'unknown task'.
const taskCatalog = () => ({
  builtin: {
    ux: { enabled: true, eligible: true, appIds: ['app-1'] },
    docs: { enabled: true, eligible: true, appIds: ['app-1'] },
    'universe-bible-images': { enabled: true, eligible: true, appIds: [] },
  },
  custom: { 'job-a': { enabled: true, eligible: true, appId: 'app-1' } },
});

const state = {
  config: null,
  quotas: [],
  runs: [],
  dispatches: {},
  recorded: [],
  contexts: [],
  blocks: {},
  completions: {},
  completed: [],
  completionsUnreadable: false,
  settled: [],
  settleError: null,
  invokePending: {},
  invoked: [],
  invokeResult: undefined,
  catalog: taskCatalog(),
  catalogReads: 0,
  reservations: {},
  reserved: [],
  reserveOk: true,
  settlement: { accepted: 0, refused: 0 },
};

vi.mock('./cosTaskStore.js', () => ({ getAllTasks: vi.fn(async () => ({ cos: { tasks: state.sequenceTasks || [] } })) }));

vi.mock('./providerUsage.js', () => ({
  getProviderQuotas: vi.fn(async () => state.quotas),
}));

vi.mock('./quotaBurnStore.js', () => ({
  getQuotaBurnConfig: vi.fn(async () => state.config),
  getQuotaBurnRuns: vi.fn(async () => state.runs),
  recordQuotaBurnRun: vi.fn(async (entry) => { state.runs.unshift(entry); }),
  // `null` — not a throw — is the module's real "could not read" signal, so the
  // stub speaks the contract the runner is tested against.
  getQuotaBurnReservations: vi.fn(async () => state.reservations),
  quotaBurnReservationKey: (familyId, stepId) => `${familyId}::${stepId}`,
}));

// Settlement is doubled at the same altitude as the invocation path: this suite
// owns the runner's accounting CONTRACT — reserve an asynchronous acceptance,
// charge a synchronous one — while `quotaBurnAcceptance.test.js` owns what
// settling a reservation actually does.
vi.mock('./quotaBurnAcceptance.js', () => ({
  reconcileQuotaBurnReservations: vi.fn(async () => state.settlement),
  reserveQuotaBurnDispatch: vi.fn(async (record) => {
    state.reserved.push(record);
    return state.reserveOk;
  }),
}));

// The shared REFERENCE path. Doubled at the same altitude as the legacy
// registry above, so this suite keeps testing the runner's own contract — which
// lane a step takes, in what order, and what gets charged — rather than a second
// copy of the invocation logic (`quotaBurnInvoke.test.js` owns that).
vi.mock('./quotaBurnInvoke.js', () => ({
  getQuotaBurnTaskCatalog: vi.fn(async () => { state.catalogReads += 1; return state.catalog; }),
  countQuotaBurnStepPending: vi.fn(async ({ step }) => state.invokePending[step.id] ?? { count: 0, detail: 'nothing' }),
  invokeQuotaBurnStep: vi.fn(async ({ step, family, candidate, context, force }) => {
    state.invoked.push({ stepId: step.id, familyId: family.id, charge: candidate.charge, force });
    state.contexts.push(context);
    return state.invokeResult ?? { dispatched: true, summary: `invoked ${step.id}` };
  }),
}));

// Only the two ledger functions are stubbed — `selectBurnCandidates` and
// `evaluateFamilies` stay REAL so this suite exercises the actual gate ladder
// rather than a second copy of it. Stubbing the ledger keeps the suite off the
// install's real `data/cos/` files.
vi.mock('./quotaBurn.js', async (importActual) => ({
  ...(await importActual()),
  getQuotaBurnDispatches: vi.fn(async () => state.dispatches),
  recordQuotaBurnDispatch: vi.fn(async (key) => { state.recorded.push(key); }),
}));

// Same posture as the dispatch ledger: the denial gate stays real (it lives in
// quotaBurn.js), only its storage is stubbed off the install's `data/cos/`.
// `recordBurnAgentCompletion` records into `state.settled` so the continuation's
// ordering — ledger first, THEN the next dispatch — is assertable.
vi.mock('./quotaBurnDenials.js', async (importActual) => ({
  ...(await importActual()),
  getActiveQuotaBurnBlocks: vi.fn(async () => state.blocks),
  recordBurnAgentCompletion: vi.fn(async (agent) => {
    state.settled.push(agent?.metadata?.taskQuotaBurnFamily ?? null);
    if (state.settleError) throw new Error(state.settleError);
    return null;
  }),
}));

// The `run once` ledger, stubbed off the install's `data/cos/` like the other
// two. `state.completed` records the writes so "a one-shot job marks itself
// spent" is assertable without a filesystem round trip.
vi.mock('./quotaBurnCompletions.js', () => ({
  // `null` — not a throw — is the module's real "could not read" signal, so the
  // stub speaks the same contract the runner is being tested against.
  getQuotaBurnCompletions: vi.fn(async () => (state.completionsUnreadable ? null : state.completions)),
  recordQuotaBurnJobCompletion: vi.fn(async (familyId, jobId) => {
    state.completed.push(`${familyId}:${jobId}`);
    state.completions = { ...state.completions, [`${familyId}:${jobId}`]: new Date(now).toISOString() };
    return state.completions;
  }),
}));

const { normalizeQuotaBurnConfig } = await import('../lib/quotaBurnConfig.js');
const { countQuotaBurnStepPending, invokeQuotaBurnStep } = await import('./quotaBurnInvoke.js');
const { getQuotaBurnStatus, runQuotaBurnCycle, rotatePlanAfter, __tickQuotaBurn, __onBurnAgentCompleted, __resetQuotaBurnRunner } = await import('./quotaBurnRunner.js');

const card = (family, percentRemaining = 50) => ({
  family, label: family, supported: true,
  limits: [{ key: 'week', scope: 'week', label: 'Weekly', resetsAt, percentRemaining }],
});

const plan = (overrides = {}) => normalizeQuotaBurnConfig({
  enabled: true,
  families: {
    grok: {
      enabled: true,
      resetWithinHours: 24,
      jobs: [
        { id: 'first', enabled: true, taskRef: { kind: 'builtin', taskType: 'universe-bible-images', appId: null } },
        { id: 'second', enabled: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } },
      ],
    },
  },
  ...overrides,
});

beforeEach(() => {
  state.sequenceTasks = [];
  state.config = plan();
  state.quotas = [card('grok')];
  state.runs = [];
  state.contexts = [];
  state.dispatches = {};
  state.recorded = [];
  state.blocks = {};
  state.completions = {};
  state.completed = [];
  state.completionsUnreadable = false;
  state.settled = [];
  state.settleError = null;
  state.invokePending = {};
  state.invoked = [];
  state.invokeResult = undefined;
  state.reservations = {};
  state.reserved = [];
  state.reserveOk = true;
  state.settlement = { accepted: 0, refused: 0 };
  state.catalog = taskCatalog();
  state.catalogReads = 0;
  __resetQuotaBurnRunner();
});

afterEach(() => { vi.clearAllMocks(); });

describe('runQuotaBurnCycle', () => {
  it('stays silent when the master switch is off and the trigger is scheduled', async () => {
    state.config = plan({ enabled: false });
    await expect(runQuotaBurnCycle()).resolves.toEqual({ skipped: 'disabled' });
    expect(state.runs).toHaveLength(0);
    expect(state.invoked).toHaveLength(0);
  });

  it('never scrapes provider quota when no family could burn', async () => {
    // getProviderQuotas({ refresh: true }) spawns a multi-second TUI scrape per
    // enabled family. With nothing actionable configured it could not produce a
    // dispatch, and it would otherwise run on every tick forever.
    const { getProviderQuotas } = await import('./providerUsage.js');
    state.config = plan({ families: { grok: { enabled: true, jobs: [] } } });
    const result = await runQuotaBurnCycle();
    expect(getProviderQuotas).not.toHaveBeenCalled();
    expect(result).toMatchObject({ dispatched: false, reason: 'no families enabled' });
  });

  it('runs the FIRST job in the plan that has pending work', async () => {
    // Order is the whole point of the plan: "generate the missing bible images
    // first, then fall through to agent work" must not be reordered by the runner.
    state.invokePending = { first: { count: 0, detail: 'all rendered' }, second: { count: 1, detail: 'ready' } };
    const result = await runQuotaBurnCycle();
    expect(result.dispatched).toBe(true);
    expect(state.invoked).toEqual([{ stepId: 'second', familyId: 'grok', charge: true, force: false }]);
    expect(state.recorded).toEqual([result.dispatchKey]);
  });

  it('hands the probe\'s work to run() instead of making it recompute', async () => {
    // A universe-bible-images probe reads every bible to produce its count, and
    // run() needs the same scan to know what to render — without the passthrough
    // that multi-megabyte read happened twice per dispatch.
    const scan = { picked: ['batch'], total: 4 };
    state.invokePending = { first: { count: 4, context: scan } };
    await runQuotaBurnCycle();
    expect(state.contexts).toEqual([scan]);
  });

  it('prefers an earlier job when both have work', async () => {
    state.invokePending = { first: { count: 3 }, second: { count: 9 } };
    await runQuotaBurnCycle();
    expect(state.invoked.map((entry) => entry.stepId)).toEqual(['first']);
  });

  it('logs why nothing burned instead of failing silently', async () => {
    state.invokePending = { first: { count: 0, detail: 'all rendered' }, second: { count: 0, detail: 'no app' } };
    const result = await runQuotaBurnCycle();
    expect(result.dispatched).toBe(false);
    // The per-job reasons are the actionable part — collapsing them to one
    // fixed string asserted something usually false.
    expect(result.reason).toMatch(/first: all rendered/);
    expect(result.reason).toMatch(/second: no app/);
    expect(state.runs[0]).toMatchObject({ trigger: 'scheduled', dispatched: false });
  });

  it('does not charge the window when the job declines', async () => {
    // A declined job spent no quota. Charging the cap for it would let a
    // repeatedly-misconfigured family exhaust its budget without doing work.
    state.invokePending = { first: { count: 1 } };
    state.invokeResult = { dispatched: false, reason: 'no managed app selected' };
    const result = await runQuotaBurnCycle();
    expect(result.dispatched).toBe(false);
    expect(state.recorded).toEqual([]);
  });

  it('explains a closed window in the run log', async () => {
    state.quotas = [card('grok', 100)];
    state.config = plan({ families: { grok: { enabled: true, resetWithinHours: 0, jobs: [{ id: 'first', enabled: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }] } } });
    const result = await runQuotaBurnCycle();
    expect(result.dispatched).toBe(false);
    expect(result.reason).toMatch(/no burnable window/);
  });

  it('force-runs one named job past the window gates without charging it', async () => {
    state.config = plan({ families: { grok: { enabled: true, resetWithinHours: 0, jobs: [{ id: 'second', enabled: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }] } } });
    state.invokePending = { second: { count: 1 } };
    const result = await runQuotaBurnCycle({ trigger: 'manual', familyId: 'grok', jobId: 'second', force: true });
    expect(result.dispatched).toBe(true);
    // A forced candidate still carries the family's REAL card and window — it is
    // only marked uncharged, so the run log and the agent brief stay truthful.
    expect(state.invoked).toEqual([{ stepId: 'second', familyId: 'grok', charge: false, force: true }]);
    expect(result.percentRemaining).toBe(50);
    expect(state.recorded).toEqual([]);
  });

  it('force-runs a family plan after its automatic window closes', async () => {
    state.config = plan({ families: { grok: { enabled: true, resetWithinHours: 0, jobs: [{ id: 'second', enabled: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }] } } });
    state.invokePending = { second: { count: 1 } };
    const result = await runQuotaBurnCycle({ trigger: 'manual', familyId: 'grok', force: true });
    expect(result.dispatched).toBe(true);
    expect(state.invoked).toEqual([{ stepId: 'second', familyId: 'grok', charge: false, force: true }]);
    expect(state.recorded).toEqual([]);
  });

  it('burns EVERY eligible family in one cycle, not just the soonest to reset', async () => {
    // Families don't share a budget — each draws down its own window against its
    // own reserve and cap. Stopping the cycle at the first dispatch meant the
    // soonest-resetting family took every tick and a longer-windowed one
    // (claude at 2h vs agy at 21h) never burned at all while claude was enabled.
    state.config = normalizeQuotaBurnConfig({
      enabled: true,
      families: {
        claude: { enabled: true, resetWithinHours: 24, jobs: [{ id: 'soon', enabled: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }] },
        agy: { enabled: true, resetWithinHours: 24, jobs: [{ id: 'later', enabled: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }] },
      },
    });
    state.quotas = [
      { family: 'claude', label: 'claude', supported: true, limits: [{ key: 'session', scope: 'session', resetsAt: new Date(now + 2 * 3600_000).toISOString(), percentRemaining: 90 }] },
      { family: 'agy', label: 'agy', supported: true, limits: [{ key: 'day', scope: 'day', resetsAt: new Date(now + 21 * 3600_000).toISOString(), percentRemaining: 93 }] },
    ];
    state.invokePending = { soon: { count: 1 }, later: { count: 1 } };

    const result = await runQuotaBurnCycle();
    expect(result.dispatched).toBe(true);
    expect(state.invoked.map((entry) => entry.familyId)).toEqual(['claude', 'agy']);
    // Both windows charged — each against its OWN dispatch key.
    expect(state.recorded).toHaveLength(2);
    expect(new Set(state.recorded).size).toBe(2);
    // One run-log row per dispatch, so neither family is hidden from the audit.
    expect(state.runs.filter((entry) => entry.dispatched)).toHaveLength(2);
    expect(result.dispatches).toHaveLength(2);
    expect(result.summary).toMatch(/agy/);
  });

  it('still dispatches the healthy family when another one\'s job declines', async () => {
    state.config = normalizeQuotaBurnConfig({
      enabled: true,
      families: {
        claude: { enabled: true, resetWithinHours: 24, jobs: [{ id: 'broken', enabled: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }] },
        agy: { enabled: true, resetWithinHours: 24, jobs: [{ id: 'good', enabled: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }] },
      },
    });
    state.quotas = [card('claude'), card('agy')];
    state.invokePending = { broken: { count: 1 }, good: { count: 1 } };
    invokeQuotaBurnStep.mockImplementationOnce(async () => ({ dispatched: false, reason: 'no managed app selected' }));

    const result = await runQuotaBurnCycle();
    expect(result.dispatched).toBe(true);
    expect(result.familyId).toBe('agy');
    // Only the family that actually started work is charged.
    expect(state.recorded).toHaveLength(1);
  });

  it('names the family in every skip reason when several plans were walked', async () => {
    state.config = normalizeQuotaBurnConfig({
      enabled: true,
      families: {
        claude: { enabled: true, resetWithinHours: 24, jobs: [{ id: 'a', enabled: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }] },
        agy: { enabled: true, resetWithinHours: 24, jobs: [{ id: 'b', enabled: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }] },
      },
    });
    state.quotas = [card('claude'), card('agy')];
    state.invokePending = { a: { count: 0, detail: 'no app' }, b: { count: 0, detail: 'no app' } };
    const result = await runQuotaBurnCycle();
    expect(result.reason).toMatch(/claude\/a: no app/);
    expect(result.reason).toMatch(/agy\/b: no app/);
  });

  it('releases the re-entrancy guard even when a cycle throws', async () => {
    // Without the finally, an ENOSPC on the ledger write (or any other throw)
    // would leave `running` stuck true and wedge the loop for the life of the
    // process — every later tick returning `already-running` forever.
    const { recordQuotaBurnRun } = await import('./quotaBurnStore.js');
    recordQuotaBurnRun.mockRejectedValueOnce(new Error('ENOSPC'));
    await expect(runQuotaBurnCycle()).rejects.toThrow('ENOSPC');

    recordQuotaBurnRun.mockImplementationOnce(async (entry) => { state.runs.unshift(entry); });
    await expect(runQuotaBurnCycle()).resolves.toMatchObject({ dispatched: false });
  });

  it('refuses to run two cycles at once', async () => {
    state.invokePending = { first: { count: 1 } };
    const [first, second] = await Promise.all([runQuotaBurnCycle(), runQuotaBurnCycle()]);
    expect([first.skipped, second.skipped].filter(Boolean)).toEqual(['already-running']);
  });
});

describe('getQuotaBurnStatus', () => {
  it('returns the config it loaded so the route need not re-read it', async () => {
    // Value, not identity: availability is stamped onto a COPY on the way out
    // (a fact about the catalog right now, never persisted). The contract is
    // that the route gets the plan back without a second file read.
    const { config } = await getQuotaBurnStatus();
    expect(config).toStrictEqual(state.config);
  });

  it('reports the live window and the reason a family would not burn', async () => {
    state.invokePending = { first: { count: 2, detail: '2 entries' }, second: { count: 0, detail: 'no app' } };
    const { status } = await getQuotaBurnStatus();
    const grok = status.families.find((family) => family.id === 'grok');
    expect(grok.willBurn).toBe(true);
    expect(grok.skipReason).toBeNull();
    expect(grok.jobs.map((job) => job.pending.count)).toEqual([2, 0]);

    const codex = status.families.find((family) => family.id === 'codex');
    expect(codex.willBurn).toBe(false);
    expect(codex.skipReason).toBe('disabled');
    // A disabled family's jobs are not probed — the counts would never be acted on.
    expect(codex.jobs.every((job) => job.pending === null)).toBe(true);
  });

  it('names WHICH window the percentage and countdown describe', async () => {
    // A family publishes a short rolling window and a weekly one; a bare
    // "50% left · resets in 2h" says nothing about which allowance that is.
    const { status } = await getQuotaBurnStatus();
    expect(status.families.find((family) => family.id === 'grok').windowLabel).toBe('Weekly');
  });

  it('surfaces an observed provider refusal on the family card', async () => {
    state.blocks = { grok: { at: now - 1000, until: now + 3_600_000, reason: 'Usage limit exceeded' } };
    const { status } = await getQuotaBurnStatus();
    const grok = status.families.find((family) => family.id === 'grok');
    expect(grok.willBurn).toBe(false);
    expect(grok.blockedUntil).toBe(new Date(now + 3_600_000).toISOString());
    expect(grok.blockedReason).toBe('Usage limit exceeded');
    expect(grok.skipReason).toMatch(/provider refused the last burn/);
  });
});

/**
 * The stop condition the whole denial ledger exists for: a plan spending a
 * weekly allowance exhausts the SHORT rolling window underneath it, and every
 * further dispatch fails instantly — while the weekly card it gates on still
 * reads "50% left, resets in 2h".
 */
describe('denial blocks in a cycle', () => {
  it('dispatches nothing while the family is blocked, and says why', async () => {
    state.invokePending = { first: { count: 1 } };
    state.blocks = { grok: { at: now - 1000, until: now + 3_600_000, reason: 'Usage limit exceeded' } };
    const entry = await runQuotaBurnCycle({ trigger: 'scheduled' });
    expect(entry.dispatched).toBe(false);
    expect(entry.reason).toMatch(/provider refused the last burn/);
    expect(state.invoked).toEqual([]);
  });

  it('resumes once the block lapses', async () => {
    state.invokePending = { first: { count: 1 } };
    state.blocks = { grok: { at: now - 7_200_000, until: now - 1000, reason: 'Usage limit exceeded' } };
    const entry = await runQuotaBurnCycle({ trigger: 'scheduled' });
    expect(entry.dispatched).toBe(true);
  });

  it('lets a forced run retry through a block', async () => {
    state.invokePending = { first: { count: 1 } };
    state.blocks = { grok: { at: now - 1000, until: now + 3_600_000, reason: 'Usage limit exceeded' } };
    const entry = await runQuotaBurnCycle({ trigger: 'manual', familyId: 'grok', jobId: 'first', force: true });
    expect(entry.dispatched).toBe(true);
  });
});

describe('run-now targeting', () => {
  it('force-runs a job whose enabled checkbox is off', async () => {
    // Clicking ▶ on a paused job is a more specific instruction than the
    // checkbox set earlier; filtering it out made the click a silent no-op
    // reported as "no pending work".
    state.config = plan({ families: { grok: { enabled: true, jobs: [{ id: 'paused', enabled: false, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }] } } });
    state.invokePending = { paused: { count: 1 } };
    const result = await runQuotaBurnCycle({ trigger: 'manual', familyId: 'grok', jobId: 'paused', force: true });
    expect(result.dispatched).toBe(true);
    expect(state.invoked.map((entry) => entry.stepId)).toEqual(['paused']);
  });

  it('still skips a disabled job on an ordinary scheduled cycle', async () => {
    state.config = plan({ families: { grok: { enabled: true, jobs: [{ id: 'paused', enabled: false, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }] } } });
    state.invokePending = { paused: { count: 1 } };
    // Nothing enabled to run ⇒ not actionable ⇒ no quota scrape at all.
    await expect(runQuotaBurnCycle()).resolves.toMatchObject({ dispatched: false });
    expect(state.invoked).toEqual([]);
  });

  it('force-runs a job in a family whose own checkbox is off', async () => {
    // Both 'switched off' gates govern the UNATTENDED loop; an explicit click on
    // one row outranks them, exactly as it outranks the window/reserve/cap gates.
    state.config = normalizeQuotaBurnConfig({
      enabled: true,
      families: { grok: { enabled: false, jobs: [{ id: 'j', enabled: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }] } },
    });
    state.invokePending = { j: { count: 1 } };
    const result = await runQuotaBurnCycle({ trigger: 'manual', familyId: 'grok', jobId: 'j', force: true });
    expect(result.dispatched).toBe(true);
    expect(state.recorded).toEqual([]);
  });

  it('reports the REQUESTED family\'s verdict, not another family\'s', async () => {
    // Reporting a different (enabled) family's verdict left the user with no
    // path to the control they actually needed.
    state.config = normalizeQuotaBurnConfig({
      enabled: true,
      families: {
        grok: { enabled: true, jobs: [{ id: 'j', enabled: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }] },
        claude: { enabled: true, jobs: [{ id: 'k', enabled: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }] },
      },
    });
    // grok has NO provider card — a fact about the world, so force can't pass it.
    state.quotas = [card('claude')];
    const result = await runQuotaBurnCycle({ trigger: 'manual', familyId: 'grok', jobId: 'j', force: true });
    expect(result.reason).toMatch(/grok: no enabled provider in this family/);
    expect(result.reason).not.toMatch(/claude/);
  });
});

describe('interval clock', () => {
  it('does not let a manual run defer the next scheduled cycle', async () => {
    // finish() used to stamp lastRunAt for every trigger, so one "Evaluate now"
    // pushed the automatic cycle a full interval out — on a 12-hour interval
    // that can skip the reset the feature exists to spend.
    state.invokePending = { first: { count: 1 } };
    await runQuotaBurnCycle({ trigger: 'manual' });
    const { getProviderQuotas } = await import('./providerUsage.js');
    getProviderQuotas.mockClear();
    // A scheduled tick immediately after must still be due.
    await runQuotaBurnCycle({ trigger: 'scheduled' });
    expect(getProviderQuotas).toHaveBeenCalled();
  });

  it('seeds the interval clock from the persisted run log after a restart', async () => {
    // lastRunAt is in-process; on a bare null the first tick after every boot is
    // "due", so a PM2 restart loop paces a 12-hourly plan into minutes — a full
    // TUI scrape per family ~60s after every boot.
    const { getProviderQuotas } = await import('./providerUsage.js');
    state.config = plan({ checkIntervalMinutes: 720 });
    state.runs = [{ at: new Date(Date.now() - 60_000).toISOString(), trigger: 'scheduled', dispatched: false }];
    await __tickQuotaBurn();
    expect(getProviderQuotas).not.toHaveBeenCalled();

    // A run log whose newest SCHEDULED entry is older than the interval is due.
    __resetQuotaBurnRunner();
    state.runs = [{ at: new Date(Date.now() - 13 * 3600_000).toISOString(), trigger: 'scheduled', dispatched: false }];
    state.invokePending = { first: { count: 1 } };
    await __tickQuotaBurn();
    expect(getProviderQuotas).toHaveBeenCalled();
  });

  it('ignores manual entries when seeding the clock', async () => {
    // Only a scheduled cycle advances the interval; a manual "Evaluate now"
    // recorded moments ago must not defer the automatic one across a restart.
    const { getProviderQuotas } = await import('./providerUsage.js');
    state.config = plan({ checkIntervalMinutes: 720 });
    state.runs = [{ at: new Date().toISOString(), trigger: 'manual', dispatched: false }];
    state.invokePending = { first: { count: 1 } };
    await __tickQuotaBurn();
    expect(getProviderQuotas).toHaveBeenCalled();
  });
});

describe('plan rotation', () => {
  it('resumes after the job the family last dispatched instead of restarting at the top', async () => {
    // `agent-prompt` always probes as "1 pending" (its probe only checks that an
    // app and a provider resolve), so an un-rotated walk re-ran job #1 on every
    // cycle forever and jobs 2..N in an ordered plan never ran once.
    state.invokePending = { first: { count: 1 }, second: { count: 1 } };
    await runQuotaBurnCycle({ trigger: 'manual' });
    await runQuotaBurnCycle({ trigger: 'manual' });
    expect(state.invoked.map((entry) => entry.stepId)).toEqual(['first', 'second']);
  });

  it('keeps walking to the next job with work when the resume point has none', async () => {
    // Rotation moves where the walk STARTS; "first job with pending work wins"
    // still holds, which is what a probing job like universe-bible-images needs.
    state.invokePending = { first: { count: 1 }, second: { count: 0, detail: 'all rendered' } };
    state.runs = [{ at: new Date().toISOString(), dispatched: true, familyId: 'grok', jobId: 'first' }];
    const result = await runQuotaBurnCycle({ trigger: 'manual' });
    expect(result.dispatched).toBe(true);
    expect(state.invoked.map((entry) => entry.stepId)).toEqual(['first']);
  });

  it('falls back to plan order for a cursor that is not in the plan', () => {
    // A job deleted from the plan, or one aged out of the capped run log.
    const jobs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(rotatePlanAfter(jobs, 'gone').map((job) => job.id)).toEqual(['a', 'b', 'c']);
    expect(rotatePlanAfter(jobs, null).map((job) => job.id)).toEqual(['a', 'b', 'c']);
    expect(rotatePlanAfter(jobs, 'a').map((job) => job.id)).toEqual(['b', 'c', 'a']);
    expect(rotatePlanAfter(jobs, 'c').map((job) => job.id)).toEqual(['a', 'b', 'c']);
  });

  it('reads every family\'s cursor before any dispatch writes a new one', async () => {
    // Two families in one cycle must not see each other's fresh run-log rows.
    state.config = normalizeQuotaBurnConfig({
      enabled: true,
      families: {
        claude: { enabled: true, resetWithinHours: 24, jobs: [{ id: 'c1', enabled: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }, { id: 'c2', enabled: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }] },
        agy: { enabled: true, resetWithinHours: 24, jobs: [{ id: 'a1', enabled: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }, { id: 'a2', enabled: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }] },
      },
    });
    state.quotas = [card('claude'), card('agy')];
    state.invokePending = { c1: { count: 1 }, c2: { count: 1 }, a1: { count: 1 }, a2: { count: 1 } };
    state.runs = [{ at: new Date().toISOString(), dispatched: true, familyId: 'agy', jobId: 'a1' }];
    await runQuotaBurnCycle({ trigger: 'manual' });
    expect(state.invoked.map((entry) => entry.stepId)).toEqual(['c1', 'a2']);
  });
});

describe('completion continuation', () => {
  it('evaluates the family again when one of its burn agents finishes', async () => {
    // The interval only STARTS a burn — see the module header for why one
    // dispatch per `checkIntervalMinutes` cannot spend the window.
    state.invokePending = { first: { count: 1 }, second: { count: 1 } };
    await runQuotaBurnCycle({ trigger: 'manual' });
    await __onBurnAgentCompleted({ metadata: { taskQuotaBurnFamily: 'grok' } });
    // The continuation advances the plan and is charged like any unforced burn.
    expect(state.invoked.map((entry) => entry.stepId)).toEqual(['first', 'second']);
    expect(state.recorded).toHaveLength(2);
    expect(state.runs[0]).toMatchObject({ trigger: 'continuation', dispatched: true });
  });

  it('records a refusal BEFORE dispatching the next job', async () => {
    // The whole point of the ordering: this continuation dispatches the next job
    // the moment a burn agent finishes, so a block recorded after it runs (or
    // from a second `agent:completed` subscriber, whose ordering against this
    // one is not guaranteed) arrives one wasted agent too late, every time.
    state.invokePending = { first: { count: 1 } };
    // Whatever the ledger just learned is what selection reads on this very tick.
    state.blocks = { grok: { at: now - 1000, until: now + 3_600_000, reason: 'Usage limit exceeded' } };
    const entry = await __onBurnAgentCompleted({ metadata: { taskQuotaBurnFamily: 'grok' } });
    expect(state.settled).toEqual(['grok']);
    expect(entry.dispatched).toBe(false);
    expect(entry.reason).toMatch(/provider refused the last burn/);
    expect(state.invoked).toEqual([]);
  });

  it('still continues when the denial ledger itself fails', async () => {
    // Telemetry must never be able to stall the plan.
    state.invokePending = { first: { count: 1 } };
    state.settleError = 'ENOSPC';
    const entry = await __onBurnAgentCompleted({ metadata: { taskQuotaBurnFamily: 'grok' } });
    expect(entry.dispatched).toBe(true);
  });

  it('scrapes only the burning family\'s quota, not every enabled provider\'s', async () => {
    // WAIT.FRESH bypasses the cache by design, so each card costs its own
    // multi-second PTY spawn — and every card but this family's is discarded.
    // Unscoped, one burn chain would pay N scrapes per link instead of one.
    const { getProviderQuotas } = await import('./providerUsage.js');
    state.invokePending = { first: { count: 1 } };
    await __onBurnAgentCompleted({ metadata: { taskQuotaBurnFamily: 'grok' } });
    expect(getProviderQuotas).toHaveBeenCalledWith(expect.objectContaining({ family: 'grok' }));
  });

  it('runs a continuation that arrived mid-cycle instead of dropping it', async () => {
    // Two burn agents finishing inside one cycle is ordinary. Dropping the
    // second on the re-entrancy guard stalls that family until the next interval
    // tick — most of a day at the 12-hour default.
    state.config = normalizeQuotaBurnConfig({
      enabled: true,
      families: {
        claude: { enabled: true, resetWithinHours: 24, jobs: [{ id: 'c1', enabled: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }] },
        agy: { enabled: true, sequence: true, resetWithinHours: 24, jobs: [
          { id: 'a0', runOnce: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } },
          { id: 'a1', runOnce: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } },
        ] },
      },
    });
    state.quotas = [card('claude'), card('agy')];
    state.invokePending = { c1: { count: 1 }, a1: { count: 1 } };
    state.sequenceTasks = [{ id: 'agy-finishing', status: 'in_progress', metadata: { quotaBurnFamily: 'agy' } }];
    // agy's agent finishes while claude's cycle is still mid-dispatch.
    invokeQuotaBurnStep.mockImplementationOnce(async ({ step, family, candidate }) => {
      state.invoked.push({ stepId: step.id, familyId: family.id, charge: candidate.charge });
      await expect(__onBurnAgentCompleted({ taskId: 'agy-finishing', result: { success: true }, metadata: { taskQuotaBurnFamily: 'agy', taskQuotaBurnStepId: 'a0' } }))
        .resolves.toEqual({ skipped: 'already-running' });
      return { dispatched: true, summary: `ran ${step.id}` };
    });

    await runQuotaBurnCycle({ trigger: 'manual', familyId: 'claude' });
    expect(state.invoked.map((entry) => entry.familyId)).toEqual(['claude', 'agy']);
  });

  it('ignores an agent that was not a quota burn', async () => {
    state.invokePending = { first: { count: 1 } };
    await __onBurnAgentCompleted({ metadata: { taskType: 'user' } });
    await __onBurnAgentCompleted(null);
    expect(state.invoked).toEqual([]);
  });

  it('credits the agent of a manual maintenance run to the denial ledger but never walks the plan on it', async () => {
    // The Schedule tab's "Run maintenance now" spends this family's window
    // (so a refusal is still the family's), but its ladder is its own — the
    // plan must not dispatch, and no plan step may be marked spent, because a
    // manual run finished a task.
    state.invokePending = { first: { count: 1 } };
    const agent = { taskId: 'manual-1', result: { success: true }, metadata: { taskQuotaBurnFamily: 'grok', taskQuotaBurnStepId: 'first', taskQuotaBurnMaintenanceRunId: 'maint-1' } };
    await expect(__onBurnAgentCompleted(agent)).resolves.toEqual({ skipped: 'maintenance-run' });
    expect(state.settled).toEqual(['grok']);
    expect(state.invoked).toEqual([]);
    expect(state.completed).toEqual([]);
    expect(state.runs).toEqual([]);
  });

  it('stops when the master switch is off', async () => {
    // A continuation is unattended spending — switching the feature off must end
    // the chain, not leave it running until the window cap happens to close it.
    state.config = plan({ enabled: false });
    state.invokePending = { first: { count: 1 } };
    await __onBurnAgentCompleted({ metadata: { taskQuotaBurnFamily: 'grok' } });
    expect(state.invoked).toEqual([]);
    expect(state.runs).toEqual([]);
  });

  it('stops once the window has no quota left to spend', async () => {
    // The chain is bounded by the same gate ladder every other cycle runs — here
    // the reserve, which the run log records so the stop is auditable.
    state.quotas = [card('grok', 10)];
    state.config = plan({ families: { grok: { enabled: true, resetWithinHours: 24, reservePercent: 40, jobs: [{ id: 'first', enabled: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }] } } });
    state.invokePending = { first: { count: 1 } };
    await __onBurnAgentCompleted({ metadata: { taskQuotaBurnFamily: 'grok' } });
    expect(state.invoked).toEqual([]);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({ trigger: 'continuation', dispatched: false });
    expect(state.runs[0].reason).toMatch(/reserve/);
  });
});

describe('forced run bypasses the pending probe', () => {
  it('calls the job directly instead of letting its own probe veto the click', async () => {
    // The probe exists to PICK a job. When the user already picked one, letting
    // it veto reproduces the silent no-op the force path exists to fix, one
    // gate later — it bites hardest on universe-bible-images, whose 6h
    // in-flight cooldown reports zero for entries that are merely queued.
    state.invokePending = { second: { count: 0, detail: 'already queued' } };
    const result = await runQuotaBurnCycle({ trigger: 'manual', familyId: 'grok', jobId: 'second', force: true });
    expect(countQuotaBurnStepPending).not.toHaveBeenCalled();
    expect(result.dispatched).toBe(true);
    expect(state.invoked.map((entry) => entry.stepId)).toEqual(['second']);
  });

  it('still probes on an unforced cycle', async () => {
    state.invokePending = { first: { count: 1 } };
    await runQuotaBurnCycle();
    expect(countQuotaBurnStepPending).toHaveBeenCalled();
  });
});

/**
 * `run once` — the per-step choice between one-shot and standing work.
 *
 * A plan is a rotation the runner walks lap after lap while the window still has
 * quota. That is right for a standing audit and wrong for work that only needs
 * doing once, which was simply re-done every lap.
 */
describe('run-once jobs', () => {
  const oneShotPlan = (jobs) => plan({
    families: { grok: { enabled: true, resetWithinHours: 24, jobs } },
  });

  it('marks a run-once job spent when it dispatches, and skips it next cycle', async () => {
    state.config = oneShotPlan([
      { id: 'once', enabled: true, runOnce: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } },
      { id: 'standing', enabled: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } },
    ]);
    state.invokePending = { once: { count: 1 }, standing: { count: 1 } };

    await runQuotaBurnCycle();
    expect(state.invoked.map((entry) => entry.stepId)).toEqual(['once']);
    expect(state.completed).toEqual(['grok:once']);

    // The plan's next lap must reach `standing` and never return to `once`.
    await runQuotaBurnCycle();
    await runQuotaBurnCycle();
    expect(state.invoked.map((entry) => entry.stepId)).toEqual(['once', 'standing', 'standing']);
  });

  it('leaves a repeating job in the rotation and records nothing', async () => {
    state.invokePending = { first: { count: 1 }, second: { count: 1 } };
    await runQuotaBurnCycle();
    await runQuotaBurnCycle();
    await runQuotaBurnCycle();
    // Regression guard for the default: absent `runOnce` must keep repeating.
    expect(state.invoked.map((entry) => entry.stepId)).toEqual(['first', 'second', 'first']);
    expect(state.completed).toEqual([]);
  });

  it('stops scraping provider quota once every step of a one-shot plan has run', async () => {
    // The whole point of threading completions into `familyHasRunnableJobs`: a
    // finished plan would otherwise pay for a multi-second TUI scrape every
    // interval, forever, to be told there is nothing to dispatch.
    const { getProviderQuotas } = await import('./providerUsage.js');
    state.config = oneShotPlan([{ id: 'once', enabled: true, runOnce: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }]);
    state.invokePending = { once: { count: 1 } };
    await runQuotaBurnCycle();
    getProviderQuotas.mockClear();

    const result = await runQuotaBurnCycle();
    expect(getProviderQuotas).not.toHaveBeenCalled();
    expect(result).toMatchObject({ dispatched: false });
    // Distinct from "no families enabled": a finished plan wants Re-arm, an
    // unset one wants a job added.
    expect(result.reason).toMatch(/already run once/);
  });

  it('lets a forced run re-run a spent job, and re-stamps it', async () => {
    state.config = oneShotPlan([{ id: 'once', enabled: true, runOnce: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }]);
    state.completions = { 'grok:once': new Date(now - 86_400_000).toISOString() };

    const result = await runQuotaBurnCycle({ trigger: 'manual', familyId: 'grok', jobId: 'once', force: true });
    expect(result.dispatched).toBe(true);
    // Uncharged against the window's automatic budget, but still recorded — the
    // two ledgers answer different questions, and the work just happened.
    expect(state.invoked).toEqual([{ stepId: 'once', familyId: 'grok', charge: false, force: true }]);
    expect(state.recorded).toEqual([]);
    expect(state.completed).toEqual(['grok:once']);
  });

  it('does not record a completion for a job that declined to dispatch', async () => {
    state.config = oneShotPlan([{ id: 'once', enabled: true, runOnce: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }]);
    state.invokePending = { once: { count: 1 } };
    state.invokeResult = { dispatched: false, reason: 'no managed app selected' };
    await runQuotaBurnCycle();
    // A misconfigured step must stay retryable — burning its one run on a
    // decline would strand it behind a Re-arm click for work that never ran.
    expect(state.completed).toEqual([]);
  });

  it('skips the cycle rather than re-running one-shot work when the ledger is unreadable', async () => {
    // Fails CLOSED: an unreadable ledger reads as "nothing has run", which would
    // re-dispatch every run-once job on the plan.
    state.completionsUnreadable = true;
    const result = await runQuotaBurnCycle();
    expect(result).toMatchObject({ dispatched: false, reason: 'run-once ledger unreadable' });
    expect(state.invoked).toEqual([]);
  });

  it('walks a whole one-shot series through the completion continuation', async () => {
    // The "run the series once" case: each finished burn agent advances the
    // plan, and the series stops of its own accord instead of looping.
    state.config = oneShotPlan([
      { id: 's1', enabled: true, runOnce: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } },
      { id: 's2', enabled: true, runOnce: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } },
    ]);
    state.invokePending = { s1: { count: 1 }, s2: { count: 1 } };

    await runQuotaBurnCycle();
    await __onBurnAgentCompleted({ metadata: { taskQuotaBurnFamily: 'grok' } });
    await __onBurnAgentCompleted({ metadata: { taskQuotaBurnFamily: 'grok' } });

    expect(state.invoked.map((entry) => entry.stepId)).toEqual(['s1', 's2']);
    expect(state.completed).toEqual(['grok:s1', 'grok:s2']);
  });

  it('reports a spent step as ran rather than probing it', async () => {
    const ranAt = new Date(now - 3_600_000).toISOString();
    state.config = oneShotPlan([{ id: 'once', enabled: true, runOnce: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }]);
    state.completions = { 'grok:once': ranAt };

    const { status } = await getQuotaBurnStatus();
    const grok = status.families.find((family) => family.id === 'grok');
    expect(grok.jobs).toEqual([{ id: 'once', ranAt, pending: null }]);
    expect(countQuotaBurnStepPending).not.toHaveBeenCalled();
    expect(grok.skipReason).toBe('every enabled job has already run once');
  });
});

// #6381 retired the quota-only `JOB_MODULES` registry and its direct
// `agentPrompt` executor, so there is now exactly ONE invocation path. These
// cover what that leaves the runner responsible for: sending every step down the
// shared path, reading the scheduled-task catalog once per cycle, and refusing —
// not dispatching — a step that still carries a legacy `jobType` and therefore
// has no reference to run.
describe('every step routes through the shared invocation path', () => {
  const refPlan = (jobs) => normalizeQuotaBurnConfig({
    enabled: true,
    families: { grok: { enabled: true, resetWithinHours: 24, jobs } },
  });
  const legacyPlan = () => refPlan([{ id: 'legacy', enabled: true, jobType: 'agent-prompt', params: { appId: 'app-1', prompt: 'x' } }]);

  it('probes and runs a taskRef step through quotaBurnInvoke', async () => {
    state.config = refPlan([{ id: 'ref', enabled: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }]);
    state.invokePending = { ref: { count: 1, detail: 'ready' } };

    const result = await runQuotaBurnCycle();

    expect(result.dispatched).toBe(true);
    expect(state.invoked).toEqual([{ stepId: 'ref', familyId: 'grok', charge: true, force: false }]);
  });

  it('sends an un-migrated legacy step down the SAME path rather than a second lane', async () => {
    // The registry that used to execute it is gone. The step is not dropped and
    // not re-interpreted: it goes to the shared path, which resolves it as
    // `legacy-unmigrated` and reports the migration reason. Dispatching it any
    // other way would be the parallel execution path #6381 removed.
    state.config = legacyPlan();
    state.invokePending = { legacy: { count: 0, detail: 'legacy "agent-prompt" step is waiting to be migrated' } };

    const result = await runQuotaBurnCycle();

    expect(countQuotaBurnStepPending).toHaveBeenCalledWith(expect.objectContaining({ step: expect.objectContaining({ id: 'legacy', jobType: 'agent-prompt' }) }));
    expect(result.dispatched).toBe(false);
    expect(state.invoked).toHaveLength(0);
  });

  it('walks past a step with no pending work to the next one', async () => {
    state.config = refPlan([
      { id: 'idle', enabled: true, taskRef: { kind: 'builtin', taskType: 'docs', appId: 'app-1' } },
      { id: 'ref', enabled: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } },
    ]);
    state.invokePending = { idle: { count: 0, detail: 'no pending work' }, ref: { count: 1, detail: 'ready' } };

    const result = await runQuotaBurnCycle();
    expect(result.jobId).toBe('ref');
    expect(state.invoked.map((entry) => entry.stepId)).toEqual(['ref']);
  });

  it('reads the scheduled-task catalog once per cycle, and not at all for a legacy-only plan', async () => {
    state.config = refPlan([
      { id: 'a', enabled: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } },
      { id: 'b', enabled: true, taskRef: { kind: 'custom', jobId: 'job-a' } },
    ]);
    await runQuotaBurnCycle();
    expect(state.catalogReads).toBe(1);

    state.catalogReads = 0;
    state.config = legacyPlan();
    await runQuotaBurnCycle();
    expect(state.catalogReads).toBe(0);
  });

  it('threads force through to the reference path so a targeted run skips the probe', async () => {
    state.config = refPlan([{ id: 'ref', enabled: false, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }]);
    await runQuotaBurnCycle({ trigger: 'manual', familyId: 'grok', jobId: 'ref', force: true });
    expect(state.invoked).toEqual([{ stepId: 'ref', familyId: 'grok', charge: false, force: true }]);
    // A forced run of a NAMED step bypasses the probe entirely — the click IS the
    // selection — and comes back uncharged.
    expect(state.recorded).toHaveLength(0);
  });

  it('does not charge the window when the reference path declines', async () => {
    state.config = refPlan([{ id: 'ref', enabled: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }]);
    state.invokePending = { ref: { count: 1 } };
    state.invokeResult = { dispatched: false, reason: 'scheduled task "ux" is disabled' };

    const result = await runQuotaBurnCycle();
    expect(result.dispatched).toBe(false);
    expect(result.reason).toContain('is disabled');
    expect(state.recorded).toHaveLength(0);
  });

  it('probes reference steps for the status page through the same path', async () => {
    state.config = refPlan([{ id: 'ref', enabled: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } }]);
    state.invokePending = { ref: { count: 1, detail: 'ready to run scheduled task "ux"' } };

    const { status } = await getQuotaBurnStatus();
    const grok = status.families.find((family) => family.id === 'grok');
    expect(grok.jobs).toEqual([{ id: 'ref', ranAt: null, pending: { count: 1, detail: 'ready to run scheduled task "ux"' } }]);
    expect(countQuotaBurnStepPending).toHaveBeenCalledWith(expect.objectContaining({ step: expect.objectContaining({ id: 'ref' }) }));
  });
});

// #6379. A reference step's work is not accepted when the request is recorded —
// an on-demand engine may still refuse it — so the runner must reserve rather
// than charge, and the cap must keep counting the reservation until
// `quotaBurnAcceptance.js` settles it. Charging at the request is the #3179
// undercount one hop earlier: the ledger says "spent" for work that never ran,
// and a `runOnce` step retires without having done anything.
describe('charging the cap and the run-once ledger exactly once', () => {
  const refPlan = (jobs) => normalizeQuotaBurnConfig({
    enabled: true,
    families: { grok: { enabled: true, resetWithinHours: 24, jobs } },
  });
  const asyncStep = (overrides = {}) => refPlan([
    { id: 'ref', enabled: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' }, ...overrides },
  ]);
  const held = (overrides = {}) => ({
    'grok::ref': {
      familyId: 'grok', stepId: 'ref', dispatchKey: 'grok:1', charge: true, runOnce: false,
      requestId: 'demand-1', at: now, chargedAt: null, ...overrides,
    },
  });
  // The key the ladder will actually gate on for this card's window — a
  // reservation only holds a cap slot when it names the same one.
  const liveWindowKey = async () =>
    (await import('./quotaBurn.js')).windowKey('grok', { resetsAt }, { now });

  beforeEach(() => {
    state.invokePending = { ref: { count: 1, detail: 'ready' } };
    state.invokeResult = { dispatched: true, summary: 'Requested "ux"', awaiting: { requestId: 'demand-1' } };
  });

  it('reserves an asynchronous acceptance instead of charging it', async () => {
    state.config = asyncStep({ runOnce: true });

    const result = await runQuotaBurnCycle();

    expect(result.dispatched).toBe(true);
    expect(state.reserved).toEqual([{
      familyId: 'grok', stepId: 'ref', dispatchKey: expect.any(String), charge: true, runOnce: true, requestId: 'demand-1',
    }]);
    // Neither ledger moves until the request is joined to a real task.
    expect(state.recorded).toHaveLength(0);
    expect(state.completed).toHaveLength(0);
    expect(state.runs[0]).toMatchObject({ requestId: 'demand-1', pending: true, charged: false, taskId: null });
  });

  it('charges a synchronous acceptance directly and records the task it queued', async () => {
    state.config = asyncStep({ runOnce: true });
    // The custom-job and programmatic lanes queue (or perform) the work inside
    // the call, so there is no request to wait on — and no reservation to take.
    state.invokeResult = { dispatched: true, summary: 'Queued "job"', detail: { taskId: 'cos-5' } };

    await runQuotaBurnCycle();

    expect(state.reserved).toHaveLength(0);
    expect(state.recorded).toHaveLength(1);
    expect(state.completed).toEqual(['grok:ref']);
    expect(state.runs[0]).toMatchObject({ pending: false, charged: true, taskId: 'cos-5' });
  });

  it('skips a step whose earlier burn is still awaiting acceptance', async () => {
    state.config = refPlan([
      { id: 'ref', enabled: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } },
      { id: 'other', enabled: true, taskRef: { kind: 'builtin', taskType: 'docs', appId: 'app-1' } },
    ]);
    state.invokePending = { ref: { count: 1 }, other: { count: 1 } };
    state.reservations = held();

    const result = await runQuotaBurnCycle();

    // The reserved step is passed over — no second request, no second charge —
    // and the walk moves on to the next step in the plan.
    expect(state.invoked.map((entry) => entry.stepId)).toEqual(['other']);
    expect(result.jobId).toBe('other');
  });

  it('counts a reservation against the window cap while it is in flight', async () => {
    state.config = normalizeQuotaBurnConfig({
      enabled: true,
      families: { grok: { enabled: true, resetWithinHours: 24, maxDispatchesPerWindow: 1, jobs: [
        { id: 'ref', enabled: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } },
      ] } },
    });
    // Reserved against the window this cycle would select, but not yet charged.
    // Reading the cap off the charged ledger alone would let this cycle dispatch
    // a second burn the plan had already committed.
    state.reservations = { 'grok::other': { ...held()['grok::ref'], stepId: 'other', dispatchKey: await liveWindowKey() } };

    const result = await runQuotaBurnCycle();

    expect(result.dispatched).toBe(false);
    expect(result.reason).toContain('dispatch cap reached (1/1)');
  });

  it('refuses to run a cycle it cannot read the reservations for', async () => {
    state.config = asyncStep();
    state.reservations = null;

    const result = await runQuotaBurnCycle();

    // Same posture as the dispatch ledger: reading an unreadable file as "nothing
    // pending" would re-queue a step already in flight and re-open its cap slot.
    expect(result).toMatchObject({ dispatched: false, reason: 'pending reservations read failed' });
    expect(state.invoked).toHaveLength(0);
  });

  it('settles nothing when the page reads status', async () => {
    const { reconcileQuotaBurnReservations } = await import('./quotaBurnAcceptance.js');
    state.config = asyncStep();
    state.reservations = held({ dispatchKey: await liveWindowKey() });

    const { status } = await getQuotaBurnStatus();

    // A probe read must perform no ledger write — opening the page is not a spend.
    expect(reconcileQuotaBurnReservations).not.toHaveBeenCalled();
    expect(state.recorded).toHaveLength(0);
    expect(state.completed).toHaveLength(0);
    // It still SHOWS the reserved burn as used, because it is committed already.
    expect(status.families.find((family) => family.id === 'grok').dispatchesUsed).toBe(1);
  });
});

it('holds a strict sequence until acceptance and successful completion, then advances despite the rotation cursor', async () => {
  state.config = plan({ families: { grok: { enabled: true, sequence: true, jobs: [
    { id: 'audit', runOnce: true, taskRef: { kind: 'builtin', taskType: 'ux', appId: 'app-1' } },
    { id: 'docs', runOnce: true, taskRef: { kind: 'builtin', taskType: 'docs', appId: 'app-1' } },
  ] } } });
  state.invokePending = { audit: { count: 1 }, docs: { count: 1 } };
  state.invokeResult = { dispatched: true, awaiting: { requestId: 'demand-sequence' }, summary: 'Requested audit' };
  expect((await runQuotaBurnCycle()).jobId).toBe('audit');
  expect(state.reserved[0].runOnce).toBe(false);
  expect(state.completed).toHaveLength(0);
  state.reservations = { 'grok::audit': { familyId: 'grok', stepId: 'audit' } };
  expect((await runQuotaBurnCycle()).dispatched).toBe(false);
  state.reservations = {};
  state.sequenceTasks = [{ id: 'task-audit', status: 'in_progress', metadata: { quotaBurnFamily: 'grok' } }];
  expect((await runQuotaBurnCycle()).dispatched).toBe(false);
  const outcome = await __onBurnAgentCompleted({ taskId: 'task-audit', result: { success: true }, metadata: { taskQuotaBurnFamily: 'grok', taskQuotaBurnStepId: 'audit' } });
  expect(state.completions['grok:audit']).toBeTruthy();
  expect(outcome.jobId).toBe('docs');
});
