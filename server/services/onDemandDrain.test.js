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
  clearOnDemandRequest: vi.fn(),
  applyOnDemandRunResets: vi.fn(async () => true),
  recordExecution: vi.fn(async () => {}),
  prepareManagedAppImprovementTask: vi.fn(async () => ({ task: { id: 'gen-1', priority: 'HIGH' }, pendingPerpetualDispatch: null, skip: null })),
  generateSelfImprovementTaskForType: vi.fn(async () => ({ id: 'self-1', priority: 'HIGH' })),
  recordDeferredPerpetualDispatch: vi.fn(async () => {}),
  applyOnDemandConsent: vi.fn((t) => t),
  drainProgrammaticOnDemandRequests: vi.fn(async () => new Set()),
  emitOnDemandEmpty: vi.fn(async () => {}),
  startPreflightCard: vi.fn(async () => {}),
  recordPreflightOutcome: vi.fn(async () => null),
  reportPreflightStep: vi.fn(async () => {}),
  finishPreflightCard: vi.fn(async () => null),
  finishPreflightDispatch: vi.fn(async () => null),
}));

vi.mock('./onDemandHandoff.js', () => ({
  reconcileOnDemandHandoffs: vi.fn(async () => {}),
  claimOnDemandRequest: vi.fn(async (id) => { const request = await mocks.clearOnDemandRequest(id); return request ? { request, token: id } : null; }),
  settleOnDemandRequest: vi.fn(async () => true),
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
// Only the card's I/O is doubled. `cardIdForRequest` keeps the REAL origin
// policy (`isUserOriginRequest` is a pure leaf), so the 'opens no card for an
// automated origin' tests below still exercise the decision, not a stub of it.
vi.mock('./preflightTaskCard.js', async () => {
  const { isUserOriginRequest } = await vi.importActual('./taskScheduleConstants.js');
  return {
    preflightCardId: (requestId) => `preflight-${requestId}`,
    cardIdForRequest: (request) => (isUserOriginRequest(request) ? `preflight-${request.id}` : null),
    startPreflightCard: (...a) => mocks.startPreflightCard(...a),
    recordPreflightOutcome: (...a) => mocks.recordPreflightOutcome(...a),
    reportPreflightStep: (...a) => mocks.reportPreflightStep(...a),
    finishPreflightCard: (...a) => mocks.finishPreflightCard(...a),
    finishPreflightDispatch: (...a) => mocks.finishPreflightDispatch(...a),
  };
});
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
function generatorAdapter({ availableSlots = 5, projectCapacityExhausted = () => false } = {}) {
  const tasksToSpawn = [];
  return {
    spawned: tasksToSpawn,
    adapter: {
      capacityExhausted: () => tasksToSpawn.length >= availableSlots,
      projectCapacityExhausted,
      canSpawn: () => true,
      emitSpawn: (task) => tasksToSpawn.push(task),
    },
  };
}

function dequeueAdapter({ availableSlots = 5, ignoreTaskId = 'completing-task', projectCapacityExhausted = () => false } = {}) {
  const spawned = [];
  return {
    spawned,
    adapter: {
      capacityExhausted: () => spawned.length >= availableSlots,
      projectCapacityExhausted,
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
  mocks.clearOnDemandRequest.mockImplementation(async (id) =>
    (await mocks.getOnDemandRequests()).find(request => request.id === id) ?? null);
  mocks.applyOnDemandRunResets.mockResolvedValue(true);
  mocks.getActiveApps.mockResolvedValue([APP]);
  mocks.addTask.mockResolvedValue({ id: 'persisted-1' });
  mocks.prepareManagedAppImprovementTask.mockResolvedValue({ task: { id: 'gen-1', priority: 'HIGH' }, pendingPerpetualDispatch: null, skip: null });
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
    mocks.prepareManagedAppImprovementTask.mockResolvedValue({ task: null, pendingPerpetualDispatch: null, skip: { gate: 'security-preflight', reason: 'no-external-open-prs', cli: null, remedy: null, detail: null } });
    mocks.applyOnDemandRunResets.mockResolvedValue(true);
    const { adapter } = makeAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);
    expect(mocks.emitOnDemandEmpty).toHaveBeenCalledTimes(1);
    // The skip is handed over explicitly — no side channel to read back later.
    expect(mocks.emitOnDemandEmpty.mock.calls[0][0]).toMatchObject({ targetApp: APP, skip: { gate: 'security-preflight', reason: 'no-external-open-prs' } });
  });

  it('stays silent for an automated drain refill', async () => {
    // A converging overnight drain must not turn into a pile of toasts.
    mocks.getOnDemandRequests.mockResolvedValue([appRequest()]);
    mocks.prepareManagedAppImprovementTask.mockResolvedValue({ task: null, pendingPerpetualDispatch: null, skip: { gate: 'security-preflight', reason: 'no-external-open-prs', cli: null, remedy: null, detail: null } });
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

describe.each(ENGINES)('%s — per-project capacity defers before preparation', (_name, makeAdapter) => {
  it('keeps a full app request queued and its visible card open', async () => {
    mocks.getOnDemandRequests.mockResolvedValue([appRequest()]);
    const { spawned, adapter } = makeAdapter({ projectCapacityExhausted: appId => appId === 'acme' });

    await drainOnDemandRequests({ state: STATE }, adapter);

    expect(mocks.startPreflightCard).toHaveBeenCalledTimes(1);
    expect(mocks.clearOnDemandRequest).not.toHaveBeenCalled();
    expect(mocks.prepareManagedAppImprovementTask).not.toHaveBeenCalled();
    expect(mocks.finishPreflightDispatch).not.toHaveBeenCalled();
    expect(spawned).toEqual([]);
  });

  it('continues to other apps while retaining the full app request', async () => {
    const otherApp = { id: 'other', name: 'Other App' };
    mocks.getOnDemandRequests.mockResolvedValue([
      appRequest({ id: 'req-full' }),
      appRequest({ id: 'req-ready', appId: otherApp.id }),
    ]);
    mocks.getActiveApps.mockResolvedValue([APP, otherApp]);
    mocks.prepareManagedAppImprovementTask.mockImplementation(async (_type, app) => ({
      task: { id: `gen-${app.id}`, priority: 'HIGH', metadata: { app: app.id } },
      pendingPerpetualDispatch: null,
    }));
    const { spawned, adapter } = makeAdapter({ projectCapacityExhausted: appId => appId === 'acme' });

    await drainOnDemandRequests({ state: STATE }, adapter);

    expect(mocks.clearOnDemandRequest).toHaveBeenCalledTimes(1);
    expect(mocks.clearOnDemandRequest).toHaveBeenCalledWith('req-ready');
    expect(mocks.prepareManagedAppImprovementTask).toHaveBeenCalledTimes(1);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].id).toBe(`gen-${otherApp.id}`);
  });
});

describe.each(ENGINES)('%s — blocked-duplicate revive (#2614)', (_name, makeAdapter) => {
  it('dispatches a Deep resume with the persisted audit text and retained-worktree pointer', async () => {
    mocks.getOnDemandRequests.mockResolvedValue([appRequest()]);
    mocks.prepareManagedAppImprovementTask.mockResolvedValue({ task: { id: 'fresh', description: 'New volatile preload', metadata: { app: APP.id, auditDepth: 'deep' } } });
    mocks.addTask.mockResolvedValue({ id: 'blocked-deep', duplicate: true, status: 'blocked' });
    const stored = { id: 'blocked-deep', status: 'pending', description: 'Original audit instructions', metadata: { auditDepth: 'deep', existingBranch: 'cos/retained', resumeWorktreePath: '/fixture/tree' } };
    mocks.reviveBlockedTask.mockResolvedValueOnce(stored);
    const { spawned, adapter } = makeAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);
    expect(spawned).toEqual([stored]);
  });

  it('does not emit a spawn when revival was refused', async () => {
    mocks.getOnDemandRequests.mockResolvedValue([appRequest()]);
    mocks.addTask.mockResolvedValue({ id: 'blocked-7', duplicate: true, status: 'blocked' });
    mocks.reviveBlockedTask.mockResolvedValueOnce({ error: 'Cleanup remains active' });
    const { spawned, adapter } = makeAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);
    expect(spawned).toEqual([]);
  });

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
    mocks.prepareManagedAppImprovementTask.mockResolvedValue({ task: null, pendingPerpetualDispatch: null, skip: { gate: 'security-preflight', reason: 'no-external-open-prs', cli: null, remedy: null, detail: null } });
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

/**
 * The programmatic-phase card (#7258). A "Run Now" used to put nothing on the
 * Tasks page until an agent task existed — which for a task type with a real
 * preflight (pr-reviewer screens every contributor diff for hidden Unicode and
 * prompt injection first) is a minute or more later, so the click read as a
 * no-op. The card is opened here, advanced by the preflight, and closed on
 * every exit from the loop.
 */
describe('preflight task card', () => {
  it('opens a card for a human Run before the capacity check, so a waiting Run is still visible', async () => {
    mocks.getOnDemandRequests.mockResolvedValue([appRequest({ targetPullRequest: 42 })]);
    const { adapter } = generatorAdapter({ availableSlots: 0 });
    await drainOnDemandRequests({ state: STATE }, adapter);
    expect(mocks.startPreflightCard).toHaveBeenCalledWith({
      requestId: 'req-1', taskType: 'code-quality', appId: 'acme', appName: 'Acme App', targetPullRequest: 42,
    });
  });

  it.each([['refill'], ['quota-burn']])('opens no card for the automated origin %s', async (origin) => {
    mocks.getOnDemandRequests.mockResolvedValue([appRequest({ origin })]);
    const { adapter } = generatorAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);
    expect(mocks.startPreflightCard).not.toHaveBeenCalled();
    // No card means no card id either: every report and close site short-circuits
    // on null rather than reading the task file to discover there is nothing there.
    expect(mocks.prepareManagedAppImprovementTask).toHaveBeenCalledWith(
      'code-quality', APP, STATE, expect.objectContaining({ preflightCardId: null }),
    );
    expect(mocks.finishPreflightCard).not.toHaveBeenCalledWith(expect.stringContaining('preflight-'), expect.anything());
  });

  it('hands the card to the generator so the preflight reports into the card the user is watching', async () => {
    mocks.getOnDemandRequests.mockResolvedValue([appRequest()]);
    const { adapter } = generatorAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);
    expect(mocks.prepareManagedAppImprovementTask).toHaveBeenCalledWith(
      'code-quality', APP, STATE, expect.objectContaining({ preflightCardId: 'preflight-req-1' }),
    );
  });

  it('closes the card against the persisted task id once an agent task exists', async () => {
    mocks.getOnDemandRequests.mockResolvedValue([appRequest()]);
    const { adapter } = generatorAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);
    expect(mocks.finishPreflightDispatch).toHaveBeenCalledWith('preflight-req-1', 'persisted-1');
  });

  it.each([
    ['improvement disabled', () => mocks.isImprovementEnabled.mockReturnValue(false), 'improvement-disabled'],
    ['task type disabled', () => mocks.loadSchedule.mockResolvedValue({ tasks: {} }), 'task-type-disabled'],
    ['unknown app', () => mocks.getActiveApps.mockResolvedValue([]), 'app-unknown'],
  ])('closes the card with a reason when the run is dropped: %s', async (_label, arrange, reason) => {
    arrange();
    mocks.getOnDemandRequests.mockResolvedValue([appRequest()]);
    const { adapter } = generatorAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);
    expect(mocks.finishPreflightCard).toHaveBeenCalledWith('preflight-req-1', expect.objectContaining({
      outcome: 'failed', reason,
    }));
  });

  it('closes a card whose request a programmatic handler satisfied without any agent', async () => {
    mocks.getOnDemandRequests.mockResolvedValue([appRequest()]);
    mocks.drainProgrammaticOnDemandRequests.mockResolvedValue(new Set(['req-1']));
    const { adapter } = generatorAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);
    expect(mocks.finishPreflightCard).toHaveBeenCalledWith('preflight-req-1', { outcome: 'programmatic' });
    expect(mocks.startPreflightCard).not.toHaveBeenCalled();
  });

  it('leaves no card open when the run produces nothing', async () => {
    mocks.getOnDemandRequests.mockResolvedValue([appRequest()]);
    mocks.prepareManagedAppImprovementTask.mockResolvedValue({ task: null, pendingPerpetualDispatch: null, skip: null });
    const { adapter } = generatorAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);
    // emitOnDemandEmpty owns the specific reason; this is the backstop close.
    expect(mocks.emitOnDemandEmpty).toHaveBeenCalledWith(expect.objectContaining({ preflightCardId: 'preflight-req-1' }));
    expect(mocks.finishPreflightDispatch).toHaveBeenCalledWith('preflight-req-1');
  });
});


describe('atomic on-demand preparation ownership', () => {
  it.each([0, 1])('prepares once when engine %i wins overlapping snapshots', async (winner) => {
    const receipt = appRequest();
    const queue = [receipt];
    const firstClaimReady = Promise.withResolvers();
    const claimsReady = Promise.withResolvers();
    const claims = [Promise.withResolvers(), Promise.withResolvers()];
    const preparationEntered = Promise.withResolvers();
    const preparationRelease = Promise.withResolvers();
    let claimCount = 0;
    mocks.getOnDemandRequests.mockResolvedValue([receipt]);
    mocks.clearOnDemandRequest.mockImplementation(async () => {
      const index = claimCount++;
      if (claimCount === 1) firstClaimReady.resolve();
      if (claimCount === 2) claimsReady.resolve();
      await claims[index].promise;
      return queue.shift() ?? null;
    });
    mocks.prepareManagedAppImprovementTask.mockImplementation(async () => {
      preparationEntered.resolve();
      await preparationRelease.promise;
      return { task: { id: 'winner-task' }, pendingPerpetualDispatch: null };
    });
    const engines = [generatorAdapter(), dequeueAdapter()];
    const drains = [drainOnDemandRequests({ state: STATE }, engines[0].adapter)];
    await firstClaimReady.promise;
    drains.push(drainOnDemandRequests({ state: STATE }, engines[1].adapter));
    await claimsReady.promise;
    claims[winner].resolve();
    await preparationEntered.promise;
    claims[1 - winner].resolve();
    await drains[1 - winner];

    // A late loser must not close or reset a card while the winner is working.
    expect(mocks.prepareManagedAppImprovementTask).toHaveBeenCalledTimes(1);
    expect(mocks.applyOnDemandRunResets).toHaveBeenCalledTimes(1);
    expect(mocks.recordExecution).toHaveBeenCalledTimes(1);
    expect(mocks.startPreflightCard).toHaveBeenCalledTimes(1);
    expect(mocks.reportPreflightStep).toHaveBeenCalledTimes(1);
    expect(mocks.finishPreflightCard).not.toHaveBeenCalled();
    expect(mocks.finishPreflightDispatch).not.toHaveBeenCalled();

    preparationRelease.resolve();
    await Promise.all(drains);
    expect(mocks.addTask).toHaveBeenCalledTimes(1);
    expect(engines[winner].spawned).toHaveLength(1);
    expect(engines[1 - winner].spawned).toEqual([]);
    expect(queue).toEqual([]);
  });

  it('does not prepare install-wide work cancelled after the snapshot', async () => {
    mocks.getOnDemandRequests.mockResolvedValue([appRequest({ appId: null })]);
    mocks.clearOnDemandRequest.mockResolvedValue(null);
    await drainOnDemandRequests({ state: STATE }, generatorAdapter().adapter);
    expect(mocks.generateSelfImprovementTaskForType).not.toHaveBeenCalled();
    expect(mocks.applyOnDemandRunResets).not.toHaveBeenCalled();
    expect(mocks.recordExecution).not.toHaveBeenCalled();
    expect(mocks.startPreflightCard).not.toHaveBeenCalled();
    expect(mocks.finishPreflightDispatch).not.toHaveBeenCalled();
    expect(mocks.saveState).not.toHaveBeenCalled();
  });

  it("does not fail another owner's card when a stale snapshot hits a drop gate", async () => {
    mocks.getOnDemandRequests.mockResolvedValue([appRequest()]);
    mocks.isImprovementEnabled.mockReturnValue(false);
    mocks.clearOnDemandRequest.mockResolvedValue(null);
    await drainOnDemandRequests({ state: STATE }, generatorAdapter().adapter);
    expect(mocks.startPreflightCard).not.toHaveBeenCalled();
    expect(mocks.finishPreflightCard).not.toHaveBeenCalled();
  });

  it('dispatches the claimed receipt with its scope and overrides', async () => {
    const claimed = appRequest({
      targetPullRequest: { number: 42, repo: 'example/repo' }, origin: 'user',
      providerOverride: { provider: 'example-provider', model: 'example-model' },
      burn: { overrides: { params: { mode: 'example-mode' } } },
    });
    mocks.getOnDemandRequests.mockResolvedValue([appRequest()]);
    mocks.clearOnDemandRequest.mockResolvedValue(claimed);
    await drainOnDemandRequests({ state: STATE }, generatorAdapter().adapter);
    expect(mocks.applyOnDemandRunResets).toHaveBeenCalledWith(claimed, APP.id);
    expect(mocks.prepareManagedAppImprovementTask).toHaveBeenCalledWith('code-quality', APP, STATE,
      expect.objectContaining({
        targetPullRequest: claimed.targetPullRequest, providerOverride: claimed.providerOverride,
        runOverrides: { mode: 'example-mode' },
      }));
    expect(mocks.addTask.mock.calls[0][0].metadata.onDemandOrigin).toBe('user');
    expect(mocks.startPreflightCard).toHaveBeenCalledWith(expect.objectContaining({
      targetPullRequest: claimed.targetPullRequest,
    }));
  });
});

it('settles burn preparation failures and successful task persistence without leaving a live claim', async () => {
  const { settleOnDemandRequest } = await import('./onDemandHandoff.js');
  mocks.getOnDemandRequests.mockResolvedValue([appRequest({ origin: 'quota-burn', burn: { family: 'codex', stepId: 'step' } })]);
  mocks.prepareManagedAppImprovementTask.mockRejectedValueOnce(new Error('preparation failed'));
  const { adapter } = generatorAdapter({});
  await expect(drainOnDemandRequests({ state: STATE }, adapter)).rejects.toThrow('preparation failed');
  expect(settleOnDemandRequest).toHaveBeenLastCalledWith(expect.objectContaining({ request: expect.objectContaining({ id: 'req-1' }) }), { taskId: null, reason: 'Request preparation failed; resume explicitly.' });
  await drainOnDemandRequests({ state: STATE }, adapter);
  expect(settleOnDemandRequest).toHaveBeenLastCalledWith(expect.anything(), { taskId: 'persisted-1', reason: null });
});


it('refuses an unrelated active duplicate instead of claiming its delivery', async () => {
  const { settleOnDemandRequest } = await import('./onDemandHandoff.js');
  mocks.getOnDemandRequests.mockResolvedValue([appRequest({ origin: 'quota-burn', burn: { family: 'codex', stepId: 'step' } })]);
  mocks.addTask.mockResolvedValue({ id: 'other-task', duplicate: true, status: 'in_progress', metadata: { quotaBurnRequestId: 'other-request' } });
  const { adapter, spawned } = generatorAdapter({});
  await drainOnDemandRequests({ state: STATE }, adapter);
  expect(spawned).toEqual([]);
  expect(settleOnDemandRequest).toHaveBeenLastCalledWith(expect.anything(), { taskId: null, reason: 'Request produced no task; resume explicitly.' });
});


describe.each(ENGINES)('%s — historical queued Deep compatibility', (_name, makeAdapter) => {
  it('durably refuses a saved legacy invocation before preparation without changing its evidence', async () => {
    const request = appRequest({ origin: 'quota-burn', burn: { family: 'codex', stepId: 'old-step', overrides: { params: { auditDepth: 'deep', deepAuditId: 'retained-ledger' } } } });
    const saved = JSON.stringify(request);
    mocks.getOnDemandRequests.mockResolvedValue([request]);
    const { adapter, spawned } = makeAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);
    expect(mocks.prepareManagedAppImprovementTask).not.toHaveBeenCalled();
    expect(mocks.generateSelfImprovementTaskForType).not.toHaveBeenCalled();
    expect(mocks.addTask).not.toHaveBeenCalled();
    expect(mocks.applyOnDemandRunResets).not.toHaveBeenCalled();
    expect(spawned).toEqual([]);
    expect((await import('./onDemandHandoff.js')).settleOnDemandRequest).toHaveBeenCalledWith(expect.objectContaining({ request }), { taskId: null, reason: 'Historical Deep requests are read-only; start a new Deep audit.' });
    expect(JSON.stringify(request)).toBe(saved);
  });
  it('dispatches an explicitly marked new extended request', async () => {
    mocks.getOnDemandRequests.mockResolvedValue([appRequest({ origin: 'quota-burn', burn: { family: 'codex', stepId: 'new-step', overrides: { params: { auditDepth: 'deep', auditWorkflow: 'extended-v1' } } } })]);
    const { adapter, spawned } = makeAdapter();
    await drainOnDemandRequests({ state: STATE }, adapter);
    expect(mocks.prepareManagedAppImprovementTask).toHaveBeenCalledOnce();
    expect(spawned).toHaveLength(1);
  });
});
