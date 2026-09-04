/**
 * Creative Director — project-start sink (#5920).
 *
 * The one seam that keeps `server/services/pipeline/*` and
 * `server/services/creativeDirector/*` out of a shared import cycle.
 *
 * The two halves are genuinely bidirectional at RUNTIME: the Creative Director's
 * tool registry can start a Series Autopilot run, and the pipeline's episode-video
 * step can start a CD project. Expressed as two static imports that is a 22-module
 * strongly-connected component (see `serviceImportCycles.test.js`), and in a static
 * ESM cycle whichever member evaluates first sees `undefined` for the others'
 * bindings — a boot-time TDZ crash waiting on a module-ordering change.
 *
 * Only ONE edge ran pipeline → creativeDirector: `pipeline/episodeVideo.js`
 * importing `completionHook.js#startCreativeDirectorProject`. This module inverts
 * it. The pipeline side depends on this leaf (it imports nothing), and the CD side
 * REGISTERS its starter here at module evaluation, so the arrow now points
 * creativeDirector → pipeline in both directions and the component dissolves.
 *
 * Deferring the import with `await import()` would have hidden the cycle from the
 * guard without removing the boot-order hazard, so it is deliberately not the fix.
 *
 * **Registration is a hard requirement, not best-effort.** `completionHook.js`
 * registers on import, and `server/index.js` imports it for that side effect at
 * boot (routes/creativeDirector.js also pulls it in, but boot order is not a
 * contract to lean on). An unregistered request THROWS rather than silently
 * dropping the start — a CD project that never advances is invisible, and the
 * caller logs the throw.
 */

let startProject = null;

/**
 * Wire the concrete starter. Idempotent: re-registering the same function is a
 * no-op (module re-evaluation under a test suite), and registering a DIFFERENT
 * one throws rather than letting a second registrant silently win.
 *
 * @param {(projectId: string) => Promise<unknown>} fn
 */
export function registerCreativeDirectorProjectStarter(fn) {
  if (typeof fn !== 'function') {
    throw new Error('registerCreativeDirectorProjectStarter: starter must be a function');
  }
  if (startProject && startProject !== fn) {
    throw new Error('registerCreativeDirectorProjectStarter: a different starter is already registered');
  }
  startProject = fn;
}

/** Whether a starter has been wired. Exported for the boot-time guard and tests. */
export function hasCreativeDirectorProjectStarter() {
  return startProject !== null;
}

/**
 * Start a Creative Director project through the registered starter.
 *
 * @param {string} projectId
 * @returns {Promise<unknown>}
 */
export async function requestCreativeDirectorProjectStart(projectId) {
  if (!startProject) {
    throw new Error(`Creative Director project start requested before a starter was registered (project ${projectId})`);
  }
  return startProject(projectId);
}

/** Test-only: drop the registration so a suite can assert the unwired behavior. */
export function __resetCreativeDirectorProjectStarter() {
  startProject = null;
}
