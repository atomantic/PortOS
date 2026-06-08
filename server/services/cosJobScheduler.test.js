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
 * Unlike the source-level regression guards in cos.test.js, these tests exercise
 * the REAL executeScheduledJob (the race lives in the await interleaving, which a
 * pure inline copy can't reproduce). We deterministically reproduce the window by
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

vi.mock('./eventScheduler.js', () => ({
  schedule: vi.fn(),
  cancel: vi.fn(),
  parseCronToNextRun: vi.fn(() => new Date(0)),
}));
vi.mock('../lib/timezone.js', () => ({
  getUserTimezone: vi.fn().mockResolvedValue('UTC'),
  getLocalParts: vi.fn(() => ({ dayOfWeek: 1 })),
  nextLocalTime: vi.fn((ms) => ms),
}));
vi.mock('../lib/fileUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  formatDuration: vi.fn(() => '1h'),
}));
vi.mock('./cosState.js', () => ({
  loadState: vi.fn(async () => sharedState),
  isDaemonRunning: vi.fn(() => daemonRunning),
}));
vi.mock('../lib/domainAutonomy.js', () => ({
  getDomainMode: vi.fn(() => 'execute'),
  DOMAIN_IDS: ['brain', 'memory', 'cos', 'messages'],
}));
// remainingActionBudget is pure — keep it REAL so the gate math is the math.
vi.mock('./domainUsage.js', () => ({
  getDomainBudgetStatus: vi.fn(),
  recordDomainUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./cosEvents.js', () => ({
  cosEvents: { emit: vi.fn() },
  emitLog: vi.fn(),
}));
vi.mock('./cosTaskStore.js', () => ({ getCosTasks: vi.fn() }));
vi.mock('./cosTaskGenerator.js', () => ({ queueEligibleImprovementTasks: vi.fn() }));

const generateTaskFromJob = vi.fn(async (job) => ({ id: `task-${job.id}`, description: job.name }));
const executeScriptJob = vi.fn().mockResolvedValue(undefined);
const checkJobGate = vi.fn().mockResolvedValue({ shouldRun: true, reason: 'ok' });
vi.mock('./autonomousJobs.js', () => ({
  generateTaskFromJob: (...a) => generateTaskFromJob(...a),
  recordJobGateSkip: vi.fn().mockResolvedValue(undefined),
  isScriptJob: (job) => job?.type === 'script',
  executeScriptJob: (...a) => executeScriptJob(...a),
  isShellJob: (job) => job?.type === 'shell',
  executeShellJob: vi.fn().mockResolvedValue(undefined),
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
vi.mock('./jobGates.js', () => ({
  checkJobGate: (...a) => checkJobGate(...a),
  hasGate: vi.fn(() => false),
}));

import {
  executeScheduledJob,
  getScheduledActionReservations,
  clearSpawningJob,
} from './cosJobScheduler.js';
import { getDomainBudgetStatus } from './domainUsage.js';

beforeEach(() => {
  daemonRunning = true;
  sharedState.agents = {};
  globalThis.__nextJobType = 'agent';
  generateTaskFromJob.mockClear();
  executeScriptJob.mockClear();
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
  clearSpawningJob('script-a');
  clearSpawningJob('script-b');
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
