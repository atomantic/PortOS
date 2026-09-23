import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './408-rename-ui-lifecycle-task.js';

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

describe('migration 408 — rename the UI lifecycle task', () => {
  let rootDir;
  let schedulePath;
  let appsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-408-'));
    mkdirSync(join(rootDir, 'data', 'cos'), { recursive: true });
    schedulePath = join(rootDir, 'data', 'cos', 'task-schedule.json');
    appsPath = join(rootDir, 'data', 'apps.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('renames saved task state and merges collisions without losing settings or history', async () => {
    writeJson(schedulePath, {
      version: 2,
      tasks: {
        'react-lifecycle': {
          enabled: true,
          providerId: 'legacy-provider',
          prompt: 'custom prompt',
          taskMetadata: { fileIssues: true, useWorktree: false },
        },
        'ui-lifecycle': {
          enabled: false,
          model: 'current-model',
          taskMetadata: { openPR: false },
        },
        'another-task': { runAfter: ['security', 'react-lifecycle'] },
      },
      executions: {
        'task:react-lifecycle': {
          count: 2,
          lastRun: '2026-09-20T00:00:00.000Z',
          perApp: { 'app-a': { count: 1, lastRun: '2026-09-19T00:00:00.000Z' } },
        },
        'task:ui-lifecycle': {
          count: 3,
          lastRun: '2026-09-21T00:00:00.000Z',
          perApp: { 'app-a': { count: 2, lastRun: '2026-09-21T00:00:00.000Z' } },
        },
      },
      onDemandRequests: [{ id: 'pending-1', taskType: 'react-lifecycle' }],
    });
    writeJson(appsPath, {
      apps: {
        'app-a': {
          taskTypeOverrides: {
            'react-lifecycle': { enabled: true, interval: 'weekly', taskMetadata: { fileIssues: true } },
            'ui-lifecycle': { enabled: false, taskMetadata: { useWorktree: false } },
          },
        },
        'app-b': { disabledTaskTypes: ['react-lifecycle', 'security', 'ui-lifecycle'] },
      },
    });

    expect(await migration.up({ rootDir })).toEqual({ schedules: 1, pendingRequests: 1, migratedApps: 2 });

    const schedule = readJson(schedulePath);
    expect(schedule.tasks).not.toHaveProperty('react-lifecycle');
    expect(schedule.tasks['ui-lifecycle']).toMatchObject({
      enabled: false,
      providerId: 'legacy-provider',
      model: 'current-model',
      prompt: 'custom prompt',
      taskMetadata: { fileIssues: true, useWorktree: false, openPR: false },
    });
    expect(schedule.tasks['another-task'].runAfter).toEqual(['security', 'ui-lifecycle']);
    expect(schedule.executions).not.toHaveProperty('task:react-lifecycle');
    expect(schedule.executions['task:ui-lifecycle']).toMatchObject({
      count: 5,
      lastRun: '2026-09-21T00:00:00.000Z',
      perApp: { 'app-a': { count: 3, lastRun: '2026-09-21T00:00:00.000Z' } },
    });
    expect(schedule.onDemandRequests[0].taskType).toBe('ui-lifecycle');

    const apps = readJson(appsPath).apps;
    expect(apps['app-a'].taskTypeOverrides).not.toHaveProperty('react-lifecycle');
    expect(apps['app-a'].taskTypeOverrides['ui-lifecycle']).toEqual({
      enabled: false,
      interval: 'weekly',
      taskMetadata: { fileIssues: true, useWorktree: false },
    });
    expect(apps['app-b'].disabledTaskTypes).toEqual(['ui-lifecycle', 'security']);
  });

  it('is idempotent when the active schedule has already been renamed', async () => {
    writeJson(schedulePath, { version: 2, tasks: { 'ui-lifecycle': { enabled: false } } });
    writeJson(appsPath, { apps: { 'app-a': { taskTypeOverrides: { 'ui-lifecycle': { enabled: true } } } } });

    expect(await migration.up({ rootDir })).toEqual({ schedules: 0, pendingRequests: 0, migratedApps: 0 });
    expect(readJson(schedulePath).tasks).toEqual({ 'ui-lifecycle': { enabled: false } });
  });
});
