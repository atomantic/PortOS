/**
 * Universe Builder Service — thin barrel (#2529) over the `universeBuilder/` modules.
 * Re-exports sanitize, storeFacade, crud, sync (peer merge + tombstone GC) and
 * compile (prompt compilation) so `import { x } from '.../universeBuilder.js'` resolves.
 */

export * from './universeBuilder/sanitize.js';
export * from './universeBuilder/storeFacade.js';
export * from './universeBuilder/crud.js';
export * from './universeBuilder/sync.js';
export * from './universeBuilder/compile.js';
