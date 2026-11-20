/**
 * Time budget for the always-run structural guards (#16086, #16551, #16996).
 *
 * The guards run on every push, docs-only ones included, so one slow scanner
 * taxes every change. Nearly every scan is a check inside a structural guard
 * runner (GUARD_CHECK_DIRS), so the budget applies to each check — the summed
 * duration of its tests, as `<runner> > <check>` — and to every other always-run
 * file whole. A runner's own wall time is the sum of its checks and is not
 * budgeted. A check's module-scope work runs while the runner collects, which no
 * test duration includes, so a scan belongs inside a test.
 *
 * The scheduled hosted run enforces CI_GUARD_BUDGET_MS on its uniform Linux
 * runner (`scripts/run-ci-tests.js` under `CI_GUARD_BUDGET=enforce`); PR, push
 * and release runs report it as a warning (#16810). Local pregate only reports a
 * guard over GUARD_BUDGET_MS: wall time on a developer machine running several
 * agent gates at once measures the host, not the guard.
 *
 * Builtins only: `scripts/pregate.js` loads this from its own fixture checkouts.
 */
import { readFileSync } from 'node:fs';
import { GUARD_CHECK_DIRS } from './guardScanners.js';

/**
 * Per-guard target on a developer machine, where pregate reports (never fails) a
 * guard over it. When the runners landed (#16996) the slowest check, the a11y
 * control-name scan, took ~2.1s there and every server check under 1s.
 */
export const GUARD_BUDGET_MS = 2500;

/**
 * The enforced budget on hosted CI's ubuntu-latest runner, whose isolated guard
 * pass runs ~1.5x slower than a developer machine. 4s leaves room for runner
 * variance while still failing a server check that grows to several times its cost.
 */
export const CI_GUARD_BUDGET_MS = 4000;

const RUNNERS = new Set(GUARD_CHECK_DIRS.map(({ runner }) => runner));

/**
 * Budget entries `{ name: ms }` for `results` (`{ file, durationMs, checks }`, with
 * `file` repo-relative and `checks` a check name -> summed test ms): each runner's
 * checks as `<runner> > <check>`, every other file by its wall time.
 */
export function guardDurations(results) {
  const durations = {};
  for (const { file, durationMs, checks } of results) {
    if (RUNNERS.has(file)) {
      for (const [check, ms] of Object.entries(checks ?? {})) durations[`${file} > ${check}`] = ms;
    } else if (typeof durationMs === 'number') durations[file] = durationMs;
  }
  return durations;
}

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
