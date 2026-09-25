import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import migration, { CLAIM_FLOW_BUCKETS, selectClaimFlowBuckets } from './411-purge-claim-flow-poisoned-learning-buckets.js';

let rootDir;

const LEARNING_REL = 'data/cos/learning.json';

async function seed(data) {
  await mkdir(join(rootDir, 'data', 'cos'), { recursive: true });
  await writeFile(join(rootDir, LEARNING_REL), JSON.stringify(data, null, 2));
}

async function readLearning() {
  return JSON.parse(await readFile(join(rootDir, LEARNING_REL), 'utf-8'));
}

beforeEach(async () => { rootDir = await mkdtemp(join(tmpdir(), 'mig411-')); });
afterEach(async () => { await rm(rootDir, { recursive: true, force: true }); });

describe('411-purge-claim-flow-poisoned-learning-buckets', () => {
  it('purges the claim-flow buckets and preserves every other type', async () => {
    await seed({
      byTaskType: {
        // Poisoned by the parent-workspace commit criterion → fabricated failures.
        'self-improve:claim-issue': { completed: 214, succeeded: 49, failed: 165, successRate: 23, recentOutcomes: [{ t: '2026-09-25T00:00:00Z', s: false }] },
        'self-improve:claim-work': { completed: 4, succeeded: 0, failed: 4, successRate: 0 },
        'claim-issue': { completed: 3, succeeded: 0, failed: 3, successRate: 0 },
        // Honest history — must survive untouched.
        'user-task': { completed: 6, succeeded: 5, failed: 1, successRate: 83 },
        'self-improve:accessibility': { completed: 7, succeeded: 6, failed: 1, successRate: 86 },
        'self-improve:branch-reconcile': { completed: 2, succeeded: 2, failed: 0, successRate: 100 },
      }
    });

    const out = await migration.up({ rootDir });

    expect(out.purged).toBe(221);
    expect(out.buckets.sort()).toEqual(['claim-issue', 'self-improve:claim-issue', 'self-improve:claim-work']);

    const data = await readLearning();
    expect(Object.keys(data.byTaskType).sort()).toEqual([
      'self-improve:accessibility', 'self-improve:branch-reconcile', 'user-task',
    ]);
    // Preserved buckets keep their real numbers — the purge must not touch them.
    expect(data.byTaskType['user-task'].successRate).toBe(83);
    expect(data.byTaskType['self-improve:accessibility'].succeeded).toBe(6);
  });

  it('unwinds the purged buckets from the aggregate totals, not just byTaskType', async () => {
    await seed({
      totals: { completed: 10, succeeded: 4, failed: 6, totalDurationMs: 10_000, successDurationMs: 4_000 },
      byTaskType: {
        'self-improve:claim-issue': { completed: 6, succeeded: 0, failed: 6, totalDurationMs: 6_000, successDurationMs: 0, successRate: 0 },
        'user-task': { completed: 4, succeeded: 4, failed: 0, totalDurationMs: 4_000, successDurationMs: 4_000, successRate: 100 },
      }
    });

    await migration.up({ rootDir });

    const data = await readLearning();
    expect(data.totals.completed).toBe(4);
    expect(data.totals.failed).toBe(0);
    expect(data.totals.succeeded).toBe(4);
  });

  it('is a no-op when no claim-flow bucket exists', async () => {
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

  it('derives its bucket list from the runtime claim-flow set rather than a copy', () => {
    // Kept in lockstep with claimFlowTaskTypes.js — a claim type added there must
    // be purged here too, or its poisoned bucket would survive this migration.
    for (const type of ['plan-task', 'claim-issue', 'claim-issue-gitlab', 'claim-issue-jira', 'claim-work']) {
      expect(CLAIM_FLOW_BUCKETS).toContain(`self-improve:${type}`);
      expect(CLAIM_FLOW_BUCKETS).toContain(type);
    }
    expect(selectClaimFlowBuckets({ 'self-improve:claim-issue': {}, 'auto-fix': {} })).toEqual(['self-improve:claim-issue']);
    expect(selectClaimFlowBuckets({ 'claim-work': {}, 'auto-fix': {} })).toEqual(['claim-work']);
    expect(selectClaimFlowBuckets(null)).toEqual([]);
    expect(selectClaimFlowBuckets([])).toEqual([]);
  });
});
