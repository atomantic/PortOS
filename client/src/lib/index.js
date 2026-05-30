// Barrel for client/src/lib/ — discovery surface, not a forced import path.
// See client/src/lib/README.md for the human-readable catalog and
// CLAUDE.md "Module organization" for the maintenance convention.

// === Prompt & rendering (mirror server/lib/ — keep byte-for-byte in sync) ===
export * from './canonPrompt.js';
export * from './cleanPlatePrompt.js';
export * from './composeStyledPrompt.js';
export * from './scenePrompt.js';
export * from './seasonStructure.js';
export * from './sheetPointers.js';
export * from './universeStylePreset.js';

// === Pipeline / image-gen defaults ===
export * from './bibleLimits.js';
export * from './catalogTypes.js';
export * from './editorialRoadmap.js';
export * from './imageCleaners.js';
export * from './imageGenBackends.js';
export * from './imageGenDefaults.js';
export * from './imageGenResolutions.js';
export * from './issueLength.js';
export * from './pipelineImageDefaults.js';
export * from './runnerFamilies.js';
export * from './videoGenResolutions.js';
export * from './videoTilingOptions.js';
export * from './wrImageDefaults.js';

// === Graph & sim ===
export * from './graphSimulation.js';

// === Generic UI / collection utilities ===
export * from './clientErrorReporter.js';
export * from './clipboard.js';
export * from './compareHelpers.js';
export * from './genUtils.js';
export * from './joinInfluenceList.js';
export * from './loopbackHost.js';
export * from './mediaNavigation.js';
export * from './sameJsonShape.js';
export * from './unsorted.js';
export * from './upsertByIdPrepend.js';
export * from './voiceLabel.js';

// === Page-scoped pure helpers ===
export * from './universeBuilderExpand.js';
export * from './writingGuide.js';
