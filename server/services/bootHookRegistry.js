/**
 * Callbacks lower modules use to reach higher ones, filled at boot by
 * `registerBootHooks()` (`services/bootHooks.js`).
 *
 * Each slot replaced a lazy `import()` whose target statically imports the
 * importer. Such an edge keeps a module out of a static closure, but
 * `vitest related` follows it, so it held the CoS, git and media-queue hubs in
 * one CI-selection cycle (#12285, #17499):
 *
 * - CoS orphan recovery: `agent/agentManagement.js` imports `cos/cos.js`.
 * - Merged-branch cleanup: branch reconciliation imports `git.js`.
 * - Media runtimes: Topaz/LTX upscale, stitch, vertical reframe and LoRA
 *   training import `mediaJobQueue/index.js` to enqueue or read their jobs.
 *
 * This leaf must import nothing. Every reader fails loudly when its slot is
 * empty: a process that reaches these consumers without boot registration is a
 * wiring defect, never a silent no-op. A suite that runs a consumer registers
 * the slot it needs (doubles, or loaders that resolve to its `vi.mock`s).
 */

const notRegistered = (what) => new Error(`${what} is not registered (registerBootHooks() has not run)`);

let cosOrphanRecovery = null;

/** @param {{ cleanupOrphanedAgents: () => Promise<number>, handleOrphanedTask: Function }} handlers */
export function registerCosOrphanRecoveryHandlers(handlers) {
  cosOrphanRecovery = handlers;
}

/** Orphan recovery keeps a dead agent from holding its task forever, so an empty slot throws. */
export function requireCosOrphanRecoveryHandlers() {
  if (!cosOrphanRecovery) throw notRegistered('CoS orphan recovery');
  return cosOrphanRecovery;
}

let mergedBranchCleanup = null;

/** @param {(repoPath: string, targetSha: string, branches: object[], options: object) => Promise<{ cleaned: string[], skipped: object[] }>} cleanup */
export function registerMergedBranchCleanup(cleanup) {
  mergedBranchCleanup = cleanup;
}

/** Deleting branches without the retirement gates is never a fallback, so an empty slot throws. */
export function requireMergedBranchCleanup() {
  if (!mergedBranchCleanup) throw notRegistered('Merged-branch cleanup');
  return mergedBranchCleanup;
}

export const QUEUE_IMPORTING_RUNTIMES = Object.freeze(['topazUpscale', 'ltxUpscale', 'stitch', 'vertical', 'training']);

let mediaRuntimes = null;

/** @param {Record<string, () => Promise<object>>} loaders - one loader per QUEUE_IMPORTING_RUNTIMES name */
export function registerMediaRuntimeModules(loaders) {
  const missing = QUEUE_IMPORTING_RUNTIMES.filter(name => typeof loaders?.[name] !== 'function');
  if (missing.length) throw new Error(`Media runtime loaders missing: ${missing.join(', ')}`);
  mediaRuntimes = loaders;
}

/** Load a registered runtime; rejects on an empty slot so the job fails visibly. */
export function loadMediaRuntimeModule(name) {
  const load = mediaRuntimes?.[name];
  if (!load) return Promise.reject(notRegistered(`Media runtime "${name}"`));
  return load();
}
