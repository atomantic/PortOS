import { beforeEach, describe, expect, it, vi } from 'vitest';

const deps = vi.hoisted(() => ({
  settings: vi.fn(),
  processing: vi.fn(),
  selfUpdate: vi.fn(),
  appUpdate: vi.fn(),
  prepareRepo: vi.fn(),
  readRepo: vi.fn(),
  queueRepair: vi.fn(),
  status: vi.fn(),
  gateState: vi.fn(),
  recordRuntime: vi.fn(),
  schedule: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('./eventScheduler.js', () => ({ schedule: deps.schedule, cancel: deps.cancel }));
vi.mock('./settings.js', () => ({
  getSettings: deps.settings,
  settingsEvents: { on: vi.fn(), emit: vi.fn() },
}));
vi.mock('./activeProcessing.js', () => ({ getSystemActivity: deps.processing }));
vi.mock('./portosSelfUpdate.js', () => ({ startPortosSelfUpdate: deps.selfUpdate }));
vi.mock('./appUpdateRunner.js', () => ({ runAppUpdate: deps.appUpdate }));
vi.mock('./updateRepoReadiness.js', () => ({
  checkUpdateRepoReadiness: deps.readRepo,
  prepareUpdateRepo: deps.prepareRepo,
  queueRepoRepairTask: deps.queueRepair,
}));
vi.mock('./updateChecker.js', () => ({
  getUpdateStatus: deps.status,
  getAutoUpdateGateState: deps.gateState,
  recordAutoUpdateRuntime: deps.recordRuntime,
}));

const { runAutoUpdateTick, syncAutoUpdateSchedule, updateBaselineAt, repairDispatchDue, __resetAutoUpdateSchedulerForTests } =
  await import('./autoUpdateScheduler.js');

const HOUR = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

const idleSnapshot = { activity: { idle: true, blockers: [] } };
const readyVerdict = { ready: true, needsAgent: false, behind: 3, defaultBranch: 'main', reasons: [], repairable: [] };

beforeEach(() => {
  Object.values(deps).forEach((mock) => mock.mockReset());
  __resetAutoUpdateSchedulerForTests();
  deps.settings.mockResolvedValue({ autoUpdate: { enabled: true, channel: 'release', minIntervalHours: 6 } });
  deps.gateState.mockResolvedValue({
    runtime: { armedAt: iso(Date.now() - 48 * HOUR), lastRunAt: null, repairQueuedAt: null },
    lastUpdateResult: null,
    updateInProgress: false,
  });
  deps.recordRuntime.mockResolvedValue({});
  deps.status.mockResolvedValue({
    updateAvailable: true,
    latestRelease: { version: '9.9.9' },
    installState: { outOfSync: false },
  });
  deps.readRepo.mockResolvedValue(readyVerdict);
  deps.prepareRepo.mockResolvedValue({ verdict: readyVerdict, actions: [] });
  deps.processing.mockResolvedValue(idleSnapshot);
  deps.selfUpdate.mockResolvedValue({ started: true, tag: 'v9.9.9' });
  deps.appUpdate.mockResolvedValue({ ok: true });
});

describe('automatic update dispatch', () => {
  // The whole design constraint: an automatic update must be the SAME action
  // the matching button performs, through the same service — not a second
  // implementation that could drift from the preflights and the launch rules.
  it('runs the release channel through the Update page launcher', async () => {
    const io = { emit: vi.fn() };
    await expect(runAutoUpdateTick({ io })).resolves.toMatchObject({ ran: true, channel: 'release' });
    expect(deps.selfUpdate).toHaveBeenCalledWith({ io, mode: 'release' });
    expect(deps.appUpdate).not.toHaveBeenCalled();
  });

  it('runs the main channel through the App Management update runner', async () => {
    deps.settings.mockResolvedValue({ autoUpdate: { enabled: true, channel: 'main', minIntervalHours: 6 } });
    const io = { emit: vi.fn() };
    await expect(runAutoUpdateTick({ io })).resolves.toMatchObject({ ran: true, channel: 'main' });
    expect(deps.appUpdate).toHaveBeenCalledWith({ io, appId: 'portos-default' });
    expect(deps.selfUpdate).not.toHaveBeenCalled();
  });

  // Stamped at the LAUNCH, not at a completion this process does not live to
  // see — update.sh pm2-deletes the server partway through, and a restart that
  // lands before the result is recorded would otherwise fire a second update.
  it('records the run at launch time', async () => {
    await runAutoUpdateTick({ io: {} });
    expect(deps.recordRuntime).toHaveBeenCalledWith(expect.objectContaining({ lastRunAt: expect.any(String) }));
  });

  // The cooldown is stamped off this answer, so an update that did not run must
  // not report one — otherwise one failed dispatch suppresses every retry for
  // the whole interval while nothing has happened.
  it('does not start the cooldown when the update failed to run', async () => {
    deps.settings.mockResolvedValue({ autoUpdate: { enabled: true, channel: 'main', minIntervalHours: 6 } });
    deps.appUpdate.mockResolvedValue({ ok: false, reason: 'failed', message: 'the update did not complete' });
    const result = await runAutoUpdateTick({ io: {} });
    expect(result).toMatchObject({ ran: false, reason: 'launch-failed' });
    expect(deps.recordRuntime).not.toHaveBeenCalledWith(expect.objectContaining({ lastRunAt: expect.any(String) }));
  });
});

describe('automatic update gates', () => {
  it('does nothing while the feature is off', async () => {
    deps.settings.mockResolvedValue({ autoUpdate: { enabled: false } });
    await expect(runAutoUpdateTick({ io: {} })).resolves.toMatchObject({ ran: false, reason: 'disabled' });
    expect(deps.gateState).not.toHaveBeenCalled();
  });

  // The cooldown rejects 71 of every 72 ticks at the default interval, and
  // `getUpdateStatus()` walks every file under client/src — so it must not be
  // paid before the gate that discards it.
  it('waits out the minimum interval without reading the update status', async () => {
    deps.gateState.mockResolvedValue({
      runtime: { armedAt: null, lastRunAt: iso(Date.now() - 2 * HOUR) },
      lastUpdateResult: null,
      updateInProgress: false,
    });
    const result = await runAutoUpdateTick({ io: {} });
    expect(result).toMatchObject({ ran: false, reason: 'cooldown' });
    expect(deps.status).not.toHaveBeenCalled();
    expect(deps.readRepo).not.toHaveBeenCalled();
    expect(deps.selfUpdate).not.toHaveBeenCalled();
  });

  // A user who updated manually an hour ago has reset the clock; an automatic
  // update queued behind that would restart the install for nothing.
  it('measures the interval from a manual update too', async () => {
    deps.gateState.mockResolvedValue({
      runtime: { armedAt: iso(Date.now() - 48 * HOUR), lastRunAt: null },
      lastUpdateResult: { completedAt: iso(Date.now() - HOUR) },
      updateInProgress: false,
    });
    await expect(runAutoUpdateTick({ io: {} })).resolves.toMatchObject({ ran: false, reason: 'cooldown' });
  });

  it('stands down while anything is still running or queued', async () => {
    deps.processing.mockResolvedValue({
      activity: { idle: false, blockers: [{ kind: 'media-queued:video', label: '2 video renders queued', count: 2 }] },
    });
    const result = await runAutoUpdateTick({ io: {} });
    expect(result).toMatchObject({ ran: false, reason: 'busy', detail: '2 video renders queued' });
    expect(deps.selfUpdate).not.toHaveBeenCalled();
  });

  // An unreadable activity snapshot is not an idle one — the tick must not fall
  // through to a restart because the check itself failed.
  it('stands down when the activity snapshot cannot be read', async () => {
    deps.processing.mockRejectedValue(new Error('unreadable'));
    await expect(runAutoUpdateTick({ io: {} })).resolves.toMatchObject({ ran: false, reason: 'activity-unknown' });
    expect(deps.selfUpdate).not.toHaveBeenCalled();
  });

  it('does not restart the install when there is nothing to update to', async () => {
    deps.status.mockResolvedValue({
      updateAvailable: false, latestRelease: { version: '1.0.0' }, installState: { outOfSync: false },
    });
    await expect(runAutoUpdateTick({ io: {} })).resolves.toMatchObject({ ran: false, reason: 'up-to-date' });
    expect(deps.selfUpdate).not.toHaveBeenCalled();
  });

  it('updates on the main channel only while origin is actually ahead', async () => {
    deps.settings.mockResolvedValue({ autoUpdate: { enabled: true, channel: 'main', minIntervalHours: 6 } });
    deps.readRepo.mockResolvedValue({ ...readyVerdict, behind: 0 });
    deps.status.mockResolvedValue({
      updateAvailable: true, latestRelease: { version: '9.9.9' }, installState: { outOfSync: false },
    });
    await expect(runAutoUpdateTick({ io: {} })).resolves.toMatchObject({ ran: false, reason: 'up-to-date' });
    expect(deps.appUpdate).not.toHaveBeenCalled();
  });
});

describe('checkout readiness gate', () => {
  const notReady = {
    ready: false, needsAgent: true, behind: 3, defaultBranch: 'main',
    summary: 'the working tree has uncommitted changes',
    reasons: ['uncommitted-changes'], repairable: [],
  };

  it('refuses to update a checkout that is not clean on the default branch', async () => {
    deps.readRepo.mockResolvedValue(notReady);
    deps.queueRepair.mockResolvedValue({ id: 'task-1' });
    const result = await runAutoUpdateTick({ io: {} });
    expect(result).toMatchObject({ ran: false, reason: 'repo-not-ready' });
    expect(deps.selfUpdate).not.toHaveBeenCalled();
  });

  // The repairs run `git checkout` in the PRIMARY checkout. Doing that before
  // the idle gate would branch-jack a live `useWorktree: false` CoS agent, so
  // nothing may be written until the install is proven idle.
  it('never writes to the checkout before the idle gate passes', async () => {
    deps.processing.mockResolvedValue({ activity: { idle: false, blockers: [{ label: '1 CoS agent running' }] } });
    deps.readRepo.mockResolvedValue({ ...readyVerdict, ready: false, needsAgent: false, repairable: ['checkout-default'] });
    await expect(runAutoUpdateTick({ io: {} })).resolves.toMatchObject({ ran: false, reason: 'busy' });
    expect(deps.prepareRepo).not.toHaveBeenCalled();
  });

  it('repairs a mechanically-fixable checkout after the idle gate, without an agent', async () => {
    deps.readRepo.mockResolvedValue({ ...readyVerdict, ready: false, needsAgent: false, repairable: ['checkout-default'] });
    deps.prepareRepo.mockResolvedValue({ verdict: readyVerdict, actions: ['switched to main'] });
    await expect(runAutoUpdateTick({ io: {} })).resolves.toMatchObject({ ran: true });
    expect(deps.queueRepair).not.toHaveBeenCalled();
    expect(deps.prepareRepo).toHaveBeenCalledTimes(1);
  });

  it('queues an agent only for what no script may safely repair', async () => {
    deps.readRepo.mockResolvedValue(notReady);
    deps.queueRepair.mockResolvedValue({ id: 'task-1' });
    await runAutoUpdateTick({ io: {} });
    expect(deps.queueRepair).toHaveBeenCalledTimes(1);
    expect(deps.prepareRepo).not.toHaveBeenCalled();
  });

  it('leaves the agent unqueued when the user switched that off', async () => {
    deps.settings.mockResolvedValue({ autoUpdate: { enabled: true, minIntervalHours: 6, resolveBlockersWithAgent: false } });
    deps.readRepo.mockResolvedValue(notReady);
    await expect(runAutoUpdateTick({ io: {} })).resolves.toMatchObject({ reason: 'repo-not-ready' });
    expect(deps.queueRepair).not.toHaveBeenCalled();
  });

  // The core regression (#7468): a repair agent that stands down without
  // fixing the tree must not be re-queued every 5-minute tick forever.
  // `addTask`'s dedup only holds while that task stays open, and
  // `agentFinalization` marks it `completed` regardless of whether the
  // checkout ended up clean — so nothing but the `repairQueuedAt` gate can
  // bound the re-dispatch. Still `repo-not-ready`, not `cooldown` — the
  // update-cooldown reason must not be reused here (see next test).
  it('does not queue a second repair agent on the tick after the first one completed', async () => {
    deps.readRepo.mockResolvedValue(notReady);
    deps.queueRepair.mockResolvedValue({ id: 'task-1' });

    await runAutoUpdateTick({ io: {} });
    expect(deps.queueRepair).toHaveBeenCalledTimes(1);
    const stampCalls = deps.recordRuntime.mock.calls.filter(([patch]) => typeof patch.repairQueuedAt === 'string');
    expect(stampCalls).toHaveLength(1);
    const [[{ repairQueuedAt }]] = stampCalls;

    // The repair task is done by the next tick (whether or not it fixed
    // anything, same as agentFinalization marking it `completed` either way),
    // but the checkout is STILL not ready, so the repair-dispatch gate above
    // is what has to hold, not the update cooldown.
    deps.queueRepair.mockClear();
    deps.gateState.mockResolvedValue({
      runtime: { armedAt: iso(Date.now() - 48 * HOUR), lastRunAt: null, repairQueuedAt },
      lastUpdateResult: null,
      updateInProgress: false,
    });

    const result = await runAutoUpdateTick({ io: {} });
    expect(result).toMatchObject({ ran: false, reason: 'repo-not-ready' });
    expect(deps.queueRepair).not.toHaveBeenCalled();
  });

  // The bug the reviewer of the first draft of this fix caught: folding the
  // repair-dispatch timestamp into the UPDATE cooldown would mean a checkout
  // the repair agent fixes in minutes still can't update for the rest of the
  // interval. It must update on the very next idle tick instead.
  it('updates on the next tick once the repair agent actually fixed the checkout', async () => {
    deps.gateState.mockResolvedValue({
      runtime: { armedAt: iso(Date.now() - 48 * HOUR), lastRunAt: null, repairQueuedAt: iso(Date.now() - 60_000) },
      lastUpdateResult: null,
      updateInProgress: false,
    });
    deps.readRepo.mockResolvedValue(readyVerdict);

    await expect(runAutoUpdateTick({ io: {} })).resolves.toMatchObject({ ran: true });
    expect(deps.queueRepair).not.toHaveBeenCalled();
  });

  // A failed enqueue (`queueRepoRepairTask` returns null on its own caught
  // error) must not stamp the gate — otherwise one failed dispatch locks out
  // every retry for the whole cooldown window while nothing was queued.
  it('does not stamp the repair gate when the enqueue itself failed', async () => {
    deps.readRepo.mockResolvedValue(notReady);
    deps.queueRepair.mockResolvedValue(null);

    await runAutoUpdateTick({ io: {} });
    expect(deps.recordRuntime).not.toHaveBeenCalledWith(expect.objectContaining({ repairQueuedAt: expect.any(String) }));
  });
});

describe('runtime-write failure handling', () => {
  // The core regression (#7530): a persistence outage on the FIRST tick
  // after enabling was reported as an ordinary, freshly-armed cooldown
  // (`updateBaselineAt` falls back to `now` with no `armedAt`), forever —
  // indistinguishable from nothing to report. It must surface as its own
  // reason and never fall through to the update/repair checks.
  it('reports a persistence-unavailable outcome when the initial arming write fails, without reaching the update gates', async () => {
    deps.gateState.mockResolvedValue({
      runtime: { armedAt: null, lastRunAt: null, repairQueuedAt: null },
      lastUpdateResult: null,
      updateInProgress: false,
    });
    deps.recordRuntime.mockRejectedValue(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));

    const result = await runAutoUpdateTick({ io: {} });
    expect(result).toMatchObject({ ran: false, reason: 'runtime-persistence-unavailable' });
    expect(deps.status).not.toHaveBeenCalled();
    expect(deps.selfUpdate).not.toHaveBeenCalled();
    expect(deps.appUpdate).not.toHaveBeenCalled();
  });

  // Repeated ticks against a still-broken write must keep reporting the same
  // outcome (the read never sees a persisted armedAt), not silently drift
  // back into a normal cooldown once the "first tick after enabling" framing
  // no longer applies.
  it('keeps reporting persistence-unavailable across repeated ticks while the write stays broken, without flooding the log', async () => {
    deps.gateState.mockResolvedValue({
      runtime: { armedAt: null, lastRunAt: null, repairQueuedAt: null },
      lastUpdateResult: null,
      updateInProgress: false,
    });
    deps.recordRuntime.mockRejectedValue(new Error('disk full'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const first = await runAutoUpdateTick({ io: {} });
    const second = await runAutoUpdateTick({ io: {} });
    const third = await runAutoUpdateTick({ io: {} });
    expect(first).toMatchObject({ ran: false, reason: 'runtime-persistence-unavailable' });
    expect(second).toMatchObject({ ran: false, reason: 'runtime-persistence-unavailable' });
    expect(third).toMatchObject({ ran: false, reason: 'runtime-persistence-unavailable' });
    // One log line for the 'arm' operation, no matter how many ticks it fails
    // on — dedup is per operation, not per call.
    const armFailures = errorSpy.mock.calls.filter(([line]) => line.includes('runtime write failed (arm)'));
    expect(armFailures).toHaveLength(1);
    errorSpy.mockRestore();
  });

  // Once the write actually lands, the tick must fall through to ordinary
  // gating again — a transient outage must not wedge the scheduler forever.
  it('resumes normal cooldown behavior once the arming write recovers', async () => {
    deps.gateState.mockResolvedValue({
      runtime: { armedAt: null, lastRunAt: null, repairQueuedAt: null },
      lastUpdateResult: null,
      updateInProgress: false,
    });
    deps.recordRuntime.mockRejectedValueOnce(new Error('disk full'));
    deps.recordRuntime.mockResolvedValue({});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const first = await runAutoUpdateTick({ io: {} });
    expect(first).toMatchObject({ ran: false, reason: 'runtime-persistence-unavailable' });

    // The write now lands (recovery), stamping `armedAt` at "now" — correctly
    // still a fresh cooldown, since this install has never updated before.
    const second = await runAutoUpdateTick({ io: {} });
    expect(second).toMatchObject({ ran: false, reason: 'cooldown' });
    expect(logSpy.mock.calls.some(([line]) => line.includes('runtime write recovered (arm)'))).toBe(true);
    const [{ armedAt }] = deps.recordRuntime.mock.calls.find(([patch]) => typeof patch.armedAt === 'string');
    logSpy.mockRestore();

    // A later tick reads that now-persisted `armedAt`, well outside the
    // interval — ordinary gating resumes with no lingering persistence flag.
    deps.gateState.mockResolvedValue({
      runtime: { armedAt, lastRunAt: null, repairQueuedAt: null },
      lastUpdateResult: null,
      updateInProgress: false,
    });
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(armedAt) + 7 * HOUR);
    const third = await runAutoUpdateTick({ io: {} });
    vi.useRealTimers();
    expect(third).toMatchObject({ ran: true, channel: 'release' });
    expect(third.persistenceWarning).toBeUndefined();
  });

  // A write failure recording an ORDINARY stand-down (cooldown, busy, …) must
  // not be discarded silently — it still has to log something a person can
  // find, distinct from the tick's own reported reason.
  it('logs, but does not otherwise change, a runtime write failure while recording an ordinary skip', async () => {
    deps.gateState.mockResolvedValue({
      runtime: { armedAt: iso(Date.now() - 2 * HOUR), lastRunAt: null, repairQueuedAt: null },
      lastUpdateResult: null,
      updateInProgress: false,
    });
    deps.recordRuntime.mockRejectedValue(new Error('disk full'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runAutoUpdateTick({ io: {} });
    expect(result).toMatchObject({ ran: false, reason: 'cooldown' });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('runtime write failed (skip)'));
    errorSpy.mockRestore();
  });

  // The launch itself must never be treated as undone or retried because its
  // OWN bookkeeping write failed afterward — `setUpdateInProgress`'s
  // persisted lock, not this write, is what guards against a second launch.
  // The caller instead gets an explicit degradation flag.
  it('preserves the launched outcome and flags a post-launch record failure without retrying', async () => {
    deps.recordRuntime.mockImplementation((patch) => {
      if (patch && typeof patch.lastRunAt === 'string') return Promise.reject(new Error('disk full'));
      return Promise.resolve({});
    });

    const result = await runAutoUpdateTick({ io: {} });
    expect(result).toMatchObject({ ran: true, channel: 'release', persistenceWarning: expect.any(String) });
    expect(deps.selfUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('poll registration', () => {
  it('registers nothing while the feature is off, and cancels a live poll', async () => {
    deps.settings.mockResolvedValue({ autoUpdate: { enabled: false } });
    await expect(syncAutoUpdateSchedule()).resolves.toBe(false);
    expect(deps.schedule).not.toHaveBeenCalled();
    expect(deps.cancel).toHaveBeenCalledWith('portos-auto-update');
  });

  it('registers one interval poll when enabled, and is idempotent across saves', async () => {
    await expect(syncAutoUpdateSchedule({ autoUpdate: { enabled: true } })).resolves.toBe(true);
    expect(deps.schedule).toHaveBeenCalledTimes(1);
    expect(deps.schedule.mock.calls[0][0]).toMatchObject({ id: 'portos-auto-update', type: 'interval' });
    // Channel/interval are re-read inside the handler, so changing one must not
    // churn the registration.
    await syncAutoUpdateSchedule({ autoUpdate: { enabled: true, channel: 'main', minIntervalHours: 12 } });
    expect(deps.schedule).toHaveBeenCalledTimes(1);
  });
});

describe('interval baseline', () => {
  it('prefers the most recent of the scheduler run, the manual update, and the arming point', () => {
    const now = Date.parse('2026-01-02T00:00:00Z');
    expect(updateBaselineAt(
      { lastRunAt: '2026-01-01T00:00:00Z', armedAt: '2025-12-01T00:00:00Z' },
      { completedAt: '2026-01-01T12:00:00Z' },
      now,
    )).toBe(Date.parse('2026-01-01T12:00:00Z'));
  });

  // Without a baseline the interval would be measured from the epoch and the
  // first tick after enabling would fire immediately.
  it('falls back to now when nothing has ever been recorded', () => {
    const now = 1_000_000;
    expect(updateBaselineAt({}, null, now)).toBe(now);
  });

  // #7468: a repair-agent dispatch must NOT feed this baseline. A fixed
  // checkout has to update on the very next tick, not wait out the same
  // interval a second time — that throttling lives in `repairDispatchDue`.
  it('ignores a repair-agent dispatch entirely', () => {
    const now = Date.parse('2026-01-02T00:00:00Z');
    expect(updateBaselineAt(
      { repairQueuedAt: '2026-01-01T23:59:00Z', armedAt: '2025-12-01T00:00:00Z' },
      null,
      now,
    )).toBe(Date.parse('2025-12-01T00:00:00Z'));
  });
});

describe('repair-dispatch cooldown', () => {
  const MIN_INTERVAL_MS = 6 * HOUR;

  // The regression this whole fix targets: a repair agent that stands down
  // must cost one dispatch per window, not one per 5-minute tick.
  it('refuses a re-dispatch before the interval has elapsed', () => {
    const now = Date.parse('2026-01-02T00:00:00Z');
    expect(repairDispatchDue(
      { repairQueuedAt: iso(now - HOUR) },
      MIN_INTERVAL_MS,
      now,
    )).toBe(false);
  });

  it('allows a re-dispatch once the interval has elapsed', () => {
    const now = Date.parse('2026-01-02T00:00:00Z');
    expect(repairDispatchDue(
      { repairQueuedAt: iso(now - 7 * HOUR) },
      MIN_INTERVAL_MS,
      now,
    )).toBe(true);
  });

  it('allows the first dispatch when nothing has ever been queued', () => {
    expect(repairDispatchDue({}, MIN_INTERVAL_MS, Date.now())).toBe(true);
  });
});
