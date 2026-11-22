/**
 * Loaders for the media job runtimes that themselves import the queue, registered
 * at boot by `registerBootHooks()` (`services/bootHooks.js`).
 *
 * Topaz/LTX upscale, stitch, vertical reframe and LoRA training each import
 * `mediaJobQueue/index.js` to enqueue or read their jobs, so the queue loading
 * them with a lazy `import()` held the queue and every one of them in one
 * CI-selection cycle (#12285, #17499). The queue names a runtime here and the
 * boot owner supplies its loader. This leaf must import nothing; a suite running
 * one of these kinds registers its loaders (or doubles) the same way.
 */
export const QUEUE_IMPORTING_RUNTIMES = Object.freeze(['topazUpscale', 'ltxUpscale', 'stitch', 'vertical', 'training']);

let loaders = null;

/**
 * @param {Record<string, () => Promise<object>>} next - one loader per QUEUE_IMPORTING_RUNTIMES name
 */
export function registerMediaRuntimeModules(next) {
  const missing = QUEUE_IMPORTING_RUNTIMES.filter(name => typeof next?.[name] !== 'function');
  if (missing.length) throw new Error(`Media runtime loaders missing: ${missing.join(', ')}`);
  loaders = next;
}

/** Load a registered runtime; rejects when boot registration has not run so the job fails visibly. */
export function loadMediaRuntimeModule(name) {
  const load = loaders?.[name];
  if (!load) return Promise.reject(new Error(`Media runtime "${name}" is not registered (registerBootHooks() has not run)`));
  return load();
}
