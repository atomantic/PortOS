import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './198-purge-poisoned-coordinator-learning-buckets.js';

let rootDir;

const LEARNING_REL = 'data/cos/learning.json';
const BR_BUCKET = 'self-improve:branch-reconcile';
const IR_BUCKET = 'self-improve:issue-reconcile';

async function seed(data) {
  await mkdir(join(rootDir, 'data', 'cos'), { recursive: true });
  await writeFile(join(rootDir, LEARNING_REL), JSON.stringify(data, null, 2));
}

async function readLearning() {
  return JSON.parse(await readFile(join(rootDir, LEARNING_REL), 'utf-8'));
}

beforeEach(async () => { rootDir = await mkdtemp(join(tmpdir(), 'mig198-')); });
afterEach(async () => { await rm(rootDir, { recursive: true, force: true }); });

describe('198-purge-poisoned-coordinator-learning-buckets (#2696)', () => {
  it('drops BOTH coordinator buckets and leaves every other task type untouched', async () => {
    await seed({
      byTaskType: {
        [BR_BUCKET]: { completed: 8, succeeded: 0, failed: 8, successRate: 0, recentOutcomes: [{ t: '2026-07-01T00:00:00Z', s: false }] },
        [IR_BUCKET]: { completed: 3, succeeded: 0, failed: 3, successRate: 0, recentOutcomes: [] },
        'self-improve:accessibility': { completed: 5, succeeded: 4, failed: 1, successRate: 80, recentOutcomes: [] },
        'idle-review': { completed: 3, succeeded: 3, failed: 0, successRate: 100 }
      }
    });
    const out = await migration.up({ rootDir });
    expect(out.purged).toBe(11);
    expect(out.buckets.sort()).toEqual([BR_BUCKET, IR_BUCKET].sort());
    const data = await readLearning();
    expect(data.byTaskType[BR_BUCKET]).toBeUndefined();
    expect(data.byTaskType[IR_BUCKET]).toBeUndefined();
    // accessibility is a fixing task that commits — NOT poisoned by this bug, must survive.
    expect(Object.keys(data.byTaskType).sort()).toEqual(['idle-review', 'self-improve:accessibility']);
    expect(data.byTaskType['self-improve:accessibility'].successRate).toBe(80);
  });

  it('purges ALL four coordinator buckets and leaves committing types alone', async () => {
    await seed({
      byTaskType: {
        'self-improve:branch-reconcile': { completed: 2, succeeded: 0, failed: 2, successRate: 0 },
        'self-improve:issue-reconcile': { completed: 2, succeeded: 0, failed: 2, successRate: 0 },
        'self-improve:branch-cleanup': { completed: 3, succeeded: 0, failed: 3, successRate: 0 },
        'self-improve:jira-status-report': { completed: 1, succeeded: 0, failed: 1, successRate: 0 },
        // These COMMIT — their bucket is legitimate and must survive.
        'self-improve:jira-sprint-manager': { completed: 4, succeeded: 3, failed: 1, successRate: 75 },
        'self-improve:accessibility': { completed: 5, succeeded: 4, failed: 1, successRate: 80 }
      }
    });
    const out = await migration.up({ rootDir });
    expect(out.purged).toBe(8);
    const data = await readLearning();
    expect(Object.keys(data.byTaskType).sort()).toEqual(['self-improve:accessibility', 'self-improve:jira-sprint-manager']);
  });

  it('purges just the one coordinator bucket present when the other never ran', async () => {
    await seed({
      byTaskType: {
        [BR_BUCKET]: { completed: 4, succeeded: 0, failed: 4, successRate: 0 },
        'idle-review': { completed: 2, succeeded: 2, failed: 0, successRate: 100 }
      }
    });
    const out = await migration.up({ rootDir });
    expect(out.purged).toBe(4);
    expect(out.buckets).toEqual([BR_BUCKET]);
    expect((await readLearning()).byTaskType[BR_BUCKET]).toBeUndefined();
  });

  it('unwinds the coordinator contribution from totals as well as the buckets', async () => {
    await seed({
      byTaskType: {
        [BR_BUCKET]: { completed: 6, succeeded: 0, failed: 6, successRate: 0, totalDurationMs: 3000, successDurationMs: 0, successMaxDurationMs: 0 },
        [IR_BUCKET]: { completed: 4, succeeded: 0, failed: 4, successRate: 0, totalDurationMs: 2000, successDurationMs: 0, successMaxDurationMs: 0 },
        'idle-review': { completed: 4, succeeded: 4, failed: 0, successRate: 100, totalDurationMs: 2000, successDurationMs: 2000, successMaxDurationMs: 700 }
      },
      totals: { completed: 14, succeeded: 4, failed: 10, totalDurationMs: 7000, successDurationMs: 2000, successMaxDurationMs: 700 }
    });
    await migration.up({ rootDir });
    const { totals } = await readLearning();
    // Only the surviving idle-review runs remain — a true 4/4, not 4/14.
    expect(totals.completed).toBe(4);
    expect(totals.succeeded).toBe(4);
    expect(totals.failed).toBe(0);
    expect(totals.totalDurationMs).toBe(2000);
  });

  it('PRESERVES genuine environmental failures — they were never poisoned by the bug', async () => {
    await seed({
      byTaskType: { [BR_BUCKET]: { completed: 2, succeeded: 0, failed: 2, successRate: 0, totalDurationMs: 0 } },
      totals: { completed: 2, succeeded: 0, failed: 2, totalDurationMs: 0 },
      environmentalFailures: {
        'network': { count: 3, lastOccurred: '2026-07-01T00:00:00Z', taskTypes: { [BR_BUCKET]: 2, 'idle-review': 1 } }
      }
    });
    await migration.up({ rootDir });
    const data = await readLearning();
    expect(data.byTaskType[BR_BUCKET]).toBeUndefined();
    expect(data.environmentalFailures.network.taskTypes[BR_BUCKET]).toBe(2);
    expect(data.environmentalFailures.network.count).toBe(3);
  });

  it('is a no-op on an install that never ran either coordinator', async () => {
    await seed({ byTaskType: { 'idle-review': { completed: 3, succeeded: 3, failed: 0, successRate: 100 } } });
    const before = await readFile(join(rootDir, LEARNING_REL), 'utf-8');
    const out = await migration.up({ rootDir });
    expect(out.purged).toBe(0);
    // Untouched byte-for-byte — no rewrite when nothing matched.
    expect(await readFile(join(rootDir, LEARNING_REL), 'utf-8')).toBe(before);
  });

  it('no-ops when the learning store does not exist yet', async () => {
    expect(await migration.up({ rootDir })).toEqual({ purged: 0, reason: 'no-file' });
  });

  it('skips (never rewrites) a corrupt or unexpectedly-shaped store', async () => {
    await mkdir(join(rootDir, 'data', 'cos'), { recursive: true });
    await writeFile(join(rootDir, LEARNING_REL), '{ not json');
    expect(await migration.up({ rootDir })).toEqual({ purged: 0, reason: 'unparseable' });
    expect(await readFile(join(rootDir, LEARNING_REL), 'utf-8')).toBe('{ not json');

    await writeFile(join(rootDir, LEARNING_REL), JSON.stringify([1, 2]));
    expect(await migration.up({ rootDir })).toEqual({ purged: 0, reason: 'unexpected-shape' });
  });

  it('does not confuse the bare schedule names for the recorded bucket keys', async () => {
    // 'branch-reconcile' / 'issue-reconcile' are the SCHEDULE keys (and the type-failure
    // ledger's), never the buckets the runs landed in — they must not be purged.
    await seed({ byTaskType: {
      'branch-reconcile': { completed: 4, succeeded: 4, failed: 0, successRate: 100 },
      'issue-reconcile': { completed: 2, succeeded: 2, failed: 0, successRate: 100 }
    } });
    const out = await migration.up({ rootDir });
    expect(out.purged).toBe(0);
    const data = await readLearning();
    expect(data.byTaskType['branch-reconcile']).toBeDefined();
    expect(data.byTaskType['issue-reconcile']).toBeDefined();
  });
});
