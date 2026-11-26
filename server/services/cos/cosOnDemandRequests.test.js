import { describe, it, expect, beforeEach, vi } from 'vitest';
import { drainProgrammaticOnDemandRequests, emitOnDemandEmpty } from './cosOnDemandRequests.js';
import { cosEvents } from './cosEvents.js';
import { runScheduledHandler } from '../scheduledHandlers/index.js';
import { checkGhHealth as ghHealth } from '../github.js';
import * as apps from '../apps.js';
import * as taskStore from './cosTaskStore.js';

vi.mock('../scheduledHandlers/index.js', () => ({ runScheduledHandler: vi.fn() }));
vi.mock('../github.js', async (importActual) => ({
  ...(await importActual()),
  checkGhHealth: vi.fn(),
}));

const improvementOn = { config: { improvementEnabled: true } };
const improvementOff = { config: { improvementEnabled: false } };
const emit = vi.spyOn(cosEvents, 'emit');
const eventsFor = (type) => emit.mock.calls.filter(([event]) => event === type).map(([, payload]) => payload);

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
  clearOnDemandRequest.mockImplementation(async (id) => ({ id }));
  runScheduledHandler.mockResolvedValue({ dispatched: true, summary: 'Described 3 bible entries' });
});

describe('drainProgrammaticOnDemandRequests', () => {
  it('runs a disabled schedule manually with saved settings and no probe context', async () => {
    const handled = await drainProgrammaticOnDemandRequests({
      taskScheduleMod, requests: [request()], schedule: schedule({ enabled: false }), state: improvementOn,
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
    expect(recordExecution).toHaveBeenCalledWith('task:universe-bible-describe');
  });

  it('reports what it did so an explicit Run is not a silent no-op', async () => {
    await drainProgrammaticOnDemandRequests({
      taskScheduleMod, requests: [request()], schedule: schedule(), state: improvementOn,
    });
    expect(emit).toHaveBeenCalledWith('schedule:on-demand-handled', {
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
      taskScheduleMod, requests: [request()], schedule: schedule(), state: improvementOn,
    });
    expect(emit).toHaveBeenCalledWith('schedule:on-demand-handled', expect.objectContaining({
      dispatched: false, reason: 'every bible entry is already described', summary: null,
    }));
  });

  it('clears an automated refill when the type was disabled after queuing', async () => {
    const handled = await drainProgrammaticOnDemandRequests({
      taskScheduleMod, requests: [{ ...request(), origin: 'refill' }], schedule: schedule({ enabled: false }), state: improvementOn,
    });
    // Still "handled" — the engines must skip it, not fall through and try to
    // generate an agent task for a type that has no prompt.
    expect(handled.has('demand-1')).toBe(true);
    expect(clearOnDemandRequest).toHaveBeenCalledWith('demand-1');
    expect(runScheduledHandler).not.toHaveBeenCalled();
  });

  it('drops the request without spending when Improve is switched off', async () => {
    await drainProgrammaticOnDemandRequests({
      taskScheduleMod, requests: [request()], schedule: schedule(), state: improvementOff,
    });
    expect(clearOnDemandRequest).toHaveBeenCalledWith('demand-1');
    expect(runScheduledHandler).not.toHaveBeenCalled();
  });

  it('leaves ordinary agent task types to the engines', async () => {
    const handled = await drainProgrammaticOnDemandRequests({
      taskScheduleMod, requests: [request('security')], schedule: schedule(), state: improvementOn,
    });
    expect(handled.size).toBe(0);
    expect(clearOnDemandRequest).not.toHaveBeenCalled();
    // Nothing is imported or run for a request this drain does not own.
    expect(runScheduledHandler).not.toHaveBeenCalled();
  });
});

it('clears a manual request whose task configuration has been removed', async () => {
  const handled = await drainProgrammaticOnDemandRequests({
    taskScheduleMod, requests: [request()], schedule: { tasks: {} }, state: improvementOn,
  });

  expect(handled).toEqual(new Set(['demand-1']));
  expect(clearOnDemandRequest).toHaveBeenCalledExactlyOnceWith('demand-1');
  expect(recordExecution).not.toHaveBeenCalled();
  expect(runScheduledHandler).not.toHaveBeenCalled();
});

it('only runs and reports the programmatic request once across both engine snapshots', async () => {
  const agentRequest = { id: 'agent-demand', taskType: 'security' };
  const programmaticRequest = request();
  const queued = new Map([agentRequest, programmaticRequest].map(item => [item.id, item]));
  clearOnDemandRequest.mockImplementation(async (id) => {
    await Promise.resolve();
    const item = queued.get(id);
    queued.delete(id);
    return item ?? null;
  });
  runScheduledHandler.mockImplementationOnce(async () => {
    expect(queued.has(programmaticRequest.id)).toBe(false);
    return { dispatched: true };
  });
  const drain = () => drainProgrammaticOnDemandRequests({
    taskScheduleMod, requests: [...queued.values()], schedule: schedule(), state: improvementOn,
  });

  const handled = await Promise.all([drain(), drain()]);

  expect(handled).toEqual([new Set([programmaticRequest.id]), new Set([programmaticRequest.id])]);
  expect([...queued.values()]).toEqual([agentRequest]);
  expect(clearOnDemandRequest.mock.calls).toEqual([[programmaticRequest.id], [programmaticRequest.id]]);
  expect(recordExecution).toHaveBeenCalledExactlyOnceWith('task:universe-bible-describe');
  expect(runScheduledHandler).toHaveBeenCalledTimes(1);
  expect(eventsFor('schedule:on-demand-handled')).toHaveLength(1);
});

it('runs the opted-in maintenance handler independently of the Improve toggle', async () => {
  await drainProgrammaticOnDemandRequests({
    taskScheduleMod, requests: [request('development-watchdog')],
    schedule: { tasks: { 'development-watchdog': { enabled: true } } }, state: improvementOff,
  });
  expect(runScheduledHandler).toHaveBeenCalledWith(expect.objectContaining({ taskType: 'development-watchdog' }));
});

describe('emitOnDemandEmpty', () => {
  const stubMod = { getPerpetualParkInfo: async () => null };

  it('reports an ordinary run with no work as idle', async () => {
    await emitOnDemandEmpty({
      taskScheduleMod: stubMod,
      request: { id: 'req-1', taskType: 'pr-watcher' },
      targetApp: { id: 'app-1', name: 'App One' },
      taskConfig: { type: 'cron', cronExpression: '0 7 * * *' },
    });

    expect(eventsFor('schedule:on-demand-empty')).toEqual([
      expect.objectContaining({ taskType: 'pr-watcher', outcome: 'idle', reason: null }),
    ]);
  });

  it.each([
    ['manual', { shouldRun: false, reason: 'on-demand-only' }, null],
    ['disabled app', { shouldRun: false, reason: 'disabled-for-app' }, null],
    ['disabled task', { shouldRun: false, reason: 'disabled' }, null],
    ['app cron', { shouldRun: false, reason: 'cron-cooldown', nextRunAt: '2999-01-02T00:00:00Z' }, '2999-01-02T00:00:00Z'],
  ])('emits only the actual automatic retry for %s', async (_name, readiness, expected) => {
    const shouldRunTask = vi.fn(async () => readiness);
    await emitOnDemandEmpty({
      taskScheduleMod: {
        shouldRunTask,
        getPerpetualParkInfo: async () => ({
          parkedUntil: '2999-01-01T00:00:00Z', parkReason: 'branches-blocked', parkActionableCount: 0,
          parkCounts: { heldDetached: 1 }, parkSkipCauses: { 'worktree-locked': 1 },
        }),
      },
      request: { id: 'retry-test', taskType: 'branch-reconcile' },
      targetApp: { id: 'app-1', name: 'Example App' },
      taskConfig: { enabled: true, type: 'on-demand', perpetual: false },
    });

    expect(shouldRunTask).toHaveBeenCalledExactlyOnceWith('branch-reconcile', 'app-1');
    expect(eventsFor('schedule:on-demand-empty')).toEqual([
      expect.objectContaining({
        outcome: 'parked', nextAutoRecheckAt: expected, actionableCount: 0,
        counts: { heldDetached: 1 }, skipCauses: { 'worktree-locked': 1 },
      }),
    ]);
  });

  // Keep the forge probe offline in every case.
  beforeEach(() => {
    ghHealth.mockReset();
    ghHealth.mockResolvedValue({ status: 'ok', ok: true, detail: null, remedy: null });
  });

  const emitTransient = async (taskType, skip = null, perpetual = true) => {
    await emitOnDemandEmpty({
      taskScheduleMod: stubMod,
      request: { id: 'req-2', taskType },
      targetApp: { id: 'app-1', name: 'App One' },
      taskConfig: { type: 'on-demand', perpetual },
      skip,
    });
    return eventsFor('schedule:on-demand-empty').at(-1);
  };

  it('reports reviewer identity trouble even if the app has an older park', async () => {
    const reason = 'Verify the configured reviewer';
    await emitOnDemandEmpty({
      taskScheduleMod: {
        getPerpetualParkInfo: async () => ({ parkReason: 'empty' }),
        shouldRunTask: async () => ({ shouldRun: false }),
      },
      request: { id: 'reviewer-request', taskType: 'claim-issue' },
      targetApp: { id: 'example-app', name: 'Example App' },
      skip: { gate: 'reviewer-identity', reason },
    });

    expect(emit).toHaveBeenCalledWith('schedule:on-demand-empty', expect.objectContaining({
      outcome: 'transient', reason, forge: { cli: 'reviewer identity', remedy: reason },
    }));
    expect(ghHealth).not.toHaveBeenCalled();
  });

  it('uses the task type to classify a failed park read and leaves retry details empty', async () => {
    const shouldRunTask = vi.fn();
    await emitOnDemandEmpty({
      taskScheduleMod: {
        getPerpetualParkInfo: vi.fn().mockRejectedValue(new Error('Schedule unavailable')),
        shouldRunTask,
      },
      request: { id: 'global-request', taskType: 'branch-reconcile' },
    });

    expect(emit).toHaveBeenCalledWith('schedule:on-demand-empty', {
      requestId: 'global-request', taskType: 'branch-reconcile', appId: null, appName: null,
      outcome: 'transient', reason: null, forge: null, parkReason: null, parkedUntil: null,
      nextAutoRecheckAt: null, actionableCount: null, counts: null, skipCauses: null,
    });
    expect(shouldRunTask).not.toHaveBeenCalled();
  });

  it('emits no forge block when the gate recorded no transient verdict', async () => {
    // Nothing recorded ⇒ we cannot name the fault, so the client keeps the
    // generic "try again shortly" copy rather than guessing at a CLI.
    expect(await emitTransient('claim-issue')).toMatchObject({ outcome: 'transient', forge: null });
  });

  it('treats a one-shot branch sweep as detector-driven for transient feedback', async () => {
    const skip = { gate: 'perpetual-work', cli: null, reason: 'probe-failed', remedy: null, detail: null };
    expect(await emitTransient('branch-reconcile', skip, false)).toMatchObject({ taskType: 'branch-reconcile', outcome: 'transient', forge: null });
  });

  it('skips the gh probe for a non-gh transient verdict, so a glab/git fault never toasts a gh remedy', async () => {
    // branch-reconcile and quota-burn go transient over git / provider faults with
    // no forge at all (cli: null); claim-issue-gitlab fails on glab. None of them
    // should be attributed to gh — the pre-fix suffix check got all three wrong.
    for (const [taskType, cli] of [['claim-issue-gitlab', 'glab'], ['branch-reconcile', null], ['quota-burn', null]]) {
      const skip = { gate: 'perpetual-work', cli, reason: 'probe-failed', remedy: null, detail: null };
      expect(await emitTransient(taskType, skip)).toMatchObject({ outcome: 'transient', forge: null });
    }
    expect(ghHealth).not.toHaveBeenCalled();
  });

  it('names gh + its remedy when a gh verdict meets a gh that is broken for good', async () => {
    ghHealth.mockResolvedValueOnce({
      status: 'unreachable', ok: false, detail: 'bad file descriptor', remedy: 'Allow the gh binary outbound.'
    });
    expect(await emitTransient('claim-issue', { gate: 'perpetual-work', cli: 'gh', reason: 'gh-list-failed', remedy: null, detail: null })).toMatchObject({
      outcome: 'transient',
      forge: { cli: 'gh', remedy: 'Allow the gh binary outbound.' }
    });
  });

  it('stays generic when gh itself is healthy — that failure really was a blip', async () => {
    expect(await emitTransient('claim-issue', { gate: 'perpetual-work', cli: 'gh', reason: 'gh-list-failed', remedy: null, detail: null })).toMatchObject({ forge: null });
  });

  it('passes a remedy the detector already named straight through, without asking gh', async () => {
    // A per-repo permission the token lacks passes checkGhHealth's global-auth
    // probe, so consulting it would drop the remedy this channel exists to carry.
    expect(await emitTransient('claim-issue', { gate: 'perpetual-work', cli: 'gh', reason: 'gh-list-failed', detail: null, remedy: 'Grant the token collaborator read.' })).toMatchObject({
      forge: { cli: 'gh', remedy: 'Grant the token collaborator read.' }
    });
    expect(ghHealth).not.toHaveBeenCalled();
  });

  it('ignores a skip from a different gate, so only the work detector\'s verdict names a forge fault', async () => {
    ghHealth.mockResolvedValue({ status: 'not-installed', ok: false, detail: null, remedy: 'Install gh.' });
    expect(await emitTransient('claim-issue', { gate: 'precondition', cli: 'gh', reason: null, remedy: null, detail: null })).toMatchObject({ forge: null });
    expect(ghHealth).not.toHaveBeenCalled();
  });

  it('reads the latest layered-intelligence skip reason only for an idle run', async () => {
    const app = { id: 'app-1', layeredIntelligence: { lastRunReason: 'stale reason' } };
    const getApp = vi.spyOn(apps, 'getAppById').mockResolvedValue({
      id: app.id, layeredIntelligence: { lastRunReason: 'Choose a CLI provider' },
    });
    try {
      for (const [taskType, perpetual] of [['layered-intelligence', false], ['security', false], ['layered-intelligence', true]]) {
        await emitOnDemandEmpty({
          taskScheduleMod: { getPerpetualParkInfo: async () => null }, targetApp: app,
          request: { id: 'request', taskType }, taskConfig: { perpetual },
        });
      }
      expect(eventsFor('schedule:on-demand-empty').map(event => [event.outcome, event.reason])).toEqual([
        ['idle', 'Choose a CLI provider'], ['idle', null], ['transient', null],
      ]);
      expect(getApp).toHaveBeenCalledExactlyOnceWith(app.id);
    } finally {
      getApp.mockRestore();
    }
  });

  it("surfaces the pr-reviewer's security refusal and records a completed diagnostic", async () => {
    const persist = vi.spyOn(taskStore, 'addTask').mockResolvedValue({ id: 'diagnostic' });
    try {
      await emitOnDemandEmpty({
        taskScheduleMod: stubMod,
        request: { id: 'req-pr-reviewer', taskType: 'pr-reviewer', targetPullRequest: 42 },
        targetApp: { id: 'app-1', name: 'Example App' },
        skip: { gate: 'security-preflight', reason: 'security-guard-not-ready' },
      });

      expect(emit).toHaveBeenCalledWith('schedule:on-demand-empty', expect.objectContaining({
        taskType: 'pr-reviewer', outcome: 'idle', reason: 'security-guard-not-ready',
      }));
      expect(persist).toHaveBeenCalledWith(expect.objectContaining({
        status: 'completed',
        metadata: expect.objectContaining({
          targetPullRequest: 42, preflightFailure: 'security-guard-not-ready',
          note: expect.stringContaining('before an agent started'),
        }),
      }), 'internal', { raw: true, suppressDequeue: true });
    } finally {
      persist.mockRestore();
    }
  });

  it.each([
    ['none', null, null],
    ['later gate', { gate: 'precondition', reason: 'ignored' }, null],
    ['pending report', { gate: 'security-preflight', reason: 'security-scan-report-pending' }, 'security-scan-report-pending'],
  ])('reports the pr-reviewer reason for %s without minting a diagnostic', async (_name, skip, reason) => {
    const persist = vi.spyOn(taskStore, 'addTask').mockResolvedValue({ id: 'diagnostic' });
    try {
      await emitOnDemandEmpty({
        taskScheduleMod: stubMod,
        request: { id: 'req-b', taskType: 'pr-reviewer' },
        targetApp: { id: 'app-1', name: 'Example App' },
        skip,
      });

      expect(emit).toHaveBeenCalledWith('schedule:on-demand-empty', expect.objectContaining({ reason }));
      expect(persist).not.toHaveBeenCalled();
    } finally {
      persist.mockRestore();
    }
  });
});
