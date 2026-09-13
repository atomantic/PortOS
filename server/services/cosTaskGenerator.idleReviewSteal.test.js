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

const preflight = vi.hoisted(() => ({ reporter: vi.fn((cardId) => ({ boundTo: cardId })) }));
const pipeline = vi.hoisted(() => ({ securityPreflight: vi.fn(async () => ({ skipped: true, reason: 'no-external-open-prs' })) }));
const scheduleMocks = vi.hoisted(() => ({
  requests: [],
  clearOnDemandRequest: vi.fn(async () => ({})),
}));

vi.mock('./preflightTaskCard.js', async (importActual) => ({
  ...(await importActual()),
  preflightReporter: (...args) => preflight.reporter(...args),
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

const { generateIdleReviewTask } = await import('./cosTaskGenerator.js');

const STATE = { config: { improvementEnabled: true, appReviewCooldownMs: 0 }, stats: {} };
const request = (overrides = {}) => ({ id: 'demand-1', appId: 'example-app', taskType: 'pr-reviewer', ...overrides });
const progressOf = () => pipeline.securityPreflight.mock.calls.at(-1)?.at(-1)?.progress;

beforeEach(() => {
  vi.clearAllMocks();
  preflight.reporter.mockImplementation((cardId) => ({ boundTo: cardId }));
  pipeline.securityPreflight.mockResolvedValue({ skipped: true, reason: 'no-external-open-prs' });
  scheduleMocks.requests = [];
});

describe('idle review stealing a queued on-demand request', () => {
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

