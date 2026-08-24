import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// eventScheduler is mocked so no real timers arm and isValidCron is deterministic.
const scheduleMock = vi.fn();
const cancelMock = vi.fn();
vi.mock('../eventScheduler.js', () => ({
  schedule: (...a) => scheduleMock(...a),
  cancel: (...a) => cancelMock(...a),
  isValidCron: (expr) => typeof expr === 'string' && expr.trim().split(/\s+/).length === 5,
  isValidRecurrence: (rule) => rule?.frequency === 'weekly' && Array.isArray(rule.weekdays) && rule.weekdays.length > 0,
}));

vi.mock('../userTimezone.js', () => ({
  getUserTimezone: async () => 'UTC',
}));

const settingsEvents = new EventEmitter();
vi.mock('../settings.js', () => ({ settingsEvents, getSettings: async () => ({}) }));

const listCommissionsMock = vi.fn();
const getCommissionMock = vi.fn();
const recordRunMock = vi.fn(async () => ({}));
const commissionEvents = new EventEmitter();
vi.mock('./store.js', () => ({
  listCommissions: (...a) => listCommissionsMock(...a),
  getCommission: (...a) => getCommissionMock(...a),
  recordCommissionRun: (...a) => recordRunMock(...a),
  commissionEvents,
  // projectControl (the commission:changed reconciler the scheduler subscribes)
  // reads the raw record to find the projects a commission spawned. Empty here —
  // the reconciler is covered by projectControl.test.js; these tests are about
  // cron arming + the fire path.
  commissionStore: () => ({ readRaw: async () => null }),
  sanitizeCommission: (raw) => raw,
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

const tasteProfileMock = vi.fn(async () => ({ sections: [{ id: 'music', summary: 'Example stated preference' }], lastSessionAt: '2026-08-15T00:00:00.000Z' }));
const tasteEvidenceMock = vi.fn(async () => ({
  derivedAt: '2026-08-16T00:00:00.000Z',
  windows: { month: { listen: {
    topArtists: [{ name: 'Example Artist', count: 3 }],
    topTracks: [{ name: 'Example Track', artist: 'Example Artist', count: 2 }],
  } } },
}));
vi.mock('../taste-questionnaire.js', () => ({ getTasteProfile: (...a) => tasteProfileMock(...a) }));
vi.mock('../twinEnrichment.js', () => ({ getTasteEvidence: (...a) => tasteEvidenceMock(...a) }));
const resolveMusicEngineSelectionMock = vi.fn(async () => ({
  status: 'ready', selection: { engine: 'musicgen', modelId: 'musicgen-medium', repo: 'example/musicgen-medium' },
}));
vi.mock('../musicEngineCatalog.js', () => ({
  resolveMusicEngineSelection: (...a) => resolveMusicEngineSelectionMock(...a),
}));

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
  runCommissionNow,
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
  tasteProfileMock.mockResolvedValue({ sections: [{ id: 'music', summary: 'Example stated preference' }], lastSessionAt: '2026-08-15T00:00:00.000Z' });
  tasteEvidenceMock.mockResolvedValue({
    derivedAt: '2026-08-16T00:00:00.000Z',
    windows: { month: { listen: {
      topArtists: [{ name: 'Example Artist', count: 3 }],
      topTracks: [{ name: 'Example Track', artist: 'Example Artist', count: 2 }],
    } } },
  });
  resolveMusicEngineSelectionMock.mockResolvedValue({
    status: 'ready', selection: { engine: 'musicgen', modelId: 'musicgen-medium', repo: 'example/musicgen-medium' },
  });
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

  it('keeps rich recurrence for the event scheduler instead of flattening intervals', () => {
    const recurrence = { frequency: 'weekly', interval: 2, weekdays: [1], time: '02:00', anchorDate: '2026-08-31' };
    expect(activeCommissions([videoCommission({ schedule: { kind: 'RECURRENCE', recurrence } })])).toEqual([{
      id: 'commission-1', recurrence, timezone: null,
    }]);
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

  it('registers rich recurrence as a recurrence event', async () => {
    const recurrence = { frequency: 'weekly', interval: 2, weekdays: [1], time: '02:00', anchorDate: '2026-08-31' };
    listCommissionsMock.mockResolvedValue([videoCommission({ schedule: { kind: 'RECURRENCE', recurrence } })]);
    await startCommissionScheduler();
    expect(scheduleMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'creative-commission-commission-1', type: 'recurrence', recurrence,
    }));
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

  it('stamps the commission BACK-POINTER on the project, never a copy of its provider pin', async () => {
    // The pin is resolved live at dispatch from this id (agentBridge →
    // commissionStagePin), so an edit to the commission reaches a project already
    // in flight. Writing a snapshot here is what used to freeze a wedged project
    // on the provider it was minted with, forever.
    getCommissionMock.mockResolvedValue(videoCommission({
      assignment: { providerId: 'claude-tui', model: 'sonnet' },
    }));
    await runScheduledCommission('commission-1');
    const [params] = createProjectMock.mock.calls[0];
    expect(params.commissionId).toBe('commission-1');
    expect(params).not.toHaveProperty('modelOverrides');
    // Resolving the pin is not this path's job any more — it must not even look.
    expect(getProviderByIdMock).not.toHaveBeenCalled();
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

  it('creates a project for a non-video output type (#2769)', async () => {
    getCommissionMock.mockResolvedValue(videoCommission({ targetAbility: 'music', generation: { lengthSeconds: 45 } }));
    await runScheduledCommission('commission-1');
    expect(createProjectMock).toHaveBeenCalledTimes(1);
    // The directive steers the CD planner to the music tools rather than a video render.
    expect(createProjectMock.mock.calls[0][0].directive.goal).toMatch(/music generation tools/i);
    expect(recordRunMock).toHaveBeenCalledWith('commission-1', expect.objectContaining({ status: 'started' }));
  });

  it('builds and persists a deterministic Digital Twin recipe for opted-in music', async () => {
    getCommissionMock.mockResolvedValue(videoCommission({
      targetAbility: 'music',
      brief: { intent: 'ambient', musicTaste: { source: 'digital-twin', window: 'month', anchorCount: 2, explorationPercent: 25 } },
      generation: { lengthSeconds: 45 },
    }));
    await runScheduledCommission('commission-1');
    expect(createProjectMock.mock.calls[0][0].directive.goal).toContain('Example Artist');
    expect(createProjectMock.mock.calls[0][0].directive.goal).toContain('Create an original work');
    expect(recordRunMock).toHaveBeenCalledWith('commission-1', expect.objectContaining({
      status: 'started', tasteRecipe: expect.objectContaining({ source: 'digital-twin', anchors: expect.any(Array) }),
      musicGeneration: {
        engine: 'musicgen', modelId: 'musicgen-medium', repo: 'example/musicgen-medium', durationSec: 45,
      },
    }));
  });

  it('records an explicit skip when the configured music renderer is unavailable', async () => {
    resolveMusicEngineSelectionMock.mockResolvedValueOnce({ status: 'unavailable', reason: 'music-model-unavailable' });
    getCommissionMock.mockResolvedValue(videoCommission({
      targetAbility: 'music',
      brief: { intent: 'ambient', musicTaste: { source: 'digital-twin', musicEngineId: 'acestep', musicModelId: 'removed-model' } },
      generation: { lengthSeconds: 45 },
    }));
    await runScheduledCommission('commission-1');
    expect(recordRunMock).toHaveBeenCalledWith('commission-1', expect.objectContaining({
      status: 'skipped', reason: 'music-model-unavailable',
    }));
    expect(createProjectMock).not.toHaveBeenCalled();
  });

  it('does not advance a taste project when its authoritative local run failed to persist', async () => {
    recordRunMock.mockResolvedValueOnce(null);
    getCommissionMock.mockResolvedValue(videoCommission({
      targetAbility: 'music',
      brief: { intent: 'ambient', musicTaste: { source: 'digital-twin' } },
      generation: { lengthSeconds: 45 },
    }));
    const outcome = await runCommissionNow('commission-1');
    expect(outcome).toMatchObject({ status: 'failed', error: 'taste-run-persistence-unavailable' });
    expect(createProjectMock).toHaveBeenCalledTimes(1);
    expect(advanceMock).not.toHaveBeenCalled();
  });

  it('records an explicit skip when taste mode has no usable observed anchors', async () => {
    tasteEvidenceMock.mockResolvedValueOnce({ derivedAt: '2026-08-16T00:00:00.000Z', windows: { month: { listen: { topArtists: [], topTracks: [] } } } });
    getCommissionMock.mockResolvedValue(videoCommission({
      targetAbility: 'music',
      brief: { intent: 'ambient', musicTaste: { source: 'digital-twin' } },
      generation: { lengthSeconds: 45 },
    }));
    await runScheduledCommission('commission-1');
    expect(recordRunMock).toHaveBeenCalledWith('commission-1', expect.objectContaining({
      status: 'skipped', reason: 'taste-source-unavailable', trigger: 'schedule',
    }));
    expect(createProjectMock).not.toHaveBeenCalled();
  });

  it('skips an UNKNOWN target ability rather than mis-generating (#2769)', async () => {
    getCommissionMock.mockResolvedValue(videoCommission({ targetAbility: 'hologram' }));
    await runScheduledCommission('commission-1');
    expect(createProjectMock).not.toHaveBeenCalled();
    expect(recordRunMock).toHaveBeenCalledWith('commission-1', expect.objectContaining({ status: 'skipped', reason: 'unknown-ability' }));
  });

  it('tags scheduled runs with trigger "schedule"', async () => {
    getCommissionMock.mockResolvedValue(videoCommission());
    await runScheduledCommission('commission-1');
    expect(recordRunMock).toHaveBeenCalledWith('commission-1', expect.objectContaining({ status: 'started', trigger: 'schedule' }));
  });
});

describe('runCommissionNow (manual "Run Now")', () => {
  it('fires through the CD pipeline, tags the run manual, and returns a started outcome', async () => {
    recordRunMock.mockResolvedValue({ id: 'run-1', status: 'started' });
    getCommissionMock.mockResolvedValue(videoCommission());
    const outcome = await runCommissionNow('commission-1');
    expect(outcome).toMatchObject({ status: 'started', projectId: 'cd-xyz' });
    expect(recordRunMock).toHaveBeenCalledWith('commission-1', expect.objectContaining({ status: 'started', trigger: 'manual' }));
    expect(advanceMock).toHaveBeenCalledWith('cd-xyz');
    expect(surfaceMock).toHaveBeenCalledTimes(1);
  });

  it('fires even a PAUSED commission (a test run before enabling)', async () => {
    getCommissionMock.mockResolvedValue(videoCommission({ enabled: false }));
    const outcome = await runCommissionNow('commission-1');
    expect(outcome.status).toBe('started');
    expect(createProjectMock).toHaveBeenCalledTimes(1);
  });

  it('fires a commission whose schedule is not (yet) derivable to a cron', async () => {
    getCommissionMock.mockResolvedValue(videoCommission({ schedule: { kind: 'DAILY' } }));
    const outcome = await runCommissionNow('commission-1');
    expect(outcome.status).toBe('started');
  });

  it('keeps the autonomy gate and reports the skip as the test outcome', async () => {
    creativeModeMock.mockReturnValue('off');
    getCommissionMock.mockResolvedValue(videoCommission());
    const outcome = await runCommissionNow('commission-1');
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'autonomy-off' });
    expect(createProjectMock).not.toHaveBeenCalled();
    expect(recordRunMock).toHaveBeenCalledWith('commission-1', expect.objectContaining({ status: 'skipped', reason: 'autonomy-off', trigger: 'manual' }));
  });

  it('keeps the budget gate and reports the skip', async () => {
    budgetMock.mockResolvedValue({ withinBudget: false });
    getCommissionMock.mockResolvedValue(videoCommission());
    const outcome = await runCommissionNow('commission-1');
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'budget' });
  });

  it('returns a failed outcome (recorded on run history) when the fire throws', async () => {
    createProjectMock.mockRejectedValueOnce(new Error('collection create failed'));
    getCommissionMock.mockResolvedValue(videoCommission());
    const outcome = await runCommissionNow('commission-1');
    expect(outcome).toMatchObject({ status: 'failed', error: 'collection create failed', projectId: null });
    expect(recordRunMock).toHaveBeenCalledWith('commission-1', expect.objectContaining({ status: 'failed', error: 'collection create failed', trigger: 'manual' }));
  });

  it('reports the minted project id when the fire throws AFTER createProject succeeded', async () => {
    // Without the id, the caller sees a bare failure, can't find the orphaned
    // CD project, and a retry mints a duplicate.
    advanceMock.mockRejectedValueOnce(new Error('advance kick failed'));
    getCommissionMock.mockResolvedValue(videoCommission());
    const outcome = await runCommissionNow('commission-1');
    expect(outcome).toMatchObject({ status: 'failed', error: 'advance kick failed', projectId: 'cd-xyz' });
    expect(recordRunMock).toHaveBeenCalledWith('commission-1', expect.objectContaining({ status: 'failed', projectId: 'cd-xyz', trigger: 'manual' }));
  });

  it('propagates NOT_FOUND for an unknown commission (route maps it to 404)', async () => {
    getCommissionMock.mockRejectedValue(Object.assign(new Error('gone'), { code: 'NOT_FOUND' }));
    await expect(runCommissionNow('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
