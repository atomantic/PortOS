import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  root: null,
  budget: { withinBudget: true, exceeded: null },
  budgetError: null,
  profile: null,
  thinkingSession: null,
  appendMindEvent: vi.fn(async () => ({ appended: true })),
  recordDomainUsage: vi.fn(async () => {}),
}));

vi.mock('./cosState.js', () => ({ loadState: vi.fn(async () => mock.root) }));
vi.mock('./agentRunEventLog.js', () => ({ appendMindEvent: (...args) => mock.appendMindEvent(...args) }));
vi.mock('./domainUsage.js', () => ({
  getDomainBudgetStatus: vi.fn(async () => {
    if (mock.budgetError) throw mock.budgetError;
    return mock.budget;
  }),
  recordDomainUsage: (...args) => mock.recordDomainUsage(...args),
}));
vi.mock('./persistentMindProfile.js', () => ({
  resolvePersistentMindProfile: vi.fn(async () => mock.profile),
  resolvePersistentMindThinkingSession: vi.fn(async () => mock.thinkingSession),
}));

const {
  createPersistentMindCallBoundary,
  evaluatePersistentMindCallAdmission,
  persistentMindCapabilityGrantFingerprint,
} = await import('./persistentMindCallGuard.js');
const { isPersistentMindCallDenial } = await import('../lib/persistentMindTrajectory.js');

const TURN_ID = 'mind-turn-1';
const route = { providerId: 'example-api', providerType: 'api', model: 'example-model', effort: 'high' };

const makeRoot = () => ({
  paused: false,
  config: {
    domainAutonomy: { cos: 'execute' },
    persistentMindProfile: { enabled: true, providerId: 'example-api', model: 'example-model', effort: 'high' },
    persistentMindCapabilities: { createTasks: true, readPortos: true },
  },
  persistentMind: {
    enabled: true,
    started: true,
    status: 'thinking',
    activeTurn: {
      id: TURN_ID,
      wake: { id: 'wake-1', kind: 'self', reason: 'scheduled reflection', sourceTurnId: 'mind-turn-0' },
      startedAt: '2026-01-01T00:00:00.000Z',
    },
  },
});

const receipts = () => mock.appendMindEvent.mock.calls
  .filter(([event]) => event.kind === 'mind.model.call')
  .map(([event]) => event);

const boundary = (overrides = {}) => createPersistentMindCallBoundary({
  mindId: 'cos-persistent-mind',
  turnId: TURN_ID,
  route,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mock.root = makeRoot();
  mock.budget = { withinBudget: true, exceeded: null };
  mock.budgetError = null;
  mock.profile = { ok: true, provider: { id: 'example-api' }, model: 'example-model', effort: 'high' };
  mock.thinkingSession = { ok: true, provider: { id: 'example-api' }, model: 'example-model', effort: 'high' };
});

describe('evaluatePersistentMindCallAdmission', () => {
  it('admits a call while route, lifecycle, grants and budget all still hold', async () => {
    await expect(evaluatePersistentMindCallAdmission({ turnId: TURN_ID, route })).resolves.toEqual({ ok: true });
  });

  it.each([
    ['the mind was stopped', (root) => { root.persistentMind.started = false; }, 'interrupted'],
    ['the mind was paused', (root) => { root.persistentMind.status = 'paused'; }, 'interrupted'],
    ['the turn is no longer active', (root) => { root.persistentMind.activeTurn = { id: 'other-turn' }; }, 'interrupted'],
    ['PortOS autonomy was paused', (root) => { root.paused = true; }, 'interrupted'],
    ['CoS left execute mode', (root) => { root.config.domainAutonomy.cos = 'dry-run'; }, 'interrupted'],
  ])('denies the next call when %s', async (_label, mutate, status) => {
    mutate(mock.root);
    const admission = await evaluatePersistentMindCallAdmission({ turnId: TURN_ID, route });
    expect(admission.ok).toBe(false);
    expect(admission.status).toBe(status);
  });

  it('denies when the exhausted budget is only reached mid-turn', async () => {
    mock.budget = { withinBudget: false, exceeded: 'actions' };
    const admission = await evaluatePersistentMindCallAdmission({ turnId: TURN_ID, route });
    expect(admission).toMatchObject({ ok: false, status: 'waiting', reason: 'CoS actions budget exhausted' });
  });

  it('fails closed when the budget ledger cannot be read', async () => {
    mock.budgetError = new Error('ledger unreadable');
    const admission = await evaluatePersistentMindCallAdmission({ turnId: TURN_ID, route });
    expect(admission).toMatchObject({ ok: false, status: 'waiting' });
    expect(admission.reason).toContain('ledger unreadable');
  });

  it('denies when the provider became unavailable or the route moved', async () => {
    mock.profile = { ok: false, error: 'Pinned provider "example-api" is unavailable' };
    await expect(evaluatePersistentMindCallAdmission({ turnId: TURN_ID, route })).resolves.toMatchObject({
      ok: false,
      status: 'degraded',
      reason: 'Pinned provider "example-api" is unavailable',
    });

    mock.profile = { ok: true, provider: { id: 'example-api' }, model: 'other-model', effort: 'high' };
    await expect(evaluatePersistentMindCallAdmission({ turnId: TURN_ID, route })).resolves.toMatchObject({
      ok: false,
      reason: 'Persistent mind route changed during the turn',
    });
  });

  it('revalidates a temporary session against its accepted snapshot, not the mutable preset id', async () => {
    mock.thinkingSession = {
      ok: false,
      requiresResubmission: true,
      error: 'Temporary thinking preset changed after acceptance; send a new message to authorize its new route',
    };
    const accepted = { id: 'preset-deep', providerId: 'example-api', model: 'example-model', effort: 'high' };
    const admission = await evaluatePersistentMindCallAdmission({
      turnId: TURN_ID,
      route,
      thinkingPresetId: 'preset-deep',
      thinkingSelection: accepted,
    });
    expect(admission).toMatchObject({ ok: false, status: 'degraded', requiresResubmission: true });

    const { resolvePersistentMindThinkingSession } = await import('./persistentMindProfile.js');
    expect(resolvePersistentMindThinkingSession).toHaveBeenCalledWith(
      expect.objectContaining({ presetId: 'preset-deep', selection: accepted }),
    );
  });

  it('denies once the capability grants differ from the turn snapshot', async () => {
    const fingerprint = persistentMindCapabilityGrantFingerprint(mock.root.config.persistentMindCapabilities);
    await expect(evaluatePersistentMindCallAdmission({
      turnId: TURN_ID, route, capabilityFingerprint: fingerprint,
    })).resolves.toEqual({ ok: true });

    mock.root.config.persistentMindCapabilities = { createTasks: true };
    await expect(evaluatePersistentMindCallAdmission({
      turnId: TURN_ID, route, capabilityFingerprint: fingerprint,
    })).resolves.toMatchObject({
      ok: false,
      status: 'degraded',
      reason: 'Persistent mind capability grants changed during the turn',
    });
  });

  it('short-circuits an aborted turn before reading any provider or budget state', async () => {
    const controller = new AbortController();
    controller.abort('Persistent mind turn interrupted');
    const admission = await evaluatePersistentMindCallAdmission({ turnId: TURN_ID, route, signal: controller.signal });
    expect(admission).toMatchObject({ ok: false, status: 'interrupted' });
    const { resolvePersistentMindProfile } = await import('./persistentMindProfile.js');
    expect(resolvePersistentMindProfile).not.toHaveBeenCalled();
  });
});

describe('createPersistentMindCallBoundary', () => {
  it('accounts each admitted call once and writes a receipt naming the run it created', async () => {
    let clock = 1_000;
    const { call, accountedCalls } = boundary({ now: () => clock });
    const result = await call({ purpose: 'turn', round: 0 }, async ({ reportRunId }) => {
      reportRunId('run-7');
      clock += 250;
      return { text: '{}', runId: 'run-7', usage: { inputTokens: 12, outputTokens: 4 } };
    });

    expect(result.runId).toBe('run-7');
    expect(accountedCalls()).toBe(1);
    expect(mock.recordDomainUsage).toHaveBeenCalledWith('cos', { actions: 1, ms: 250 });
    expect(receipts()).toHaveLength(1);
    expect(receipts()[0]).toMatchObject({
      kind: 'mind.model.call',
      turnId: TURN_ID,
      eventId: `mind-model-call:${TURN_ID}:0`,
    });
    expect(receipts()[0].data).toMatchObject({
      purpose: 'turn',
      round: 0,
      runId: 'run-7',
      providerId: 'example-api',
      model: 'example-model',
      effort: 'high',
      elapsedMs: 250,
      outcome: 'completed',
    });
    expect(receipts()[0].data.usage).toMatchObject({ state: 'reported', totalTokens: 16 });
  });

  it('records unknown usage rather than zero when the provider reported none', async () => {
    const { call } = boundary();
    await call({ purpose: 'summary' }, async () => ({ text: 'summary', runId: 'run-1' }));
    expect(receipts()[0].data.usage).toEqual({
      state: 'unknown',
      source: 'unavailable',
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
    });
  });

  it('never starts a denied call, and does not charge the ledger for one', async () => {
    mock.budget = { withinBudget: false, exceeded: 'minutes' };
    const run = vi.fn();
    const { call, accountedCalls } = boundary();
    await expect(call({ purpose: 'tool-round', round: 1 }, run)).rejects.toMatchObject({
      message: 'CoS minutes budget exhausted',
      deniedStatus: 'waiting',
    });

    expect(run).not.toHaveBeenCalled();
    expect(mock.recordDomainUsage).not.toHaveBeenCalled();
    expect(accountedCalls()).toBe(0);
    expect(receipts()[0].data).toMatchObject({
      purpose: 'tool-round',
      round: 1,
      outcome: 'denied',
      reason: 'CoS minutes budget exhausted',
      elapsedMs: null,
      runId: null,
    });
  });

  it('marks a boundary refusal so a caller can tell it from a provider failure', async () => {
    mock.profile = { ok: false, error: 'Pinned provider "example-api" is unavailable' };
    const { call } = boundary();
    const denial = await call({ purpose: 'turn', round: 0 }, async () => ({})).catch((error) => error);
    expect(isPersistentMindCallDenial(denial)).toBe(true);
    expect(isPersistentMindCallDenial(new Error('provider exploded'))).toBe(false);
  });

  it('propagates a revoked temporary route as requiring resubmission', async () => {
    mock.thinkingSession = { ok: false, requiresResubmission: true, error: 'Temporary thinking preset "Deep" is no longer available' };
    const { call } = boundary({ thinkingPresetId: 'preset-deep', thinkingSelection: { id: 'preset-deep' } });
    const denial = await call({ purpose: 'turn', round: 0 }, async () => ({})).catch((error) => error);
    expect(denial.requiresResubmission).toBe(true);
    expect(denial.deniedStatus).toBe('degraded');
  });

  it('accounts a failed attempt and records the run it had already created', async () => {
    let clock = 0;
    const { call, accountedCalls } = boundary({ now: () => clock });
    await expect(call({ purpose: 'turn', round: 0 }, async ({ reportRunId }) => {
      reportRunId('run-9');
      clock += 40;
      throw new Error('provider stream ended without a response');
    })).rejects.toThrow('provider stream ended without a response');

    expect(accountedCalls()).toBe(1);
    expect(mock.recordDomainUsage).toHaveBeenCalledWith('cos', { actions: 1, ms: 40 });
    expect(receipts()[0].data).toMatchObject({
      runId: 'run-9',
      elapsedMs: 40,
      outcome: 'failed',
      reason: 'provider stream ended without a response',
    });
  });

  it('reports an aborted attempt as interrupted rather than failed', async () => {
    const controller = new AbortController();
    const { call } = boundary({ signal: controller.signal });
    await expect(call({ purpose: 'turn', round: 0 }, async () => {
      controller.abort('Persistent mind turn interrupted');
      throw new Error('Persistent mind turn interrupted');
    })).rejects.toThrow('Persistent mind turn interrupted');
    expect(receipts()[0].data.outcome).toBe('interrupted');
  });

  it('gives every attempt in one turn its own receipt id', async () => {
    const { call } = boundary();
    await call({ purpose: 'turn', round: 0 }, async () => ({ runId: 'run-1' }));
    await call({ purpose: 'tool-round', round: 1 }, async () => ({ runId: 'run-2' }));
    expect(receipts().map((event) => event.eventId)).toEqual([
      `mind-model-call:${TURN_ID}:0`,
      `mind-model-call:${TURN_ID}:1`,
    ]);
  });
});
