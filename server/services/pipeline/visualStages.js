/**
 * Pipeline — Visual stage handoff helpers (barrel, #2531)
 *
 * The former ~1760-line monolith was split along feature seams:
 *
 *   - ./visualStageHelpers.js — shared style/prompt composers + enqueue plumbing.
 *   - ./covers.js             — comic + volume front/back cover renders.
 *   - ./comicPages.js         — comic page renders + panel prompt refine.
 *   - ./storyboards.js        — storyboard scene/shot renders + scene refine.
 *
 * This barrel re-exports the full public surface so every existing
 * `from './visualStages.js'` import path stays valid.
 */

export * from './visualStageHelpers.js';
export * from './covers.js';
export * from './comicPages.js';
export * from './storyboards.js';
