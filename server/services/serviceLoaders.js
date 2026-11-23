/**
 * Composition root for `lib/lateBoundServices.js`: the one place that links each late-bound name to its module.
 *
 * Import it for its side effect from a process entry point only. Importing it
 * from a service would hand that service's importers every module below again.
 */
import { registerLateBoundService } from '../lib/lateBoundServices.js';

export const SERVICE_LOADERS = Object.freeze({
  agentManagement: () => import('./agent/agentManagement.js'),
  agentWorktreeCleanup: () => import('./agent/agentWorktreeCleanup.js'),
  cosToolRegistry: () => import('./cos/cosToolRegistry.js'),
  creativeFirstPassGen: () => import('./creativeDirector/firstPassGen.js'),
  creativeToolRegistry: () => import('./creative/toolRegistry.js'),
  eidoverse: () => import('./eidoverse.js'),
  eidoverseRuntime: () => import('./eidoverseRuntime.js'),
  eidoverseWorld: () => import('./eidoverseWorld.js'),
  managedVisitors: () => import('./managedVisitors.js'),
  persistentMindAdapter: () => import('./persistent/persistentMindAdapter.js'),
});

for (const [name, load] of Object.entries(SERVICE_LOADERS)) registerLateBoundService(name, load);
