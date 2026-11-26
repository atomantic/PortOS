/**
 * Tests for cosJobScheduler.js — the same-tick daily-action budget race (#984).
 *
 * The per-domain CoS daily action budget is enforced in executeScheduledJob from
 * recorded usage + an in-flight count. Before #984 there was a narrow same-process
 * window: a second scheduled job that read the budget gate while a first job was
 * parked AFTER passing the gate but BEFORE being counted could also pass — agent
 * jobs reserve `spawningJobIds` only after the `checkJobGate` await, and inline
 * script/shell jobs record usage only post-execution. A `maxActionsPerDay: 1` cap
 * could therefore be overshot by one. #984 adds a synchronous reservation counter,
 * bumped the instant a job is admitted to fire (before any further await) and
 * included in the gate's in-flight term, so a second job in that window sees the
 * reservation and is withheld.
 *
 * These tests reproduce the await interleaving in executeScheduledJob by
 * parking the first job at its first post-reservation await, then running the
 * second job to completion while the first sits in the window. The only un-mocked
 * dependency is the pure `remainingActionBudget` math — everything with I/O is
 * mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let daemonRunning = true;
const sharedState = {
  paused: false,
  config: { autonomousJobsEnabled: true, maxConcurrentAgents: 5 },
  agents: {},
};

// A manually-resolved deferred — lets a test park one call at a chosen await and
// release it after the other call has run, modelling the exact race interleaving.
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

vi.mock('../eventScheduler.js', () => ({
  schedule: vi.fn(),
  cancel: vi.fn(),
  getEvent: vi.fn(() => null),
  parseCronToNextRun: vi.fn(() => new Date(0)),
}));
vi.mock('../../lib/timezone.js', () => ({
  getLocalParts: vi.fn(() => ({ dayOfWeek: 1 })),
  nextLocalTime: vi.fn((ms) => ms),
}));
vi.mock('../userTimezone.js', () => ({
  getUserTimezone: vi.fn().mockResolvedValue('UTC'),
}));
vi.mock('../../lib/fileUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  formatDuration: vi.fn(() => '1h'),
}));
vi.mock('./cosState.js', () => ({
  loadState: vi.fn(async () => sharedState),
  isDaemonRunning: vi.fn(() => daemonRunning),
  canQueueImprovementTasks: vi.fn(() => false),
}));
vi.mock('../../lib/domainAutonomy.js', () => ({
  getDomainMode: vi.fn(() => 'execute'),
  DOMAIN_IDS: ['brain', 'memory', 'cos', 'messages'],
}));
// remainingActionBudget is pure — keep it REAL so the gate math is the math.
vi.mock('../domainUsage.js', () => ({
  getDomainBudgetStatus: vi.fn(),
  recordDomainUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./cosEvents.js', () => ({
  cosEvents: { emit: vi.fn() },
  emitLog: vi.fn(),
}));
vi.mock('./cosTaskStore.js', () => ({ getCosTasks: vi.fn() }));
vi.mock('./cosImprovementTasks.js', () => ({ queueEligibleImprovementTasks: vi.fn() }));

const generateTaskFromJob = vi.fn(async (job) => ({ id: `task-${job.id}`, description: job.name }));
const executeScriptJob = vi.fn().mockResolvedValue(undefined);
const executeShellJob = vi.fn().mockResolvedValue(undefined);
const recordJobGateSkip = vi.fn().mockResolvedValue(undefined);
const recordJobBlockedConfig = vi.fn().mockResolvedValue(undefined);
const clearJobBlockedConfig = vi.fn().mockResolvedValue(undefined);
const setJobUnreachableRetryStep = vi.fn().mockResolvedValue(undefined);
const runJobPreflight = vi.fn();
const recordJobFailureIncident = vi.fn().mockResolvedValue({ alerted: true });
const resolveJobIncidents = vi.fn().mockResolvedValue([]);
const checkJobGate = vi.fn().mockResolvedValue({ shouldRun: true, reason: 'ok' });
vi.mock('../autonomousJobs.js', () => ({
  generateTaskFromJob: (...a) => generateTaskFromJob(...a),
  recordJobGateSkip: (...a) => recordJobGateSkip(...a),
  recordJobBlockedConfig: (...a) => recordJobBlockedConfig(...a),
  clearJobBlockedConfig: (...a) => clearJobBlockedConfig(...a),
  setJobUnreachableRetryStep: (...a) => setJobUnreachableRetryStep(...a),
  isScriptJob: (job) => job?.type === 'script',
  executeScriptJob: (...a) => executeScriptJob(...a),
  isShellJob: (job) => job?.type === 'shell',
  executeShellJob: (...a) => executeShellJob(...a),
  // Dynamically imported inside executeScheduledJob — return a job built from the
  // requested id so two distinct ids model two distinct same-tick jobs.
  getJob: vi.fn(async (jobId) => ({
    id: jobId,
    name: jobId,
    enabled: true,
    category: 'test',
    intervalMs: 86_400_000,
    type: globalThis.__nextJobType || 'agent',
  })),
}));
vi.mock('../autonomousJobs/preflight.js', () => ({
  runJobPreflight: (...a) => runJobPreflight(...a),
}));
vi.mock('../autonomousJobs/incidents.js', () => ({
  recordJobFailureIncident: (...a) => recordJobFailureIncident(...a),
  resolveJobIncidents: (...a) => resolveJobIncidents(...a),
}));
vi.mock('../jobGates.js', () => ({
  checkJobGate: (...a) => checkJobGate(...a),
  hasGate: vi.fn(() => false),
}));

import {
  scheduleNextImprovementCheck,
  executeScheduledJob,
  getScheduledActionReservations,
  clearSpawningJob,
  registerSingleJobSchedule,
  handleJobSpawnFailed,
  handleJobAgentCompleted,
} from './cosJobScheduler.js';
import { schedule as scheduleEvent, cancel as cancelEvent, getEvent as getScheduledEvent } from '../eventScheduler.js';
vi.mock('../taskSchedule.js', () => ({ getUpcomingTasks: vi.fn() }));
import { getUpcomingTasks } from '../taskSchedule.js';
import { getJob } from '../autonomousJobs.js';
import { emitLog } from './cosEvents.js';
import { getDomainBudgetStatus } from '../domainUsage.js';
import { getDomainMode } from '../../lib/domainAutonomy.js';
import { canQueueImprovementTasks } from './cosState.js';
import { queueEligibleImprovementTasks } from './cosImprovementTasks.js';

beforeEach(() => {
  daemonRunning = true;
  sharedState.agents = {};
  globalThis.__nextJobType = 'agent';
  generateTaskFromJob.mockClear();
  executeScriptJob.mockClear();
  executeShellJob.mockClear();
  recordJobGateSkip.mockClear();
  recordJobBlockedConfig.mockClear();
  clearJobBlockedConfig.mockClear();
  setJobUnreachableRetryStep.mockClear();
  recordJobFailureIncident.mockClear();
  resolveJobIncidents.mockClear();
  runJobPreflight.mockReset();
  runJobPreflight.mockResolvedValue({ ok: true });
  checkJobGate.mockReset();
  checkJobGate.mockResolvedValue({ shouldRun: true, reason: 'ok' });
  // maxActionsPerDay:1, nothing recorded yet — the exact same-tick boundary.
  getDomainBudgetStatus.mockResolvedValue({
    withinBudget: true,
    exceeded: null,
    budget: { maxActionsPerDay: 1, maxMinutesPerDay: null },
    usage: { actions: 0, ms: 0 },
  });
});

afterEach(() => {
  // Success paths leave the job in spawningJobIds (+ a 5-min timeout); clear so the
  // module-level set and timer don't leak across tests.
  clearSpawningJob('job-a');
  clearSpawningJob('job-b');
  clearSpawningJob('job-fail');
  clearSpawningJob('script-a');
  clearSpawningJob('script-b');
  clearSpawningJob('script-fail');
  clearSpawningJob('shell-fail');
  delete globalThis.__nextJobType;
});

describe('executeScheduledJob — same-tick daily-action budget race (#984)', () => {
  it('a second AGENT job in the post-gate window is withheld (maxActionsPerDay:1)', async () => {
    // Park job-a at checkJobGate — its FIRST await after the budget gate passed
    // and (with the fix) after the synchronous reservation was taken, but BEFORE
    // addSpawningJob counts it. Distinct ids so the `spawningJobIds.has` guard
    // can't be what stops job-b — only the reservation gate should.
    const gateReached = deferred();
    const releaseGate = deferred();
    checkJobGate.mockImplementation(async (jobId) => {
      if (jobId === 'job-a') {
        gateReached.resolve();
        await releaseGate.promise;
      }
      return { shouldRun: true, reason: 'ok' };
    });

    const pA = executeScheduledJob('job-a');
    await gateReached.promise; // job-a now sits in the race window

    // job-b reads the budget gate while job-a is parked. Buggy code: remaining is
    // still 1 (job-a not yet in spawningJobIds), so job-b fires too → two spawns.
    // Fixed code: job-b sees the reservation, is over budget, and is withheld.
    await executeScheduledJob('job-b');

    releaseGate.resolve();
    await pA;

    expect(generateTaskFromJob).toHaveBeenCalledTimes(1);
    expect(generateTaskFromJob).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-a' }));
  });

  it('a second SCRIPT job in the post-record window is withheld (maxActionsPerDay:1)', async () => {
    globalThis.__nextJobType = 'script';
    // Script jobs reach their first post-reservation await at executeScriptJob
    // (recordDomainUsage runs only after it resolves). Park job-a there.
    const execReached = deferred();
    const releaseExec = deferred();
    executeScriptJob.mockImplementation(async (job) => {
      if (job.id === 'script-a') {
        execReached.resolve();
        await releaseExec.promise;
      }
    });

    const pA = executeScheduledJob('script-a');
    await execReached.promise;

    await executeScheduledJob('script-b');

    releaseExec.resolve();
    await pA;

    expect(executeScriptJob).toHaveBeenCalledTimes(1);
    expect(executeScriptJob).toHaveBeenCalledWith(expect.objectContaining({ id: 'script-a' }));
  });

  it('releases the reservation on every exit path (counter settles to zero)', async () => {
    const gateReached = deferred();
    const releaseGate = deferred();
    checkJobGate.mockImplementation(async (jobId) => {
      if (jobId === 'job-a') {
        gateReached.resolve();
        await releaseGate.promise;
      }
      return { shouldRun: true, reason: 'ok' };
    });

    const pA = executeScheduledJob('job-a');
    await gateReached.promise;
    // While job-a is parked the reservation is live (the window the gate read).
    expect(getScheduledActionReservations()).toBe(1);

    await executeScheduledJob('job-b'); // withheld path releases its reservation
    releaseGate.resolve();
    await pA; // handoff to spawningJobIds releases job-a's reservation

    expect(getScheduledActionReservations()).toBe(0);
  });

  it('a single job still fires when the budget has room for exactly one', async () => {
    await executeScheduledJob('job-a');
    expect(generateTaskFromJob).toHaveBeenCalledTimes(1);
    expect(getScheduledActionReservations()).toBe(0);
  });
});

describe('executeScheduledJob — execution failure advances schedule to avoid rapid loop', () => {
  it('defers an active audit without emitting an incident or creating another occurrence', async () => {
    emitLog.mockClear();
    generateTaskFromJob.mockRejectedValueOnce(Object.assign(new Error('Audit already active'), { status: 409, code: 'AUDIT_ACTIVE' }));
    await executeScheduledJob('job-fail');
    expect(recordJobGateSkip).toHaveBeenCalledWith('job-fail');
    expect(emitLog).toHaveBeenCalledWith('info', expect.stringContaining('Autonomous job withheld'), expect.any(Object));
    expect(emitLog.mock.calls.some(([level]) => level === 'error')).toBe(false);
    expect(getScheduledActionReservations()).toBe(0);
  });

  it('calls recordJobGateSkip when generateTaskFromJob throws', async () => {
    generateTaskFromJob.mockRejectedValueOnce(new Error('Prompt template broken'));
    await executeScheduledJob('job-fail');
    expect(recordJobGateSkip).toHaveBeenCalledWith('job-fail');
    expect(getScheduledActionReservations()).toBe(0);
  });

  it('calls recordJobGateSkip when executeScriptJob fails', async () => {
    globalThis.__nextJobType = 'script';
    executeScriptJob.mockRejectedValueOnce(new Error('Syntax error in job script'));
    await executeScheduledJob('script-fail');
    expect(recordJobGateSkip).toHaveBeenCalledWith('script-fail');
    expect(getScheduledActionReservations()).toBe(0);
  });

  it('calls recordJobGateSkip when executeShellJob fails', async () => {
    globalThis.__nextJobType = 'shell';
    executeShellJob.mockRejectedValueOnce(new Error('Command failed: exit 1'));
    await executeScheduledJob('shell-fail');
    expect(recordJobGateSkip).toHaveBeenCalledWith('shell-fail');
    expect(getScheduledActionReservations()).toBe(0);
  });
});

describe('registerSingleJobSchedule', () => {
  it('cancels a disabled job instead of registering a recurring timer', async () => {
    scheduleEvent.mockClear();
    cancelEvent.mockClear();
    getJob.mockResolvedValueOnce({ id: 'job-disabled', enabled: false });

    await registerSingleJobSchedule('job-disabled');

    expect(cancelEvent).toHaveBeenCalledWith('job:job-disabled');
    expect(scheduleEvent).not.toHaveBeenCalled();
  });

  // #6375 — this is the scheduler that actually arms the timer. An on-demand
  // job stays enabled (so POST /jobs/:id/trigger still runs it) but must never
  // be given a fire time; before the cadence existed, a null intervalMs reached
  // `lastRun + intervalMs` and produced a bogus delay instead.
  it('arms no timer for an enabled on-demand job, and cancels any stale one', async () => {
    scheduleEvent.mockClear();
    cancelEvent.mockClear();
    getJob.mockResolvedValueOnce({
      id: 'job-on-demand',
      name: 'Manual only',
      enabled: true,
      interval: 'on-demand',
      intervalMs: null,
    });

    await registerSingleJobSchedule('job-on-demand');

    expect(scheduleEvent).not.toHaveBeenCalled();
    expect(cancelEvent).toHaveBeenCalledWith('job:job-on-demand');
  });

  it('a weekdaysOnly on-demand job with a stale scheduledTime still arms no timer', async () => {
    // The synthesized daily/weekday cron path keys on weekdaysOnly, so it would
    // otherwise capture an on-demand job that carried those fields over.
    scheduleEvent.mockClear();
    cancelEvent.mockClear();
    getJob.mockResolvedValueOnce({
      id: 'job-on-demand-weekday',
      name: 'Manual only',
      enabled: true,
      interval: 'on-demand',
      intervalMs: null,
      weekdaysOnly: true,
      scheduledTime: '04:30',
    });

    await registerSingleJobSchedule('job-on-demand-weekday');

    expect(scheduleEvent).not.toHaveBeenCalled();
  });

  it('still arms a timer for a recurring job', async () => {
    scheduleEvent.mockClear();
    getJob.mockResolvedValueOnce({
      id: 'job-daily',
      name: 'Daily',
      enabled: true,
      interval: 'daily',
      intervalMs: 86_400_000,
    });

    await registerSingleJobSchedule('job-daily');

    expect(scheduleEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job:job-daily', type: 'once' })
    );
    expect(scheduleEvent.mock.calls[0][0].delayMs).toBeGreaterThan(0);
  });
});

it('wakes at a future app deadline even while the task is ready for another app', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T16:00:00Z'));
  try {
    getUpcomingTasks.mockResolvedValue([{ taskType: 'do-release', status: 'ready', eligibleIn: 0,
      nextScheduledAt: Date.now() + 300000 }]);
    await scheduleNextImprovementCheck();
    expect(scheduleEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      id: 'cos-improvement-check', delayMs: 300000
    }));
  } finally {
    vi.useRealTimers();
  }
});

// #7527: getUpcomingTasks now REJECTS (rather than swallowing input failures
// into a misleadingly "complete" []) when app inventory/override/readiness
// reads fail. cosJobScheduler owns that failure — it must retry soon instead
// of falling back to the 1h default, which could sleep through a cron minute.
it.each([false, true])('the improvement timer honors scheduler queue admission (%s)', async allowed => {
  getScheduledEvent.mockReturnValue(null);
  getUpcomingTasks.mockResolvedValue([]);
  canQueueImprovementTasks.mockReturnValueOnce(allowed);
  queueEligibleImprovementTasks.mockClear();

  await scheduleNextImprovementCheck();
  await scheduleEvent.mock.lastCall[0].handler();

  expect(queueEligibleImprovementTasks).toHaveBeenCalledTimes(allowed ? 1 : 0);
  expect(scheduleEvent.mock.lastCall[0].id).toBe('cos-improvement-check');
});

describe('scheduleNextImprovementCheck — getUpcomingTasks input failure (#7527)', () => {
  beforeEach(async () => {
    // Reset the module-level "input unavailable" transition flag to a known
    // state (false) before each test, so the log-once assertions below don't
    // depend on execution order with other tests in this file.
    getScheduledEvent.mockReturnValue(null);
    getUpcomingTasks.mockResolvedValueOnce([]);
    await scheduleNextImprovementCheck();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('arms a short retry instead of the 1h fallback, and logs the outage once (not per consecutive failure)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    scheduleEvent.mockClear();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    getUpcomingTasks.mockRejectedValueOnce(new Error('inventory read failed'));
    await scheduleNextImprovementCheck();
    expect(scheduleEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      id: 'cos-improvement-check', delayMs: 15000
    }));
    expect(errSpy).toHaveBeenCalledTimes(1);

    getUpcomingTasks.mockRejectedValueOnce(new Error('still down'));
    await scheduleNextImprovementCheck();
    expect(errSpy).toHaveBeenCalledTimes(1);

    errSpy.mockRestore();
  });

  it('logs recovery exactly once when getUpcomingTasks succeeds again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getUpcomingTasks.mockRejectedValueOnce(new Error('inventory read failed'));
    await scheduleNextImprovementCheck();

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    getUpcomingTasks.mockResolvedValueOnce([]);
    await scheduleNextImprovementCheck();
    expect(logSpy).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
  });

  it('preserves an already-armed earlier deadline instead of pushing it out to the 15s retry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    scheduleEvent.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getScheduledEvent.mockReturnValue({ active: true, nextRunAt: Date.now() + 5000 });

    getUpcomingTasks.mockRejectedValueOnce(new Error('inventory read failed'));
    await scheduleNextImprovementCheck();

    expect(scheduleEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      id: 'cos-improvement-check', delayMs: 5000
    }));
  });

  it('re-arms via the retry handler even when its own finally-block recompute also fails (no orphaned one-shot)', async () => {
    // This is the trap called out in #7527: the fired handler recomputes the
    // next arm from its own `finally`. If that recompute threw instead of
    // catching internally, the eventScheduler's 'once' rearm logic would
    // deactivate this fired event with no replacement — the improvement
    // cadence would die silently until a process restart.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    scheduleEvent.mockClear();
    getScheduledEvent.mockReturnValue(null);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    canQueueImprovementTasks.mockReturnValue(false);

    getUpcomingTasks.mockRejectedValueOnce(new Error('inventory read failed'));
    await scheduleNextImprovementCheck();
    const retryHandler = scheduleEvent.mock.calls.at(-1)[0].handler;

    scheduleEvent.mockClear();
    getUpcomingTasks.mockRejectedValueOnce(new Error('still down'));
    await expect(retryHandler()).resolves.toBeUndefined();

    expect(scheduleEvent).toHaveBeenCalledTimes(1);
    expect(scheduleEvent).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'cos-improvement-check' }));
  });
});

describe('handleJobSpawnFailed — no 1s re-fire loop after a failed dispatch', () => {
  beforeEach(() => {
    scheduleEvent.mockClear();
    recordJobGateSkip.mockClear();
    generateTaskFromJob.mockClear();
  });

  it('arms the next occurrence when its timer lands while the previous run is still going', async () => {
    sharedState.agents = { 'agent-1': { status: 'running', metadata: { jobId: 'job-a' } } };
    const defaultGetJob = getJob.getMockImplementation();
    getJob.mockResolvedValue({ id: 'job-a', name: 'job-a', enabled: true, intervalMs: 3_600_000, lastRun: new Date().toISOString() });

    await executeScheduledJob('job-a');
    getJob.mockImplementation(defaultGetJob);

    expect(generateTaskFromJob).not.toHaveBeenCalled();
    expect(recordJobGateSkip).toHaveBeenCalledWith('job-a');
    expect(scheduleEvent).toHaveBeenCalledTimes(1);
    expect(scheduleEvent.mock.calls[0][0].delayMs).toBeGreaterThan(60000);
  });

  it('leaves the timer to the spawn events while a fire is still spawning', async () => {
    getDomainBudgetStatus.mockResolvedValue({ withinBudget: true, exceeded: null, budget: {}, usage: { actions: 0, ms: 0 } });
    await executeScheduledJob('job-a');
    scheduleEvent.mockClear();
    recordJobGateSkip.mockClear();

    await executeScheduledJob('job-a');

    expect(scheduleEvent).not.toHaveBeenCalled();
    expect(recordJobGateSkip).not.toHaveBeenCalled();
  });

  it.each([
    ['CoS is paused', () => { sharedState.paused = true; }],
    ['scheduled jobs are off', () => { sharedState.config.autonomousJobsEnabled = false; }],
  ])('checks a past-due job once a minute, not every second, while %s', async (_label, arrange) => {
    arrange();
    await executeScheduledJob('job-a');
    sharedState.paused = false;
    sharedState.config.autonomousJobsEnabled = true;

    expect(generateTaskFromJob).not.toHaveBeenCalled();
    expect(scheduleEvent.mock.calls.map(([event]) => event.delayMs)).toEqual([60000]);
  });

  it('a throw inside a fire leaves a timer that recomputes the schedule instead of re-running the job', async () => {
    await handleJobSpawnFailed('job-a', 'held');
    const { handler } = scheduleEvent.mock.calls[0][0];
    scheduleEvent.mockClear();
    getDomainBudgetStatus.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(handler()).rejects.toThrow('database unavailable');

    expect(scheduleEvent).toHaveBeenCalledTimes(1);
    const recovery = scheduleEvent.mock.calls[0][0];
    expect(recovery).toMatchObject({ id: 'job:job-a', type: 'once', delayMs: 60000 });
    scheduleEvent.mockClear();
    await recovery.handler();
    expect(generateTaskFromJob).not.toHaveBeenCalled();
    expect(scheduleEvent).toHaveBeenCalledTimes(1);
  });

  it('a held dispatch retries on the 60s defer and re-runs the job at most once per minute', async () => {
    await handleJobSpawnFailed('job-held', 'held');

    expect(scheduleEvent).toHaveBeenCalledTimes(1);
    const evt = scheduleEvent.mock.calls[0][0];
    expect(evt).toMatchObject({ id: 'job:job-held', type: 'once', delayMs: 60000 });
    expect(recordJobGateSkip).not.toHaveBeenCalled();

    await evt.handler();
    expect(generateTaskFromJob).toHaveBeenCalledTimes(1);
    clearSpawningJob('job-held');
  });

  it('a spawn error records a gate skip and re-arms via the normal schedule, not a 1s retry', async () => {
    // The failure is also reported to the incident ledger, which reads the job too.
    const defaultGetJob = getJob.getMockImplementation();
    getJob.mockResolvedValue({ id: 'job-err', name: 'job-err', enabled: true, intervalMs: 86_400_000, lastRun: new Date().toISOString() });

    await handleJobSpawnFailed('job-err', 'failed');
    getJob.mockImplementation(defaultGetJob);

    expect(recordJobGateSkip).toHaveBeenCalledWith('job-err');
    expect(scheduleEvent).toHaveBeenCalledTimes(1);
    expect(scheduleEvent.mock.calls[0][0].delayMs).toBeGreaterThan(60000);
  });
});

it.each(['off', 'dry-run'])('records the skip before re-arming a scheduled job in %s mode', async mode => {
  scheduleEvent.mockClear();
  getDomainMode.mockReturnValueOnce(mode);

  await executeScheduledJob('job-a');

  expect(generateTaskFromJob).not.toHaveBeenCalled();
  expect(recordJobGateSkip).toHaveBeenCalledExactlyOnceWith('job-a');
  expect(scheduleEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 'job:job-a' }));
  expect(recordJobGateSkip.mock.invocationCallOrder[0]).toBeLessThan(scheduleEvent.mock.invocationCallOrder[0]);
});

describe('executeScheduledJob — pre-dispatch preflight', () => {
  it('a blocked_config job spawns nothing, reserves nothing and raises one incident', async () => {
    runJobPreflight.mockResolvedValueOnce({ ok: false, reason: 'pinned provider "p1" has no credential: API key is not set' });
    await executeScheduledJob('job-a');

    expect(recordJobBlockedConfig).toHaveBeenCalledWith('job-a', expect.stringContaining('no credential'));
    expect(recordJobFailureIncident).toHaveBeenCalledWith('job-a', expect.stringContaining('Configuration blocked'), expect.any(Object));
    expect(generateTaskFromJob).not.toHaveBeenCalled();
    expect(checkJobGate).not.toHaveBeenCalled();
    expect(getScheduledActionReservations()).toBe(0);
    expect(scheduleEvent).toHaveBeenCalled();
  });

  it('heals a previous blocked_config verdict once preflight passes', async () => {
    getJob.mockResolvedValueOnce({ id: 'job-a', name: 'job-a', enabled: true, intervalMs: 86_400_000, lastStatus: 'blocked_config' });
    await executeScheduledJob('job-a');
    expect(clearJobBlockedConfig).toHaveBeenCalledWith('job-a');
    expect(generateTaskFromJob).toHaveBeenCalledTimes(1);
  });

  it('a green script run resolves open incidents; a failing one records one', async () => {
    globalThis.__nextJobType = 'script';
    await executeScheduledJob('script-a');
    expect(resolveJobIncidents).toHaveBeenCalledWith('script-a');

    executeScriptJob.mockRejectedValueOnce(new Error('Syntax error in job script'));
    await executeScheduledJob('script-fail');
    expect(recordJobFailureIncident).toHaveBeenCalledWith('script-fail', 'Syntax error in job script', expect.any(Object));
  });
});

describe('handleJobSpawnFailed — zero-spend unreachable retry ladder', () => {
  const unreachable = 'getaddrinfo ENOTFOUND api.example.com';
  const job = (extra = {}) => ({ id: 'job-net', name: 'job-net', enabled: true, intervalMs: 86_400_000, lastRun: new Date().toISOString(), ...extra });

  const defaultGetJob = getJob.getMockImplementation();
  beforeEach(() => {
    scheduleEvent.mockClear();
    recordJobGateSkip.mockClear();
  });
  afterEach(() => { getJob.mockImplementation(defaultGetJob); });

  it.each([[0, 5 * 60_000], [1, 15 * 60_000], [2, 30 * 60_000]])('step %i retries after %i ms with the alert suppressed', async (step, delay) => {
    getJob.mockResolvedValue(job({ unreachableRetryStep: step || undefined }));
    await handleJobSpawnFailed('job-net', 'failed', unreachable);

    expect(setJobUnreachableRetryStep).toHaveBeenCalledWith('job-net', step + 1);
    expect(scheduleEvent.mock.calls.at(-1)[0]).toMatchObject({ id: 'job:job-net', delayMs: delay });
    expect(recordJobFailureIncident).not.toHaveBeenCalled();
    expect(recordJobGateSkip).not.toHaveBeenCalled();
  });

  it('alerts and advances to the next period once the ladder is exhausted', async () => {
    getJob.mockResolvedValue(job({ unreachableRetryStep: 3 }));
    await handleJobSpawnFailed('job-net', 'failed', unreachable);

    expect(recordJobFailureIncident).toHaveBeenCalledWith('job-net', unreachable, expect.any(Object));
    expect(setJobUnreachableRetryStep).toHaveBeenCalledWith('job-net', 0);
    expect(recordJobGateSkip).toHaveBeenCalledWith('job-net');
  });

  it('never retries past the next natural occurrence', async () => {
    // Hourly job: the 5m rung fits, the 30m rung would land past the next fire... use a 10m cadence.
    getJob.mockResolvedValue(job({ intervalMs: 10 * 60_000, unreachableRetryStep: 1 }));
    await handleJobSpawnFailed('job-net', 'failed', unreachable);

    expect(setJobUnreachableRetryStep).not.toHaveBeenCalledWith('job-net', 2);
    expect(recordJobFailureIncident).toHaveBeenCalled();
  });

  it('a non-network spawn failure skips the ladder and alerts once', async () => {
    getJob.mockResolvedValue(job());
    await handleJobSpawnFailed('job-net', 'failed', '401 invalid api key');

    expect(recordJobFailureIncident).toHaveBeenCalledWith('job-net', '401 invalid api key', expect.any(Object));
    expect(recordJobGateSkip).toHaveBeenCalledWith('job-net');
  });
});

describe('handleJobAgentCompleted — incident ledger feed', () => {
  const agent = (result, metadata = { jobId: 'job-a', autonomousJob: true }) => ({ id: 'agent-1', metadata, result });

  it('a failed scheduled-job run records its error; a green one resolves incidents', async () => {
    await handleJobAgentCompleted(agent({ success: false, error: 'exit 1' }));
    expect(recordJobFailureIncident).toHaveBeenCalledWith('job-a', 'exit 1', expect.any(Object));

    await handleJobAgentCompleted(agent({ success: true }));
    expect(resolveJobIncidents).toHaveBeenCalledWith('job-a');
  });

  it('ignores user tasks, runs without an error message, and agents without a job', async () => {
    await handleJobAgentCompleted(agent({ success: false, error: 'x' }, { taskType: 'user' }));
    await handleJobAgentCompleted(agent({ success: false }));
    await handleJobAgentCompleted(null);
    expect(recordJobFailureIncident).not.toHaveBeenCalled();
    expect(resolveJobIncidents).not.toHaveBeenCalled();
  });
});
