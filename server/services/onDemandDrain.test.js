/**
 * Behavioral contract for the ONE on-demand drain both Priority 0 engines run.
 *
 * PortOS has two on-demand engines racing the same queue —
 * `cosTaskGenerator.js#spawnPriority0OnDemand` (periodic `evaluateTasks`) and
 * `cos.js#spawnDequeuePriority0OnDemand` (event-driven `dequeueNextTask`) — and
 * which one drains a given request is a race. While the loop was hand-mirrored,
 * the ONLY guards on that parity were source greps against each engine's body,
 * and they still passed while #3294's registry-failure fix sat in the generator
 * copy alone: a request drained by the cos.js copy during a `getActiveApps()`
 * failure had the user's "Run Now" silently deleted (#6618).
 *
 * These run the shared loop through BOTH engines' adapters, so a divergence has
 * to be a real behavioral difference rather than a grep that stopped matching.
 * The registry-failure case below is the one that was live-broken: it fails
 * against `cos.js` on unmodified `main`, where the read was `catch(() => [])`
 * inside the loop and the request was cleared as an "unknown app".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getActiveApps: vi.fn(),
  isImprovementEnabled: vi.fn(() => true),
  loadState: vi.fn(async () => ({ stats: {} })),
  saveState: vi.fn(async () => {}),
  withStateLock: vi.fn(async (fn) => fn()),
  markAppReviewCooldown: vi.fn(async () => {}),
  bindAppReviewAgent: vi.fn(async () => {}),
  addTask: vi.fn(async () => ({ id: 'persisted-1' })),
  reviveBlockedTask: vi.fn(async () => {}),
  loadSchedule: vi.fn(async () => ({ tasks: { 'code-quality': { enabled: true } } })),
  getOnDemandRequests: vi.fn(async () => []),
  clearOnDemandRequest: vi.fn(async () => {}),
  applyOnDemandRunResets: vi.fn(async () => true),
  recordExecution: vi.fn(async () => {}),
  prepareManagedAppImprovementTask: vi.fn(async () => ({ task: { id: 'gen-1', priority: 'HIGH' }, pendingPerpetualDispatch: null })),
  generateSelfImprovementTaskForType: vi.fn(async () => ({ id: 'self-1', priority: 'HIGH' })),
  recordDeferredPerpetualDispatch: vi.fn(async () => {}),
  applyOnDemandConsent: vi.fn((t) => t),
  drainProgrammaticOnDemandRequests: vi.fn(async () => new Set()),
  emitOnDemandEmpty: vi.fn(async () => {}),
}));

vi.mock('./apps.js', () => ({ getActiveApps: (...a) => mocks.getActiveApps(...a) }));
vi.mock('./cosState.js', () => ({
  isImprovementEnabled: (...a) => mocks.isImprovementEnabled(...a),
  loadState: (...a) => mocks.loadState(...a),
  saveState: (...a) => mocks.saveState(...a),
  withStateLock: (...a) => mocks.withStateLock(...a),
}));
vi.mock('./appActivity.js', () => ({
  markAppReviewCooldown: (...a) => mocks.markAppReviewCooldown(...a),
  bindAppReviewAgent: (...a) => mocks.bindAppReviewAgent(...a),
}));
vi.mock('./cosTaskStore.js', () => ({
  addTask: (...a) => mocks.addTask(...a),
  reviveBlockedTask: (...a) => mocks.reviveBlockedTask(...a),
}));
vi.mock('./taskSchedule.js', () => ({
  loadSchedule: (...a) => mocks.loadSchedule(...a),
  getOnDemandRequests: (...a) => mocks.getOnDemandRequests(...a),
  clearOnDemandRequest: (...a) => mocks.clearOnDemandRequest(...a),
  applyOnDemandRunResets: (...a) => mocks.applyOnDemandRunResets(...a),
  recordExecution: (...a) => mocks.recordExecution(...a),
}));
vi.mock('./cosTaskGenerator.js', () => ({
  prepareManagedAppImprovementTask: (...a) => mocks.prepareManagedAppImprovementTask(...a),
  generateSelfImprovementTaskForType: (...a) => mocks.generateSelfImprovementTaskForType(...a),
  recordDeferredPerpetualDispatch: (...a) => mocks.recordDeferredPerpetualDispatch(...a),
  applyOnDemandConsent: (...a) => mocks.applyOnDemandConsent(...a),
  drainProgrammaticOnDemandRequests: (...a) => mocks.drainProgrammaticOnDemandRequests(...a),
  emitOnDemandEmpty: (...a) => mocks.emitOnDemandEmpty(...a),
}));

const { drainOnDemandRequests } = await import('./onDemandDrain.js');

const APP = { id: 'acme', name: 'Acme App' };
const STATE = { agents: {}, stats: {}, config: {} };

// The two real adapters, reproduced from the engines they belong to. Each test
// runs the shared loop through BOTH, so a behavior that only holds for one is a
// failure rather than an untested corner.
function generatorAdapter({ availableSlots = 5 } = {}) {
  const tasksToSpawn = [];
  return {
    spawned: tasksToSpawn,
    adapter: {
      capacityExhausted: () => tasksToSpawn.length >= availableSlots,
      canSpawn: () => true,
      emitSpawn: (task) => tasksToSpawn.push(task),
    },
  };
}

function dequeueAdapter({ availableSlots = 5, ignoreTaskId = 'completing-task' } = {}) {
  const spawned = [];
  return {
    spawned,
    adapter: {
      capacityExhausted: () => spawned.length >= availableSlots,
      canSpawn: () => true,
      emitSpawn: (task) => spawned.push(task),
      addTaskOptions: { ignoreTaskId },
    },
  };
}

const ENGINES = [
  ['evaluateTasks (spawnPriority0OnDemand)', generatorAdapter],
  ['dequeueNextTask (spawnDequeuePriority0OnDemand)', dequeueAdapter],
];

const appRequest = (overrides = {}) => ({
  id: 'req-1', taskType: 'code-quality', appId: 'acme', ...overrides
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isImprovementEnabled.mockReturnValue(true);
  mocks.loadState.mockResolvedValue({ stats: {} });
  mocks.withStateLock.mockImplementation(async (fn) => fn());
  mocks.loadSchedule.mockResolvedValue({ tasks: { 'code-quality': { enabled: true } } });
  mocks.getOnDemandRequests.mockResolvedValue([]);
  mocks.applyOnDemandRunResets.mockResolvedValue(true);
  mocks.getActiveApps.mockResolvedValue([APP]);
  mocks.addTask.mockResolvedValue({ id: 'persisted-1' });
  mocks.prepareManagedAppImprovementTask.mockResolvedValue({ task: { id: 'gen-1', priority: 'HIGH' }, pendingPerpetualDispatch: null });
  mocks.generateSelfImprovementTaskForType.mockResolvedValue({ id: 'self-1', priority: 'HIGH' });
  mocks.drainProgrammaticOnDemandRequests.mockResolvedValue(new Set());
  mocks.applyOnDemandConsent.mockImplementation((t) => t);
});

// ── The #6618 defect ────────────────────────────────────────────────────────
describe.each(ENGINES)('%s — a failing app registry defers, never clears', (_name, makeAdapter) => {
  beforeEach(() => {
    mocks.getOnDemandRequests.mockResolvedValue([appRequest()]);
    mocks.getActiveApps.mockRejectedValue(new Error('registry read failed'));
  });

  it('leaves the app-targeted request queued', async () => {
    const { adapter } = makeAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);
    // The pre-fix cos.js form (`catch(() => [])`) fell through to the
    // unknown-app branch and destroyed the user's Run Now here.
    expect(mocks.clearOnDemandRequest).not.toHaveBeenCalled();
  });

  it('emits no task and generates nothing', async () => {
    const { spawned, adapter } = makeAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);
    expect(spawned).toEqual([]);
    expect(mocks.prepareManagedAppImprovementTask).not.toHaveBeenCalled();
    expect(mocks.addTask).not.toHaveBeenCalled();
  });

  it('leaves the app-review marker untouched so nothing is stranded', async () => {
    const { adapter } = makeAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);
    expect(mocks.markAppReviewCooldown).not.toHaveBeenCalled();
    expect(mocks.bindAppReviewAgent).not.toHaveBeenCalled();
  });
});

describe.each(ENGINES)('%s — registry read cost', (_name, makeAdapter) => {
  it('reads the registry once per cycle, not once per request', async () => {
    mocks.getOnDemandRequests.mockResolvedValue([
      appRequest({ id: 'req-1' }), appRequest({ id: 'req-2' }), appRequest({ id: 'req-3' })
    ]);
    const { adapter } = makeAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);
    expect(mocks.getActiveApps).toHaveBeenCalledTimes(1);
  });

  it('does not read the registry at all when the queue is empty', async () => {
    const { adapter } = makeAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);
    expect(mocks.getActiveApps).not.toHaveBeenCalled();
  });

  it('an EMPTY registry still clears an app-targeted request as unknown', async () => {
    // The sentinel's other half: `[]` is a successful read of zero apps, which
    // genuinely means the named app is gone. Only `null` (a failed read) defers.
    mocks.getOnDemandRequests.mockResolvedValue([appRequest()]);
    mocks.getActiveApps.mockResolvedValue([]);
    const { spawned, adapter } = makeAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);
    expect(mocks.clearOnDemandRequest).toHaveBeenCalledWith('req-1');
    expect(spawned).toEqual([]);
  });
});

// ── The parity the deleted "Mirrors the sibling engine" comments asserted ────
describe.each(ENGINES)('%s — on-demand metadata stamp', (_name, makeAdapter) => {
  it('stamps onDemand + the request origin onto the task before addTask', async () => {
    mocks.getOnDemandRequests.mockResolvedValue([appRequest({ origin: 'refill' })]);
    const { spawned, adapter } = makeAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);

    expect(spawned).toHaveLength(1);
    expect(spawned[0].metadata).toMatchObject({ onDemand: true, onDemandOrigin: 'refill' });
    // Stamped BEFORE persistence, so the blocked-revive branch inherits it.
    expect(mocks.addTask.mock.calls[0][0].metadata).toMatchObject({ onDemand: true });
  });

  it('applies the Run Now consent before the admission check', async () => {
    mocks.getOnDemandRequests.mockResolvedValue([appRequest()]);
    const order = [];
    mocks.applyOnDemandConsent.mockImplementation((t) => { order.push('consent'); return t; });
    const { adapter } = makeAdapter();
    await drainOnDemandRequests({ state: STATE }, {
      ...adapter,
      canSpawn: () => { order.push('canSpawn'); return true; },
    });
    expect(order).toEqual(['consent', 'canSpawn']);
  });
});

describe.each(ENGINES)('%s — empty-result feedback', (_name, makeAdapter) => {
  it('reports an empty result for a user-initiated Run', async () => {
    mocks.getOnDemandRequests.mockResolvedValue([appRequest()]);
    mocks.prepareManagedAppImprovementTask.mockResolvedValue(null);
    mocks.applyOnDemandRunResets.mockResolvedValue(true);
    const { adapter } = makeAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);
    expect(mocks.emitOnDemandEmpty).toHaveBeenCalledTimes(1);
    expect(mocks.emitOnDemandEmpty.mock.calls[0][0]).toMatchObject({ targetApp: APP });
  });

  it('stays silent for an automated drain refill', async () => {
    // A converging overnight drain must not turn into a pile of toasts.
    mocks.getOnDemandRequests.mockResolvedValue([appRequest()]);
    mocks.prepareManagedAppImprovementTask.mockResolvedValue(null);
    mocks.applyOnDemandRunResets.mockResolvedValue(false);
    const { adapter } = makeAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);
    expect(mocks.emitOnDemandEmpty).not.toHaveBeenCalled();
  });

  it('resets the drain brakes only through applyOnDemandRunResets', async () => {
    mocks.getOnDemandRequests.mockResolvedValue([appRequest()]);
    const { adapter } = makeAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);
    expect(mocks.applyOnDemandRunResets).toHaveBeenCalledWith(expect.objectContaining({ id: 'req-1' }), 'acme');
  });
});

describe.each(ENGINES)('%s — blocked-duplicate revive (#2614)', (_name, makeAdapter) => {
  it('revives the blocked twin and emits it under the existing task id', async () => {
    mocks.getOnDemandRequests.mockResolvedValue([appRequest()]);
    mocks.addTask.mockResolvedValue({ id: 'blocked-7', duplicate: true, status: 'blocked' });
    const { spawned, adapter } = makeAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);

    expect(mocks.reviveBlockedTask).toHaveBeenCalledWith(
      'blocked-7',
      expect.objectContaining({ metadata: expect.objectContaining({ onDemand: true }) }),
      'internal',
      { suppressDequeue: true }
    );
    expect(spawned).toHaveLength(1);
    expect(spawned[0].id).toBe('blocked-7');
  });

  it('drops a non-blocked duplicate without reviving or emitting', async () => {
    mocks.getOnDemandRequests.mockResolvedValue([appRequest()]);
    mocks.addTask.mockResolvedValue({ id: 'dup-1', duplicate: true, status: 'pending' });
    const { spawned, adapter } = makeAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);
    expect(mocks.reviveBlockedTask).not.toHaveBeenCalled();
    expect(spawned).toEqual([]);
  });
});

// ── The dispatch-signature hand-off (#6871) ─────────────────────────────────
// prepareManagedAppImprovementTask returns the deferred perpetual-dispatch
// record ALONGSIDE the task instead of parking it in a WeakMap keyed on the
// task object — addTask's raw branch (cosTaskStore.js) re-wraps a multi-line
// description into a brand-new object, so the old identity-keyed record would
// silently miss unless the caller kept using the exact object the generator
// returned. These pin that the record travels through the return value
// regardless of which task-object variant addTask hands back.
describe.each(ENGINES)('%s — deferred perpetual-dispatch recording', (_name, makeAdapter) => {
  it('records the dispatch from the returned record even when addTask hands back a different task object', async () => {
    mocks.getOnDemandRequests.mockResolvedValue([appRequest()]);
    mocks.prepareManagedAppImprovementTask.mockResolvedValue({
      task: { id: 'gen-1', priority: 'HIGH' },
      pendingPerpetualDispatch: { taskType: 'code-quality', appId: 'acme', signature: 'sig-1' }
    });
    // Not === the task prepare returned — the normal shape of a multi-line
    // description surviving addTask's raw branch.
    mocks.addTask.mockResolvedValue({ id: 'gen-1', priority: 'HIGH', description: 'line one' });
    const { adapter } = makeAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);

    expect(mocks.recordDeferredPerpetualDispatch).toHaveBeenCalledWith(
      { taskType: 'code-quality', appId: 'acme', signature: 'sig-1' },
      expect.anything()
    );
  });

  it('also records on the blocked-duplicate revive branch', async () => {
    mocks.getOnDemandRequests.mockResolvedValue([appRequest()]);
    mocks.prepareManagedAppImprovementTask.mockResolvedValue({
      task: { id: 'gen-1', priority: 'HIGH' },
      pendingPerpetualDispatch: { taskType: 'code-quality', appId: 'acme', signature: 'sig-2' }
    });
    mocks.addTask.mockResolvedValue({ id: 'blocked-7', duplicate: true, status: 'blocked' });
    const { adapter } = makeAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);

    expect(mocks.recordDeferredPerpetualDispatch).toHaveBeenCalledWith(
      { taskType: 'code-quality', appId: 'acme', signature: 'sig-2' },
      expect.anything()
    );
  });

  it('records nothing for a non-blocked duplicate', async () => {
    mocks.getOnDemandRequests.mockResolvedValue([appRequest()]);
    mocks.prepareManagedAppImprovementTask.mockResolvedValue({
      task: { id: 'gen-1', priority: 'HIGH' },
      pendingPerpetualDispatch: { taskType: 'code-quality', appId: 'acme', signature: 'sig-3' }
    });
    mocks.addTask.mockResolvedValue({ id: 'dup-1', duplicate: true, status: 'pending' });
    const { adapter } = makeAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);

    expect(mocks.recordDeferredPerpetualDispatch).not.toHaveBeenCalled();
  });
});

describe.each(ENGINES)('%s — app-review marker discipline (#978)', (_name, makeAdapter) => {
  it('advances one app cooldown per cycle no matter how many requests name it', async () => {
    mocks.getOnDemandRequests.mockResolvedValue([
      appRequest({ id: 'req-1' }), appRequest({ id: 'req-2' })
    ]);
    const { adapter } = makeAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);
    expect(mocks.markAppReviewCooldown).toHaveBeenCalledTimes(1);
    expect(mocks.markAppReviewCooldown).toHaveBeenCalledWith('acme');
  });

  it('binds the active agent only once a task actually exists', async () => {
    mocks.getOnDemandRequests.mockResolvedValue([appRequest()]);
    mocks.prepareManagedAppImprovementTask.mockResolvedValue(null);
    const { adapter } = makeAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);
    // The cooldown still advanced — only the bind is deferred, so a null
    // generator result can't strand `activeAgentId`.
    expect(mocks.markAppReviewCooldown).toHaveBeenCalledTimes(1);
    expect(mocks.bindAppReviewAgent).not.toHaveBeenCalled();
  });
});

describe.each(ENGINES)('%s — skip gates', (_name, makeAdapter) => {
  it('drops the request when improvement is disabled', async () => {
    mocks.getOnDemandRequests.mockResolvedValue([appRequest()]);
    mocks.isImprovementEnabled.mockReturnValue(false);
    const { spawned, adapter } = makeAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);
    expect(mocks.clearOnDemandRequest).toHaveBeenCalledWith('req-1');
    expect(spawned).toEqual([]);
  });

  it('drops an automated refill when its task type was disabled after queuing', async () => {
    mocks.getOnDemandRequests.mockResolvedValue([appRequest({ origin: 'refill' })]);
    mocks.loadSchedule.mockResolvedValue({ tasks: { 'code-quality': { enabled: false } } });
    const { spawned, adapter } = makeAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);
    expect(mocks.clearOnDemandRequest).toHaveBeenCalledWith('req-1');
    expect(spawned).toEqual([]);
  });

  it('skips a request the programmatic drain already handled', async () => {
    mocks.getOnDemandRequests.mockResolvedValue([appRequest()]);
    mocks.drainProgrammaticOnDemandRequests.mockResolvedValue(new Set(['req-1']));
    const { spawned, adapter } = makeAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);
    expect(mocks.clearOnDemandRequest).not.toHaveBeenCalled();
    expect(spawned).toEqual([]);
  });

  it('stops draining once the adapter reports capacity exhausted', async () => {
    mocks.getOnDemandRequests.mockResolvedValue([
      appRequest({ id: 'req-1' }), appRequest({ id: 'req-2' })
    ]);
    const { spawned, adapter } = makeAdapter({ availableSlots: 1 });
    await drainOnDemandRequests({ state: STATE }, adapter);
    expect(spawned).toHaveLength(1);
    expect(mocks.clearOnDemandRequest).toHaveBeenCalledTimes(1);
  });

  it('routes an app-less request through the self-improvement generator', async () => {
    mocks.getOnDemandRequests.mockResolvedValue([appRequest({ appId: null })]);
    const { spawned, adapter } = makeAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);
    expect(mocks.generateSelfImprovementTaskForType).toHaveBeenCalledWith('code-quality', STATE);
    expect(mocks.markAppReviewCooldown).not.toHaveBeenCalled();
    expect(spawned).toHaveLength(1);
  });
});

// ── The three real differences the adapters own ─────────────────────────────
describe('the per-engine adapter differences', () => {
  beforeEach(() => {
    mocks.getOnDemandRequests.mockResolvedValue([appRequest()]);
  });

  it('the dequeue engine forwards ignoreTaskId so a completion re-issue is dedup-safe', async () => {
    const { adapter } = dequeueAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);
    expect(mocks.addTask).toHaveBeenCalledWith(
      expect.anything(), 'internal',
      { raw: true, ignoreTaskId: 'completing-task', suppressDequeue: true }
    );
  });

  it('the generator engine sends no ignoreTaskId — it has no completing task to exclude', async () => {
    const { adapter } = generatorAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);
    expect(mocks.addTask).toHaveBeenCalledWith(
      expect.anything(), 'internal', { raw: true, suppressDequeue: true }
    );
  });

  it('a denied admission discards nothing else — the request stays cleared and no task is emitted', async () => {
    // Priority 0 is a COMMITTED tier: `canSpawn` returning false is the
    // destructive case cosDequeue's `canSpawnCommitted` exists to avoid, so the
    // engines never pass a capacity predicate that can deny here. Pin the shape
    // anyway so the shared loop's behavior under a denial is not a surprise.
    const { spawned, adapter } = generatorAdapter();
    await drainOnDemandRequests({ state: STATE }, { ...adapter, canSpawn: () => false });
    expect(spawned).toEqual([]);
    expect(mocks.addTask).not.toHaveBeenCalled();
    expect(mocks.emitOnDemandEmpty).not.toHaveBeenCalled();
  });

  it('returns the loaded schedule so a caller reuses it instead of loading twice', async () => {
    const schedule = { tasks: { 'code-quality': { enabled: true } } };
    mocks.loadSchedule.mockResolvedValue(schedule);
    const { adapter } = dequeueAdapter();
    const result = await drainOnDemandRequests({ state: STATE }, adapter);
    expect(result.schedule).toBe(schedule);
    expect(mocks.loadSchedule).toHaveBeenCalledTimes(1);
  });

  it('returns the schedule even when the registry read defers the whole cycle', async () => {
    mocks.getActiveApps.mockRejectedValue(new Error('registry read failed'));
    const { adapter } = dequeueAdapter();
    const result = await drainOnDemandRequests({ state: STATE }, adapter);
    expect(result.schedule).toEqual({ tasks: { 'code-quality': { enabled: true } } });
  });
});


describe('schedule disablement at dispatch', () => {
  it.each([
    [{}, true],
    [{ origin: 'quota-burn', burn: { family: 'grok', stepId: 'step-1', maintenanceRunId: 'manual-1' } }, true],
    [{ origin: 'quota-burn', burn: { family: 'grok', stepId: 'step-1' } }, false],
    [{ origin: 'refill' }, false],
  ])('dispatches only explicit runs: %j', async (provenance, shouldSpawn) => {
    mocks.loadSchedule.mockResolvedValue({ tasks: { 'code-quality': { enabled: false } } });
    mocks.getOnDemandRequests.mockResolvedValue([appRequest(provenance)]);
    const { adapter, spawned } = generatorAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);
    expect(spawned).toHaveLength(shouldSpawn ? 1 : 0);
  });
});
