import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { RUN_TERMINAL_STATUSES } from '../../lib/creativeDirectorPresets.js';

// The raw store read (tombstone-inclusive) these paths run on.
const readRawMock = vi.fn(async () => null);
const listIdsMock = vi.fn(async () => []);
const commissionEvents = new EventEmitter();
vi.mock('./store.js', () => ({
  commissionStore: () => ({ readRaw: (...a) => readRawMock(...a), listIds: (...a) => listIdsMock(...a) }),
  commissionEvents,
  // The real sanitizer only needs to preserve the fields this module reads;
  // identity keeps the fixtures readable and store.test.js owns sanitizer coverage.
  sanitizeCommission: (raw) => raw,
}));

const getProviderByIdMock = vi.fn(async (id) => ({ id, type: 'tui' }));
vi.mock('../providers.js', () => ({ getProviderById: (...a) => getProviderByIdMock(...a) }));
vi.mock('../../lib/aiToolkit/constants.js', () => ({ PROVIDER_TYPES: { CLI: 'cli', TUI: 'tui', API: 'api' } }));

const listProjectsByCommissionIdMock = vi.fn(async () => []);
const getProjectsByIdsMock = vi.fn(async () => []);
const updateProjectMock = vi.fn(async () => ({}));
vi.mock('../creativeDirector/local.js', () => ({
  listProjectsByCommissionId: (...a) => listProjectsByCommissionIdMock(...a),
  getProjectsByIds: (...a) => getProjectsByIdsMock(...a),
  updateProject: (...a) => updateProjectMock(...a),
}));

const stopProjectMock = vi.fn(async (id) => ({ projectId: id, stopped: true }));
const retireRunsMock = vi.fn(async () => ({ runs: 1, tasks: 1, agents: 1 }));
vi.mock('../creativeDirector/stopProject.js', () => ({
  stopProject: (...a) => stopProjectMock(...a),
  retireRuns: (...a) => retireRunsMock(...a),
  // A stand-in for the real pure filter — the restart path must narrow to the LLM
  // stages, and a pass-through stub would hide it sweeping up plan-step render
  // runs. It reads the terminal set from the same presets leaf the real one does,
  // so it cannot drift if RUN_TERMINAL_STATUSES gains a value. (Importing the real
  // module here isn't an option: stopProject.js pulls in creativeDirector/local.js
  // and with it the whole provider graph this suite deliberately mocks away.)
  inflightRuns: (project, kinds) => (project?.runs || []).filter((r) => r
    && !RUN_TERMINAL_STATUSES.has(r.status)
    && (!kinds || kinds.includes(r.kind))),
}));

const advanceMock = vi.fn(async () => {});
vi.mock('../creativeDirector/planAdvance.js', () => ({ advanceAfterPlanStepSettled: (...a) => advanceMock(...a) }));
// The legacy scene-loop counterpart. A directive-less project (a teaser a plan
// step spawned) must go here instead — advanceAfterPlanStepSettled no-ops on it.
const advanceSceneMock = vi.fn(async () => {});
vi.mock('../creativeDirector/completionHook.js', () => ({ advanceAfterSceneSettled: (...a) => advanceSceneMock(...a) }));

const {
  ledgerProjectIds,
  commissionStagePin,
  backfillProjectCommissionIds,
  restartCommissionStages,
  stopCommissionProjects,
  reconcileCommissionProjects,
} = await import('./projectControl.js');

const commission = (over = {}) => ({
  id: 'commission-1',
  enabled: true,
  assignment: { providerId: 'lmstudio-tui', model: 'qwen3.6:35b', effort: 'high' },
  runs: [],
  ...over,
});

// A commission fire always mints a directive-driven project; the legacy
// scene-loop shape reaches this module only via a plan step's teaser (which
// inherits the same commissionId), so it gets its own fixture below.
const project = (over = {}) => ({
  id: 'cd-1', status: 'planning', runs: [], directive: { goal: 'g' }, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  getProviderByIdMock.mockImplementation(async (id) => ({ id, type: 'tui' }));
  readRawMock.mockResolvedValue(null);
  listIdsMock.mockResolvedValue([]);
  listProjectsByCommissionIdMock.mockResolvedValue([]);
  getProjectsByIdsMock.mockResolvedValue([]);
});

describe('ledgerProjectIds', () => {
  it('returns distinct ids newest-first and drops run rows that minted nothing', () => {
    // Three DISTINCT ids in ledger (oldest→newest) order, so the expectation is
    // asymmetric: a forward walk would yield ['cd-a','cd-b','cd-c'] and fail. A
    // two-id fixture reads the same in both directions and pins nothing.
    const ids = ledgerProjectIds({
      runs: [
        { projectId: 'cd-a' },
        { status: 'skipped', projectId: null },
        { projectId: 'cd-b' },
        { projectId: 'cd-a' }, // a re-run against the same project — dedupes
        { projectId: 'cd-c' },
      ],
    });
    expect(ids).toEqual(['cd-c', 'cd-a', 'cd-b']);
  });

  it('tolerates a commission with no run history', () => {
    expect(ledgerProjectIds(null)).toEqual([]);
    expect(ledgerProjectIds({ runs: 'nope' })).toEqual([]);
  });
});

describe('commissionStagePin', () => {
  it('resolves the commission LIVE, so a dispatch picks up an edited provider', async () => {
    readRawMock.mockResolvedValue(commission());
    expect(await commissionStagePin('commission-1')).toEqual({ providerId: 'lmstudio-tui', model: 'qwen3.6:35b', effort: 'high' });
  });

  it('inherits the default when nothing is pinned', async () => {
    readRawMock.mockResolvedValue(commission({ assignment: {} }));
    expect(await commissionStagePin('commission-1')).toBeNull();
    expect(getProviderByIdMock).not.toHaveBeenCalled();
  });

  it('omits the model when only a provider is pinned — never ships model:null into task metadata', async () => {
    readRawMock.mockResolvedValue(commission({ assignment: { providerId: 'lmstudio-tui', model: null } }));
    expect(await commissionStagePin('commission-1')).toEqual({ providerId: 'lmstudio-tui' });
  });

  it('inherits the default for an unknown commission', async () => {
    readRawMock.mockResolvedValue(null);
    expect(await commissionStagePin('commission-gone')).toBeNull();
  });

  it.each([
    ['an api-type provider (no agent harness)', { id: 'gpt-4o', type: 'api' }],
    ['a removed provider', null],
    ['a disabled provider', { id: 'lmstudio-tui', type: 'tui', enabled: false }],
  ])('drops the pin for %s', async (_label, provider) => {
    readRawMock.mockResolvedValue(commission());
    getProviderByIdMock.mockResolvedValue(provider);
    expect(await commissionStagePin('commission-1')).toBeNull();
  });

  it('fails open when provider resolution throws', async () => {
    readRawMock.mockResolvedValue(commission());
    getProviderByIdMock.mockRejectedValue(new Error('toolkit hiccup'));
    expect(await commissionStagePin('commission-1')).toBeNull();
  });
});

describe('project lookup', () => {
  it('finds projects by the commissionId back-pointer, not the capped run ledger', async () => {
    // The ledger has evicted this project (the case the whole module exists for).
    readRawMock.mockResolvedValue(commission({ runs: [] }));
    listProjectsByCommissionIdMock.mockResolvedValue([project({ id: 'cd-wedged' })]);

    await stopCommissionProjects('commission-1');

    expect(stopProjectMock).toHaveBeenCalledWith('cd-wedged', expect.objectContaining({ reason: expect.any(String) }));
  });

  it('still reaches projects minted before the back-pointer existed, via the ledger', async () => {
    readRawMock.mockResolvedValue(commission({ runs: [{ projectId: 'cd-legacy' }] }));
    listProjectsByCommissionIdMock.mockResolvedValue([]);
    getProjectsByIdsMock.mockResolvedValue([project({ id: 'cd-legacy' })]);

    await stopCommissionProjects('commission-1');

    expect(getProjectsByIdsMock).toHaveBeenCalledWith(['cd-legacy']);
    expect(stopProjectMock).toHaveBeenCalledWith('cd-legacy', expect.anything());
  });

  it('does not re-fetch a ledger id the back-pointer query already returned', async () => {
    readRawMock.mockResolvedValue(commission({ runs: [{ projectId: 'cd-1' }] }));
    listProjectsByCommissionIdMock.mockResolvedValue([project({ id: 'cd-1' })]);

    await stopCommissionProjects('commission-1');

    expect(getProjectsByIdsMock).not.toHaveBeenCalled();
    expect(stopProjectMock).toHaveBeenCalledTimes(1);
  });

  it('leaves finished projects alone', async () => {
    readRawMock.mockResolvedValue(commission());
    listProjectsByCommissionIdMock.mockResolvedValue([
      project({ id: 'cd-done', status: 'complete' }),
      project({ id: 'cd-dead', status: 'failed' }),
    ]);

    await stopCommissionProjects('commission-1');

    expect(stopProjectMock).not.toHaveBeenCalled();
  });
});

describe('stopCommissionProjects', () => {
  it('stops every live project, passing the pre-read record so stopProject skips a re-read', async () => {
    readRawMock.mockResolvedValue(commission());
    const p1 = project({ id: 'cd-1' });
    const p2 = project({ id: 'cd-2' });
    listProjectsByCommissionIdMock.mockResolvedValue([p1, p2]);

    const result = await stopCommissionProjects('commission-1', { reason: 'Creative commission deleted' });

    expect(stopProjectMock).toHaveBeenCalledWith('cd-1', { reason: 'Creative commission deleted', project: p1 });
    expect(result.stopped).toEqual(['cd-1', 'cd-2']);
  });

  it('reads the TOMBSTONED record so a delete can still find its projects', async () => {
    readRawMock.mockResolvedValue(commission({ deleted: true, runs: [{ projectId: 'cd-1' }] }));
    getProjectsByIdsMock.mockResolvedValue([project()]);
    await stopCommissionProjects('commission-1');
    expect(readRawMock).toHaveBeenCalledWith('commission-1', { includeDeleted: true });
    expect(stopProjectMock).toHaveBeenCalledWith('cd-1', expect.anything());
  });

  it('keeps going when one project fails to stop', async () => {
    readRawMock.mockResolvedValue(commission());
    listProjectsByCommissionIdMock.mockResolvedValue([project({ id: 'cd-1' }), project({ id: 'cd-2' })]);
    stopProjectMock.mockRejectedValueOnce(new Error('boom'));

    const result = await stopCommissionProjects('commission-1');

    expect(stopProjectMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ stopped: ['cd-2'], checked: 2 });
  });
});

describe('restartCommissionStages', () => {
  it('retires the wedged stage task and re-advances — the task metadata still holds the OLD provider', async () => {
    const order = [];
    retireRunsMock.mockImplementation(async () => { order.push('retire'); return { runs: 1, tasks: 1, agents: 1 }; });
    advanceMock.mockImplementation(async () => { order.push('advance'); });
    readRawMock.mockResolvedValue(commission());
    listProjectsByCommissionIdMock.mockResolvedValue([project({
      runs: [
        { runId: 'r1', kind: 'plan', taskId: 'cd-1-plan-a', status: 'running' },
        { runId: 'r2', kind: 'plan-step', status: 'running' },   // a render — not an LLM stage
        { runId: 'r3', kind: 'plan', status: 'completed' },
      ],
    })]);

    const result = await restartCommissionStages('commission-1');

    expect(order).toEqual(['retire', 'advance']);
    // Only the LLM stage is retired — the in-flight render step is left alone.
    expect(retireRunsMock).toHaveBeenCalledExactlyOnceWith('cd-1', {
      runs: [expect.objectContaining({ runId: 'r1' })],
      reason: 'Creative commission provider changed',
    });
    expect(result.restarted).toEqual(['cd-1']);
  });

  it('hands a directive-LESS project to the scene loop — the plan loop no-ops on it and would strand the retired stage', async () => {
    // A plan step's `cd_produceVideoFromIssue` teaser inherits commissionId but has
    // no directive. advanceAfterPlanStepSettled returns immediately on such a
    // project, so routing it there would retire the stage and re-dispatch nothing.
    readRawMock.mockResolvedValue(commission());
    listProjectsByCommissionIdMock.mockResolvedValue([{
      id: 'cd-teaser',
      status: 'rendering',
      directive: null,
      runs: [{ runId: 'r1', kind: 'treatment', taskId: 't1', status: 'running' }],
    }]);

    await restartCommissionStages('commission-1');

    expect(retireRunsMock).toHaveBeenCalled();
    expect(advanceSceneMock).toHaveBeenCalledExactlyOnceWith('cd-teaser');
    expect(advanceMock).not.toHaveBeenCalled();
  });

  it('restarts a PAUSED project’s stage but never auto-resumes the project', async () => {
    readRawMock.mockResolvedValue(commission());
    listProjectsByCommissionIdMock.mockResolvedValue([project({
      status: 'paused',
      runs: [{ runId: 'r1', kind: 'plan', taskId: 't1', status: 'running' }],
    })]);

    const result = await restartCommissionStages('commission-1');

    expect(retireRunsMock).toHaveBeenCalled();
    expect(advanceMock).not.toHaveBeenCalled();
    expect(result.restarted).toEqual(['cd-1']);
  });

  it('does nothing when no stage is in flight — a live pin needs no teardown', async () => {
    readRawMock.mockResolvedValue(commission());
    listProjectsByCommissionIdMock.mockResolvedValue([project({
      runs: [{ runId: 'r1', kind: 'plan', status: 'completed' }],
    })]);

    const result = await restartCommissionStages('commission-1');

    expect(retireRunsMock).not.toHaveBeenCalled();
    expect(advanceMock).not.toHaveBeenCalled();
    expect(result.restarted).toEqual([]);
  });
});

describe('reconcileCommissionProjects', () => {
  const wedged = () => project({ runs: [{ runId: 'r1', kind: 'plan', taskId: 't1', status: 'running' }] });

  it('stops in-flight work on delete', async () => {
    readRawMock.mockResolvedValue(commission({ deleted: true }));
    listProjectsByCommissionIdMock.mockResolvedValue([project()]);
    const result = await reconcileCommissionProjects({ id: 'commission-1', action: 'delete' });
    expect(result).toEqual({ action: 'stopped' });
    expect(stopProjectMock).toHaveBeenCalledWith('cd-1', expect.objectContaining({ reason: 'Creative commission deleted' }));
  });

  it('stops in-flight work when the commission is PAUSED — pause means stop, not "skip the next tick"', async () => {
    readRawMock.mockResolvedValue(commission({ enabled: false }));
    listProjectsByCommissionIdMock.mockResolvedValue([project()]);
    const result = await reconcileCommissionProjects({ id: 'commission-1', action: 'update' });
    expect(result).toEqual({ action: 'stopped' });
    expect(stopProjectMock).toHaveBeenCalledWith('cd-1', expect.objectContaining({ reason: 'Creative commission paused' }));
    expect(retireRunsMock).not.toHaveBeenCalled();
  });

  it('stops (never restarts) a TOMBSTONED commission reached on a non-delete action', async () => {
    // A restore that lost the LWW, or a synced tombstone arriving as an update:
    // deleted outranks everything, or we re-dispatch work the user removed.
    readRawMock.mockResolvedValue(commission({ deleted: true, enabled: true }));
    listProjectsByCommissionIdMock.mockResolvedValue([wedged()]);

    const result = await reconcileCommissionProjects({ id: 'commission-1', action: 'update', fields: ['assignment'] });

    expect(result).toEqual({ action: 'stopped' });
    expect(stopProjectMock).toHaveBeenCalledWith('cd-1', expect.objectContaining({ reason: 'Creative commission deleted' }));
    expect(retireRunsMock).not.toHaveBeenCalled();
  });

  it('restarts (never stops) the stages of an enabled commission whose provider changed', async () => {
    readRawMock.mockResolvedValue(commission());
    listProjectsByCommissionIdMock.mockResolvedValue([wedged()]);

    const result = await reconcileCommissionProjects({ id: 'commission-1', action: 'update', fields: ['assignment'] });

    expect(result).toEqual({ action: 'restarted' });
    expect(stopProjectMock).not.toHaveBeenCalled();
    expect(retireRunsMock).toHaveBeenCalled();
  });

  it('skips the project lookup for an edit that cannot affect in-flight work', async () => {
    const result = await reconcileCommissionProjects({ id: 'commission-1', action: 'update', fields: ['brief', 'schedule'] });
    expect(result).toEqual({ action: 'noop' });
    expect(readRawMock).not.toHaveBeenCalled();
    expect(listProjectsByCommissionIdMock).not.toHaveBeenCalled();
  });

  it('reconciles when the emitter reports NO field set — absent must not read as irrelevant', async () => {
    readRawMock.mockResolvedValue(commission({ enabled: false }));
    listProjectsByCommissionIdMock.mockResolvedValue([project()]);
    const result = await reconcileCommissionProjects({ id: 'commission-1', action: 'update' });
    expect(result).toEqual({ action: 'stopped' });
  });

  it.each([['create'], [undefined]])('ignores %s (nothing spawned / no id)', async (action) => {
    const result = await reconcileCommissionProjects(action === 'create'
      ? { id: 'commission-1', action: 'create' }
      : { action: 'merge' });
    expect(result).toEqual({ action: 'noop' });
    expect(readRawMock).not.toHaveBeenCalled();
    expect(stopProjectMock).not.toHaveBeenCalled();
  });

  it('ignores a vanished commission', async () => {
    readRawMock.mockResolvedValue(null);
    expect(await reconcileCommissionProjects({ id: 'commission-gone', action: 'update' })).toEqual({ action: 'noop' });
    expect(stopProjectMock).not.toHaveBeenCalled();
  });
});

describe('backfillProjectCommissionIds', () => {
  it('stamps the back-pointer onto projects minted before the field existed', async () => {
    // Without this, an install upgrading with a project ALREADY wedged keeps the
    // old behavior for exactly the project that needs the fix: the dispatch path
    // only consults a commission when the project names one.
    listIdsMock.mockResolvedValue(['commission-1']);
    readRawMock.mockResolvedValue(commission({ runs: [{ projectId: 'cd-old' }, { projectId: 'cd-new' }] }));
    getProjectsByIdsMock.mockResolvedValue([
      {
        id: 'cd-old',
        status: 'planning',
        // What the OLD fire path wrote, plus a hand-set evaluation pin.
        modelOverrides: {
          treatment: { providerId: 'claude-ollama-tui' },
          plan: { providerId: 'claude-ollama-tui' },
          evaluation: { providerId: 'vision-api' },
        },
      },
      { id: 'cd-new', status: 'planning', commissionId: 'commission-1' }, // already stamped
    ]);

    const result = await backfillProjectCommissionIds();

    // Stamps the back-pointer AND drops the stale snapshot — a per-project pin now
    // outranks the commission's, so leaving it would keep the project stuck on the
    // provider it was minted with, which is the whole bug. `evaluation` survives:
    // the commission never wrote it.
    expect(updateProjectMock).toHaveBeenCalledExactlyOnceWith('cd-old', {
      commissionId: 'commission-1',
      modelOverrides: { evaluation: { providerId: 'vision-api' } },
    });
    expect(result).toEqual({ stamped: 1, stopped: 0 });
  });

  it('includes tombstoned commissions — their wedged projects still need stopping', async () => {
    listIdsMock.mockResolvedValue(['commission-1']);
    readRawMock.mockResolvedValue(commission({ deleted: true, runs: [{ projectId: 'cd-old' }] }));
    getProjectsByIdsMock.mockResolvedValue([{ id: 'cd-old', status: 'planning' }]);

    await backfillProjectCommissionIds();

    expect(listIdsMock).toHaveBeenCalledWith({ includeDeleted: true });
    expect(updateProjectMock).toHaveBeenCalled();
  });

  it.each([
    ['deleted', { deleted: true }, 'Creative commission deleted'],
    ['paused', { enabled: false }, 'Creative commission paused'],
  ])('stops the projects of a commission %s BEFORE this build shipped', async (_label, over, reason) => {
    // Its pause/delete event fired on a build with no reconciler, so nothing ever
    // stopped that work — and it is exactly the work still retrying on upgrade.
    listIdsMock.mockResolvedValue(['commission-1']);
    readRawMock.mockResolvedValue(commission({ ...over, runs: [{ projectId: 'cd-orphan' }] }));
    getProjectsByIdsMock.mockResolvedValue([{ id: 'cd-orphan', status: 'planning' }]);

    const result = await backfillProjectCommissionIds();

    expect(stopProjectMock).toHaveBeenCalledExactlyOnceWith('cd-orphan', { reason });
    expect(result).toEqual({ stamped: 1, stopped: 1 });
  });

  it('does NOT stop the projects of a live, enabled commission', async () => {
    listIdsMock.mockResolvedValue(['commission-1']);
    readRawMock.mockResolvedValue(commission({ runs: [{ projectId: 'cd-live' }] }));
    getProjectsByIdsMock.mockResolvedValue([{ id: 'cd-live', status: 'planning' }]);

    const result = await backfillProjectCommissionIds();

    expect(stopProjectMock).not.toHaveBeenCalled();
    expect(result).toEqual({ stamped: 1, stopped: 0 });
  });

  it('is a no-op on a fresh install and on a re-run', async () => {
    expect(await backfillProjectCommissionIds()).toEqual({ stamped: 0, stopped: 0 });
    expect(updateProjectMock).not.toHaveBeenCalled();

    listIdsMock.mockResolvedValue(['commission-1']);
    readRawMock.mockResolvedValue(commission({ runs: [{ projectId: 'cd-1' }] }));
    getProjectsByIdsMock.mockResolvedValue([{ id: 'cd-1', commissionId: 'commission-1' }]);
    expect(await backfillProjectCommissionIds()).toEqual({ stamped: 0, stopped: 0 });
    expect(updateProjectMock).not.toHaveBeenCalled();
  });
});
