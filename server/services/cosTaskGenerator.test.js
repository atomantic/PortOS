/**
 * Tests for the dry-run eligibility helpers in cosTaskGenerator.js.
 *
 * `selectDryRunAutoApproved` is the shared, non-mutating pass both spawn
 * engines (`dequeueNextTask` in cos.js and `evaluateTasks` here) use to log
 * exactly the auto-approved system tasks execute mode WOULD spawn — applying
 * the same global-slot / max-spawns / cooldown / per-project gates against
 * virtual capacity, without blocking, persisting, or emitting anything. The
 * pre-fix dry-run logged every auto-approved task regardless of eligibility
 * (over-report) and, in dequeue, stopped once user tasks filled the slots
 * (under-report). These tests pin both behaviors.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { selectDryRunAutoApproved, exceedsMaxSpawns } from './cosTaskGenerator.js';
import { MAX_TOTAL_SPAWNS } from '../lib/validation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GEN_SRC = readFileSync(join(__dirname, 'cosTaskGenerator.js'), 'utf-8');
const COS_SRC = readFileSync(join(__dirname, 'cos.js'), 'utf-8');

const task = (id, metadata = {}) => ({ id, metadata });
const noCooldown = () => Promise.resolve(false);

// The unit tests above exercise selectDryRunAutoApproved with synthetic hooks;
// these source-level guards pin that each ENGINE wires the hook set matching
// its own execute path — so a future edit can't silently swap or drop a hook
// (e.g. give dequeue the pipeline cooldown bypass it doesn't have in execute).
describe('dry-run hook wiring matches each engine execute path', () => {
  // Isolate each engine's selectDryRunAutoApproved call site.
  const callSite = (src) => {
    // Anchor on the CALL (`await selectDryRunAutoApproved(`), not the function
    // definition (`export async function selectDryRunAutoApproved(`).
    const start = src.indexOf('await selectDryRunAutoApproved(');
    expect(start, 'selectDryRunAutoApproved must be called').toBeGreaterThan(-1);
    return src.slice(start, src.indexOf('});', start) + 3);
  };

  it('dequeueNextTask (cos.js) passes extraSkip (disabled-analysis-type) but NOT cooldownExempt', () => {
    const site = callSite(COS_SRC);
    expect(site).toContain('extraSkip: isDisabledAnalysisType');
    expect(site).not.toContain('cooldownExempt');
  });

  it('evaluateTasks (cosTaskGenerator.js) passes cooldownExempt (pipeline continuation) but NOT extraSkip', () => {
    const site = callSite(GEN_SRC);
    expect(site).toContain('cooldownExempt:');
    expect(site).toContain('pipeline?.currentStage > 0');
    expect(site).not.toContain('extraSkip');
  });
});

describe('exceedsMaxSpawns', () => {
  it('is false below the ceiling and true at/above it — no mutation', () => {
    expect(exceedsMaxSpawns(task('a', { totalSpawnCount: 0 }))).toBe(false);
    expect(exceedsMaxSpawns(task('b', { totalSpawnCount: MAX_TOTAL_SPAWNS - 1 }))).toBe(false);
    expect(exceedsMaxSpawns(task('c', { totalSpawnCount: MAX_TOTAL_SPAWNS }))).toBe(true);
    expect(exceedsMaxSpawns(task('d', { totalSpawnCount: MAX_TOTAL_SPAWNS + 3 }))).toBe(true);
  });

  it('treats a missing/NaN totalSpawnCount as zero', () => {
    expect(exceedsMaxSpawns(task('a'))).toBe(false);
    expect(exceedsMaxSpawns(task('b', { totalSpawnCount: 'nope' }))).toBe(false);
  });
});

describe('selectDryRunAutoApproved', () => {
  const baseCtx = {
    availableSlots: 5,
    alreadySpawned: 0,
    perProjectLimit: 5,
    spawnProjectCounts: {},
    isOnCooldown: noCooldown
  };

  it('returns all tasks when nothing gates them out', async () => {
    const tasks = [task('1'), task('2'), task('3')];
    const out = await selectDryRunAutoApproved(tasks, baseCtx);
    expect(out.map(t => t.id)).toEqual(['1', '2', '3']);
  });

  it('stops at the global slot cap (does not over-report)', async () => {
    const tasks = [task('1'), task('2'), task('3'), task('4')];
    const out = await selectDryRunAutoApproved(tasks, { ...baseCtx, availableSlots: 2 });
    expect(out.map(t => t.id)).toEqual(['1', '2']);
  });

  it('honors slots already consumed by higher-priority picks (under-report fix)', async () => {
    // Two of three slots already taken by on-demand/user tasks → only one auto-approved fits.
    const tasks = [task('1'), task('2'), task('3')];
    const out = await selectDryRunAutoApproved(tasks, { ...baseCtx, availableSlots: 3, alreadySpawned: 2 });
    expect(out.map(t => t.id)).toEqual(['1']);
  });

  it('skips tasks that have hit the max-spawns ceiling', async () => {
    const tasks = [
      task('1', { totalSpawnCount: MAX_TOTAL_SPAWNS }),
      task('2', { totalSpawnCount: 1 }),
      task('3', { totalSpawnCount: MAX_TOTAL_SPAWNS + 1 })
    ];
    const out = await selectDryRunAutoApproved(tasks, baseCtx);
    expect(out.map(t => t.id)).toEqual(['2']);
  });

  it('skips tasks whose app is on cooldown', async () => {
    const tasks = [task('1', { app: 'appA' }), task('2', { app: 'appB' }), task('3')];
    const isOnCooldown = (appId) => Promise.resolve(appId === 'appA');
    const out = await selectDryRunAutoApproved(tasks, { ...baseCtx, isOnCooldown });
    expect(out.map(t => t.id)).toEqual(['2', '3']);
  });

  it('exempts cooldown when cooldownExempt returns true (pipeline continuation)', async () => {
    const tasks = [task('1', { app: 'appA', pipeline: { currentStage: 2 } })];
    const out = await selectDryRunAutoApproved(tasks, {
      ...baseCtx,
      isOnCooldown: () => Promise.resolve(true),
      cooldownExempt: (t) => t.metadata?.pipeline?.currentStage > 0
    });
    expect(out.map(t => t.id)).toEqual(['1']);
  });

  it('enforces the per-project cap including running agents', async () => {
    // appA already has 1 running; per-project limit is 2 → only one more appA task fits.
    const tasks = [task('1', { app: 'appA' }), task('2', { app: 'appA' }), task('3', { app: 'appB' })];
    const out = await selectDryRunAutoApproved(tasks, {
      ...baseCtx,
      perProjectLimit: 2,
      spawnProjectCounts: { appA: 1 }
    });
    expect(out.map(t => t.id)).toEqual(['1', '3']);
  });

  it('applies the engine-specific extraSkip gate (disabled analysis type)', async () => {
    const tasks = [task('1', { analysisType: 'security' }), task('2', { analysisType: 'perf' })];
    const out = await selectDryRunAutoApproved(tasks, {
      ...baseCtx,
      extraSkip: (t) => t.metadata?.analysisType === 'security'
    });
    expect(out.map(t => t.id)).toEqual(['2']);
  });

  it('does not mutate the passed-in spawnProjectCounts', async () => {
    const counts = { appA: 1 };
    await selectDryRunAutoApproved([task('1', { app: 'appA' })], { ...baseCtx, spawnProjectCounts: counts });
    expect(counts).toEqual({ appA: 1 });
  });

  it('returns nothing when no slots remain', async () => {
    const out = await selectDryRunAutoApproved([task('1')], { ...baseCtx, availableSlots: 3, alreadySpawned: 3 });
    expect(out).toEqual([]);
  });

  it('a skipped task does not consume virtual project capacity (skip-before-increment)', async () => {
    // Both tasks are on appX with a per-project limit of 1. Task 1 is gated out
    // (extraSkip) → it must NOT consume appX's only slot, so task 2 still fits.
    // If a skipped task counted toward capacity, task 2 would be wrongly dropped.
    const tasks = [task('1', { app: 'appX' }), task('2', { app: 'appX' })];
    const out = await selectDryRunAutoApproved(tasks, {
      ...baseCtx,
      perProjectLimit: 1,
      extraSkip: (t) => t.id === '1'
    });
    expect(out.map(t => t.id)).toEqual(['2']);
  });
});
