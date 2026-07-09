import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration, { intervalFieldsFromMs, buildOverride } from './184-migrate-layered-intelligence-to-scheduled-task.js';

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 184 — layered intelligence → per-app scheduled task', () => {
  let rootDir, jobsPath, appsPath, schedulePath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-184-'));
    mkdirSync(join(rootDir, 'data', 'cos'), { recursive: true });
    jobsPath = join(rootDir, 'data', 'cos', 'autonomous-jobs.json');
    appsPath = join(rootDir, 'data', 'apps.json');
    schedulePath = join(rootDir, 'data', 'cos', 'task-schedule.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  describe('pure helpers', () => {
    it('intervalFieldsFromMs maps day/week to the string enum, else custom', () => {
      expect(intervalFieldsFromMs(DAY)).toEqual({ interval: 'daily', intervalMs: DAY });
      expect(intervalFieldsFromMs(WEEK)).toEqual({ interval: 'weekly', intervalMs: WEEK });
      expect(intervalFieldsFromMs(6 * 60 * 60 * 1000)).toEqual({ interval: 'custom', intervalMs: 6 * 60 * 60 * 1000 });
      expect(intervalFieldsFromMs(undefined)).toEqual({ interval: 'daily', intervalMs: DAY });
      expect(intervalFieldsFromMs(0)).toEqual({ interval: 'daily', intervalMs: DAY });
    });

    it('buildOverride enables only when BOTH the job and the per-app config were on', () => {
      expect(buildOverride({ enabled: true, intervalMs: DAY }, true).enabled).toBe(true);
      expect(buildOverride({ enabled: true, intervalMs: DAY }, false).enabled).toBe(false);
      expect(buildOverride({ enabled: false, intervalMs: DAY }, true).enabled).toBe(false);
    });

    it('buildOverride carries provider/model only when set', () => {
      expect(buildOverride({ enabled: true, providerId: 'p', model: 'm', intervalMs: DAY }, true))
        .toMatchObject({ enabled: true, providerId: 'p', model: 'm' });
      const bare = buildOverride({ enabled: true, intervalMs: DAY }, true);
      expect(bare).not.toHaveProperty('providerId');
      expect(bare).not.toHaveProperty('model');
    });
  });

  it('no-ops cleanly on a fresh install (no files)', async () => {
    const result = await migration.up({ rootDir });
    expect(result).toMatchObject({ updated: 0, globalEnabled: false, jobRemoved: false, migratedApps: 0 });
  });

  it('tombstones the job and moves each app when the global job was enabled', async () => {
    writeJson(jobsPath, {
      jobs: [
        { id: 'job-other', enabled: true },
        { id: 'job-layered-intelligence', enabled: true, category: 'layered-intelligence' }
      ]
    });
    writeJson(appsPath, {
      apps: {
        'portos-default': { name: 'PortOS', layeredIntelligence: { enabled: true, intervalMs: DAY, providerId: 'ollama', model: 'qwen', rules: 'keep it tight', sources: { goals: true } } },
        'app-a': { name: 'A', layeredIntelligence: { enabled: false, intervalMs: 6 * 60 * 60 * 1000 } },
        'app-noli': { name: 'No LI' }
      }
    });
    writeJson(schedulePath, { tasks: { 'layered-intelligence': { type: 'daily', enabled: false } } });

    const result = await migration.up({ rootDir });
    expect(result).toMatchObject({ globalEnabled: true, jobRemoved: true, migratedApps: 2 });

    // Job tombstoned; sibling job untouched.
    const jobs = readJson(jobsPath).jobs;
    expect(jobs.map((j) => j.id)).toEqual(['job-other']);

    // PortOS: enabled (job on + app on), provider/model carried, behavior kept.
    const apps = readJson(appsPath).apps;
    expect(apps['portos-default'].taskTypeOverrides['layered-intelligence']).toEqual({
      enabled: true, interval: 'daily', intervalMs: DAY, providerId: 'ollama', model: 'qwen'
    });
    expect(apps['portos-default'].layeredIntelligence.rules).toBe('keep it tight'); // behavior stays
    expect(apps['portos-default'].layeredIntelligence.sources.goals).toBe(true);

    // app-a: per-app was off ⇒ override disabled; sub-daily interval ⇒ custom.
    expect(apps['app-a'].taskTypeOverrides['layered-intelligence']).toEqual({
      enabled: false, interval: 'custom', intervalMs: 6 * 60 * 60 * 1000
    });

    // app with no LI config gets no override.
    expect(apps['app-noli'].taskTypeOverrides).toBeUndefined();

    // Global task type enabled so the moved per-app enables actually run.
    expect(readJson(schedulePath).tasks['layered-intelligence'].enabled).toBe(true);
  });

  it('disables every app override + leaves the task off when the job was disabled', async () => {
    writeJson(jobsPath, { jobs: [{ id: 'job-layered-intelligence', enabled: false }] });
    writeJson(appsPath, {
      apps: { 'app-a': { name: 'A', layeredIntelligence: { enabled: true, intervalMs: DAY } } }
    });
    writeJson(schedulePath, { tasks: { 'layered-intelligence': { enabled: false } } });

    const result = await migration.up({ rootDir });
    expect(result.globalEnabled).toBe(false);

    const apps = readJson(appsPath).apps;
    // per-app was on but the job was off ⇒ effective off preserved.
    expect(apps['app-a'].taskTypeOverrides['layered-intelligence'].enabled).toBe(false);
    // Task type stays disabled (nothing to enable).
    expect(readJson(schedulePath).tasks['layered-intelligence'].enabled).toBe(false);
  });

  it('is idempotent — a second run does not overwrite an existing override', async () => {
    writeJson(jobsPath, { jobs: [{ id: 'job-layered-intelligence', enabled: true }] });
    writeJson(appsPath, {
      apps: { 'app-a': { name: 'A', layeredIntelligence: { enabled: true, intervalMs: DAY } } }
    });
    writeJson(schedulePath, { tasks: { 'layered-intelligence': { enabled: false } } });

    await migration.up({ rootDir });
    // Hand-edit the override to prove a re-run leaves it alone.
    const apps1 = readJson(appsPath);
    apps1.apps['app-a'].taskTypeOverrides['layered-intelligence'].enabled = false;
    writeJson(appsPath, apps1);

    const result2 = await migration.up({ rootDir });
    expect(result2.migratedApps).toBe(0); // nothing re-moved
    expect(readJson(appsPath).apps['app-a'].taskTypeOverrides['layered-intelligence'].enabled).toBe(false);
  });
});
