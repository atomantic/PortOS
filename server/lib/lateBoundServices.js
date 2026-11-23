/**
 * Registry of late-bound service modules: a leaf loads an upper-layer module by name without an import edge to it.
 *
 * A literal `import()` in a leaf keeps the target out of the static graph but
 * still links the two for test selection (`vitest related` and the CI planner's
 * DB and browser closures), so one lazy call from a low module to a hub made
 * nearly every suite depend on nearly every service (#17896). Here the leaf
 * names the module and the composition root (`services/serviceLoaders.js`,
 * imported by `server/index.js`) owns the edge.
 *
 * Nothing is registered by default. A test that exercises a late-bound call
 * registers its loader itself, which keeps that dependency visible to the
 * planner: `registerLateBoundService('x', () => import('./x.js'))`.
 * A missing registration throws; it never resolves to an empty module.
 */

const loaders = new Map();

/** Bind `name` to `load`, a function returning (a promise of) the module. The last registration wins. */
export function registerLateBoundService(name, load) {
  if (typeof load !== 'function') throw new TypeError(`Late-bound service "${name}" needs a loader function`);
  loaders.set(name, load);
}

/** The module registered under `name`. Rejects when the process never registered it. */
export async function loadLateBoundService(name) {
  const load = loaders.get(name);
  if (!load) {
    throw new Error(`Late-bound service "${name}" is not registered in this process (see services/serviceLoaders.js)`);
  }
  return load();
}
