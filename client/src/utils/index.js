// Barrel for client/src/utils/ — discovery surface, not a forced import path.
// See client/src/utils/README.md for the human-readable catalog and
// AGENTS.md "Module organization" for the maintenance convention.
//
// Every module here exports named (no defaults), so a flat `export * from`
// surfaces each helper under its own name. The barrel exists so helpers are
// discoverable and the drift test (index.test.js) can enforce that every new
// utils module gets registered here AND documented in the README. Existing
// deep imports (`import { formatBytes } from '../utils/formatters'`) keep
// working — the barrel is for discovery, not to force a re-import.

// === Formatting & time ===
export * from './formatters.js';
export * from './cronHelpers.js';
export * from './markdownText.js';
export * from './timeWindow.js';
export * from './timezone.js';

// === General pure helpers ===
export * from './animationClips.js';
export * from './coalesce.js';
export * from './easing.js';
export * from './hashString.js';
export * from './modelFit.js';
export * from './sleep.js';
export * from './urlNormalize.js';
export * from './platform.js';
export * from './navWorkingSet.js';
export * from './providers.js';
export * from './systemCapabilities.js';
export * from './layeredIntelligenceReasons.js';

// === Module loading / resilience ===
export { lazyWithReload } from './lazyWithReload.js';
export * from './staleChunkReload.js';

// === File handling ===
export * from './fileUpload.js';

// === OpenWorld — character & avatar ===
export * from './characterXp.js';

export * from './renderBudget.js';
