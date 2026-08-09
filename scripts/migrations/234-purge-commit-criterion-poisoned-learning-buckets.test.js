import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import migration, { PRESERVED_BUCKETS, selectPoisonedBuckets } from './234-purge-commit-criterion-poisoned-learning-buckets.js';

let rootDir;

const LEARNING_REL = 'data/cos/learning.json';

async function seed(data) {
  await mkdir(join(rootDir, 'data', 'cos'), { recursive: true });
  await writeFile(join(rootDir, LEARNING_REL), JSON.stringify(data, null, 2));
}

async function readLearning() {
  return JSON.parse(await readFile(join(rootDir, LEARNING_REL), 'utf-8'));
}

beforeEach(async () => { rootDir = await mkdtemp(join(tmpdir(), 'mig234-')); });
afterEach(async () => { await rm(rootDir, { recursive: true, force: true }); });

describe('234-purge-commit-criterion-poisoned-learning-buckets (#3637)', () => {
  it('purges every commit-judged bucket and preserves the ones the criterion never touched', async () => {
    await seed({
      byTaskType: {
        // Judged by the unsatisfiable criterion → fabricated failures.
        'self-improve:accessibility': { completed: 5, succeeded: 0, failed: 5, successRate: 0, recentOutcomes: [{ t: '2026-07-01T00:00:00Z', s: false }] },
        'self-improve:code-quality': { completed: 4, succeeded: 0, failed: 4, successRate: 0, recentOutcomes: [] },
        'app-improve:security': { completed: 2, succeeded: 0, failed: 2, successRate: 0 },
        'idle-review': { completed: 3, succeeded: 0, failed: 3, successRate: 0 },
        // Never judged by it — must survive.
        'user-task': { completed: 6, succeeded: 5, failed: 1, successRate: 83 },
        'self-improve:layered-intelligence': { completed: 2, succeeded: 2, failed: 0, successRate: 100 },
        'self-improve:branch-reconcile': { completed: 7, succeeded: 6, failed: 1, successRate: 86 },
      }
    });

    const out = await migration.up({ rootDir });

    expect(out.purged).toBe(14);
    expect(out.buckets.sort()).toEqual([
      'app-improve:security', 'idle-review', 'self-improve:accessibility', 'self-improve:code-quality',
    ]);

    const data = await readLearning();
    expect(Object.keys(data.byTaskType).sort()).toEqual([
      'self-improve:branch-reconcile', 'self-improve:layered-intelligence', 'user-task',
    ]);
    // Preserved buckets keep their real numbers — the purge must not touch them.
    expect(data.byTaskType['user-task'].successRate).toBe(83);
    expect(data.byTaskType['self-improve:branch-reconcile'].succeeded).toBe(6);
  });

  it('unwinds the purged buckets from the aggregate totals, not just byTaskType', async () => {
    await seed({
      totals: { completed: 10, succeeded: 4, failed: 6, totalDurationMs: 10_000, successDurationMs: 4_000 },
      byTaskType: {
        'self-improve:accessibility': { completed: 6, succeeded: 0, failed: 6, totalDurationMs: 6_000, successDurationMs: 0, successRate: 0 },
        'user-task': { completed: 4, succeeded: 4, failed: 0, totalDurationMs: 4_000, successDurationMs: 4_000, successRate: 100 },
      }
    });

    await migration.up({ rootDir });

    const data = await readLearning();
    expect(data.totals.completed).toBe(4);
    expect(data.totals.failed).toBe(0);
    expect(data.totals.succeeded).toBe(4);
  });

  it('is a no-op when only preserved buckets exist', async () => {
    await seed({ byTaskType: { 'user-task': { completed: 3, succeeded: 3, failed: 0, successRate: 100 } } });
    const out = await migration.up({ rootDir });
    expect(out.purged).toBe(0);
    expect((await readLearning()).byTaskType['user-task'].completed).toBe(3);
  });

  it('is a no-op with no learning store at all', async () => {
    expect(await migration.up({ rootDir })).toEqual({ purged: 0, reason: 'no-file' });
  });

  it('leaves an unparseable or non-object store alone rather than rewriting it', async () => {
    await mkdir(join(rootDir, 'data', 'cos'), { recursive: true });
    await writeFile(join(rootDir, LEARNING_REL), '{ not json');
    expect(await migration.up({ rootDir })).toEqual({ purged: 0, reason: 'unparseable' });
    expect(await readFile(join(rootDir, LEARNING_REL), 'utf-8')).toBe('{ not json');

    await writeFile(join(rootDir, LEARNING_REL), '[]');
    expect(await migration.up({ rootDir })).toEqual({ purged: 0, reason: 'unexpected-shape' });
  });

  // The runner records a purge migration as applied WITHOUT running it when the
  // applied-list was rebuilt from [] (#2770) — without this flag a lost ledger
  // would delete legitimately-earned post-fix learning data.
  it('opts into the runner purge class', () => {
    expect(migration.purge).toBe(true);
  });

  it('derives its coordinator exemptions from the runtime set rather than a copy', () => {
    // Kept in lockstep with taskTypeHooks.js — a new coordinator type added there
    // must be exempt here too, or this migration would purge its honest history.
    expect(PRESERVED_BUCKETS.has('self-improve:branch-cleanup')).toBe(true);
    expect(PRESERVED_BUCKETS.has('self-improve:jira-status-report')).toBe(true);
    // The bare form too: extractTaskType only prefixes a task carrying an
    // `analysisType`, so a coordinator typed on `taskType` alone can land in an
    // unprefixed bucket — and it was exempt from the old criterion either way.
    expect(PRESERVED_BUCKETS.has('branch-reconcile')).toBe(true);
    expect(selectPoisonedBuckets({ 'branch-reconcile': {}, 'auto-fix': {} })).toEqual(['auto-fix']);
    expect(selectPoisonedBuckets({ 'self-improve:branch-cleanup': {}, 'auto-fix': {} })).toEqual(['auto-fix']);
    expect(selectPoisonedBuckets(null)).toEqual([]);
    expect(selectPoisonedBuckets([])).toEqual([]);
  });
});
