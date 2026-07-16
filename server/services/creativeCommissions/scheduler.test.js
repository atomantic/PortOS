import { describe, it, expect, vi, beforeEach } from 'vitest';

// eventScheduler is mocked so no real timers arm and isValidCron is deterministic.
const scheduleMock = vi.fn();
const cancelMock = vi.fn();
vi.mock('../eventScheduler.js', () => ({
  schedule: (...a) => scheduleMock(...a),
  cancel: (...a) => cancelMock(...a),
  isValidCron: (expr) => typeof expr === 'string' && expr.trim().split(/\s+/).length === 5,
}));

vi.mock('../../lib/timezone.js', () => ({ getUserTimezone: async () => 'UTC' }));

const listCommissionsMock = vi.fn();
const getCommissionMock = vi.fn();
const recordRunMock = vi.fn(async () => ({}));
vi.mock('./store.js', () => ({
  listCommissions: (...a) => listCommissionsMock(...a),
  getCommission: (...a) => getCommissionMock(...a),
  recordCommissionRun: (...a) => recordRunMock(...a),
}));

// CD graph + autonomy/budget mocks (dynamic-imported inside the fire handler).
const createProjectMock = vi.fn(async () => ({ id: 'cd-xyz' }));
const advanceMock = vi.fn(async () => {});
vi.mock('../creativeDirector/local.js', () => ({ createProject: (...a) => createProjectMock(...a) }));
vi.mock('../creativeDirector/planAdvance.js', () => ({ advanceAfterPlanStepSettled: (...a) => advanceMock(...a) }));
vi.mock('../videoGen/local.js', () => ({ defaultVideoModelId: () => 'ltx-default' }));

const loadStateMock = vi.fn(async () => ({ config: {} }));
vi.mock('../cosState.js', () => ({ loadState: (...a) => loadStateMock(...a) }));
const creativeModeMock = vi.fn(() => 'execute');
vi.mock('../../lib/domainAutonomy.js', () => ({ getCreativeAutonomyMode: (...a) => creativeModeMock(...a) }));
const budgetMock = vi.fn(async () => ({ withinBudget: true }));
vi.mock('../domainUsage.js', () => ({ getDomainBudgetStatus: (...a) => budgetMock(...a) }));

const {
  activeCommissions,
  syncCommissionSchedules,
  startCommissionScheduler,
  stopCommissionScheduler,
  runScheduledCommission,
} = await import('./scheduler.js');

const videoCommission = (over = {}) => ({
  id: 'commission-1',
  name: 'Nightly Surreal',
  enabled: true,
  targetAbility: 'video',
  brief: { intent: 'surreal', styleSpec: 'flat', constraints: {} },
  schedule: { kind: 'DAILY', atLocalTime: '02:00', timezone: null },
  generation: { quality: 'standard', aspectRatio: '16:9', targetDurationSeconds: 10, model: null },
  feedback: [],
  feedbackWindow: 5,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  stopCommissionScheduler();
  creativeModeMock.mockReturnValue('execute');
  budgetMock.mockResolvedValue({ withinBudget: true });
  loadStateMock.mockResolvedValue({ config: {} });
});

describe('activeCommissions', () => {
  it('keeps enabled commissions with a valid derivable cron', () => {
    const active = activeCommissions([videoCommission()]);
    expect(active).toEqual([{ id: 'commission-1', cron: '0 2 * * *', timezone: null }]);
  });

  it('drops disabled commissions and ones with an underivable schedule', () => {
    const active = activeCommissions([
      videoCommission({ id: 'a', enabled: false }),
      videoCommission({ id: 'b', schedule: { kind: 'DAILY' } }), // no time → no cron
      videoCommission({ id: 'c' }),
    ]);
    expect(active.map((e) => e.id)).toEqual(['c']);
  });
});

describe('startCommissionScheduler (no cold-boot generation)', () => {
  it('arms crons but never generates at boot', async () => {
    listCommissionsMock.mockResolvedValue([videoCommission()]);
    const count = await startCommissionScheduler();
    expect(count).toBe(1);
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'creative-commission-commission-1', type: 'cron', cron: '0 2 * * *',
    }));
    // The load-bearing guarantee: arming a schedule fires NO LLM/generation.
    expect(createProjectMock).not.toHaveBeenCalled();
    expect(advanceMock).not.toHaveBeenCalled();
  });

  it('cancels crons whose commission was removed on the next sync', async () => {
    listCommissionsMock.mockResolvedValueOnce([videoCommission()]);
    await syncCommissionSchedules();
    listCommissionsMock.mockResolvedValueOnce([]);
    await syncCommissionSchedules();
    expect(cancelMock).toHaveBeenCalledWith('creative-commission-commission-1');
  });
});

describe('runScheduledCommission gates', () => {
  it('generates through the CD directive pipeline when autonomy is execute + within budget', async () => {
    getCommissionMock.mockResolvedValue(videoCommission());
    await runScheduledCommission('commission-1');
    expect(createProjectMock).toHaveBeenCalledWith(expect.objectContaining({
      aspectRatio: '16:9', quality: 'standard', modelId: 'ltx-default', targetDurationSeconds: 10,
      directive: expect.objectContaining({ goal: expect.stringContaining('surreal') }),
    }));
    expect(advanceMock).toHaveBeenCalledWith('cd-xyz');
    expect(recordRunMock).toHaveBeenCalledWith('commission-1', expect.objectContaining({ status: 'started', projectId: 'cd-xyz' }));
  });

  it('skips generation (records skipped) when creative autonomy is off', async () => {
    creativeModeMock.mockReturnValue('off');
    getCommissionMock.mockResolvedValue(videoCommission());
    await runScheduledCommission('commission-1');
    expect(createProjectMock).not.toHaveBeenCalled();
    expect(recordRunMock).toHaveBeenCalledWith('commission-1', expect.objectContaining({ status: 'skipped', reason: 'autonomy-off' }));
  });

  it('skips generation when over the daily budget', async () => {
    budgetMock.mockResolvedValue({ withinBudget: false });
    getCommissionMock.mockResolvedValue(videoCommission());
    await runScheduledCommission('commission-1');
    expect(createProjectMock).not.toHaveBeenCalled();
    expect(recordRunMock).toHaveBeenCalledWith('commission-1', expect.objectContaining({ status: 'skipped', reason: 'budget' }));
  });

  it('does nothing when the commission is missing or disabled', async () => {
    getCommissionMock.mockResolvedValue(null);
    await runScheduledCommission('gone');
    expect(createProjectMock).not.toHaveBeenCalled();
    expect(recordRunMock).not.toHaveBeenCalled();
  });

  it('skips a non-video target ability (Phase 1 supports video only)', async () => {
    getCommissionMock.mockResolvedValue(videoCommission({ targetAbility: 'music' }));
    await runScheduledCommission('commission-1');
    expect(createProjectMock).not.toHaveBeenCalled();
    expect(recordRunMock).toHaveBeenCalledWith('commission-1', expect.objectContaining({ status: 'skipped', reason: 'unsupported-ability' }));
  });
});
