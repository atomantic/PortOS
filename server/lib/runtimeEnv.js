/**
 * Which runtime is this process? Dependency-free on purpose.
 *
 * Kept apart from every module that has an opinion about storage, paths, or
 * the database, because the lowest-level file primitives (`fileCore.js`) and
 * the highest-level backend selectors both need this answer. `db.js` used to
 * own `isTestRunner`, which forced anything asking the question to pull in
 * `pg` — and, worse, meant the many suites that write
 * `vi.mock('../lib/db.js', () => ({ query }))` silently stripped it out of the
 * module graph for every other consumer in that suite.
 */

/**
 * Are we executing under a test runner?
 *
 * `NODE_ENV === 'test'` alone is not reliable: a suite run from a CoS-agent
 * worktree (or any wrapper that sets NODE_ENV=development / leaves it unset)
 * still executes test code, and every guard and backend selector keyed on
 * NODE_ENV then quietly chooses the production path. Vitest always sets
 * `process.env.VITEST` in every worker process, so OR-ing it in arms them
 * regardless of how NODE_ENV was (mis)configured. This is the signal that
 * actually closed the 2026-06-14 fixture leak into the real Postgres.
 *
 * Read on every call rather than captured at module load, so a test can pin
 * either variable and observe the change.
 *
 * @returns {boolean}
 */
export function isTestRunner() {
  return process.env.NODE_ENV === 'test' || process.env.VITEST != null;
}

/**
 * Are we executing inside an actual Vitest worker — narrower than
 * `isTestRunner()`.
 *
 * `NODE_ENV=test` alone is not "running under Vitest": it is also the
 * documented signal a plain `node` process uses to select the file-backend
 * escape hatch (see AGENTS.md "Storage backend policy"), and `scripts/
 * smoke-boot.js` sets it on the real `server/index.js` boot specifically so
 * CI can smoke-test the server without Postgres. That smoke-booted server
 * legitimately writes its own runtime files into the real `data/` tree — the
 * exact thing `lib/testDataIsolation.js`'s write guard exists to catch a
 * *test suite* doing. Only `process.env.VITEST` (set by every Vitest worker,
 * never by a bare `node` invocation) tells the two apart, so the write guard
 * gates on this, not `isTestRunner()`.
 *
 * @returns {boolean}
 */
export function isVitestRunner() {
  return process.env.VITEST != null;
}
