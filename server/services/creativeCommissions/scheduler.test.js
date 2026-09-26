import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  // Real value from store.js — the scheduler branches on this to keep a
  // confirmed deletion a quiet no-op (#7528).
  ERR_NOT_FOUND: 'NOT_FOUND',
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
const surfaceLossMock = vi.fn(async () => {});
vi.mock('./surface.js', () => ({
  surfaceCommissionRun: (...a) => surfaceMock(...a),
  surfaceCommissionHistoryLoss: (...a) => surfaceLossMock(...a),
}));

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
const resolveUniverseStyleMock = vi.fn();
vi.mock('../creativeStyleSources.js', () => ({
  resolveUniverseStyleSource: (...a) => resolveUniverseStyleMock(...a),
  resolveMoodBoardStyleSource: async () => ({ board: null, images: [] }),
}));

const {
  activeCommissions,
  syncCommissionSchedules,
  startCommissionScheduler,
  stopCommissionScheduler,
  runScheduledCommission,
  runCommissionNow,
  HISTORY_UNAVAILABLE,
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

describe('inventory read failure recovery (#7526)', () => {
  it('preserves armed crons and the signature when the inventory read rejects, and emits an actionable error', async () => {
    listCommissionsMock.mockResolvedValueOnce([videoCommission()]);
    await startCommissionScheduler();
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    cancelMock.mockClear(); // beforeEach's teardown of the PRIOR test's cron is not under test here

    listCommissionsMock.mockRejectedValueOnce(new Error('connection terminated'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const count = await syncCommissionSchedules();

    // The regression: a rejected read used to be swallowed into `[]`, which
    // read as "zero commissions" and cancelled every armed cron below.
    expect(cancelMock).not.toHaveBeenCalled();
    expect(count).toBe(1); // still-armed count, not zero
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('connection terminated'));
    // Actionable, not a record dump — no commission payload in the log line.
    expect(consoleErrorSpy.mock.calls.some((args) => args[0].includes('Nightly Surreal'))).toBe(false);
    consoleErrorSpy.mockRestore();
  });

  describe('with fake timers', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('recovers registrations via the coalesced backoff retry once the store recovers, with no further user save', async () => {
      listCommissionsMock.mockResolvedValueOnce([videoCommission()]);
      await startCommissionScheduler();
      cancelMock.mockClear(); // beforeEach's teardown of the PRIOR test's cron is not under test here

      // The commission was actually deleted while the store was unreachable —
      // the failed read must not have raced ahead and cancelled it early.
      listCommissionsMock.mockRejectedValueOnce(new Error('connection terminated'));
      listCommissionsMock.mockResolvedValue([]);
      await syncCommissionSchedules();
      expect(cancelMock).not.toHaveBeenCalled();

      // No settings/commission mutation follows — only the scheduler's own
      // retry should notice the store is back.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(cancelMock).toHaveBeenCalledWith('creative-commission-commission-1');
    });

    it('coalesces repeated failures onto one pending retry instead of stacking timers', async () => {
      listCommissionsMock.mockRejectedValue(new Error('connection terminated'));
      await syncCommissionSchedules(); // failure #1 arms a retry at the first backoff tier
      await syncCommissionSchedules(); // failure #2 while that retry is pending — must coalesce
      expect(listCommissionsMock).toHaveBeenCalledTimes(2);

      listCommissionsMock.mockResolvedValueOnce([]);
      await vi.advanceTimersByTimeAsync(5_000); // first tier only
      // A stacked second timer would fire an extra attempt at the same tick.
      expect(listCommissionsMock).toHaveBeenCalledTimes(3);
    });

    it('shutdown cancels a pending reconciliation retry', async () => {
      listCommissionsMock.mockRejectedValue(new Error('connection terminated'));
      await syncCommissionSchedules();
      stopCommissionScheduler();
      listCommissionsMock.mockClear();

      await vi.advanceTimersByTimeAsync(300_000); // past every backoff tier
      expect(listCommissionsMock).not.toHaveBeenCalled();
    });
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

  it('hands the configured universe style to both the planner goal and the project styleSpec', async () => {
    resolveUniverseStyleMock.mockResolvedValue({
      name: 'Example Universe', embrace: ['ink wash'], avoid: [], styleNotes: '', styleReferences: [], moodBoardId: null, images: [],
    });
    getCommissionMock.mockResolvedValue(videoCommission({
      brief: { intent: 'surreal', styleSpec: 'flat', constraints: { universeId: 'u1' } },
    }));
    await runScheduledCommission('commission-1');
    const [params] = createProjectMock.mock.calls[0];
    expect(params.directive.goal).toContain('Visual style to embrace: ink wash');
    expect(params.styleSpec).toContain('Visual style to embrace: ink wash');
    expect(params.styleSpec.endsWith('flat')).toBe(true);
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

  it('does nothing when the commission is disabled (paused)', async () => {
    getCommissionMock.mockResolvedValue(videoCommission({ enabled: false }));
    await runScheduledCommission('commission-1');
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

describe('runScheduledCommission pre-fire read failures (#7528)', () => {
  it('confirmed deletion (ERR_NOT_FOUND) stays a quiet no-op — no failed run, nothing thrown', async () => {
    getCommissionMock.mockRejectedValue(Object.assign(new Error('Commission not found: commission-1'), { code: 'NOT_FOUND' }));
    await expect(runScheduledCommission('commission-1')).resolves.toBeUndefined();
    expect(recordRunMock).not.toHaveBeenCalled();
    expect(createProjectMock).not.toHaveBeenCalled();
  });

  it('a non-NOT_FOUND pre-fire read failure (e.g. a storage timeout, or the deliberately-propagated federated feedback read) records a failed run and propagates', async () => {
    const readErr = Object.assign(new Error('storage timeout'), { code: 'ETIMEDOUT' });
    getCommissionMock.mockRejectedValue(readErr);

    await expect(runScheduledCommission('commission-1')).rejects.toBe(readErr);

    // Never a successful no-op: the ledger shows a failed scheduled attempt.
    expect(recordRunMock).toHaveBeenCalledWith('commission-1', {
      status: 'failed', trigger: 'schedule', error: 'read-failed:ETIMEDOUT',
    });
    // Never substitutes empty feedback / launches generation on an unreadable read.
    expect(createProjectMock).not.toHaveBeenCalled();
  });

  it('classifies an error with no `.code` by constructor name, never by its raw message', async () => {
    getCommissionMock.mockRejectedValue(new TypeError('cannot read property of undefined'));
    await expect(runScheduledCommission('commission-1')).rejects.toThrow('cannot read property of undefined');
    expect(recordRunMock).toHaveBeenCalledWith('commission-1', expect.objectContaining({ error: 'read-failed:TypeError' }));
  });

  it('falls back to a bare classification when the error carries neither a code nor a name', async () => {
    getCommissionMock.mockRejectedValue(Object.assign(Object.create(null), { message: 'opaque failure' }));
    await expect(runScheduledCommission('commission-1')).rejects.toBeTruthy();
    expect(recordRunMock).toHaveBeenCalledWith('commission-1', expect.objectContaining({ error: 'read-failed' }));
  });

  it('emits an independent diagnostic and still propagates the original error when the failure ledger write ALSO fails', async () => {
    const readErr = Object.assign(new Error('storage timeout'), { code: 'ETIMEDOUT' });
    getCommissionMock.mockRejectedValue(readErr);
    const ledgerErr = new Error('ledger write timeout');
    recordRunMock.mockRejectedValueOnce(ledgerErr);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runScheduledCommission('commission-1')).rejects.toBe(readErr);

    expect(consoleErrorSpy.mock.calls.some(([line]) => line.includes('pre-fire read failed AND its failure could not be recorded'))).toBe(true);
    consoleErrorSpy.mockRestore();
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

// A lost run-history write is the failure mode that used to be invisible (#7529):
// the run row never landed, so the commission's gallery (derived from persisted
// run ids) stayed empty, no rating control appeared, and surfacing — gated on a
// real run — never fired. The outcome still said `started` with `run: null`,
// which is byte-identical to "the commission was deleted mid-fire".
describe('run-history write failures are observable (#7529)', () => {
  let consoleErrorSpy;
  beforeEach(() => {
    getCommissionMock.mockResolvedValue(videoCommission());
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { consoleErrorSpy.mockRestore(); });

  it('reports a started fire whose history write failed, keeping the created project id', async () => {
    recordRunMock.mockRejectedValueOnce(Object.assign(new Error('write timeout'), { code: 'ETIMEDOUT' }));
    const outcome = await runCommissionNow('commission-1');
    // Generation genuinely started — the project id stays authoritative.
    expect(outcome).toMatchObject({ status: 'started', projectId: 'cd-xyz', run: null });
    expect(outcome.historyWarning).toEqual({
      code: HISTORY_UNAVAILABLE,
      outcome: 'started',
      trigger: 'manual',
      commissionId: 'commission-1',
      projectId: 'cd-xyz',
      detail: 'write-failed:ETIMEDOUT',
    });
    // No duplicate project and no replayed provider work to "repair" history.
    expect(createProjectMock).toHaveBeenCalledTimes(1);
    expect(advanceMock).toHaveBeenCalledWith('cd-xyz');
  });

  it('does NOT warn when the commission was deleted mid-fire (an honest absent run, not a degraded write)', async () => {
    recordRunMock.mockResolvedValueOnce(null);
    const outcome = await runCommissionNow('commission-1');
    expect(outcome).toMatchObject({ status: 'started', projectId: 'cd-xyz', run: null });
    expect(outcome.historyWarning).toBeUndefined();
  });

  it('emits a scheduled diagnostic naming trigger and local ids, never the prompt or the raw driver message', async () => {
    recordRunMock.mockRejectedValueOnce(Object.assign(new Error('relation "commissions" does not exist'), { code: '42P01' }));
    await runScheduledCommission('commission-1');
    const line = consoleErrorSpy.mock.calls.map(([l]) => l).find((l) => l.includes('run history write failed'));
    expect(line).toContain('commission-1');
    expect(line).toContain('cd-xyz');
    expect(line).toContain('schedule');
    expect(line).toContain('write-failed:42P01');
    // Bounded classification only — no record contents, prompts or feedback.
    expect(line).not.toContain('relation "commissions" does not exist');
    expect(line).not.toContain('surreal');
  });

  it('reports a SKIPPED outcome whose history write failed', async () => {
    creativeModeMock.mockReturnValue('off');
    recordRunMock.mockRejectedValueOnce(new Error('disk full'));
    const outcome = await runCommissionNow('commission-1');
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'autonomy-off', run: null });
    expect(outcome.historyWarning).toMatchObject({
      code: HISTORY_UNAVAILABLE, outcome: 'skipped', trigger: 'manual', projectId: null, detail: 'write-failed:Error',
    });
  });

  it('reports a FAILED outcome whose history write failed, still naming the orphaned project', async () => {
    advanceMock.mockRejectedValueOnce(new Error('advance kick failed'));
    recordRunMock
      .mockResolvedValueOnce({ id: 'run-1', status: 'started' }) // the started row landed
      .mockRejectedValueOnce(new Error('write timeout'));        // the failure row did not
    const outcome = await runCommissionNow('commission-1');
    expect(outcome).toMatchObject({ status: 'failed', error: 'advance kick failed', projectId: 'cd-xyz', run: null });
    expect(outcome.historyWarning).toMatchObject({
      code: HISTORY_UNAVAILABLE, outcome: 'failed', trigger: 'manual', projectId: 'cd-xyz',
    });
  });

  it('still refuses to advance a taste-aware fire whose authoritative run was lost to a write failure', async () => {
    recordRunMock.mockRejectedValueOnce(new Error('write timeout'));
    getCommissionMock.mockResolvedValue(videoCommission({
      targetAbility: 'music',
      brief: { intent: 'ambient', musicTaste: { source: 'digital-twin' } },
      generation: { lengthSeconds: 45 },
    }));
    const outcome = await runCommissionNow('commission-1');
    expect(outcome).toMatchObject({ status: 'failed', error: 'taste-run-persistence-unavailable' });
    expect(advanceMock).not.toHaveBeenCalled();
  });
});

// The scheduled trigger is the case #7529 is really about, and it has no HTTP
// response to carry `historyWarning` home in. Its signal has to be the persisted
// notification, not a console line nobody reads at 02:00.
describe('a lost run-history write reaches an unattended user (#7529)', () => {
  let consoleErrorSpy;
  beforeEach(() => {
    getCommissionMock.mockResolvedValue(videoCommission());
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { consoleErrorSpy.mockRestore(); });

  it('notifies on a SCHEDULED fire whose started row was lost, linking the project that is still running', async () => {
    recordRunMock.mockRejectedValueOnce(Object.assign(new Error('write timeout'), { code: 'ETIMEDOUT' }));
    await runScheduledCommission('commission-1');
    expect(surfaceLossMock).toHaveBeenCalledTimes(1);
    const [commission, warning] = surfaceLossMock.mock.calls[0];
    expect(commission.id).toBe('commission-1');
    expect(warning).toMatchObject({
      code: HISTORY_UNAVAILABLE, outcome: 'started', trigger: 'schedule', projectId: 'cd-xyz',
    });
    // The normal fired-run notification is gated on a real run and cannot fire here.
    expect(surfaceMock).not.toHaveBeenCalled();
  });

  it('notifies when the PRE-FIRE failure row is also lost, and still propagates the original read error', async () => {
    const readErr = Object.assign(new Error('storage timeout'), { code: 'ETIMEDOUT' });
    getCommissionMock.mockRejectedValue(readErr);
    recordRunMock.mockRejectedValueOnce(new Error('ledger write timeout'));

    await expect(runScheduledCommission('commission-1')).rejects.toBe(readErr);

    expect(consoleErrorSpy.mock.calls.some(([line]) => line.includes('pre-fire read failed AND its failure could not be recorded'))).toBe(true);
    // The record was unreadable, so only its id is available to name it by.
    expect(surfaceLossMock).toHaveBeenCalledWith({ id: 'commission-1' }, expect.objectContaining({
      code: HISTORY_UNAVAILABLE, outcome: 'failed', trigger: 'schedule',
    }));
  });

  it('raises no history notification when the write succeeded', async () => {
    recordRunMock.mockResolvedValueOnce({ id: 'run-1', status: 'started', projectId: 'cd-xyz' });
    await runScheduledCommission('commission-1');
    expect(surfaceLossMock).not.toHaveBeenCalled();
    expect(surfaceMock).toHaveBeenCalledTimes(1);
  });
});
