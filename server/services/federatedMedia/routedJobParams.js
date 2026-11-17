/**
 * Persisted params for a job rendering on a federated peer. A legacy build ignores
 * `remoteMedia` and would render locally, so top-level params must be unrenderable:
 * `prompt: ''`; `modelId: null` (explicit null, since a JS default only fires on
 * `undefined` and would select the local model); `pythonPath: null`.
 * `enqueueJob` applies it to every `remoteMedia` job (#4683).
 * @param {object} args
 * @param {object} [args.params] - Job params that survive routing (destination
 *   tags, dimensions, seed). Local-only routing/backend selectors are stripped
 *   by the caller before they get here.
 * @param {object} [args.remoteMedia] - The versioned marker from
 *   prepareRemoteMediaJob. Defaults to the one already on `params` — which is
 *   how enqueueJob calls it, having selected the job on that same marker.
 * @returns {object} Params to persist on the queued proxy job.
 */
export const routedJobParams = ({ params = {}, remoteMedia = params.remoteMedia }) => ({
  ...params,
  prompt: '',
  modelId: null,
  pythonPath: null,
  remoteMedia,
});
