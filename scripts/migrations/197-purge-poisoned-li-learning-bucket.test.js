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

  it('purges the environmental-failure ledger entries for the dropped bucket', async () => {
    await seed({
      byTaskType: { [LI_BUCKET]: { completed: 2, succeeded: 0, failed: 2, successRate: 0 } },
      environmentalFailures: {
        'network': { count: 3, lastOccurred: '2026-07-01T00:00:00Z', taskTypes: { [LI_BUCKET]: 2, 'idle-review': 1 } },
        'disk': { count: 1, lastOccurred: '2026-07-01T00:00:00Z', taskTypes: { [LI_BUCKET]: 1 } }
      }
    });
    await migration.up({ rootDir });
    const data = await readLearning();
    // The LI share is removed; the unrelated task type's entry survives.
    expect(data.environmentalFailures.network.taskTypes).toEqual({ 'idle-review': 1 });
    expect(data.environmentalFailures.network.count).toBe(1);
    // A category that only ever held LI failures goes away entirely.
    expect(data.environmentalFailures.disk).toBeUndefined();
  });

  it('is a no-op on an install that never ran LI', async () => {
    await seed({ byTaskType: { 'idle-review': { completed: 3, succeeded: 3, failed: 0, successRate: 100 } } });
    const before = await readFile(join(rootDir, LEARNING_REL), 'utf-8');
    const out = await migration.up({ rootDir });
    expect(out.purged).toBe(0);
    // Untouched byte-for-byte — no rewrite when nothing matched.
    expect(await readFile(join(rootDir, LEARNING_REL), 'utf-8')).toBe(before);
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
