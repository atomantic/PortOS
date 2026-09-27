import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './417-rename-do-release-task.js';

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

// The merge rules are covered by migration 408's suite (same shared helper);
// this pins the release-check → do-release wiring and that the operator's
// customized prompt and release options travel with the task.
describe('migration 417 — rename release-check to do-release', () => {
  let rootDir;
  let schedulePath;
  let appsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-417-'));
    mkdirSync(join(rootDir, 'data', 'cos'), { recursive: true });
    schedulePath = join(rootDir, 'data', 'cos', 'task-schedule.json');
    appsPath = join(rootDir, 'data', 'apps.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('moves the schedule, history, pending run, and app override to do-release', async () => {
    writeJson(schedulePath, {
      tasks: {
        'release-check': { type: 'cron', cron: '0 9 * * 1', prompt: 'custom release prompt', promptCustomized: true, taskMetadata: { requireApproval: true } },
        'claim-issue': { runAfter: ['release-check'], suggestedAfter: ['release-check'] },
      },
      executions: { 'task:release-check': { count: 4, lastRun: '2026-09-20T00:00:00.000Z' } },
      onDemandRequests: [{ id: 'pending-1', taskType: 'release-check' }],
    });
    writeJson(appsPath, {
      apps: { 'app-a': { taskTypeOverrides: { 'release-check': { enabled: true, taskMetadata: { mergeDependencyUpdates: false } } } } },
    });

    expect(await migration.up({ rootDir })).toEqual({ schedules: 1, pendingRequests: 1, migratedApps: 1, learningBuckets: 0 });

    const schedule = readJson(schedulePath);
    expect(schedule.tasks).not.toHaveProperty('release-check');
    expect(schedule.tasks['do-release']).toEqual({
      type: 'cron', cron: '0 9 * * 1', prompt: 'custom release prompt', promptCustomized: true, taskMetadata: { requireApproval: true },
    });
    expect(schedule.tasks['claim-issue'].runAfter).toEqual(['do-release']);
    expect(schedule.tasks['claim-issue'].suggestedAfter).toEqual(['do-release']);
    expect(schedule.executions).toEqual({ 'task:do-release': { count: 4, lastRun: '2026-09-20T00:00:00.000Z' } });
    expect(schedule.onDemandRequests[0].taskType).toBe('do-release');
    expect(readJson(appsPath).apps['app-a'].taskTypeOverrides).toEqual({
      'do-release': { enabled: true, taskMetadata: { mergeDependencyUpdates: false } },
    });

    expect(await migration.up({ rootDir })).toEqual({ schedules: 0, pendingRequests: 0, migratedApps: 0, learningBuckets: 0 });
  });

  it('moves the learning buckets so the confidence gate keeps its history', async () => {
    const learningPath = join(rootDir, 'data', 'cos', 'learning.json');
    const lowConfidence = { completed: 9, succeeded: 2 };
    writeJson(learningPath, {
      byTaskType: { 'self-improve:release-check': lowConfidence, 'self-improve:release-checker': { completed: 1 } },
      routingAccuracy: { 'app-improve:release-check': { a: 1 } },
      byTaskTypeExecution: { 'self-improve:release-check|codex|model-x|high': lowConfidence },
      correlationWindow: [{ taskType: 'self-improve:release-check', success: false }],
      errorPatterns: { timeout: { count: 2, taskTypes: { 'self-improve:release-check': 2 } } },
      failureSignatures: { sig: { recent: [{ taskType: 'self-improve:release-check' }] } },
    });

    expect(await migration.up({ rootDir })).toMatchObject({ learningBuckets: 6 });
    expect(readJson(learningPath)).toEqual({
      byTaskType: { 'self-improve:do-release': lowConfidence, 'self-improve:release-checker': { completed: 1 } },
      routingAccuracy: { 'app-improve:do-release': { a: 1 } },
      byTaskTypeExecution: { 'self-improve:do-release|codex|model-x|high': lowConfidence },
      correlationWindow: [{ taskType: 'self-improve:do-release', success: false }],
      errorPatterns: { timeout: { count: 2, taskTypes: { 'self-improve:do-release': 2 } } },
      failureSignatures: { sig: { recent: [{ taskType: 'self-improve:do-release' }] } },
    });
    expect(await migration.up({ rootDir })).toMatchObject({ learningBuckets: 0 });
  });
});
