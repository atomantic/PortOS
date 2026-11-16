/**
 * Per-file time budget for the always-run structural guards (#16086).
 *
 * The guard stage runs on every push, docs-only ones included, so one slow
 * scanner taxes every change. Pregate reads each guard's Vitest wall time and
 * fails the stage naming any file over GUARD_BUDGET_MS.
 *
 * Builtins only: `scripts/pregate.js` loads this from its own fixture checkouts.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';

export const GUARD_BUDGET_MS = 3000;

/** Calibration workload time (ms) on the machine GUARD_BUDGET_MS was tuned on; see calibrateBudgetScale. */
export const CALIBRATION_REFERENCE_MS = 25;

/** Cap so a pathological calibration reading can never disable the budget outright. */
export const MAX_BUDGET_SCALE = 6;

/** Fixed CPU + JSON + hashing work, the same shape of cost the guards pay scanning sources. */
function timeCalibration() {
  const start = performance.now();
  const rows = Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `file-${i}.js`, deps: [i, i + 1, i + 2] }));
  for (let round = 0; round < 60; round++) {
    const text = JSON.stringify(rows);
    JSON.parse(text);
    createHash('sha1').update(text).digest('hex');
  }
  return performance.now() - start;
}

/**
 * How much slower this machine is than the one the budget was tuned on, as a
 * multiplier >= 1 (#16292). Takes the fastest of a few runs so one scheduler
 * hiccup does not inflate it. `measure` returns elapsed ms; injectable for tests.
 */
export function calibrateBudgetScale({ measure = timeCalibration, runs = 3 } = {}) {
  let best = Infinity;
  for (let i = 0; i < runs; i++) best = Math.min(best, measure());
  if (!Number.isFinite(best)) return 1;
  return Math.min(MAX_BUDGET_SCALE, Math.max(1, best / CALIBRATION_REFERENCE_MS));
}

/** `{ file, durationMs, budgetMs }` for every guard over its budget, slowest first. */
export function overBudgetGuards(fileDurations, budgetMs = GUARD_BUDGET_MS) {
  return Object.entries(fileDurations ?? {})
    .map(([file, durationMs]) => ({ file, durationMs, budgetMs }))
    .filter(({ durationMs, budgetMs }) => durationMs > budgetMs)
    .sort((a, b) => b.durationMs - a.durationMs);
}

/**
 * Split guards over budget in the stage into those an isolated serial re-run
 * clears and those still over (#16279). A guard missing from the re-run
 * readings (the re-run failed or recorded nothing) stays over, so an
 * unverified retry never excuses a slow guard.
 * Returns `{ cleared, stillOver }`, each `{ file, durationMs, isolatedMs, budgetMs }`.
 */
export function settleOverBudget(over, isolatedDurations) {
  const cleared = [];
  const stillOver = [];
  for (const entry of over) {
    const isolatedMs = isolatedDurations?.[entry.file];
    const row = { ...entry, isolatedMs: typeof isolatedMs === 'number' ? isolatedMs : null };
    (row.isolatedMs !== null && row.isolatedMs <= entry.budgetMs ? cleared : stillOver).push(row);
  }
  return { cleared, stillOver };
}

/** Durations the test runner wrote for a guard stage; empty when it ran nothing or the file is unreadable. */
export function readGuardDurations(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Vitest wall time stretches with host contention (parallel agents, other
 * builds), so a slow reading on a saturated machine says nothing about the
 * guard. Enforce only while the 1-minute load average fits the core count;
 * Windows reports 0 and is always enforced.
 */
export function hostTooBusyForBudget({ load = loadavg()[0], cores = availableParallelism() } = {}) {
  return load > cores;
}
