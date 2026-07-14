/**
 * Universe Builder Service — barrel.
 *
 * Stores user-created "universe templates" — sci-fi/fantasy/etc. universe
 * descriptions expanded by an LLM into a structured prompt set:
 *
 *   - influences.embrace / influences.avoid (token lists managed as draggable
 *     chips) act as both the style prompt and the negative prompt — they are
 *     joined verbatim at render-compile time and form the single source of
 *     truth for the universe's positive + negative tokens.
 *   - categories: named prompt buckets, seeded with common universe-art buckets
 *     like landscapes / characters / vehicles, but open to project-specific
 *     buckets like colonies, factions, species, clothing_styles, or raider_clans
 *     (each with a list of `variations` — short prompt fragments)
 *   - compositeSheets: complete board/poster prompts that combine several
 *     buckets into one image, e.g. a colony costume guide or a universe summary
 *     concept pitch poster
 *
 * From those pieces the route can compile a flat list of full prompts and
 * enqueue them as image-gen jobs, all tagged with the same `universeId` and
 * `runId` so the resulting renders form a self-contained collection.
 *
 * Renders for a run land in a media-collections.json collection named
 * "Universe: <worldName>" (or any other name the user picks at kickoff).
 *
 * ---------------------------------------------------------------------------
 * This file is a THIN BARREL (#2529). The former ~2000-line god-module was
 * split along its natural seams into focused sibling modules under
 * `universeBuilder/`; this barrel re-exports their public surface so every
 * existing `import { x } from '.../universeBuilder.js'` keeps resolving:
 *
 *   - `universeBuilder/sanitize.js`     — constants + record-shape sanitizers
 *   - `universeBuilder/storeFacade.js`  — the shared synchronous store getter
 *   - `universeBuilder/crud.js`         — read/list/get, create/update/delete,
 *                                          runs, render-history mutations
 *   - `universeBuilder/sync.js`         — peer-sync merge + tombstone GC
 *   - `universeBuilder/compile.js`      — prompt compilation
 *
 * (The pre-existing `universeBuilder/store.js` + `db.js` back the facade.)
 */

export * from './universeBuilder/sanitize.js';
export * from './universeBuilder/storeFacade.js';
export * from './universeBuilder/crud.js';
export * from './universeBuilder/sync.js';
export * from './universeBuilder/compile.js';
