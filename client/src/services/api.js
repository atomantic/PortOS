// Barrel file — re-exports all API sub-modules.
// Consumers using `import * as api from '../services/api'` continue to work unchanged.

export * from './apiCore.js';
export * from './apiHealth.js';
export * from './apiSystem.js';
export * from './apiApps.js';
export * from './apiPorts.js';
export * from './apiScaffold.js';
export * from './apiProviders.js';
export * from './apiRuns.js';
export * from './apiHistory.js';
export * from './apiCommands.js';
export * from './apiGit.js';
export * from './apiMedia.js';
export * from './apiAgents.js';
export * from './apiPersonalities.js';
export * from './apiAccounts.js';
export * from './apiSchedules.js';
export * from './apiMessages.js';
export * from './apiCalendar.js';
export * from './apiGoals.js';
export * from './apiReview.js';
export * from './apiDatabase.js';
export * from './apiGSD.js';
export * from './apiGithub.js';
export * from './apiLoops.js';
export * from './apiMemory.js';
export * from './apiBrain.js';
export * from './apiNotes.js';
export * from './apiDigitalTwin.js';
export * from './apiMeatspace.js';
export * from './apiMortalLoom.js';
export * from './apiOpenClaw.js';
export * from './apiPalette.js';
export * from './apiDashboard.js';
export * from './apiAsk.js';
export * from './apiImageVideo.js';
export * from './apiMediaJobs.js';

// Default export for simplified imports (get/post/put/delete helpers)
export { default } from './apiCore.js';
