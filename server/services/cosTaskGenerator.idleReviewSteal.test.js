/**
 * The idle-review tier can STEAL a queued on-demand request for the app it
 * picked (`generateManagedAppImprovementTask`), which takes the request off the
 * queue for good — the on-demand drain never sees it again.
 *
 * That made a human's "Run" lie. The drain opens a programmatic-phase card the
 * moment the request is queued (services/preflightTaskCard.js); the steal
 * reported nothing into it and never closed it, so the card sat at "Waiting for
 * a free task slot" with its pre-agent checks all pending — while the agent the
 * steal produced was visibly already working two cards below — until the
 * 15-minute orphan sweep mislabelled it `interrupted`.
 *
 * These pin the hand-off: the steal binds the pre-agent progress reporter to
 * that card, and carries the card id out to the tier — the only place the
 * admission decision is final, and therefore the only place that may close it
 * (cosDequeue#closeStolenIdleReviewCard).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const preflight = vi.hoisted(() => ({ reporter: vi.fn((cardId) => ({ boundTo: cardId })),
  reportStep: vi.fn(async () => {}), finish: vi.fn(async () => {}), finishDispatch: vi.fn(async () => {}) }));
const pipeline = vi.hoisted(() => ({ securityPreflight: vi.fn(async () => ({ skipped: true, reason: 'no-external-open-prs' })) }));
const scheduleMocks = vi.hoisted(() => ({
  requests: [],
  clearOnDemandRequest: vi.fn(),
}));

vi.mock('./preflightTaskCard.js', async (importActual) => ({
  ...(await importActual()),
  preflightReporter: (...args) => preflight.reporter(...args),
  reportPreflightStep: (...args) => preflight.reportStep(...args),
  finishPreflightCard: (...args) => preflight.finish(...args),
  finishPreflightDispatch: (...args) => preflight.finishDispatch(...args),
}));
// The security preflight is the deterministic phase whose progress the card
// renders; skipping it keeps these tests on the wiring rather than on a real
// forge scan.
vi.mock('./prReviewerPipeline.js', async (importActual) => ({
  ...(await importActual()),
  runPrReviewerSecurityPreflight: (...args) => pipeline.securityPreflight(...args),
}));
vi.mock('./apps.js', async (importActual) => ({
  ...(await importActual()),
  getActiveApps: vi.fn(async () => [{ id: 'example-app', name: 'Example App' }]),
  getAppTaskTypeOverrides: vi.fn(async () => ({})),
}));
vi.mock('./appActivity.js', async (importActual) => ({
  ...(await importActual()),
  getNextAppForReview: vi.fn(async () => ({ id: 'example-app', name: 'Example App' })),
  markIdleReviewStarted: vi.fn(async () => {}),
  markAppReviewCooldown: vi.fn(async () => {}),
  bindAppReviewAgent: vi.fn(async () => {}),
  updateAppActivity: vi.fn(async () => {}),
}));
vi.mock('./cosState.js', async (importActual) => ({
  ...(await importActual()),
  loadState: vi.fn(async () => ({ stats: {}, config: {} })),
  saveState: vi.fn(async () => {}),
  withStateLock: vi.fn(async (fn) => fn()),
}));
vi.mock('./taskSchedule.js', async (importActual) => ({
  ...(await importActual()),
  getOnDemandRequests: vi.fn(async () => scheduleMocks.requests),
  clearOnDemandRequest: (...args) => scheduleMocks.clearOnDemandRequest(...args),
  applyOnDemandRunResets: vi.fn(async () => true),
  recordExecution: vi.fn(async () => {}),
  getTaskInterval: vi.fn(async () => ({ prompt: null, taskMetadata: {} })),
  getNextTaskType: vi.fn(async () => null),
}));

const { applyOnDemandRunResets, recordExecution, getNextTaskType } = await import('./taskSchedule.js');
const { generateIdleReviewTask, prepareManagedAppImprovementTask } = await import('./cosTaskGenerator.js');

const STATE = { config: { improvementEnabled: true, appReviewCooldownMs: 0 }, stats: {} };
const request = (overrides = {}) => ({ id: 'demand-1', appId: 'example-app', taskType: 'pr-reviewer', ...overrides });
const progressOf = () => pipeline.securityPreflight.mock.calls.at(-1)?.at(-1)?.progress;

beforeEach(() => {
  vi.clearAllMocks();
  preflight.reporter.mockImplementation((cardId) => ({ boundTo: cardId }));
  pipeline.securityPreflight.mockResolvedValue({ skipped: true, reason: 'no-external-open-prs' });
  scheduleMocks.requests = [];
  scheduleMocks.clearOnDemandRequest.mockImplementation(async (id) => {
    const index = scheduleMocks.requests.findIndex(request => request.id === id);
    return index === -1 ? null : scheduleMocks.requests.splice(index, 1)[0];
  });
});

describe('idle review stealing a queued on-demand request', () => {
  it('leaves another owner or cancelled receipt alone', async () => {
    scheduleMocks.requests = [request()];
    scheduleMocks.clearOnDemandRequest.mockResolvedValue(null);
    const result = await generateIdleReviewTask(STATE);
    expect(result).toEqual({ task: null, pendingPerpetualDispatch: null, preflightCardId: null });
    expect(applyOnDemandRunResets).not.toHaveBeenCalled();
    expect(recordExecution).not.toHaveBeenCalled();
    expect(getNextTaskType).not.toHaveBeenCalled();
    expect(pipeline.securityPreflight).not.toHaveBeenCalled();
    expect(preflight.reporter).not.toHaveBeenCalled();
  });

  it.each([0, 1])('only idle consumer %i owns preparation and the card', async (winner) => {
    const receipt = request({ targetPullRequest: 42 });
    scheduleMocks.requests = [receipt];
    const firstClaimReady = Promise.withResolvers();
    const claimsReady = Promise.withResolvers();
    const claims = [Promise.withResolvers(), Promise.withResolvers()];
    const preflightEntered = Promise.withResolvers();
    const preflightRelease = Promise.withResolvers();
    let count = 0;
    const queue = [receipt];
    scheduleMocks.clearOnDemandRequest.mockImplementation(async () => {
      const index = count++;
      if (count === 1) firstClaimReady.resolve();
      if (count === 2) claimsReady.resolve();
      await claims[index].promise;
      return queue.shift() ?? null;
    });
    pipeline.securityPreflight.mockImplementation(async () => {
      preflightEntered.resolve();
      await preflightRelease.promise;
      return { skipped: true, reason: 'no-external-open-prs' };
    });
    const drains = [generateIdleReviewTask(STATE)];
    await firstClaimReady.promise;
    drains.push(generateIdleReviewTask(STATE));
    await claimsReady.promise;
    claims[winner].resolve();
    await preflightEntered.promise;
    claims[1 - winner].resolve();
    expect(await drains[1 - winner]).toEqual({
      task: null, pendingPerpetualDispatch: null, preflightCardId: null,
    });
    expect(applyOnDemandRunResets).toHaveBeenCalledTimes(1);
    expect(recordExecution).not.toHaveBeenCalled();
    expect(pipeline.securityPreflight).toHaveBeenCalledTimes(1);
    preflightRelease.resolve();
    const result = await drains[winner];
    expect(result.preflightCardId).toBe('preflight-demand-1');
    expect(result.task).toBeNull();
    // The security preflight found no reviewable PR; no task was executed.
    expect(recordExecution).not.toHaveBeenCalled();
    expect(progressOf()).toEqual({ boundTo: 'preflight-demand-1' });
  });

  it('carries the human Run card out to the tier that rules on the task', async () => {
    scheduleMocks.requests = [request()];
    const result = await generateIdleReviewTask(STATE);
    expect(scheduleMocks.clearOnDemandRequest).toHaveBeenCalledWith('demand-1');
    // The card id the drain would have used, so the steal reports into the SAME
    // record the user is already watching rather than opening a second one.
    expect(result.preflightCardId).toBe('preflight-demand-1');
    // Closing it belongs to the tier: this produced no task, and a card closed
    // `handed-off` here would name an agent that never started.
    expect(result.task).toBeNull();
  });

  it('keeps the stolen card active through the caller’s handoff', async () => {
    const { isPreflightActive } = await import('./preflightActivity.js');
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    let finishActivity;
    scheduleMocks.requests = [request()];
    pipeline.securityPreflight.mockImplementation(async () => { entered.resolve(); await release.promise; return { skipped: true }; });
    const pending = generateIdleReviewTask(STATE, { onPreflightStart: (_id, end) => { finishActivity = end; } });
    await entered.promise;
    expect(isPreflightActive('preflight-demand-1')).toBe(true);
    release.resolve();
    await pending;
    expect(isPreflightActive('preflight-demand-1')).toBe(true);
    expect(preflight.reportStep).toHaveBeenCalledWith('preflight-demand-1', 'prepare');
    finishActivity();
    expect(isPreflightActive('preflight-demand-1')).toBe(false);
  });

  it('keeps activity through idle-tier closure and clears it on failure', async () => {
    const { isPreflightActive } = await import('./preflightActivity.js');
    const { admitIdleReviewTask } = await import('./cosDequeue.js');
    const taskStore = await import('./cosTaskStore.js');
    const spy = vi.spyOn(taskStore, 'getCosApprovalView').mockResolvedValue({ autoApprovedCount: 0 });
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    scheduleMocks.requests = [request()];
    preflight.finishDispatch.mockImplementationOnce(async () => { entered.resolve(); await release.promise; throw new Error('synthetic handoff failure'); });
    try {
      const pending = admitIdleReviewTask({ state: { ...STATE, config: { ...STATE.config, idleReviewEnabled: true } },
        alreadySpawned: 0, hasPendingUserTasks: false, cosAutonomyMode: 'execute', autonomousSlotCeiling: 1 },
      { canSpawn: () => true, emitSpawn: vi.fn(), trackSpawn: vi.fn() });
      await entered.promise;
      expect(isPreflightActive('preflight-demand-1')).toBe(true);
      release.resolve();
      await expect(pending).rejects.toThrow('synthetic handoff failure');
      expect(isPreflightActive('preflight-demand-1')).toBe(false);
      expect(preflight.finish).toHaveBeenCalledWith('preflight-demand-1', expect.objectContaining({ outcome: 'failed' }));
    } finally { spy.mockRestore(); }
  });

  it('binds the pre-agent progress reporter to that card', async () => {
    scheduleMocks.requests = [request()];
    await generateIdleReviewTask(STATE);
    expect(progressOf()).toEqual({ boundTo: 'preflight-demand-1' });
  });

  it('cards nothing for an automated origin, which has nobody waiting on it', async () => {
    scheduleMocks.requests = [request({ origin: 'refill' })];
    const result = await generateIdleReviewTask(STATE);
    expect(result.preflightCardId).toBeNull();
    expect(progressOf()).toEqual({ boundTo: null });
  });

  it('cards nothing when the tier picked its own work instead of stealing a Run', async () => {
    scheduleMocks.requests = [request({ appId: 'other-app' })];
    const result = await generateIdleReviewTask(STATE);
    expect(scheduleMocks.clearOnDemandRequest).not.toHaveBeenCalled();
    expect(result.preflightCardId).toBeNull();
  });
});


describe('prepareManagedAppImprovementTask on a pr-reviewer preflight skip', () => {
  it('returns the preflight reason on the skip, so a user Run can say why nothing started', async () => {
    pipeline.securityPreflight.mockResolvedValue({ skipped: true, reason: 'security-guard-not-ready' });
    const prepared = await prepareManagedAppImprovementTask('pr-reviewer', { id: 'example-app', name: 'Example App' }, STATE);
    expect(prepared).toEqual({
      task: null,
      pendingPerpetualDispatch: null,
      skip: { gate: 'security-preflight', reason: 'security-guard-not-ready', cli: null, remedy: null, detail: null },
    });
  });
});
