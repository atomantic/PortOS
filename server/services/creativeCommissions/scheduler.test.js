import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// eventScheduler is mocked so no real timers arm and isValidCron is deterministic.
const scheduleMock = vi.fn();
const cancelMock = vi.fn();
vi.mock('../eventScheduler.js', () => ({
  schedule: (...a) => scheduleMock(...a),
  cancel: (...a) => cancelMock(...a),
  isValidCron: (expr) => typeof expr === 'string' && expr.trim().split(/\s+/).length === 5,
}));

vi.mock('../../lib/timezone.js', () => ({ getUserTimezone: async () => 'UTC' }));

const settingsEvents = new EventEmitter();
vi.mock('../settings.js', () => ({ settingsEvents }));

const listCommissionsMock = vi.fn();
const getCommissionMock = vi.fn();
const recordRunMock = vi.fn(async () => ({}));
const commissionEvents = new EventEmitter();
vi.mock('./store.js', () => ({
  listCommissions: (...a) => listCommissionsMock(...a),
  getCommission: (...a) => getCommissionMock(...a),
  recordCommissionRun: (...a) => recordRunMock(...a),
  commissionEvents,
}));

// Surfacing (notification + brain inbox) is mocked so the fire handler stays
// hermetic — the real surface.js lazy-imports notifications/brainStorage.
const surfaceMock = vi.fn(async () => {});
vi.mock('./surface.js', () => ({ surfaceCommissionRun: (...a) => surfaceMock(...a) }));

// CD graph + autonomy/budget mocks (dynamic-imported inside the fire handler).
const createProjectMock = vi.fn(async () => ({ id: 'cd-xyz' }));
const advanceMock = vi.fn(async () => {});
vi.mock('../creativeDirector/local.js', () => ({ createProject: (...a) => createProjectMock(...a) }));
vi.mock('../creativeDirector/planAdvance.js', () => ({ advanceAfterPlanStepSettled: (...a) => advanceMock(...a) }));
vi.mock('../videoGen/local.js', () => ({ defaultVideoModelId: () => 'ltx-default' }));

// Provider resolution for the fire-time pin guard (dynamic-imported inside the
// fire handler). Default: an agent-capable (tui) provider, so a pinned
// commission fans its override onto both stages. Tests override per-case.
const getProviderByIdMock = vi.fn(async (id) => ({ id, type: 'tui' }));
vi.mock('../providers.js', () => ({ getProviderById: (...a) => getProviderByIdMock(...a) }));
vi.mock('../../lib/aiToolkit/constants.js', () => ({ PROVIDER_TYPES: { CLI: 'cli', TUI: 'tui', API: 'api' } }));

const loadStateMock = vi.fn(async () => ({ config: {} }));
vi.mock('../cosState.js', () => ({ loadState: (...a) => loadStateMock(...a) }));
const creativeModeMock = vi.fn(() => 'execute');
vi.mock('../../lib/domainAutonomy.js', () => ({ getCreativeAutonomyMode: (...a) => creativeModeMock(...a) }));
const budgetMock = vi.fn(async () => ({ withinBudget: true }));
const recordUsageMock = vi.fn(async () => {});
vi.mock('../domainUsage.js', () => ({
  getDomainBudgetStatus: (...a) => budgetMock(...a),
  recordDomainUsage: (...a) => recordUsageMock(...a),
}));

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

  it('re-arms crons when the store emits commission:changed (any writer path)', async () => {
    listCommissionsMock.mockResolvedValue([videoCommission()]);
    // Emitting the store event should trigger a re-sync without the route calling in.
    commissionEvents.emit('commission:changed', { id: 'commission-1', action: 'create' });
    await vi.waitFor(() => expect(scheduleMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'creative-commission-commission-1',
    })));
  });

  it('re-syncs on settings:updated so a global timezone change re-registers crons', async () => {
    listCommissionsMock.mockResolvedValue([videoCommission()]);
    settingsEvents.emit('settings:updated', {});
    await vi.waitFor(() => expect(scheduleMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'creative-commission-commission-1',
    })));
  });
});

describe('runScheduledCommission gates', () => {
  it('generates through the CD directive pipeline when autonomy is execute + within budget', async () => {
    getCommissionMock.mockResolvedValue(videoCommission());
    await runScheduledCommission('commission-1');
    expect(createProjectMock).toHaveBeenCalledWith(expect.objectContaining({
      aspectRatio: '16:9', quality: 'standard', modelId: 'ltx-default', targetDurationSeconds: 10,
      directive: expect.objectContaining({ goal: expect.stringContaining('surreal') }),
      // An unset LLM assignment leaves modelOverrides empty → the CD stages
      // inherit the install's default AI Assignment (pre-#2657 behavior).
      modelOverrides: {},
    }));
    expect(advanceMock).toHaveBeenCalledWith('cd-xyz');
    expect(recordRunMock).toHaveBeenCalledWith('commission-1', expect.objectContaining({ status: 'started', projectId: 'cd-xyz' }));
    // Phase 2: a successful fire surfaces the run (notification + brain inbox) so
    // the user can rate it — the reaction steers the next fire.
    expect(surfaceMock).toHaveBeenCalledTimes(1);
    // The planner's cos action is accounted by completeAgent on completion — the
    // fire handler must NOT pre-charge (that would double-count).
    expect(recordUsageMock).not.toHaveBeenCalled();
  });

  it('fans the LLM assignment pin onto both CD cognitive stages (treatment + plan)', async () => {
    getCommissionMock.mockResolvedValue(videoCommission({
      assignment: { providerId: 'claude-tui', model: 'sonnet' },
    }));
    await runScheduledCommission('commission-1');
    const pin = { providerId: 'claude-tui', model: 'sonnet' };
    expect(createProjectMock).toHaveBeenCalledWith(expect.objectContaining({
      modelOverrides: { treatment: pin, plan: pin },
    }));
  });

  it('omits the model from the pin when only a provider is chosen', async () => {
    getCommissionMock.mockResolvedValue(videoCommission({
      assignment: { providerId: 'claude-tui', model: null },
    }));
    await runScheduledCommission('commission-1');
    const pin = { providerId: 'claude-tui' };
    expect(createProjectMock).toHaveBeenCalledWith(expect.objectContaining({
      modelOverrides: { treatment: pin, plan: pin },
    }));
  });

  it('drops a pin to a non-agent (api) provider and still generates on the default', async () => {
    // A CoS treatment/plan task only accepts a cli/tui provider; an api pin
    // would be rejected by the harness-boundary guard mid-fire. The guard drops
    // it so the run proceeds on the install default instead of stalling.
    getProviderByIdMock.mockResolvedValueOnce({ id: 'gpt-4o', type: 'api' });
    getCommissionMock.mockResolvedValue(videoCommission({
      assignment: { providerId: 'gpt-4o', model: 'gpt-4o' },
    }));
    await runScheduledCommission('commission-1');
    expect(createProjectMock).toHaveBeenCalledWith(expect.objectContaining({ modelOverrides: {} }));
    // The commission still fires (falls back to default), it doesn't skip.
    expect(advanceMock).toHaveBeenCalledWith('cd-xyz');
  });

  it('drops a pin to a removed/unresolvable provider (fails open to the default)', async () => {
    getProviderByIdMock.mockResolvedValueOnce(null);
    getCommissionMock.mockResolvedValue(videoCommission({
      assignment: { providerId: 'ghost-provider', model: null },
    }));
    await runScheduledCommission('commission-1');
    expect(createProjectMock).toHaveBeenCalledWith(expect.objectContaining({ modelOverrides: {} }));
  });

  it('drops a pin to a DISABLED agent provider (respects the provider disable control)', async () => {
    // The agent runner honors an explicit task pin without re-checking `enabled`,
    // so a commission pinned to a provider the user later disabled would keep
    // launching through it. The guard drops the pin and falls back to the default.
    getProviderByIdMock.mockResolvedValueOnce({ id: 'claude-tui', type: 'tui', enabled: false });
    getCommissionMock.mockResolvedValue(videoCommission({
      assignment: { providerId: 'claude-tui', model: 'sonnet' },
    }));
    await runScheduledCommission('commission-1');
    expect(createProjectMock).toHaveBeenCalledWith(expect.objectContaining({ modelOverrides: {} }));
  });

  it('does NOT surface when the fire is skipped (nothing was generated)', async () => {
    creativeModeMock.mockReturnValue('off');
    getCommissionMock.mockResolvedValue(videoCommission());
    await runScheduledCommission('commission-1');
    expect(surfaceMock).not.toHaveBeenCalled();
  });

  it('caps the derived project name so createCollection (80-char limit) never fails', async () => {
    getCommissionMock.mockResolvedValue(videoCommission({ name: 'X'.repeat(200) }));
    await runScheduledCommission('commission-1');
    const { name } = createProjectMock.mock.calls[0][0];
    // "Creative Director: " (19) + name must be ≤ 80 → name ≤ 61.
    expect(name.length).toBeLessThanOrEqual(61);
    expect(name.endsWith(new Date().toISOString().slice(0, 10))).toBe(true);
  });

  it('fails closed (skips) when the autonomy/config read is unavailable', async () => {
    loadStateMock.mockRejectedValueOnce(new Error('cos state read failed'));
    getCommissionMock.mockResolvedValue(videoCommission());
    await runScheduledCommission('commission-1');
    expect(createProjectMock).not.toHaveBeenCalled();
    expect(recordRunMock).toHaveBeenCalledWith('commission-1', expect.objectContaining({ status: 'skipped', reason: 'governance-unavailable' }));
  });

  it('fails closed (skips) when the budget read is unavailable', async () => {
    budgetMock.mockRejectedValueOnce(new Error('budget read failed'));
    getCommissionMock.mockResolvedValue(videoCommission());
    await runScheduledCommission('commission-1');
    expect(createProjectMock).not.toHaveBeenCalled();
    expect(recordRunMock).toHaveBeenCalledWith('commission-1', expect.objectContaining({ status: 'skipped', reason: 'budget-unavailable' }));
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
