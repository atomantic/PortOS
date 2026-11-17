/**
 * Per-file time budget for the always-run structural guards (#16086, #16551).
 *
 * The guards run on every push, docs-only ones included, so one slow scanner
 * taxes every change. Hosted CI enforces the budget on its uniform Linux runner
 * (`scripts/run-ci-tests.js` under `CI_GUARD_BUDGET=enforce`). Local pregate
 * only reports a guard over it: wall time on a developer machine running
 * several agent gates at once measures the host, not the guard.
 *
 * Builtins only: `scripts/pregate.js` loads this from its own fixture checkouts.
 */
import { readFileSync } from 'node:fs';

export const GUARD_BUDGET_MS = 3000;

/** `{ file, durationMs, budgetMs }` for every guard over its budget, slowest first. */
export function overBudgetGuards(fileDurations, budgetMs = GUARD_BUDGET_MS) {
  return Object.entries(fileDurations ?? {})
    .map(([file, durationMs]) => ({ file, durationMs, budgetMs }))
    .filter(({ durationMs, budgetMs }) => durationMs > budgetMs)
    .sort((a, b) => b.durationMs - a.durationMs);
}

/** `a.test.js 3.4s; b.test.js 3.1s`, shared by the pregate report line and the CI failure. */
export const describeGuardDurations = (rows) => rows.map(({ file, durationMs }) => `${file} ${(durationMs / 1000).toFixed(1)}s`).join('; ');

/** Durations the test runner wrote for a guard stage; empty when it ran nothing or the file is unreadable. */
export function readGuardDurations(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
