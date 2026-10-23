import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { runMigrations } from '../run-migrations.js';

const ORIGINAL = '437-github-notifications-system-task.js';
const REPAIR = '438-retry-github-notifications-task-move.js';
const here = dirname(fileURLToPath(import.meta.url));
let rootDir;
let migrationsDir;
const path = (name) => join(rootDir, 'data', name);
const write = (name, value) => writeFileSync(path(name), JSON.stringify(value));
const read = (name) => JSON.parse(readFileSync(path(name), 'utf8'));
const run = () => runMigrations({ rootDir, migrationsDir });
const installMigration = (name) => writeFileSync(join(migrationsDir, name),
  `export { default } from ${JSON.stringify(pathToFileURL(join(here, name)).href)};\n`);
const schedule = (task = { type: 'cron', enabled: true, cronExpression: '*/15 * * * 1-5' }) => ({
  version: 2,
  tasks: { 'github-notifications': task, security: { type: 'on-demand', enabled: true } },
  executions: { 'task:github-notifications': { lastRun: 1 }, 'task:security': { lastRun: 2 } },
  onDemandRequests: [{ taskType: 'github-notifications' }, { taskType: 'security' }],
});

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'migration-438-'));
  migrationsDir = join(rootDir, 'migrations');
  mkdirSync(join(rootDir, 'data/cos'), { recursive: true });
  mkdirSync(migrationsDir);
});
afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

describe('migration 438 through the migration runner', () => {
  it('recovers a schedule 437 marked applied, keeping the repair pending until its jobs input is readable', async () => {
    installMigration(ORIGINAL);
    write('cos/task-schedule.json', schedule());
    writeFileSync(path('cos/autonomous-jobs.json'), '{ not json');
    await run();
    expect(read('migrations.applied.json')).toEqual([ORIGINAL]);

    installMigration(REPAIR);
    await expect(run()).rejects.toThrow('repair data/cos/autonomous-jobs.json');
    expect(read('migrations.applied.json')).toEqual([ORIGINAL]);
    expect(readFileSync(path('cos/autonomous-jobs.json'), 'utf8')).toBe('{ not json');
    expect(read('cos/task-schedule.json')).toEqual(schedule());

    write('cos/autonomous-jobs.json', { version: 1, jobs: [{ id: 'job-example', enabled: false }] });
    expect(await run()).toBe(1);
    expect(read('migrations.applied.json')).toEqual([ORIGINAL, REPAIR]);
    expect(read('cos/autonomous-jobs.json').jobs).toEqual([
      { id: 'job-example', enabled: false },
      expect.objectContaining({ id: 'job-github-notifications', enabled: true, cronExpression: '*/15 * * * 1-5' }),
    ]);
    expect(read('cos/task-schedule.json')).toEqual({
      version: 2, tasks: { security: { type: 'on-demand', enabled: true } },
      executions: { 'task:security': { lastRun: 2 } }, onDemandRequests: [{ taskType: 'security' }],
    });
    const before = readFileSync(path('cos/autonomous-jobs.json'), 'utf8');
    expect(await run()).toBe(0);
    expect(readFileSync(path('cos/autonomous-jobs.json'), 'utf8')).toBe(before);
  });

  it('preserves an existing replacement job and its explicit operator choices', async () => {
    installMigration(REPAIR);
    write('cos/task-schedule.json', schedule());
    const jobs = { version: 1, jobs: [{ id: 'job-github-notifications', enabled: false, cronExpression: '0 9 * * *' }] };
    write('cos/autonomous-jobs.json', jobs);
    await run();
    expect(read('cos/autonomous-jobs.json')).toEqual(jobs);
    expect(read('cos/task-schedule.json').tasks['github-notifications']).toBeUndefined();
  });

  it('leaves a malformed jobs container pending rather than overwriting it with defaults', async () => {
    installMigration(REPAIR);
    write('cos/task-schedule.json', schedule());
    write('cos/autonomous-jobs.json', { version: 1, jobs: { retained: true } });
    await expect(run()).rejects.toThrow('repair data/cos/autonomous-jobs.json');
    expect(existsSync(path('migrations.applied.json'))).toBe(false);
    expect(read('cos/autonomous-jobs.json')).toEqual({ version: 1, jobs: { retained: true } });
  });

  it('does not inspect damaged jobs when retiring an on-demand schedule', async () => {
    installMigration(REPAIR);
    write('cos/task-schedule.json', schedule({ type: 'on-demand', enabled: true }));
    writeFileSync(path('cos/autonomous-jobs.json'), '{ not json');
    await run();
    expect(read('cos/task-schedule.json').tasks['github-notifications']).toBeUndefined();
    expect(readFileSync(path('cos/autonomous-jobs.json'), 'utf8')).toBe('{ not json');
  });

  it('keeps unreadable schedule bytes pending for a later repaired input', async () => {
    installMigration(REPAIR);
    writeFileSync(path('cos/task-schedule.json'), '{ not json');
    await expect(run()).rejects.toThrow('repair data/cos/task-schedule.json');
    expect(existsSync(path('migrations.applied.json'))).toBe(false);
    write('cos/task-schedule.json', schedule());
    await run();
    expect(read('cos/autonomous-jobs.json').jobs[0]).toMatchObject({ enabled: true, cronExpression: '*/15 * * * 1-5' });
  });
});
