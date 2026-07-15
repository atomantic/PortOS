// Barrel for client/src/utils/ — discovery surface, not a forced import path.
// See client/src/utils/README.md for the human-readable catalog and
// CLAUDE.md "Module organization" for the maintenance convention.
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
export * from './timeWindow.js';

// === General pure helpers ===
export * from './coalesce.js';
export * from './easing.js';
export * from './hashString.js';
export * from './urlNormalize.js';
export * from './platform.js';
export * from './navWorkingSet.js';
export * from './providers.js';
export * from './layeredIntelligenceReasons.js';

// === Module loading / resilience ===
export * from './lazyWithReload.js';
export * from './staleChunkReload.js';

// === File handling ===
export * from './fileUpload.js';

// === CyberCity — character & avatar ===
export * from './characterXp.js';

// === CyberCity — scene compute helpers (one per district / feature) ===
export * from './cityActivityHeatmap.js';
export * from './cityAgentMotion.js';
export * from './cityAiCore.js';
export * from './cityArtifacts.js';
export * from './cityBackupVault.js';
export * from './cityChronotype.js';
export * from './cityDataHarbor.js';
export * from './cityDistrictLayout.js';
export * from './cityEasterEggs.js';
export * from './cityFederation.js';
export * from './cityFilter.js';
export * from './cityFlowLines.js';
export * from './cityGoalMonuments.js';
export * from './cityHealthTower.js';
export * from './cityInteriorWindows.js';
export * from './cityJiraDistrict.js';
export * from './cityMemoryDistrict.js';
export * from './cityMiniMap.js';
export * from './cityPhotoMode.js';
export * from './cityPlan.js';
export * from './cityPlayerRig.js';
export * from './cityRenderBudget.js';
export * from './cityRooftops.js';
export * from './cityProductivity.js';
export * from './citySeasonalDecor.js';
export * from './citySoundscape.js';
export * from './cityTaskFlowRiver.js';
export * from './cityTaskQueue.js';
export * from './cityTimeline.js';
export * from './cityVoiceMarker.js';
