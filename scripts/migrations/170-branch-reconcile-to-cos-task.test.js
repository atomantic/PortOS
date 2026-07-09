import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './170-branch-reconcile-to-cos-task.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 170 — branch reconciler → per-app CoS task', () => {
  let rootDir, settingsPath, schedulePath, appsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-170-'));
    mkdirSync(join(rootDir, 'data', 'cos'), { recursive: true });
    settingsPath = join(rootDir, 'data', 'settings.json');
    schedulePath = join(rootDir, 'data', 'cos', 'task-schedule.json');
    appsPath = join(rootDir, 'data', 'apps.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('no-ops when there is no settings.json (fresh install)', async () => {
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    expect(result.reason).toBe('no-branchReconcile-settings');
  });

  it('no-ops when settings has no branchReconcile key', async () => {
    writeJson(settingsPath, { theme: 'dark' });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    expect(result.reason).toBe('no-branchReconcile-settings');
    expect(readJson(settingsPath)).toEqual({ theme: 'dark' });
  });

  it('removes the dead key without enabling anything when the old reconciler was disabled', async () => {
    writeJson(settingsPath, { branchReconcile: { enabled: false, cron: '0 3 * * *' }, theme: 'dark' });
    writeJson(schedulePath, { tasks: { 'branch-reconcile': { enabled: false } } });
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 1, wasEnabled: false });
    expect('branchReconcile' in readJson(settingsPath)).toBe(false);
    expect(readJson(settingsPath).theme).toBe('dark');
    // Task stays disabled — user never opted in.
    expect(readJson(schedulePath).tasks['branch-reconcile'].enabled).toBe(false);
  });

  it('carries an enabled reconciler into the new task: cron→recheckCron, actions→taskMetadata', async () => {
    writeJson(settingsPath, {
      branchReconcile: { enabled: true, cron: '30 4 * * *', actions: { cleanupMerged: true, openPr: false, resolveConflicts: true, autoMerge: false } }
    });
    writeJson(schedulePath, { tasks: { 'branch-reconcile': { type: 'perpetual', enabled: false, taskMetadata: { useWorktree: false, openPR: false, cleanupMerged: true, openPr: true, resolveConflicts: true, autoMerge: true } } } });
    const result = await migration.up({ rootDir });
    expect(result.wasEnabled).toBe(true);

    const task = readJson(schedulePath).tasks['branch-reconcile'];
    expect(task.enabled).toBe(true);
    expect(task.recheckCron).toBe('30 4 * * *');
    expect(task.taskMetadata.openPr).toBe(false);     // carried from actions
    expect(task.taskMetadata.autoMerge).toBe(false);  // carried from actions
    expect(task.taskMetadata.cleanupMerged).toBe(true);
    expect(task.taskMetadata.resolveConflicts).toBe(true);
    // Managed isolation flags preserved.
    expect(task.taskMetadata.useWorktree).toBe(false);
    expect(task.taskMetadata.openPR).toBe(false);
    // Dead key gone.
    expect('branchReconcile' in readJson(settingsPath)).toBe(false);
  });

  it('absent action keys default to ON (opt-out semantics)', async () => {
    writeJson(settingsPath, { branchReconcile: { enabled: true, actions: {} } });
    writeJson(schedulePath, { tasks: { 'branch-reconcile': {} } });
    await migration.up({ rootDir });
    const meta = readJson(schedulePath).tasks['branch-reconcile'].taskMetadata;
    expect(meta).toMatchObject({ cleanupMerged: true, openPr: true, resolveConflicts: true, autoMerge: true });
  });

  it('preserves PortOS-only scope by disabling the task on other managed apps', async () => {
    writeJson(settingsPath, { branchReconcile: { enabled: true } });
    writeJson(schedulePath, { tasks: { 'branch-reconcile': {} } });
    writeJson(appsPath, {
      apps: {
        'portos-default': { name: 'PortOS' },
        'other-app': { name: 'Other', taskTypeOverrides: { security: { enabled: true } } },
        'third-app': { name: 'Third' }
      }
    });
    await migration.up({ rootDir });
    const apps = readJson(appsPath).apps;
    // PortOS inherits the enable — no override added.
    expect(apps['portos-default'].taskTypeOverrides?.['branch-reconcile']).toBeUndefined();
    // Others are explicitly disabled, preserving unrelated overrides.
    expect(apps['other-app'].taskTypeOverrides['branch-reconcile'].enabled).toBe(false);
    expect(apps['other-app'].taskTypeOverrides.security.enabled).toBe(true);
    expect(apps['third-app'].taskTypeOverrides['branch-reconcile'].enabled).toBe(false);
  });

  it('is idempotent — re-running after the key is gone no-ops', async () => {
    writeJson(settingsPath, { branchReconcile: { enabled: true } });
    writeJson(schedulePath, { tasks: { 'branch-reconcile': {} } });
    await migration.up({ rootDir });
    const second = await migration.up({ rootDir });
    expect(second.updated).toBe(0);
    expect(second.reason).toBe('no-branchReconcile-settings');
  });
});
