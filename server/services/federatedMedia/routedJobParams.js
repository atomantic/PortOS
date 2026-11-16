/**
 * Persisted params for a job rendering on a federated peer. A legacy build ignores
 * `remoteMedia` and would render locally, so top-level params must be unrenderable:
 * `prompt: ''`; `modelId: null` (explicit null, since a JS default only fires on
 * `undefined` and would select the local model); `pythonPath: null`.
 * `enqueueJob` applies it to every `remoteMedia` job (#4683).
 */
export const routedJobParams = ({ params = {}, remoteMedia = params.remoteMedia }) => ({
  ...params,
  prompt: '',
  modelId: null,
  pythonPath: null,
  remoteMedia,
});
