// Barrel for client/src/lib/ — discovery surface, not a forced import path.
// See client/src/lib/README.md for the human-readable catalog and
// CLAUDE.md "Module organization" for the maintenance convention.

// === Prompt & rendering (mirror server/lib/ — keep byte-for-byte in sync) ===
export * from './canonPrompt.js';
export * from './cleanPlatePrompt.js';
export * from './composeStyledPrompt.js';
export * from './scenePrompt.js';
export * from './seasonStructure.js';
export * from './universeStylePreset.js';

// === Pipeline / image-gen defaults ===
export * from './bibleLimits.js';
export * from './imageGenBackends.js';
export * from './imageGenResolutions.js';
export * from './issueLength.js';
export * from './pipelineImageDefaults.js';
export * from './runnerFamilies.js';
export * from './wrImageDefaults.js';

// === Graph & sim ===
export * from './graphSimulation.js';

// === Generic UI / collection utilities ===
export * from './clipboard.js';
export * from './genUtils.js';
export * from './joinInfluenceList.js';
export * from './mediaNavigation.js';
export * from './unsorted.js';
export * from './upsertByIdPrepend.js';
