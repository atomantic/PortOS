import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultPersistentMindState, PERSISTENT_MIND_LIMITS } from '../lib/persistentMind.js';
import {
  __resetCosAdmissionReservations,
  acquireCosActionReservation,
  acquireCosGlobalSlot,
} from './cosAdmissionReservations.js';

const mock = vi.hoisted(() => ({
  root: null,
  scheduled: new Map(),
  emitted: [],
  budget: { withinBudget: true, exceeded: null },
  recordUsage: vi.fn(async () => {}),
  acquireSlot: vi.fn(async () => ({ ok: true, release: vi.fn() })),
  appendMindEvent: vi.fn(async (event) => ({ appended: true, event })),
  prepareContext: vi.fn(async () => ({ text: 'bounded context', chars: 15, summaryState: 'not-needed' })),
  updateInProgress: false,
  daemonRunning: true,
  profile: {
    ok: true,
    provider: { id: 'example-cloud' },
    model: 'example-model',
    effort: 'high',
    thinkingInterface: 'text',
  },
  imageCapability: { status: 'supported', reason: 'Supported.' },
  thinkingSession: null,
}));

vi.mock('./cosState.js', () => ({
  loadState: vi.fn(async () => mock.root),
  saveState: vi.fn(async (state) => { mock.root = state; }),
  withStateLock: vi.fn(async (fn) => fn()),
  isDaemonRunning: vi.fn(() => mock.daemonRunning),
}));

vi.mock('./cosEvents.js', () => ({
  cosEvents: { emit: vi.fn((...args) => mock.emitted.push(args)) },
  emitLog: vi.fn(),
}));

vi.mock('./eventScheduler.js', () => ({
  schedule: vi.fn((config) => {
    mock.scheduled.set(config.id, config);
    return config;
  }),
  cancel: vi.fn((id) => mock.scheduled.delete(id)),
}));

vi.mock('./domainUsage.js', () => ({
  getDomainBudgetStatus: vi.fn(async () => mock.budget),
  recordDomainUsage: (...args) => mock.recordUsage(...args),
}));

vi.mock('./cosLocalEndpointSlots.js', () => ({
  acquireLocalEndpointProviderSlot: (...args) => mock.acquireSlot(...args),
}));

vi.mock('./agentRunEventLog.js', () => ({
  appendMindEvent: (...args) => mock.appendMindEvent(...args),
}));

vi.mock('./persistentMindContext.js', () => ({
  preparePersistentMindContext: (...args) => mock.prepareContext(...args),
}));

vi.mock('./persistentMindProfile.js', () => ({
  resolvePersistentMindProfile: vi.fn(async () => mock.profile),
  resolvePersistentMindThinkingSession: vi.fn(async () => mock.thinkingSession),
}));
vi.mock('./providers.js', () => ({ getProviderById: vi.fn(async () => mock.profile.provider) }));
vi.mock('./persistentMindImageCapability.js', () => ({
  resolvePersistentMindImageCapability: vi.fn(async () => mock.imageCapability),
  imageCapabilityAllowsAttempt: (capability, provider) => capability?.status === 'supported'
    || (capability?.status === 'unknown' && provider?.type === 'api'),
}));

vi.mock('./updateChecker.js', () => ({
  isUpdateInProgress: vi.fn(() => mock.updateInProgress),
}));

const supervisor = await import('./persistentMindSupervisor.js');

const makeRoot = () => ({
  paused: false,
  config: {
    domainAutonomy: { cos: 'execute' },
    maxConcurrentAgents: 3,
    persistentMindProfile: { enabled: true, providerId: 'example-cloud', model: 'example-model', effort: 'high', thinkingInterface: 'text' },
  },
  agents: {},
  persistentMind: createDefaultPersistentMindState(),
});

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('persistent mind supervisor', () => {
  beforeEach(() => {
    mock.root = makeRoot();
    mock.scheduled.clear();
    mock.emitted.length = 0;
    mock.budget = { withinBudget: true, exceeded: null };
    mock.daemonRunning = true;
    mock.updateInProgress = false;
    mock.recordUsage.mockClear();
    mock.profile = {
      ok: true,
      provider: { id: 'example-cloud', type: 'api' },
      model: 'example-model',
      effort: 'high',
      thinkingInterface: 'text',
    };
    mock.imageCapability = { status: 'supported', reason: 'Supported.' };
    mock.thinkingSession = {
      ok: true,
      temporary: true,
      presetId: 'deep',
      presetLabel: 'Deep pass',
      provider: { id: 'example-alt', type: 'api' },
      model: 'alt-model',
      effort: 'max',
      thinkingInterface: 'text',
    };
    mock.acquireSlot.mockReset();
    mock.acquireSlot.mockResolvedValue({ ok: true, release: vi.fn() });
    mock.appendMindEvent.mockClear();
    mock.prepareContext.mockClear();
    __resetCosAdmissionReservations();
    supervisor.__resetPersistentMindSupervisorForTests();
  });

  it('is silent on boot and enables the runtime only when explicitly started', async () => {
    const prepare = vi.fn();
    const run = vi.fn();
    await supervisor.registerPersistentMindTurnAdapter({ prepare, run });

    await supervisor.initializePersistentMindSupervisor();
    expect(mock.scheduled.size).toBe(0);
    expect(await supervisor.startPersistentMind()).toEqual({ success: true, alreadyStarted: false });
    expect(mock.root.persistentMind).toMatchObject({ enabled: true, started: true, status: 'waiting' });
    expect(prepare).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('parks an explicitly started mind instead of spinning when no provider adapter is registered', async () => {
    await supervisor.setPersistentMindEnabled(true);
    await supervisor.startPersistentMind();
    await supervisor.drainPersistentMind();

    expect(mock.root.persistentMind.status).toBe('degraded');
    expect(mock.root.persistentMind.pauseReason).toBe('Persistent mind provider is not configured');
    expect(Date.parse(mock.root.persistentMind.nextEligibleWakeAt)).toBeGreaterThan(Date.now());
    expect(mock.scheduled.get(supervisor.PERSISTENT_MIND_WAKE_EVENT_ID).delayMs).toBeGreaterThan(1_000);
  });

  it('accepts a message durably, deduplicates retries, and runs only one turn', async () => {
    const pending = deferred();
    const prepare = vi.fn(async () => ({ ok: true, provider: { id: 'example-cloud' }, model: 'example-model', effort: 'high' }));
    const run = vi.fn(() => pending.promise);
    await supervisor.registerPersistentMindTurnAdapter({ prepare, run });
    await supervisor.setPersistentMindEnabled(true);
    await supervisor.startPersistentMind();

    expect(await supervisor.enqueuePersistentMindMessage({ id: 'message-1', text: 'Please review this.' }))
      .toEqual({ success: true, duplicate: false, messageId: 'message-1' });
    expect(await supervisor.enqueuePersistentMindMessage({ id: 'message-1', text: 'Please review this.' }))
      .toEqual({ success: true, duplicate: true, messageId: 'message-1' });

    const firstDrain = supervisor.drainPersistentMind();
    const secondDrain = supervisor.drainPersistentMind();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run.mock.calls[0][0].wake).toMatchObject({ kind: 'message', message: { id: 'message-1' } });
    pending.resolve({});
    await Promise.all([firstDrain, secondDrain]);

    expect(mock.prepareContext).toHaveBeenCalledWith(expect.objectContaining({
      mindId: 'cos-persistent-mind',
      providerId: 'example-cloud',
      model: 'example-model',
    }));
    expect(run.mock.calls[0][0].context).toMatchObject({ text: 'bounded context', summaryState: 'not-needed' });
    expect(mock.appendMindEvent.mock.calls.map(([event]) => event.kind)).toEqual(expect.arrayContaining([
      'mind.message.accepted',
      'mind.wake',
      'mind.model.request',
      'mind.model.result',
      'mind.turn.completed',
    ]));

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      profile: expect.objectContaining({ provider: expect.objectContaining({ id: 'example-cloud' }), model: 'example-model', effort: 'high' }),
    }));
    expect(mock.acquireSlot).toHaveBeenCalledTimes(1);
    expect(mock.root.persistentMind.activeTurn).toBeNull();
    expect(mock.root.persistentMind.recentMessageIds).toContain('message-1');
    expect(mock.root.persistentMind.recentMessageFingerprints).toEqual([
      { id: 'message-1', fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ]);
    expect(await supervisor.enqueuePersistentMindMessage({ id: 'message-1', text: 'Changed after completion.' }))
      .toMatchObject({ success: false, code: 'IDEMPOTENCY_CONFLICT', status: 409 });
    expect(mock.recordUsage).toHaveBeenCalledWith('cos', expect.objectContaining({ actions: 1 }));
  });

  it('caps model-requested follow-ups at the saved maximum quiet period', async () => {
    mock.root.config.persistentMindProfile.wakeIntervalMinutes = 15;
    await supervisor.registerPersistentMindTurnAdapter({
      prepare: vi.fn(async () => ({ ok: true, provider: { id: 'example-cloud' } })),
      run: vi.fn(async () => ({
        selfWake: {
          reason: 'Check again later',
          notBefore: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
        },
      })),
    });
    await supervisor.setPersistentMindEnabled(true);
    await supervisor.startPersistentMind();
    await supervisor.drainPersistentMind();

    const { lastCompletedAt, selfWake } = mock.root.persistentMind;
    expect(selfWake.reason).toBe('Check again later');
    expect(selfWake.scheduleKind).toBe('requested');
    expect(Date.parse(selfWake.notBefore) - Date.parse(lastCompletedAt)).toBe(15 * 60_000);
  });

  it('re-arms an idle automatic wake when its saved cadence changes', async () => {
    const lastCompletedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    mock.root.persistentMind = {
      ...createDefaultPersistentMindState(),
      enabled: true,
      started: true,
      status: 'idle',
      lastCompletedTurnId: 'turn-1',
      lastCompletedAt,
      selfWake: {
        id: 'wake-old',
        kind: 'self',
        scheduleKind: 'quiet',
        reason: 'maximum quiet period elapsed',
        sourceTurnId: 'turn-1',
        createdAt: lastCompletedAt,
        notBefore: new Date(Date.parse(lastCompletedAt) + 30 * 60_000).toISOString(),
      },
    };
    mock.root.config.persistentMindProfile.wakeIntervalMinutes = 60;

    await supervisor.refreshPersistentMindWakeCadence();

    expect(Date.parse(mock.root.persistentMind.selfWake.notBefore) - Date.parse(lastCompletedAt)).toBe(60 * 60_000);
    expect(mock.scheduled.get(supervisor.PERSISTENT_MIND_WAKE_EVENT_ID).delayMs).toBeGreaterThan(40 * 60_000);
  });

  it('does not postpone a requested wake whose reason matches the automatic wake text', async () => {
    const lastCompletedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const requestedAt = new Date(Date.now() + 5 * 60_000).toISOString();
    mock.root.persistentMind = {
      ...createDefaultPersistentMindState(),
      enabled: true,
      started: true,
      status: 'waiting',
      lastCompletedTurnId: 'turn-1',
      lastCompletedAt,
      selfWake: {
        id: 'wake-requested',
        kind: 'self',
        scheduleKind: 'requested',
        reason: 'maximum quiet period elapsed',
        sourceTurnId: 'turn-1',
        createdAt: lastCompletedAt,
        notBefore: requestedAt,
      },
    };
    mock.root.config.persistentMindProfile.wakeIntervalMinutes = 60;

    await supervisor.refreshPersistentMindWakeCadence();

    expect(mock.root.persistentMind.selfWake.notBefore).toBe(requestedAt);
    expect(mock.scheduled.get(supervisor.PERSISTENT_MIND_WAKE_EVENT_ID).delayMs).toBeLessThanOrEqual(5 * 60_000);
  });

  it('fails closed when a legacy completed message has no retry fingerprint', async () => {
    mock.root.persistentMind.recentMessageIds = ['legacy-message'];

    await expect(supervisor.enqueuePersistentMindMessage({
      id: 'legacy-message',
      text: 'A changed retry cannot be verified.',
    })).resolves.toMatchObject({
      success: false,
      code: 'IDEMPOTENCY_CONFLICT',
      status: 409,
    });
  });

  it('rejects new image messages while a source transition is in progress', async () => {
    mock.updateInProgress = true;

    await expect(supervisor.enqueuePersistentMindMessage({
      id: 'message-during-update',
      images: ['attachment-example'],
    })).resolves.toMatchObject({
      success: false,
      code: 'UPDATE_IN_PROGRESS',
      status: 409,
    });
    expect(mock.root.persistentMind.queuedMessages).toEqual([]);
  });

  it('pauses before adapter preparation when the pinned profile cannot resolve', async () => {
    const prepare = vi.fn();
    await supervisor.registerPersistentMindTurnAdapter({ prepare, run: vi.fn() });
    mock.profile = { ok: false, error: 'Pinned provider unavailable' };
    await supervisor.setPersistentMindEnabled(true);
    await supervisor.startPersistentMind();
    await supervisor.drainPersistentMind();

    expect(prepare).not.toHaveBeenCalled();
    expect(mock.root.persistentMind).toMatchObject({ status: 'degraded', pauseReason: 'Pinned provider unavailable' });
  });

  it('recovers an orphaned image turn without losing images or duplicating acceptance', async () => {
    const message = {
      id: 'message-1',
      text: 'Do not lose this image.',
      images: [{
        attachmentId: 'attachment-example',
        filename: 'mind-attachment-example.png',
        path: '/api/screenshots/mind-attachment-example.png',
        originalName: 'diagram.png',
        mimeType: 'image/png',
        size: 128,
        uploadedAt: new Date(1).toISOString(),
      }],
      createdAt: new Date(1).toISOString(),
    };
    mock.root.persistentMind = {
      ...createDefaultPersistentMindState(),
      enabled: true,
      started: true,
      status: 'thinking',
      activeTurn: {
        id: 'turn-orphan',
        wake: { kind: 'message', message },
        startedAt: new Date(1).toISOString(),
        heartbeatAt: new Date(1).toISOString(),
        providerId: 'example-cloud',
        model: 'example-model',
        effort: 'high',
      },
    };

    const recovered = await supervisor.initializePersistentMindSupervisor();
    expect(recovered.activeTurn).toBeNull();
    expect(recovered.status).toBe('interrupted');
    expect(recovered.queuedMessages).toEqual([message]);
    expect(recovered.nextEligibleWakeAt).not.toBeNull();
    expect(mock.scheduled.has(supervisor.PERSISTENT_MIND_WATCHDOG_EVENT_ID)).toBe(true);
    expect(mock.appendMindEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'mind.failed',
      turnId: 'turn-orphan',
      data: expect.objectContaining({ status: 'interrupted' }),
    }));
    expect(mock.appendMindEvent.mock.calls.map(([event]) => event.kind))
      .not.toContain('mind.message.accepted');
  });

  it('records pause, stop, and disable boundaries even without an active provider turn', async () => {
    await supervisor.setPersistentMindEnabled(true);
    await supervisor.startPersistentMind();
    await supervisor.pausePersistentMind('Pause for inspection');
    expect(mock.appendMindEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'mind.paused',
      data: expect.objectContaining({ status: 'paused', error: 'Pause for inspection' }),
    }));

    await supervisor.resumePersistentMind();
    await supervisor.stopPersistentMind();
    expect(mock.appendMindEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'mind.paused',
      data: expect.objectContaining({ status: 'idle', error: 'Persistent mind stopped' }),
    }));

    await supervisor.setPersistentMindEnabled(false);
    expect(mock.appendMindEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'mind.paused',
      data: expect.objectContaining({ status: 'disabled', error: 'Persistent mind disabled' }),
    }));
  });

  it('can wait for an aborted active turn to settle before cleanup starts', async () => {
    const pending = deferred();
    await supervisor.registerPersistentMindTurnAdapter({
      prepare: vi.fn(async () => ({ ok: true, provider: { id: 'example-cloud' } })),
      run: vi.fn(() => pending.promise),
    });
    await supervisor.setPersistentMindEnabled(true);
    await supervisor.startPersistentMind();
    await supervisor.enqueuePersistentMindMessage({ id: 'message-cleanup', text: 'This turn will be interrupted.' });
    const drain = supervisor.drainPersistentMind();
    await vi.waitFor(() => expect(mock.root.persistentMind.activeTurn).not.toBeNull());

    let stopped = false;
    const stopping = supervisor.stopPersistentMind({ waitForTurn: true }).then(() => {
      stopped = true;
    });
    await vi.waitFor(() => expect(mock.root.persistentMind.activeTurn).toBeNull());
    expect(stopped).toBe(false);

    pending.resolve({ events: [{ kind: 'mind.thought', id: 'late-result', data: {} }] });
    await Promise.all([drain, stopping]);
    expect(stopped).toBe(true);
    expect(mock.root.persistentMind).toMatchObject({ started: false, status: 'idle' });
  });

  it('requeues a message and degrades visibly when the pinned provider is unavailable', async () => {
    await supervisor.registerPersistentMindTurnAdapter({
      prepare: vi.fn(async () => ({ ok: false, error: 'Pinned provider unavailable' })),
      run: vi.fn(),
    });
    await supervisor.setPersistentMindEnabled(true);
    await supervisor.startPersistentMind();
    await supervisor.enqueuePersistentMindMessage({ id: 'message-1', text: 'Wait for the configured provider.' });
    await supervisor.drainPersistentMind();

    expect(mock.root.persistentMind.status).toBe('degraded');
    expect(mock.root.persistentMind.pauseReason).toBe('Pinned provider unavailable');
    expect(mock.root.persistentMind.queuedMessages.map((item) => item.id)).toEqual(['message-1']);
    expect(mock.root.persistentMind.nextEligibleWakeAt).not.toBeNull();
    expect(mock.acquireSlot).not.toHaveBeenCalled();
  });

  it('revalidates image capability before inference and retains the claimed message', async () => {
    const run = vi.fn();
    await supervisor.registerPersistentMindTurnAdapter({
      prepare: vi.fn(async () => ({ ok: true, provider: mock.profile.provider })),
      run,
    });
    mock.root.persistentMind = {
      ...mock.root.persistentMind,
      enabled: true,
      started: true,
      status: 'waiting',
      queuedMessages: [{
        id: 'message-image', text: '', createdAt: new Date().toISOString(),
        images: [{ attachmentId: 'attachment-1', filename: 'mind-example.png', originalName: 'example.png', mimeType: 'image/png', size: 10, uploadedAt: new Date().toISOString() }],
      }],
    };
    mock.imageCapability = { status: 'unsupported', reason: 'The pinned model is now text-only.' };
    await supervisor.drainPersistentMind();
    expect(run).not.toHaveBeenCalled();
    expect(mock.root.persistentMind.status).toBe('degraded');
    expect(mock.root.persistentMind.pauseReason).toBe('The pinned model is now text-only.');
    expect(mock.root.persistentMind.queuedMessages.map((message) => message.id)).toEqual(['message-image']);
  });

  it('holds queued work durably when the CoS budget is exhausted', async () => {
    const prepare = vi.fn();
    const run = vi.fn();
    await supervisor.registerPersistentMindTurnAdapter({ prepare, run });
    await supervisor.setPersistentMindEnabled(true);
    await supervisor.startPersistentMind();
    await supervisor.enqueuePersistentMindMessage({ id: 'message-1', text: 'Wait for tomorrow.' });
    mock.budget = { withinBudget: false, exceeded: 'actions' };

    await supervisor.drainPersistentMind();

    expect(prepare).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(mock.root.persistentMind.queuedMessages.map((item) => item.id)).toEqual(['message-1']);
    expect(mock.root.persistentMind.pauseReason).toBe('CoS actions budget exhausted');
    expect(mock.root.persistentMind.nextEligibleWakeAt).not.toBeNull();
  });

  it('holds queued work durably when ordinary CoS agents fill the global capacity', async () => {
    const prepare = vi.fn();
    const run = vi.fn();
    await supervisor.registerPersistentMindTurnAdapter({ prepare, run });
    await supervisor.setPersistentMindEnabled(true);
    await supervisor.startPersistentMind();
    await supervisor.enqueuePersistentMindMessage({ id: 'message-1', text: 'Wait for a global slot.' });
    mock.root.config.maxConcurrentAgents = 1;
    mock.root.agents = { 'agent-1': { status: 'running' } };

    await supervisor.drainPersistentMind();

    expect(prepare).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(mock.root.persistentMind.queuedMessages.map((item) => item.id)).toEqual(['message-1']);
    expect(mock.root.persistentMind.pauseReason).toBe('CoS agent capacity exhausted (1/1)');
    expect(mock.root.persistentMind.nextEligibleWakeAt).not.toBeNull();
  });

  it('holds a shared global slot throughout provider preparation', async () => {
    const prepared = deferred();
    await supervisor.registerPersistentMindTurnAdapter({
      prepare: vi.fn(() => prepared.promise),
      run: vi.fn(async () => ({})),
    });
    mock.root.config.maxConcurrentAgents = 1;
    await supervisor.setPersistentMindEnabled(true);
    await supervisor.startPersistentMind();
    const drain = supervisor.drainPersistentMind();
    await vi.waitFor(() => expect(mock.root.persistentMind.activeTurn).not.toBeNull());

    expect(acquireCosGlobalSlot({ agents: {}, limit: 1, reservationId: 'ordinary-task' })).toMatchObject({ ok: false });
    await supervisor.pausePersistentMind();
    prepared.resolve({ ok: true, provider: { id: 'example-cloud' } });
    await drain;
    const released = acquireCosGlobalSlot({ agents: {}, limit: 1, reservationId: 'ordinary-task' });
    expect(released.ok).toBe(true);
    released.release();
  });

  it('does not claim a turn when another admission reserved the final daily action', async () => {
    mock.budget = {
      withinBudget: true,
      exceeded: null,
      budget: { maxActionsPerDay: 1, maxMinutesPerDay: null },
      usage: { actions: 0, ms: 0 },
    };
    const existing = acquireCosActionReservation({
      budget: mock.budget.budget,
      usage: mock.budget.usage,
      reservationId: 'ordinary-agent',
    });
    const run = vi.fn();
    await supervisor.registerPersistentMindTurnAdapter({
      prepare: vi.fn(async () => ({ ok: true, provider: { id: 'example-cloud' } })),
      run,
    });
    await supervisor.setPersistentMindEnabled(true);
    await supervisor.startPersistentMind();

    await supervisor.drainPersistentMind();

    expect(run).not.toHaveBeenCalled();
    expect(mock.root.persistentMind.activeTurn).toBeNull();
    expect(mock.root.persistentMind.pauseReason).toBe('CoS actions budget exhausted');
    existing.release();
  });

  it('requeues a claimed message when the shared local endpoint has no slot', async () => {
    const run = vi.fn();
    mock.profile = {
      ok: true,
      provider: { id: 'example-local', endpoint: 'http://127.0.0.1:1234' },
      model: 'example-model',
      effort: 'high',
      thinkingInterface: 'text',
    };
    await supervisor.registerPersistentMindTurnAdapter({
      prepare: vi.fn(async () => ({ ok: true, provider: { id: 'example-local', endpoint: 'http://127.0.0.1:1234' } })),
      run,
    });
    mock.acquireSlot.mockResolvedValueOnce({ ok: false, reason: 'local endpoint localhost:1234 is at capacity (1/1)' });
    await supervisor.setPersistentMindEnabled(true);
    await supervisor.startPersistentMind();
    await supervisor.enqueuePersistentMindMessage({ id: 'message-1', text: 'Wait for capacity.' });

    await supervisor.drainPersistentMind();

    expect(run).not.toHaveBeenCalled();
    expect(mock.prepareContext).not.toHaveBeenCalled();
    expect(mock.root.persistentMind.status).toBe('waiting');
    expect(mock.root.persistentMind.queuedMessages.map((item) => item.id)).toEqual(['message-1']);
    expect(mock.root.persistentMind.pauseReason).toContain('at capacity');
  });

  it('holds one local endpoint slot and one usage span across context summarization and the turn', async () => {
    const contextReady = deferred();
    const release = vi.fn();
    mock.acquireSlot.mockResolvedValue({ ok: true, release });
    mock.prepareContext.mockImplementationOnce(() => contextReady.promise);
    const run = vi.fn(async () => ({}));
    await supervisor.registerPersistentMindTurnAdapter({
      prepare: vi.fn(async () => ({ ok: true, provider: { id: 'example-cloud' } })),
      summarize: vi.fn(async () => 'summary'),
      run,
    });
    await supervisor.setPersistentMindEnabled(true);
    await supervisor.startPersistentMind();
    const drain = supervisor.drainPersistentMind();
    await vi.waitFor(() => expect(mock.prepareContext).toHaveBeenCalled());

    expect(mock.acquireSlot).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();

    contextReady.resolve({ text: 'bounded context', chars: 15, summaryState: 'ready' });
    await drain;
    expect(run).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(mock.recordUsage).toHaveBeenCalledWith('cos', expect.objectContaining({ actions: 1 }));
  });

  it('does not run a turn canceled while context preparation is pending', async () => {
    const contextReady = deferred();
    mock.prepareContext.mockImplementationOnce(() => contextReady.promise);
    const run = vi.fn(async () => ({}));
    await supervisor.registerPersistentMindTurnAdapter({
      prepare: vi.fn(async () => ({ ok: true, provider: { id: 'example-cloud' } })),
      run,
    });
    await supervisor.setPersistentMindEnabled(true);
    await supervisor.startPersistentMind();
    const drain = supervisor.drainPersistentMind();
    await vi.waitFor(() => expect(mock.prepareContext).toHaveBeenCalled());

    await supervisor.pausePersistentMind();
    contextReady.resolve({ text: 'bounded context', chars: 15, summaryState: 'ready' });
    await drain;

    expect(run).not.toHaveBeenCalled();
    expect(mock.root.persistentMind.status).toBe('paused');
  });

  it('does not schedule or run a wake while the CoS lifecycle gate is closed', async () => {
    const run = vi.fn();
    await supervisor.registerPersistentMindTurnAdapter({
      prepare: vi.fn(async () => ({ ok: true, provider: { id: 'example-cloud' } })),
      run,
    });
    await supervisor.setPersistentMindEnabled(true);
    await supervisor.startPersistentMind();
    mock.scheduled.clear();
    mock.root.paused = true;

    await supervisor.enqueuePersistentMindMessage({ id: 'message-1', text: 'Wait for resume.' });
    await supervisor.drainPersistentMind();

    expect(run).not.toHaveBeenCalled();
    expect(mock.scheduled.has(supervisor.PERSISTENT_MIND_WAKE_EVENT_ID)).toBe(false);
    expect(mock.root.persistentMind.queuedMessages.map((item) => item.id)).toEqual(['message-1']);

    mock.root.paused = false;
    mock.daemonRunning = false;
    await supervisor.handlePersistentMindGlobalResume();
    expect(mock.scheduled.has(supervisor.PERSISTENT_MIND_WAKE_EVENT_ID)).toBe(false);
  });

  it('re-arms a fired one-shot only after the scheduler can finish cleaning it up', async () => {
    await supervisor.registerPersistentMindTurnAdapter({
      prepare: vi.fn(async () => ({ ok: true, provider: { id: 'example-cloud' } })),
      run: vi.fn(async () => ({})),
    });
    await supervisor.setPersistentMindEnabled(true);
    await supervisor.startPersistentMind();
    const firstWake = mock.scheduled.get(supervisor.PERSISTENT_MIND_WAKE_EVENT_ID);

    await firstWake.handler();
    // Mirrors eventScheduler's one-shot cleanup immediately after await handler().
    mock.scheduled.delete(supervisor.PERSISTENT_MIND_WAKE_EVENT_ID);
    expect(mock.scheduled.has(supervisor.PERSISTENT_MIND_WAKE_EVENT_ID)).toBe(false);
    await new Promise((resolve) => setImmediate(resolve));

    const replacement = mock.scheduled.get(supervisor.PERSISTENT_MIND_WAKE_EVENT_ID);
    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(firstWake);
  });

  it('does not start a turn when cancellation lands while provider preparation is pending', async () => {
    const prepared = deferred();
    const run = vi.fn();
    await supervisor.registerPersistentMindTurnAdapter({
      prepare: vi.fn(() => prepared.promise),
      run,
    });
    await supervisor.setPersistentMindEnabled(true);
    await supervisor.startPersistentMind();
    await supervisor.enqueuePersistentMindMessage({ id: 'message-1', text: 'Cancel before inference.' });
    const drain = supervisor.drainPersistentMind();
    await vi.waitFor(() => expect(mock.root.persistentMind.activeTurn).not.toBeNull());

    await supervisor.pausePersistentMind();
    prepared.resolve({ ok: true, provider: { id: 'example-cloud' } });
    await drain;

    expect(run).not.toHaveBeenCalled();
    expect(mock.acquireSlot).not.toHaveBeenCalled();
    expect(mock.root.persistentMind.status).toBe('paused');
    expect(mock.root.persistentMind.queuedMessages.map((item) => item.id)).toEqual(['message-1']);
  });

  it('watchdog interruption aborts and requeues a stale turn without starting a second copy', async () => {
    const run = vi.fn(({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    await supervisor.registerPersistentMindTurnAdapter({
      prepare: vi.fn(async () => ({ ok: true, provider: { id: 'example-cloud' } })),
      run,
    });
    await supervisor.setPersistentMindEnabled(true);
    await supervisor.startPersistentMind();
    await supervisor.enqueuePersistentMindMessage({ id: 'message-1', text: 'Watch this turn.' });
    const drain = supervisor.drainPersistentMind();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));

    mock.root.persistentMind.activeTurn.heartbeatAt = new Date(
      Date.now() - PERSISTENT_MIND_LIMITS.WATCHDOG_STALE_MS
    ).toISOString();
    await expect(supervisor.checkPersistentMindWatchdog()).resolves.toEqual({ interrupted: true });
    await drain;

    expect(run).toHaveBeenCalledTimes(1);
    expect(mock.root.persistentMind.activeTurn).toBeNull();
    expect(mock.root.persistentMind.queuedMessages.map((item) => item.id)).toEqual(['message-1']);
    expect(mock.root.persistentMind.status).toBe('interrupted');
  });

  it('does not interrupt a replacement turn when a stale watchdog snapshot loses the race', async () => {
    mock.root.persistentMind = {
      ...createDefaultPersistentMindState(),
      enabled: true,
      started: true,
      status: 'thinking',
      activeTurn: {
        id: 'turn-stale',
        wake: { kind: 'self', id: 'wake-stale', reason: 'stale', sourceTurnId: 'turn-0', createdAt: new Date(1).toISOString(), notBefore: null },
        startedAt: new Date(1).toISOString(),
        heartbeatAt: new Date(1).toISOString(),
        providerId: 'example-cloud',
        model: null,
        effort: null,
      },
    };
    const originalWithStateLock = (await import('./cosState.js')).withStateLock;
    let replaced = false;
    originalWithStateLock.mockImplementationOnce(async (fn) => {
      mock.root.persistentMind.activeTurn = {
        ...mock.root.persistentMind.activeTurn,
        id: 'turn-replacement',
        heartbeatAt: new Date().toISOString(),
      };
      replaced = true;
      return fn();
    });

    await expect(supervisor.checkPersistentMindWatchdog()).resolves.toEqual({ interrupted: false });

    expect(replaced).toBe(true);
    expect(mock.root.persistentMind.activeTurn.id).toBe('turn-replacement');
    expect(mock.root.persistentMind.status).toBe('thinking');
  });

  it('coalesces self-wakes and rejects a recursive wake without a completed source turn', async () => {
    mock.root.persistentMind = {
      ...createDefaultPersistentMindState(),
      enabled: true,
      started: true,
      status: 'idle',
      lastCompletedTurnId: 'turn-1',
    };
    expect(await supervisor.requestPersistentMindWake({ sourceTurnId: 'turn-0', reason: 'stale' }))
      .toEqual({ success: false, error: 'Self-wake must reference the last completed turn' });
    const first = await supervisor.requestPersistentMindWake({ sourceTurnId: 'turn-1', reason: 'first' });
    const second = await supervisor.requestPersistentMindWake({ sourceTurnId: 'turn-1', reason: 'newest' });
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(mock.root.persistentMind.selfWake.reason).toBe('newest');
  });

  const withDeepPreset = () => {
    mock.root.config.persistentMindThinkingPresets = {
      presets: [{ id: 'deep', label: 'Deep pass', providerId: 'example-alt', model: 'alt-model', effort: 'max' }],
    };
  };
  // Adapters may only prepare the transport for the route they are handed.
  const echoProfileAdapter = () => vi.fn(async ({ profile }) => ({ ok: true, provider: profile.provider }));

  it('runs one selected message on its preset and returns the very next turn to the default', async () => {
    withDeepPreset();
    const run = vi.fn(async () => ({}));
    await supervisor.registerPersistentMindTurnAdapter({ prepare: echoProfileAdapter(), run });
    await supervisor.setPersistentMindEnabled(true);
    await supervisor.startPersistentMind();

    expect(await supervisor.enqueuePersistentMindMessage({ id: 'message-1', text: 'Deep pass please.', thinkingPresetId: 'deep' }))
      .toEqual({ success: true, duplicate: false, messageId: 'message-1' });
    await supervisor.enqueuePersistentMindMessage({ id: 'message-2', text: 'Back to normal.' });

    await supervisor.drainPersistentMind();
    await supervisor.drainPersistentMind();

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][0]).toMatchObject({ provider: { id: 'example-alt' }, model: 'alt-model', effort: 'max' });
    expect(run.mock.calls[1][0]).toMatchObject({ provider: { id: 'example-cloud' }, model: 'example-model', effort: 'high' });
    // The selection lives on the message, so the stored default is untouched.
    expect(mock.root.config.persistentMindProfile).toMatchObject({ providerId: 'example-cloud', model: 'example-model' });

    const modelRequests = mock.appendMindEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.kind === 'mind.model.request');
    expect(modelRequests.map((event) => event.data.thinkingPresetId)).toEqual(['deep', null]);
  });

  it('refuses a message naming a preset the user removed, and will not let a retry swap models', async () => {
    withDeepPreset();
    await supervisor.registerPersistentMindTurnAdapter({ prepare: echoProfileAdapter(), run: vi.fn() });
    await supervisor.setPersistentMindEnabled(true);
    await supervisor.startPersistentMind();

    expect(await supervisor.enqueuePersistentMindMessage({ id: 'message-1', text: 'Deep pass please.', thinkingPresetId: 'removed' }))
      .toMatchObject({ success: false, code: 'THINKING_PRESET_UNAVAILABLE', status: 422 });
    expect(mock.root.persistentMind.queuedMessages).toEqual([]);

    await supervisor.enqueuePersistentMindMessage({ id: 'message-2', text: 'Deep pass please.', thinkingPresetId: 'deep' });
    expect(await supervisor.enqueuePersistentMindMessage({ id: 'message-2', text: 'Deep pass please.', thinkingPresetId: 'deep' }))
      .toEqual({ success: true, duplicate: true, messageId: 'message-2' });
    expect(await supervisor.enqueuePersistentMindMessage({ id: 'message-2', text: 'Deep pass please.' }))
      .toMatchObject({ success: false, code: 'IDEMPOTENCY_CONFLICT', status: 409 });
  });

  it('degrades visibly rather than falling back when a temporary preset no longer resolves', async () => {
    withDeepPreset();
    mock.thinkingSession = { ok: false, error: 'Temporary thinking preset "Deep pass" model "alt-model" is not available from provider "example-alt"' };
    const run = vi.fn();
    await supervisor.registerPersistentMindTurnAdapter({ prepare: echoProfileAdapter(), run });
    await supervisor.setPersistentMindEnabled(true);
    await supervisor.startPersistentMind();
    await supervisor.enqueuePersistentMindMessage({ id: 'message-1', text: 'Deep pass please.', thinkingPresetId: 'deep' });
    await supervisor.drainPersistentMind();

    expect(run).not.toHaveBeenCalled();
    expect(mock.root.persistentMind.status).toBe('degraded');
    expect(mock.root.persistentMind.pauseReason).toMatch(/Temporary thinking preset/);
    // Nothing was spent, so the message stays queued for the user to fix the preset.
    expect(mock.root.persistentMind.queuedMessages.map((item) => item.id)).toEqual(['message-1']);
  });

  it('never auto-replays a temporary session interrupted after its provider span opened', async () => {
    withDeepPreset();
    const run = vi.fn(({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    await supervisor.registerPersistentMindTurnAdapter({ prepare: echoProfileAdapter(), run });
    await supervisor.setPersistentMindEnabled(true);
    await supervisor.startPersistentMind();
    await supervisor.enqueuePersistentMindMessage({ id: 'message-1', text: 'Deep pass please.', thinkingPresetId: 'deep' });
    const drain = supervisor.drainPersistentMind();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));

    mock.root.persistentMind.activeTurn.heartbeatAt = new Date(
      Date.now() - PERSISTENT_MIND_LIMITS.WATCHDOG_STALE_MS
    ).toISOString();
    await expect(supervisor.checkPersistentMindWatchdog()).resolves.toEqual({ interrupted: true });
    await drain;

    expect(mock.root.persistentMind.queuedMessages).toEqual([]);
    expect(mock.root.persistentMind.recentMessageIds).toEqual(['message-1']);
    // An idempotent client retry reads as a completed duplicate, so a second
    // drain cannot repeat work the provider may already have billed.
    expect(await supervisor.enqueuePersistentMindMessage({ id: 'message-1', text: 'Deep pass please.', thinkingPresetId: 'deep' }))
      .toEqual({ success: true, duplicate: true, messageId: 'message-1' });
    await supervisor.drainPersistentMind();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('retires, never replays, a temporary session abandoned by a restart, a stop, or a disable', async () => {
    withDeepPreset();
    const temporaryTurn = (turnId, messageId) => ({
      id: turnId,
      wake: {
        kind: 'message',
        message: { id: messageId, text: 'Deep pass please.', thinkingPresetId: 'deep', createdAt: new Date().toISOString() },
      },
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    });
    const startedWith = (turn) => {
      mock.root.persistentMind = {
        ...createDefaultPersistentMindState(),
        enabled: true,
        started: true,
        status: 'thinking',
        activeTurn: turn,
      };
    };
    await supervisor.registerPersistentMindTurnAdapter({ prepare: echoProfileAdapter(), run: vi.fn() });

    // A hard crash leaves started:true on disk, so boot recovery — not the
    // state normalizer — owns this one.
    startedWith(temporaryTurn('mind-turn-crash', 'paid-crash'));
    await supervisor.initializePersistentMindSupervisor();
    expect(mock.root.persistentMind.queuedMessages).toEqual([]);
    expect(mock.root.persistentMind.recentMessageIds).toEqual(['paid-crash']);

    startedWith(temporaryTurn('mind-turn-stop', 'paid-stop'));
    await supervisor.stopPersistentMind();
    expect(mock.root.persistentMind.queuedMessages).toEqual([]);
    expect(mock.root.persistentMind.recentMessageIds).toEqual(['paid-stop']);

    startedWith(temporaryTurn('mind-turn-disable', 'paid-disable'));
    await supervisor.setPersistentMindEnabled(false);
    expect(mock.root.persistentMind.queuedMessages).toEqual([]);
    expect(mock.root.persistentMind.recentMessageIds).toEqual(['paid-disable']);

    // An ordinary message keeps its free automatic recovery on every path.
    const ordinaryTurn = {
      id: 'mind-turn-plain',
      wake: { kind: 'message', message: { id: 'plain-1', text: 'Ordinary.', createdAt: new Date().toISOString() } },
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
    startedWith(ordinaryTurn);
    await supervisor.stopPersistentMind();
    expect(mock.root.persistentMind.queuedMessages.map((item) => item.id)).toEqual(['plain-1']);
    expect(mock.root.persistentMind.recentMessageIds).toEqual([]);
  });
});
