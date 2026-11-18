/**
 * Creative Ingredients Catalog — Postgres data layer (barrel).
 * Re-exports the focused seams under `catalogDB/` so `import { x } from '.../catalogDB.js'` keeps resolving.
 * Dependency graph is acyclic: `shared` (leaf) <- every seam; `ingredients` <- `tags`; `facets` <- {`refs`, `media`}.
 */

// `CATALOG_REVISION_RETENTION` lives on the leaf `shared` module and `export *` does not forward bindings a seam merely imports, so re-export it explicitly.
export * from '../catalogDB/scraps.js';
export * from '../catalogDB/ingredients.js';
export * from '../catalogDB/refs.js';
export * from '../catalogDB/media.js';
export * from '../catalogDB/tags.js';
export * from '../catalogDB/commit.js';
export * from '../catalogDB/sync.js';
export * from '../catalogDB/facets.js';
