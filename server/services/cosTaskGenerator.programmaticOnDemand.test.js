/**
 * The ORDINARY scheduled-task manual path for programmatic handlers (#6376).
 *
 * `universe-bible-describe` / `universe-bible-images` are the only scheduled
 * types PortOS runs itself. A "Run Now" queues the normal on-demand request; the
 * two dispatch engines then hand it to `drainProgrammaticOnDemandRequests`
 * instead of generating an agent task. These cases pin the contract that makes
 * that safe: the handler is invoked once with the task's own saved settings, a
 * disabled/gated request is cleared without running anything, and the request is
 * reported back to the engines so their agent loop skips it.
 *
 * Isolated file so the handler double can't leak into the shared
 * cosTaskGenerator suite.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const runScheduledHandler = vi.fn(async () => ({ dispatched: true, summary: 'Described 3 bible entries' }));
vi.mock('./scheduledHandlers/index.js', () => ({
  SCHEDULED_HANDLER_MODULES: {},
  runScheduledHandler: (...args) => runScheduledHandler(...args),
  countScheduledHandlerPending: vi.fn(),
}));

vi.mock('./cosEvents.js', () => ({
  cosEvents: { emit: vi.fn(), on: vi.fn() },
  emitLog: vi.fn(),
}));

const isImprovementEnabled = vi.fn(() => true);
vi.mock('./cosState.js', async (importActual) => ({
  ...(await importActual()),
  isImprovementEnabled: (...args) => isImprovementEnabled(...args),
}));

const { drainProgrammaticOnDemandRequests } = await import('./cosTaskGenerator.js');
const { cosEvents } = await import('./cosEvents.js');

// Returns the removed record to the caller that actually took it, and null to a
// loser — the claim the drain gates its run on.
const clearOnDemandRequest = vi.fn(async (id) => ({ id }));
const recordExecution = vi.fn(async () => {});
const taskScheduleMod = { clearOnDemandRequest, recordExecution };

const DESCRIBE_SETTINGS = { universeId: 'u1', scope: 'characters', depth: 'core', maxEntries: 4 };
const schedule = (overrides = {}) => ({
  tasks: {
    'universe-bible-describe': {
      enabled: true, providerId: 'codex', model: 'gpt-5', effort: 'high',
      taskMetadata: DESCRIBE_SETTINGS, ...overrides,
    },
    security: { enabled: true },
  },
});
const request = (taskType = 'universe-bible-describe') => ({ id: 'demand-1', taskType });

beforeEach(() => {
  vi.clearAllMocks();
  isImprovementEnabled.mockReturnValue(true);
  clearOnDemandRequest.mockImplementation(async (id) => ({ id }));
  runScheduledHandler.mockResolvedValue({ dispatched: true, summary: 'Described 3 bible entries' });
});

describe('drainProgrammaticOnDemandRequests', () => {
  it('runs a disabled schedule manually with saved settings and no probe context', async () => {
    const handled = await drainProgrammaticOnDemandRequests({
      taskScheduleMod, requests: [request()], schedule: schedule({ enabled: false }), state: {},
    });

    expect(handled.has('demand-1')).toBe(true);
    expect(runScheduledHandler).toHaveBeenCalledWith({
      taskType: 'universe-bible-describe',
      params: DESCRIBE_SETTINGS,
      job: { model: 'gpt-5', effort: 'high', providerId: 'codex' },
      // A manual Run is explicit consent for THIS work, so it ignores the
      // in-flight cooldown; with no probe to reuse the handler does its own scan.
      force: true,
    });
    // The request is cleared BEFORE the handler runs, so a crash mid-run can't
    // leave a request that re-fires the same batch on the next tick.
    expect(clearOnDemandRequest).toHaveBeenCalledWith('demand-1');
    expect(recordExecution).toHaveBeenCalledWith('task:universe-bible-describe');
  });

  it('reports what it did so an explicit Run is not a silent no-op', async () => {
    await drainProgrammaticOnDemandRequests({
      taskScheduleMod, requests: [request()], schedule: schedule(), state: {},
    });
    expect(cosEvents.emit).toHaveBeenCalledWith('schedule:on-demand-handled', {
      requestId: 'demand-1',
      taskType: 'universe-bible-describe',
      dispatched: true,
      summary: 'Described 3 bible entries',
      reason: null,
    });
  });

  it('passes a decline through as the handler\'s own reason', async () => {
    runScheduledHandler.mockResolvedValue({ dispatched: false, reason: 'every bible entry is already described' });
    await drainProgrammaticOnDemandRequests({
      taskScheduleMod, requests: [request()], schedule: schedule(), state: {},
    });
    expect(cosEvents.emit).toHaveBeenCalledWith('schedule:on-demand-handled', expect.objectContaining({
      dispatched: false, reason: 'every bible entry is already described', summary: null,
    }));
  });

  it('clears an automated refill when the type was disabled after queuing', async () => {
    const handled = await drainProgrammaticOnDemandRequests({
      taskScheduleMod, requests: [{ ...request(), origin: 'refill' }], schedule: schedule({ enabled: false }), state: {},
    });
    // Still "handled" — the engines must skip it, not fall through and try to
    // generate an agent task for a type that has no prompt.
    expect(handled.has('demand-1')).toBe(true);
    expect(clearOnDemandRequest).toHaveBeenCalledWith('demand-1');
    expect(runScheduledHandler).not.toHaveBeenCalled();
  });

  it('drops the request without spending when Improve is switched off', async () => {
    isImprovementEnabled.mockReturnValue(false);
    await drainProgrammaticOnDemandRequests({
      taskScheduleMod, requests: [request()], schedule: schedule(), state: {},
    });
    expect(clearOnDemandRequest).toHaveBeenCalledWith('demand-1');
    expect(runScheduledHandler).not.toHaveBeenCalled();
  });

  it('leaves ordinary agent task types to the engines', async () => {
    const handled = await drainProgrammaticOnDemandRequests({
      taskScheduleMod, requests: [request('security')], schedule: schedule(), state: {},
    });
    expect(handled.size).toBe(0);
    expect(clearOnDemandRequest).not.toHaveBeenCalled();
    // Nothing is imported or run for a request this drain does not own.
    expect(runScheduledHandler).not.toHaveBeenCalled();
  });
});

describe('drainProgrammaticOnDemandRequests — cross-engine claim', () => {
  it('does not run when the sibling engine already took the request', async () => {
    // Both on-demand engines drain their OWN snapshot with no shared lock, so
    // the same request can be in both. `clearOnDemandRequest` returns the record
    // only to the caller that removed it; a drain that ignored that would spend
    // two describe/render batches (and toast twice) for one Run Now click.
    clearOnDemandRequest.mockResolvedValue(null);

    const handled = await drainProgrammaticOnDemandRequests({
      taskScheduleMod, requests: [request()], schedule: schedule(), state: {},
    });

    expect(handled.has('demand-1')).toBe(true);
    expect(runScheduledHandler).not.toHaveBeenCalled();
    expect(recordExecution).not.toHaveBeenCalled();
    expect(cosEvents.emit).not.toHaveBeenCalled();
  });
});
