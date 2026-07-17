import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './197-purge-poisoned-li-learning-bucket.js';

let rootDir;

const LEARNING_REL = 'data/cos/learning.json';
const LI_BUCKET = 'self-improve:layered-intelligence';

async function seed(data) {
  await mkdir(join(rootDir, 'data', 'cos'), { recursive: true });
  await writeFile(join(rootDir, LEARNING_REL), JSON.stringify(data, null, 2));
}

async function readLearning() {
  return JSON.parse(await readFile(join(rootDir, LEARNING_REL), 'utf-8'));
}

beforeEach(async () => { rootDir = await mkdtemp(join(tmpdir(), 'mig197-')); });
afterEach(async () => { await rm(rootDir, { recursive: true, force: true }); });

describe('197-purge-poisoned-li-learning-bucket (#2700)', () => {
  it('drops the poisoned LI bucket and leaves every other task type untouched', async () => {
    await seed({
      byTaskType: {
        [LI_BUCKET]: { completed: 12, succeeded: 0, failed: 12, successRate: 0, recentOutcomes: [{ t: '2026-07-01T00:00:00Z', s: false }] },
        'self-improve:ui': { completed: 5, succeeded: 4, failed: 1, successRate: 80, recentOutcomes: [] },
        'idle-review': { completed: 3, succeeded: 3, failed: 0, successRate: 100 }
      }
    });
    const out = await migration.up({ rootDir });
    expect(out.purged).toBe(12);
    const data = await readLearning();
    expect(data.byTaskType[LI_BUCKET]).toBeUndefined();
    // An absent bucket is what readLiTaskMetrics reads as an honest "never ran".
    expect(Object.keys(data.byTaskType).sort()).toEqual(['idle-review', 'self-improve:ui']);
    expect(data.byTaskType['self-improve:ui'].successRate).toBe(80);
  });

  it('unwinds the LI contribution from totals as well as the bucket', async () => {
    // Deleting only byTaskType would leave the global success rate (the CoS
    // Learning card) still reporting the fabricated failures.
    await seed({
      byTaskType: {
        [LI_BUCKET]: { completed: 10, succeeded: 0, failed: 10, successRate: 0, totalDurationMs: 5000, successDurationMs: 0, successMaxDurationMs: 0 },
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

  it('unwinds routingAccuracy and its byModelTier contribution', async () => {
    await seed({
      byTaskType: {
        [LI_BUCKET]: { completed: 4, succeeded: 0, failed: 4, successRate: 0, totalDurationMs: 4000, avgDurationMs: 1000 },
        'idle-review': { completed: 2, succeeded: 2, failed: 0, successRate: 100, totalDurationMs: 1000, avgDurationMs: 500 }
      },
      totals: { completed: 6, succeeded: 2, failed: 4, totalDurationMs: 5000 },
      routingAccuracy: {
        [LI_BUCKET]: { light: { succeeded: 0, failed: 4 } },
        'idle-review': { light: { succeeded: 2, failed: 0 } }
      },
      byModelTier: { light: { completed: 6, succeeded: 2, failed: 4, totalDurationMs: 5000, avgDurationMs: 833 } }
    });
    await migration.up({ rootDir });
    const data = await readLearning();
    expect(data.routingAccuracy[LI_BUCKET]).toBeUndefined();
    expect(data.routingAccuracy['idle-review']).toBeDefined();
    // The tier keeps only the non-LI runs, so routing stops seeing a poisoned tier.
    expect(data.byModelTier.light.completed).toBe(2);
    expect(data.byModelTier.light.failed).toBe(0);
  });

  it('PRESERVES genuine environmental failures — they were never poisoned by the bug', async () => {
    // Rate-limit/auth/network events are diverted to their own ledger and never
    // reach byTaskType, so they are real outages regardless of the commit bug.
    // (resetTaskTypeLearning purges them; this repair migration must not.)
    await seed({
      byTaskType: { [LI_BUCKET]: { completed: 2, succeeded: 0, failed: 2, successRate: 0, totalDurationMs: 0 } },
      totals: { completed: 2, succeeded: 0, failed: 2, totalDurationMs: 0 },
      environmentalFailures: {
        'network': { count: 3, lastOccurred: '2026-07-01T00:00:00Z', taskTypes: { [LI_BUCKET]: 2, 'idle-review': 1 } }
      }
    });
    await migration.up({ rootDir });
    const data = await readLearning();
    expect(data.byTaskType[LI_BUCKET]).toBeUndefined();
    expect(data.environmentalFailures.network.taskTypes[LI_BUCKET]).toBe(2);
    expect(data.environmentalFailures.network.count).toBe(3);
  });

  it('is a no-op on an install that never ran LI', async () => {
    await seed({ byTaskType: { 'idle-review': { completed: 3, succeeded: 3, failed: 0, successRate: 100 } } });
    const before = await readFile(join(rootDir, LEARNING_REL), 'utf-8');
    const out = await migration.up({ rootDir });
    expect(out.purged).toBe(0);
    // Untouched byte-for-byte — no rewrite when nothing matched.
    expect(await readFile(join(rootDir, LEARNING_REL), 'utf-8')).toBe(before);
  });

  it('tolerates a raw store missing the aggregates the runtime always layers on', async () => {
    // Offline, there is no loadLearningData to apply defaults — a throw here would
    // block boot instead of repairing anything.
    await seed({ byTaskType: { [LI_BUCKET]: { completed: 3, succeeded: 0, failed: 3, successRate: 0 } } });
    const out = await migration.up({ rootDir });
    expect(out.purged).toBe(3);
    expect((await readLearning()).byTaskType[LI_BUCKET]).toBeUndefined();
  });

  it('no-ops when the learning store does not exist yet', async () => {
    const out = await migration.up({ rootDir });
    expect(out).toEqual({ purged: 0, reason: 'no-file' });
  });

  it('skips (never rewrites) a corrupt or unexpectedly-shaped store', async () => {
    await mkdir(join(rootDir, 'data', 'cos'), { recursive: true });
    await writeFile(join(rootDir, LEARNING_REL), '{ not json');
    expect(await migration.up({ rootDir })).toEqual({ purged: 0, reason: 'unparseable' });
    expect(await readFile(join(rootDir, LEARNING_REL), 'utf-8')).toBe('{ not json');

    await writeFile(join(rootDir, LEARNING_REL), JSON.stringify([1, 2]));
    expect(await migration.up({ rootDir })).toEqual({ purged: 0, reason: 'unexpected-shape' });
  });

  it('does not confuse the bare schedule name for the recorded bucket key', async () => {
    // 'layered-intelligence' is the SCHEDULE key (and the type-failure ledger's),
    // and was never the bucket the runs landed in — it must not be purged.
    await seed({ byTaskType: { 'layered-intelligence': { completed: 4, succeeded: 4, failed: 0, successRate: 100 } } });
    const out = await migration.up({ rootDir });
    expect(out.purged).toBe(0);
    expect((await readLearning()).byTaskType['layered-intelligence']).toBeDefined();
  });
});
