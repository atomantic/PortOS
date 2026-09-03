import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './335-schedule-interval-types.js';

describe('migration 335 — collapse interval types to on-demand/cron + perpetual flag', () => {
  let rootDir;
  let schedulePath;
  let appsPath;

  const writeSchedule = (tasks) => {
    mkdirSync(join(rootDir, 'data', 'cos'), { recursive: true });
    writeFileSync(schedulePath, `${JSON.stringify({ version: 2, tasks, executions: {} }, null, 2)}\n`);
  };
  const readTasks = () => JSON.parse(readFileSync(schedulePath, 'utf8')).tasks;

  const writeApps = (apps) => {
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    writeFileSync(appsPath, `${JSON.stringify({ apps }, null, 2)}\n`);
  };
  const readApps = () => JSON.parse(readFileSync(appsPath, 'utf8')).apps;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-335-'));
    schedulePath = join(rootDir, 'data', 'cos', 'task-schedule.json');
    appsPath = join(rootDir, 'data', 'apps.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('is a no-op on a fresh install with no schedule or apps file', async () => {
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0 });
  });

  it('maps every retired cadence onto the two-variant model', async () => {
    writeSchedule({
      'a-once': { type: 'once', enabled: true },
      'a-rotation': { type: 'rotation', enabled: true },
      'a-daily': { type: 'daily', enabled: true },
      'a-weekly': { type: 'weekly', enabled: true },
      'a-custom': { type: 'custom', intervalMs: 1_800_000, enabled: true },
      'a-perpetual': { type: 'perpetual', recheckCron: '0 3 * * *', enabled: true },
    });

    await migration.up({ rootDir });
    const tasks = readTasks();

    expect(tasks['a-once']).toMatchObject({ type: 'on-demand', perpetual: false, enabled: true });
    expect(tasks['a-rotation']).toMatchObject({ type: 'cron', cronExpression: '0 7 * * *' });
    expect(tasks['a-daily']).toMatchObject({ type: 'cron', cronExpression: '0 7 * * *' });
    expect(tasks['a-weekly']).toMatchObject({ type: 'cron', cronExpression: '0 7 * * 1' });
    expect(tasks['a-custom']).toMatchObject({ type: 'cron', cronExpression: '*/30 * * * *' });
    // The recheck cadence survives the type collapse.
    expect(tasks['a-perpetual']).toMatchObject({ type: 'on-demand', perpetual: true, recheckCron: '0 3 * * *' });
  });

  it('preserves enabled/weekdaysOnly and an already-cron expression', async () => {
    writeSchedule({
      paused: { type: 'weekly', enabled: false, weekdaysOnly: true },
      pinned: { type: 'cron', cronExpression: '30 8 * * 2', enabled: true, weekdaysOnly: true },
    });

    await migration.up({ rootDir });
    const tasks = readTasks();

    expect(tasks.paused).toMatchObject({ enabled: false, weekdaysOnly: true, type: 'cron', cronExpression: '0 7 * * 1' });
    expect(tasks.pinned).toMatchObject({ enabled: true, weekdaysOnly: true, type: 'cron', cronExpression: '30 8 * * 2' });
  });

  it('gives the reconcile drains the perpetual flag their hardcoded behavior relied on', async () => {
    writeSchedule({
      'branch-reconcile': { type: 'on-demand', enabled: true, recheckCron: '0 3 * * *' },
      'issue-reconcile': { type: 'on-demand', enabled: true },
      'claim-issue': { type: 'on-demand', enabled: true },
    });

    await migration.up({ rootDir });
    const tasks = readTasks();

    expect(tasks['branch-reconcile']).toMatchObject({ type: 'on-demand', perpetual: true });
    expect(tasks['issue-reconcile']).toMatchObject({ type: 'on-demand', perpetual: true });
    // Every OTHER on-demand task stays a single-run manual action.
    expect(tasks['claim-issue']).toMatchObject({ type: 'on-demand', perpetual: false });
  });

  it('rewrites per-app cadence overrides and leaves a raw cron string alone', async () => {
    writeApps({
      'app-1': {
        id: 'app-1',
        taskTypeOverrides: {
          security: { enabled: true, interval: 'weekly' },
          'layered-intelligence': { enabled: true, interval: 'custom', intervalMs: 900_000 },
          'ui-bugs': { enabled: true, interval: 'once' },
          typing: { enabled: true, interval: '15 6 * * 3' },
          inherited: { enabled: true, interval: null },
        },
      },
    });

    await migration.up({ rootDir });
    const overrides = readApps()['app-1'].taskTypeOverrides;

    expect(overrides.security.interval).toBe('0 7 * * 1');
    expect(overrides['layered-intelligence'].interval).toBe('*/15 * * * *');
    expect(overrides['ui-bugs'].interval).toBe('on-demand');
    expect(overrides.typing.interval).toBe('15 6 * * 3');
    expect(overrides.inherited.interval).toBeNull();
  });

  it('is idempotent — a second run changes nothing', async () => {
    writeSchedule({ 'a-weekly': { type: 'weekly', enabled: true }, 'branch-reconcile': { type: 'on-demand', enabled: true } });
    writeApps({ 'app-1': { id: 'app-1', taskTypeOverrides: { security: { enabled: true, interval: 'daily' } } } });

    const first = await migration.up({ rootDir });
    expect(first.updated).toBeGreaterThan(0);
    const afterFirst = readFileSync(schedulePath, 'utf8');
    const appsAfterFirst = readFileSync(appsPath, 'utf8');

    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0 });
    expect(readFileSync(schedulePath, 'utf8')).toBe(afterFirst);
    expect(readFileSync(appsPath, 'utf8')).toBe(appsAfterFirst);
  });
});
