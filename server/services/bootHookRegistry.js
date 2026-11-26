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
 * - Media runtimes & terminal hooks: video/image/audio/SuperCollider/HTML
 *   generators, remote adapters, policy/staging/settlement helpers, and the
 *   terminal completion hook table all sit above `mediaJobQueue/` (#17499,
 *   #18217). Routing them through this leaf keeps `mediaJobQueue` off the
 *   domain subtrees (CoS, Creative Director, Pipeline, Music Video, FableLoom).
 * - Music Video boot recovery: `render.js` and `excerptRender.js` are the
 *   render pipeline. Boot calls them only to resume interrupted jobs (#17692).
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

export const QUEUE_IMPORTING_RUNTIMES = Object.freeze(['topazUpscale', 'falUpscale', 'ltxUpscale', 'stitch', 'vertical']);

export const MEDIA_RUNTIME_MODULES = Object.freeze([
  ...QUEUE_IMPORTING_RUNTIMES,
  'videoLocal', 'videoGrok', 'videoFal', 'videoReactor', 'videoRunway', 'videoGemini', 'videoHiggsfield', 'videoGoogle',
  'imageLocal', 'imageCodex', 'imageGrok', 'imageAgy', 'imageFal', 'imageRunway', 'imageHiggsfield', 'imageGoogle',
  'audioLocal', 'sharingCopy', 'htmlComposition', 'superCollider',
  'audioRemote', 'imageRemote', 'videoRemote',
  'reviewedReference', 'finishVisualProfile', 'imageVerifier', 'topazStaging', 'videoModelSelection',
  'creativeDirectorVideoExecution', 'musicVideoProjects', 'musicVideoClipCastReferences',
  'musicVideoRevisionService', 'musicVideoProductionReview', 'fableLoomRequestInputs',
]);

let mediaRuntimes = null;

/** @param {Record<string, () => Promise<object>>} loaders - one loader per MEDIA_RUNTIME_MODULES name */
export function registerMediaRuntimeModules(loaders) {
  const missing = MEDIA_RUNTIME_MODULES.filter(name => typeof loaders?.[name] !== 'function');
  if (missing.length) throw new Error(`Media runtime loaders missing: ${missing.join(', ')}`);
  mediaRuntimes = loaders;
}

/** Load a registered runtime; rejects on an empty slot so the job fails visibly. */
export function loadMediaRuntimeModule(name) {
  const load = mediaRuntimes?.[name];
  if (!load) return Promise.reject(notRegistered(`Media runtime "${name}"`));
  return load();
}

let mediaJobTerminalHooks = null;

/** @param {Array<[Function, () => Promise<unknown>]>} registrations - [matcher, loader] pairs for terminal media job hooks */
export function registerMediaJobTerminalHooks(registrations) {
  if (!Array.isArray(registrations)
    || registrations.some(entry => !Array.isArray(entry) || typeof entry[0] !== 'function' || typeof entry[1] !== 'function')) {
    throw new Error('Media job terminal hooks must be an array of [matcher, loader] pairs');
  }
  mediaJobTerminalHooks = registrations;
}

/** Terminal listeners attach durable outputs, so an empty slot throws. */
export function requireMediaJobTerminalHooks() {
  if (!mediaJobTerminalHooks) throw notRegistered('Media job terminal hooks');
  return mediaJobTerminalHooks;
}

let musicVideoRecovery = null;

/**
 * @param {{ recoverRenders: () => Promise<void>, recoverExcerpts: () => Promise<void> }} loaders
 * Each loader imports its pipeline module and runs that module's boot recovery.
 */
export function registerMusicVideoRecovery(loaders) {
  if (typeof loaders?.recoverRenders !== 'function' || typeof loaders?.recoverExcerpts !== 'function') {
    throw new Error('Music Video recovery loaders missing: recoverRenders, recoverExcerpts');
  }
  musicVideoRecovery = loaders;
}

/** Interrupted renders must be marked, so an empty slot throws. */
export function requireMusicVideoRecovery() {
  if (!musicVideoRecovery) throw notRegistered('Music Video recovery');
  return musicVideoRecovery;
}
