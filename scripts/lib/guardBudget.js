/**
 * Per-file time budget for the always-run structural guards (#16086).
 *
 * The guard stage runs on every push, docs-only ones included, so one slow
 * scanner taxes every change. Pregate reads each guard's Vitest wall time and
 * fails the stage naming any file over GUARD_BUDGET_MS.
 *
 * Builtins only: `scripts/pregate.js` loads this from its own fixture checkouts.
 */
import { readFileSync } from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';

export const GUARD_BUDGET_MS = 3000;

/** `{ file, durationMs, budgetMs }` for every guard over its budget, slowest first. */
export function overBudgetGuards(fileDurations) {
  return Object.entries(fileDurations ?? {})
    .map(([file, durationMs]) => ({ file, durationMs, budgetMs: GUARD_BUDGET_MS }))
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
