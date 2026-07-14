/**
 * Creative Ingredients Catalog — Postgres data layer (barrel).
 *
 * Backs the typed catalog of creative "ingredients" (characters, places,
 * objects, ideas, scenes, concepts). Mirrors the role memoryDB.js plays for
 * memories: thin SQL wrappers + row→object translation, no business logic.
 *
 * Tables: catalog_scraps, catalog_ingredients, catalog_ingredient_sources,
 * catalog_ingredient_refs, catalog_ingredient_relations, catalog_ingredient_media,
 * catalog_tags, catalog_ingredient_revisions. See server/scripts/init-db.sql.
 *
 * ---------------------------------------------------------------------------
 * This file is a THIN BARREL (#2529). The former ~1900-line god-module was
 * split along its natural seams into focused sibling modules under `catalogDB/`;
 * this barrel re-exports their public surface so every existing
 * `import { x } from '.../catalogDB.js'` keeps resolving:
 *
 *   - `catalogDB/shared.js`      — row→object mappers, id-minters, the bible
 *                                   payload sanitizer, revision constants, and
 *                                   the cross-seam HOMING SQL fragments (leaf)
 *   - `catalogDB/scraps.js`      — scrap CRUD + chunking
 *   - `catalogDB/ingredients.js` — ingredient CRUD, revisions, FTS/vector/hybrid
 *                                   search (imports normalizeTags from tags)
 *   - `catalogDB/refs.js`        — source links, external refs, relations, roles
 *   - `catalogDB/media.js`       — media attachments + integrity surface
 *   - `catalogDB/tags.js`        — tag taxonomy / normalization
 *   - `catalogDB/sync.js`        — peer-sync change feeds + upserts
 *   - `catalogDB/facets.js`      — export slice / sync bundle / stats / facets
 *
 * Module dependency graph is acyclic: `shared` (leaf) ← every seam;
 * `ingredients` ← `tags`; `facets` ← {`refs`, `media`}.
 */

// `CATALOG_REVISION_RETENTION` is a public export that lives on the leaf module;
// `export *` on a function seam does not forward a binding it merely imports, so
// re-export it explicitly here to preserve the `catalogDB.js` import path.
export { CATALOG_REVISION_RETENTION } from './catalogDB/shared.js';
export * from './catalogDB/scraps.js';
export * from './catalogDB/ingredients.js';
export * from './catalogDB/refs.js';
export * from './catalogDB/media.js';
export * from './catalogDB/tags.js';
export * from './catalogDB/sync.js';
export * from './catalogDB/facets.js';
