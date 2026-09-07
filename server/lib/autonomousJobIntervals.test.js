/** Autonomous-job cadence resolution and no-clock compatibility contracts. */

import { describe, it, expect } from 'vitest';

// Declared here rather than imported from fileUtils: this suite's whole point is
// that autonomousJobIntervals.js stays import-free, and pulling fileUtils in
// through the test would put its closure back into the suite's import budget.
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
import {
  INTERVAL_OPTIONS,
  JOB_INTERVAL_VALUES,
  ON_DEMAND_INTERVAL,
  isOnDemandJob,
  resolveIntervalMs
} from './autonomousJobIntervals.js';

describe('resolveIntervalMs', () => {
  it('returns the no-interval sentinel for the on-demand cadence — not DAY, not NaN', () => {
    const resolved = resolveIntervalMs(ON_DEMAND_INTERVAL);
    expect(resolved).toBeNull();
    expect(resolved).not.toBe(DAY);
    expect(Number.isNaN(resolved)).toBe(false);
  });

  it('no longer falls through to DAY for a cadence outside the vocabulary', () => {
    // The `default: return DAY` this replaced turned a typo'd cadence into a
    // daily job that nobody asked for.
    expect(resolveIntervalMs('dailyy')).toBeNull();
    expect(resolveIntervalMs(undefined)).toBeNull();
  });

  it('resolves every recurring option to its declared duration', () => {
    for (const opt of INTERVAL_OPTIONS) {
      expect(resolveIntervalMs(opt.value), opt.value).toBe(opt.ms);
    }
  });

  it('custom uses the caller-supplied duration and falls back to a day', () => {
    expect(resolveIntervalMs('custom', 90_000)).toBe(90_000);
    expect(resolveIntervalMs('custom')).toBe(DAY);
  });

  it('JOB_INTERVAL_VALUES covers every option plus custom', () => {
    expect(JOB_INTERVAL_VALUES).toEqual([...INTERVAL_OPTIONS.map(o => o.value), 'custom']);
  });
});

describe('isOnDemandJob', () => {
  it('is true for the cadence and for a job left with no resolvable interval', () => {
    expect(isOnDemandJob({ interval: ON_DEMAND_INTERVAL, intervalMs: null })).toBe(true);
    expect(isOnDemandJob({ interval: 'daily', intervalMs: null })).toBe(true);
  });

  it('is false for a recurring job', () => {
    expect(isOnDemandJob({ interval: 'daily', intervalMs: DAY })).toBe(false);
  });

  it('is false for a cron-mode job that kept a stale on-demand cadence', () => {
    // Switching a job to Cron does not rewrite `interval`, so the cron fields
    // have to win or the job would silently stop firing.
    expect(isOnDemandJob({ interval: ON_DEMAND_INTERVAL, intervalMs: null, cronExpression: '0 4 * * *' })).toBe(false);
    expect(isOnDemandJob({ interval: ON_DEMAND_INTERVAL, intervalMs: null, cronSchedule: { kind: 'DAILY' } })).toBe(false);
  });
});
