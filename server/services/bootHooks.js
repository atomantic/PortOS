/**
 * Boot-time registration of the callbacks lower modules use to reach higher ones.
 *
 * Each registry below replaced a lazy `import()` whose target statically imports
 * the importer. Such an edge keeps a module out of a static closure, but
 * `vitest related` follows it, so it held the CoS, git, worktree and media-queue
 * hubs in one CI-selection cycle (#12285, #17499). The loaders live here, above
 * both sides: nothing in that cycle imports this module.
 *
 * `bootstrapServices()` calls `registerBootHooks()` before it initializes any
 * consumer (the CoS daemon, the media queue, or the routes that serve git
 * cleanup). A suite that runs one of those consumers calls it too, or registers
 * doubles in the leaf directly. Loaders stay lazy so the boot closure is unchanged.
 */
import { registerCosOrphanRecoveryHandlers } from './cos/cosOrphanRecoveryHooks.js';
import { registerMergedBranchCleanup } from './mergedBranchCleanupHook.js';
import { registerMediaRuntimeModules } from './mediaJobQueue/runtimeModuleRegistry.js';

const agentManagement = () => import('./agent/agentManagement.js');

export function registerBootHooks() {
  registerCosOrphanRecoveryHandlers({
    cleanupOrphanedAgents: async (...args) => (await agentManagement()).cleanupOrphanedAgents(...args),
    handleOrphanedTask: async (...args) => (await agentManagement()).handleOrphanedTask(...args),
  });
  registerMergedBranchCleanup(async (...args) => (await import('./branchReconcile.js')).cleanupMerged(...args));
  registerMediaRuntimeModules({
    topazUpscale: () => import('./videoGen/topazJob.js'),
    ltxUpscale: () => import('./videoGen/upscaleJob.js'),
    stitch: () => import('./videoGen/stitchJob.js'),
    vertical: () => import('./videoGen/verticalJob.js'),
    training: () => import('./loraTraining/index.js'),
  });
}
