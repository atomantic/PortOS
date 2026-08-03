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
  runBurnJob: vi.fn(async ({ job, family, candidate }) => {
    state.ran.push({ jobId: job.id, familyId: family.id, hasWindow: Boolean(candidate.dispatchKey) });
    return state.jobResult ?? { dispatched: true, summary: `ran ${job.id}` };
  }),
}));

// Only the two ledger functions are stubbed — `selectBurnCandidates` and
// `explainFamilySkip` stay REAL so this suite exercises the actual gates rather
// than a second copy of them. Stubbing the ledger keeps the suite off the
// install's real `data/cos/` files.
vi.mock('./quotaBurn.js', async (importActual) => ({
  ...(await importActual()),
  getQuotaBurnDispatches: vi.fn(async () => state.dispatches),
  recordQuotaBurnDispatch: vi.fn(async (key) => { state.recorded.push(key); }),
}));

const { normalizeQuotaBurnConfig } = await import('../lib/quotaBurnConfig.js');
const { getQuotaBurnStatus, runQuotaBurnCycle, __resetQuotaBurnRunner } = await import('./quotaBurnRunner.js');

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

  it('runs the FIRST job in the plan that has pending work', async () => {
    // Order is the whole point of the plan: "generate the missing bible images
    // first, then fall through to agent work" must not be reordered by the runner.
    state.pending = { first: { count: 0, detail: 'all rendered' }, second: { count: 1, detail: 'ready' } };
    const result = await runQuotaBurnCycle();
    expect(result.dispatched).toBe(true);
    expect(state.ran).toEqual([{ jobId: 'second', familyId: 'grok', hasWindow: true }]);
    expect(state.recorded).toEqual([result.dispatchKey]);
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
    expect(result.reason).toMatch(/no job in the grok plan had pending work/);
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
    expect(state.ran).toEqual([{ jobId: 'second', familyId: 'grok', hasWindow: false }]);
    // A forced run carries no window key, so it never eats the automatic budget.
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
  it('reports the live window and the reason a family would not burn', async () => {
    state.pending = { first: { count: 2, detail: '2 entries' }, second: { count: 0, detail: 'no app' } };
    const status = await getQuotaBurnStatus();
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
