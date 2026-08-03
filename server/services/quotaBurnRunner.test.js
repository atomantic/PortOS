import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const now = Date.now();
const resetsAt = new Date(now + 2 * 3600_000).toISOString();

const state = {
  config: null,
  quotas: [],
  runs: [],
  dispatches: {},
  recorded: [],
  pending: {},
  ran: [],
  contexts: [],
};

vi.mock('./providerUsage.js', () => ({
  getProviderQuotas: vi.fn(async () => state.quotas),
}));

vi.mock('./quotaBurnStore.js', () => ({
  getQuotaBurnConfig: vi.fn(async () => state.config),
  getQuotaBurnRuns: vi.fn(async () => state.runs),
  recordQuotaBurnRun: vi.fn(async (entry) => { state.runs.unshift(entry); }),
}));

vi.mock('./quotaBurnJobs/index.js', () => ({
  countJobPending: vi.fn(async ({ job }) => state.pending[job.id] ?? { count: 0, detail: 'nothing' }),
  runBurnJob: vi.fn(async ({ job, family, candidate, context }) => {
    state.ran.push({ jobId: job.id, familyId: family.id, charge: candidate.charge });
    state.contexts.push(context);
    return state.jobResult ?? { dispatched: true, summary: `ran ${job.id}` };
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

const { normalizeQuotaBurnConfig } = await import('../lib/quotaBurnConfig.js');
const { getQuotaBurnStatus, runQuotaBurnCycle, __tickQuotaBurn, __resetQuotaBurnRunner } = await import('./quotaBurnRunner.js');

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
        { id: 'first', enabled: true, jobType: 'universe-bible-images', params: {} },
        { id: 'second', enabled: true, jobType: 'agent-prompt', params: {} },
      ],
    },
  },
  ...overrides,
});

beforeEach(() => {
  state.config = plan();
  state.quotas = [card('grok')];
  state.runs = [];
  state.pending = {};
  state.ran = [];
  state.contexts = [];
  state.dispatches = {};
  state.recorded = [];
  state.jobResult = undefined;
  __resetQuotaBurnRunner();
});

afterEach(() => { vi.clearAllMocks(); });

describe('runQuotaBurnCycle', () => {
  it('stays silent when the master switch is off and the trigger is scheduled', async () => {
    state.config = plan({ enabled: false });
    await expect(runQuotaBurnCycle()).resolves.toEqual({ skipped: 'disabled' });
    expect(state.runs).toHaveLength(0);
    expect(state.ran).toHaveLength(0);
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
    state.pending = { first: { count: 0, detail: 'all rendered' }, second: { count: 1, detail: 'ready' } };
    const result = await runQuotaBurnCycle();
    expect(result.dispatched).toBe(true);
    expect(state.ran).toEqual([{ jobId: 'second', familyId: 'grok', charge: true }]);
    expect(state.recorded).toEqual([result.dispatchKey]);
  });

  it('hands the probe\'s work to run() instead of making it recompute', async () => {
    // A universe-bible-images probe reads every bible to produce its count, and
    // run() needs the same scan to know what to render — without the passthrough
    // that multi-megabyte read happened twice per dispatch.
    const scan = { picked: ['batch'], total: 4 };
    state.pending = { first: { count: 4, context: scan } };
    await runQuotaBurnCycle();
    expect(state.contexts).toEqual([scan]);
  });

  it('prefers an earlier job when both have work', async () => {
    state.pending = { first: { count: 3 }, second: { count: 9 } };
    await runQuotaBurnCycle();
    expect(state.ran.map((entry) => entry.jobId)).toEqual(['first']);
  });

  it('logs why nothing burned instead of failing silently', async () => {
    state.pending = { first: { count: 0, detail: 'all rendered' }, second: { count: 0, detail: 'no app' } };
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
    state.pending = { first: { count: 1 } };
    state.jobResult = { dispatched: false, reason: 'no managed app selected' };
    const result = await runQuotaBurnCycle();
    expect(result.dispatched).toBe(false);
    expect(state.recorded).toEqual([]);
  });

  it('explains a closed window in the run log', async () => {
    state.quotas = [card('grok', 100)];
    state.config = plan({ families: { grok: { enabled: true, resetWithinHours: 0, jobs: [{ id: 'first', enabled: true, jobType: 'agent-prompt' }] } } });
    const result = await runQuotaBurnCycle();
    expect(result.dispatched).toBe(false);
    expect(result.reason).toMatch(/no burnable window/);
  });

  it('force-runs one named job past the window gates without charging it', async () => {
    state.config = plan({ families: { grok: { enabled: true, resetWithinHours: 0, jobs: [{ id: 'second', enabled: true, jobType: 'agent-prompt' }] } } });
    state.pending = { second: { count: 1 } };
    const result = await runQuotaBurnCycle({ trigger: 'manual', familyId: 'grok', jobId: 'second', force: true });
    expect(result.dispatched).toBe(true);
    // A forced candidate still carries the family's REAL card and window — it is
    // only marked uncharged, so the run log and the agent brief stay truthful.
    expect(state.ran).toEqual([{ jobId: 'second', familyId: 'grok', charge: false }]);
    expect(result.percentRemaining).toBe(50);
    expect(state.recorded).toEqual([]);
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
    state.pending = { first: { count: 1 } };
    const [first, second] = await Promise.all([runQuotaBurnCycle(), runQuotaBurnCycle()]);
    expect([first.skipped, second.skipped].filter(Boolean)).toEqual(['already-running']);
  });
});

describe('getQuotaBurnStatus', () => {
  it('returns the config it loaded so the route need not re-read it', async () => {
    const { config } = await getQuotaBurnStatus();
    expect(config).toBe(state.config);
  });

  it('reports the live window and the reason a family would not burn', async () => {
    state.pending = { first: { count: 2, detail: '2 entries' }, second: { count: 0, detail: 'no app' } };
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
});

describe('run-now targeting', () => {
  it('force-runs a job whose enabled checkbox is off', async () => {
    // Clicking ▶ on a paused job is a more specific instruction than the
    // checkbox set earlier; filtering it out made the click a silent no-op
    // reported as "no pending work".
    state.config = plan({ families: { grok: { enabled: true, jobs: [{ id: 'paused', enabled: false, jobType: 'agent-prompt' }] } } });
    state.pending = { paused: { count: 1 } };
    const result = await runQuotaBurnCycle({ trigger: 'manual', familyId: 'grok', jobId: 'paused', force: true });
    expect(result.dispatched).toBe(true);
    expect(state.ran.map((entry) => entry.jobId)).toEqual(['paused']);
  });

  it('still skips a disabled job on an ordinary scheduled cycle', async () => {
    state.config = plan({ families: { grok: { enabled: true, jobs: [{ id: 'paused', enabled: false, jobType: 'agent-prompt' }] } } });
    state.pending = { paused: { count: 1 } };
    // Nothing enabled to run ⇒ not actionable ⇒ no quota scrape at all.
    await expect(runQuotaBurnCycle()).resolves.toMatchObject({ dispatched: false });
    expect(state.ran).toEqual([]);
  });

  it('force-runs a job in a family whose own checkbox is off', async () => {
    // Both 'switched off' gates govern the UNATTENDED loop; an explicit click on
    // one row outranks them, exactly as it outranks the window/reserve/cap gates.
    state.config = normalizeQuotaBurnConfig({
      enabled: true,
      families: { grok: { enabled: false, jobs: [{ id: 'j', enabled: true, jobType: 'agent-prompt' }] } },
    });
    state.pending = { j: { count: 1 } };
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
        grok: { enabled: true, jobs: [{ id: 'j', enabled: true, jobType: 'agent-prompt' }] },
        claude: { enabled: true, jobs: [{ id: 'k', enabled: true, jobType: 'agent-prompt' }] },
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
    state.pending = { first: { count: 1 } };
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
    state.pending = { first: { count: 1 } };
    await __tickQuotaBurn();
    expect(getProviderQuotas).toHaveBeenCalled();
  });

  it('ignores manual entries when seeding the clock', async () => {
    // Only a scheduled cycle advances the interval; a manual "Evaluate now"
    // recorded moments ago must not defer the automatic one across a restart.
    const { getProviderQuotas } = await import('./providerUsage.js');
    state.config = plan({ checkIntervalMinutes: 720 });
    state.runs = [{ at: new Date().toISOString(), trigger: 'manual', dispatched: false }];
    state.pending = { first: { count: 1 } };
    await __tickQuotaBurn();
    expect(getProviderQuotas).toHaveBeenCalled();
  });
});
