/**
 * Editorial check shared infrastructure (#1829) — re-exporting barrel (#2842).
 *
 * Extracted from checkRegistry.js: the imports, constants, stage names, and
 * pure summary/helper functions that the EDITORIAL_CHECKS entries (now in
 * ./checks/*.js) and the registry tail depend on. Kept side-effect-free so the
 * check files import from here without a cycle through checkRegistry.js (whose
 * EDITORIAL_CHECKS array spreads the check files — importing infra back from the
 * registry would hit a TDZ on eagerly-evaluated configSchemas).
 *
 * This file had grown to 2,635 lines spanning a dozen unrelated sub-domains.
 * Issue #2842 split it into ./checkInfra/* the same way #1152 split
 * `arcPlanner.js`; this barrel re-exports everything so existing
 * `from './checkInfra.js'` imports keep working. New code may import the
 * focused module directly.
 */

export * from './checkInfra/externals.js';
export * from './checkInfra/taxonomy.js';
export * from './checkInfra/revealForeshadowing.js';
export * from './checkInfra/craftStages.js';
export * from './checkInfra/voiceCanon.js';
export * from './checkInfra/structureStages.js';
export * from './checkInfra/povAndNames.js';
export * from './checkInfra/canonScaffolding.js';
export * from './checkInfra/llmRunner.js';
export * from './checkInfra/readability.js';
export * from './checkInfra/rosterCast.js';
export * from './checkInfra/sceneAnalysis.js';
export * from './checkInfra/proseDensity.js';
export * from './checkInfra/comic.js';
