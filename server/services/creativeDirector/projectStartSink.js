/**
 * Creative Director — project-start sink (#5920).
 *
 * Leaf seam that keeps `server/services/pipeline/*` and `creativeDirector/*` out of
 * a static import cycle (a boot-time TDZ hazard; see `server/test/guards/modules/serviceImportCycles.test.js`).
 * The pipeline calls this leaf; the CD side REGISTERS its starter here at module
 * evaluation (`completionHook.js`, imported by `server/index.js`). A lazy
 * `await import()` would only hide the cycle from the guard, so it is not the fix.
 *
 * Registration is a hard requirement: an unregistered request THROWS, because a CD
 * project that silently never advances is invisible.
 */

let startProject = null;

/**
 * Wire the concrete starter. Re-registering the same fn is a no-op; a DIFFERENT one throws.
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
