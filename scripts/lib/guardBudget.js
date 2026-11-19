/**
 * Per-file time budget for the always-run structural guards (#16086, #16551).
 *
 * The guards run on every push, docs-only ones included, so one slow scanner
 * taxes every change. The scheduled hosted run enforces CI_GUARD_BUDGET_MS on its
 * uniform Linux runner (`scripts/run-ci-tests.js` under `CI_GUARD_BUDGET=enforce`);
 * PR, push and release runs report it as a warning (#16810). Local
 * pregate only reports a guard over GUARD_BUDGET_MS: wall time on a developer
 * machine running several agent gates at once measures the host, not the guard.
 *
 * Builtins only: `scripts/pregate.js` loads this from its own fixture checkouts.
 */
import { readFileSync } from 'node:fs';

/** Per-file target on a developer machine, where pregate reports (never fails) a guard over it. */
export const GUARD_BUDGET_MS = 3000;

/**
 * The enforced budget on hosted CI's ubuntu-latest runner. Its isolated guard
 * pass runs ~1.5x slower than a developer machine: the slowest guards measured
 * 3.0-3.5s there when this was set (#16551). 6s leaves room for runner variance
 * while still failing a guard that doubles its cost.
 */
export const CI_GUARD_BUDGET_MS = 6000;

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
