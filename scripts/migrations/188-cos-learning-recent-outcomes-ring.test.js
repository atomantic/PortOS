/**
 * Tests for migration 188 — initialize the per-task-type recent-outcomes ring on
 * data/cos/learning.json and bump the store version to 2 (issue #2460).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './188-cos-learning-recent-outcomes-ring.js';

describe('migration 188 — cos-learning recent-outcomes ring', () => {
  let rootDir;
  let learningPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'mig188-'));
    mkdirSync(join(rootDir, 'data', 'cos'), { recursive: true });
    learningPath = join(rootDir, 'data', 'cos', 'learning.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  const write = (obj) => writeFileSync(learningPath, JSON.stringify(obj, null, 2));
  const read = () => JSON.parse(readFileSync(learningPath, 'utf-8'));

  it('initializes an empty ring on each task type and bumps version to 2', async () => {
    write({
      version: 1,
      byTaskType: {
        'self-improve:ui': { completed: 3, succeeded: 1, failed: 2, successRate: 33 },
        'idle-review': { completed: 5, succeeded: 5, failed: 0, successRate: 100 }
      }
    });

    const result = await migration.up({ rootDir });
    expect(result).toEqual({ migrated: true, initialized: 2 });

    const data = read();
    expect(data.version).toBe(2);
    expect(data.byTaskType['self-improve:ui'].recentOutcomes).toEqual([]);
    expect(data.byTaskType['idle-review'].recentOutcomes).toEqual([]);
    // Lifetime counters left untouched.
    expect(data.byTaskType['self-improve:ui'].completed).toBe(3);
  });

  it('does NOT backfill the ring from failure history (would fabricate an all-failure window)', async () => {
    write({
      version: 1,
      byTaskType: { 'auto-fix': { completed: 4, succeeded: 0, failed: 4, successRate: 0 } },
      failureSignatures: { timeout: { count: 4, recent: [{ taskType: 'auto-fix' }] } }
    });

    await migration.up({ rootDir });
    expect(read().byTaskType['auto-fix'].recentOutcomes).toEqual([]);
  });

  it('is idempotent — a second run writes nothing new', async () => {
    write({
      version: 1,
      byTaskType: { 'auto-fix': { completed: 1, succeeded: 1, failed: 0, successRate: 100 } }
    });

    await migration.up({ rootDir });
    // Simulate real activity landing in the ring between runs.
    const afterFirst = read();
    afterFirst.byTaskType['auto-fix'].recentOutcomes.push({ t: '2026-07-11T00:00:00.000Z', s: true });
    writeFileSync(learningPath, JSON.stringify(afterFirst, null, 2));

    const result = await migration.up({ rootDir });
    expect(result).toEqual({ migrated: false, initialized: 0 });
    // The real sample recorded between runs is preserved (not clobbered/reset).
    expect(read().byTaskType['auto-fix'].recentOutcomes).toEqual([{ t: '2026-07-11T00:00:00.000Z', s: true }]);
  });

  it('no-ops when learning.json does not exist yet (fresh install)', async () => {
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ migrated: false, initialized: 0 });
    expect(existsSync(learningPath)).toBe(false);
  });
});
