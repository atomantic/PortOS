import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './437-github-notifications-system-task.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 437 — GitHub notifications check becomes a System task', () => {
  let rootDir, jobsPath, schedulePath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-437-'));
    mkdirSync(join(rootDir, 'data', 'cos'), { recursive: true });
    jobsPath = join(rootDir, 'data', 'cos', 'autonomous-jobs.json');
    schedulePath = join(rootDir, 'data', 'cos', 'task-schedule.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  const schedule = (task) => ({
    version: 2,
    tasks: { 'github-notifications': task, security: { type: 'on-demand', enabled: true } },
    executions: { 'task:github-notifications': { lastRun: 1 }, 'task:security': { lastRun: 2 } },
    onDemandRequests: [{ id: 'demand-1', taskType: 'github-notifications' }, { id: 'demand-2', taskType: 'security' }],
  });

  it('carries a weekday schedule over to an enabled System task and removes the scheduled task', async () => {
    writeJson(schedulePath, schedule({ type: 'cron', cronExpression: '*/15 * * * 1-5', enabled: true }));
    writeJson(jobsPath, { version: 1, jobs: [{ id: 'job-system-health-check', enabled: true }] });

    await migration.up({ rootDir });

    const jobs = readJson(jobsPath).jobs;
    expect(jobs.find((job) => job.id === 'job-github-notifications')).toMatchObject({ enabled: true, cronExpression: '*/15 * * * 1-5' });
    expect(jobs.find((job) => job.id === 'job-system-health-check')).toEqual({ id: 'job-system-health-check', enabled: true });
    const after = readJson(schedulePath);
    expect(Object.keys(after.tasks)).toEqual(['security']);
    expect(Object.keys(after.executions)).toEqual(['task:security']);
    expect(after.onDemandRequests.map((request) => request.id)).toEqual(['demand-2']);

    // A re-run finds nothing to move and leaves the job as it is.
    await migration.up({ rootDir });
    expect(readJson(jobsPath).jobs.filter((job) => job.id === 'job-github-notifications')).toHaveLength(1);
  });

  it('leaves an install that never turned the check on to the shipped default (off)', async () => {
    writeJson(schedulePath, schedule({ type: 'on-demand', cronExpression: null, enabled: true }));
    await migration.up({ rootDir });
    expect(existsSync(jobsPath)).toBe(false);
    expect(readJson(schedulePath).tasks['github-notifications']).toBeUndefined();
  });

  it('keeps the scheduled task to retry when the jobs file cannot be parsed', async () => {
    writeJson(schedulePath, schedule({ type: 'cron', cronExpression: '0 9 * * *', enabled: true }));
    writeFileSync(jobsPath, '{ not json');
    await migration.up({ rootDir });
    expect(readFileSync(jobsPath, 'utf-8')).toBe('{ not json');
    expect(readJson(schedulePath).tasks['github-notifications']).toMatchObject({ cronExpression: '0 9 * * *' });
  });
});
