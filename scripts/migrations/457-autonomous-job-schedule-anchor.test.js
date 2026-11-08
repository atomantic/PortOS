import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './457-autonomous-job-schedule-anchor.js';
import { nextIntervalJobFireTime } from '../../server/services/autonomousJobs/scheduler.js';

const WEEK = 7 * 24 * 3_600_000;

describe('migration 457 — autonomous job schedule anchors', () => {
  let rootDir, jobsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-457-'));
    mkdirSync(join(rootDir, 'data', 'cos'), { recursive: true });
    jobsPath = join(rootDir, 'data', 'cos', 'autonomous-jobs.json');
    writeFileSync(join(rootDir, 'data', 'settings.json'), JSON.stringify({ timezone: 'America/Los_Angeles' }));
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  const job = (overrides) => ({ id: 'job-x', interval: 'weekly', intervalMs: WEEK, scheduledTime: '03:00', ...overrides });
  const run = async (jobs) => {
    writeFileSync(jobsPath, JSON.stringify({ version: 1, jobs }));
    const result = await migration.up({ rootDir });
    return { result, jobs: JSON.parse(readFileSync(jobsPath, 'utf-8')).jobs };
  };

  it('anchors on the nearest slot, so an on-time job keeps its next fire time', async () => {
    const onTime = job({ lastRun: '2026-10-26T10:01:00.000Z' }); // Monday 03:01 PDT
    const before = nextIntervalJobFireTime(onTime, 'America/Los_Angeles');
    const { jobs } = await run([onTime]);
    expect(jobs[0].scheduleAnchor).toBe(1);
    expect(nextIntervalJobFireTime(jobs[0], 'America/Los_Angeles')).toBe(before);
  });

  it('keeps a job that already drifted on the weekday it drifted to, and anchors never-run jobs to now', async () => {
    const drifted = job({ id: 'drifted', lastRun: '2026-10-27T03:01:00.000Z' }); // Monday 20:01 PDT -> nearest slot is Tuesday
    const monthly = job({ id: 'monthly', interval: 'monthly', intervalMs: 30 * 24 * 3_600_000, lastRun: '2026-10-15T10:00:00.000Z' });
    const neverRun = job({ id: 'never', lastRun: null });
    const { jobs } = await run([drifted, monthly, neverRun]);
    expect(jobs.find(j => j.id === 'drifted').scheduleAnchor).toBe(2);
    expect(jobs.find(j => j.id === 'monthly').scheduleAnchor).toBe(15);
    expect(jobs.find(j => j.id === 'never').scheduleAnchor).toBeGreaterThanOrEqual(0);
  });

  it('leaves daily, cron, sub-weekly, on-demand, time-less and already-anchored jobs untouched', async () => {
    const jobs = [
      job({ id: 'daily', interval: 'daily', intervalMs: 86_400_000 }),
      job({ id: 'cron', cronExpression: '0 3 * * 0' }),
      job({ id: 'hourly', interval: 'hourly', intervalMs: 3_600_000 }),
      job({ id: 'on-demand', interval: 'on-demand', intervalMs: null, scheduledTime: null }),
      job({ id: 'no-time', scheduledTime: null }),
      job({ id: 'picked', scheduleAnchor: 5, lastRun: '2026-10-26T10:01:00.000Z' }),
    ];
    const { result, jobs: after } = await run(jobs);
    expect(result.anchored).toBe(0);
    expect(after).toEqual(jobs);
  });

  it('is a no-op without a jobs file', async () => {
    expect(await migration.up({ rootDir })).toEqual({ anchored: 0, reason: 'no-jobs-file' });
  });
});
