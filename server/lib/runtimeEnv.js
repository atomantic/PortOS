/**
 * Which runtime is this process? Dependency-free test, Vitest and smoke-boot detectors.
 *
 * Dependency-free `isTestRunner()` (NODE_ENV=test **or** VITEST, so a run that dropped NODE_ENV is still armed), `isVitestRunner()` (a real Vitest worker) and `isSmokeBoot()` (`SMOKE_BOOT_ENV`).
 * Kept apart from `db.js` (which once owned it, forcing every asker to pull in `pg`, and letting suites that `vi.mock('../lib/db.js', ...)` strip it from the graph) because `fileCore.js` and the backend selectors both need it.
 */

/** Under a test runner? `NODE_ENV === 'test'` alone is unreliable (a CoS-agent worktree or wrapper setting NODE_ENV=development still executes test code, and guards keyed on it choose the production path); OR-ing `process.env.VITEST` (set in every Vitest worker) is the signal that closed the 2026-06-14 fixture leak into the real Postgres. Read per call so tests can pin either variable. */
export function isTestRunner() {
  return process.env.NODE_ENV === 'test' || process.env.VITEST != null;
}

/** Inside an actual Vitest worker, narrower than `isTestRunner()`: `NODE_ENV=test` is also how a plain `node` process selects the file-backend hatch, and `scripts/smoke-boot.js` sets it on the real `server/index.js` boot (writing its own files in its disposable `data/`, #8343), so `lib/testDataIsolation.js`'s write guard gates on `process.env.VITEST` instead. */
export function isVitestRunner() {
  return process.env.VITEST != null;
}

/** Env var `scripts/smoke-boot.js` sets on the server it boots (#8343). */
export const SMOKE_BOOT_ENV = 'PORTOS_SMOKE_BOOT';

/** Is this process the server boot smoke? It proves `server/index.js` boots and stays up and must not DO anything: boot skips autonomous startup work (schedulers, CoS agent spawning/recovery, crash recovery, peer polling/sync, share watchers, local-LLM startup, the fleet model host). `NODE_ENV=test` can't carry this (it only selects file storage). */
export function isSmokeBoot() {
  return process.env[SMOKE_BOOT_ENV] === '1';
}
