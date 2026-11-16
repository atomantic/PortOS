/**
 * Harnesses — the coding-agent CLIs/TUIs PortOS drives (Models → Harnesses).
 *
 * Coding-agent harness (CLI/TUI) inventory for Models → Harnesses: installed vs latest version, the providers riding on each, and the model-catalog refresh. Read-side only: install / update / remove is an SSE stream owned by the shared `RuntimeInstallModal`
 * (`/api/harnesses/action` with `runtime` and `action` in the query, like every BYO-runtime installer).
 */

import { request } from './apiCore.js';

/**
 * Every harness with its installed version, the latest published version and its provider records. `fresh` bypasses the runtime-status TTL and the npm-registry cache (the Refresh button, and the re-read after an action so a just-installed version shows).
 */
export const getHarnesses = ({ fresh = false, ...options } = {}) =>
  request(`/harnesses${fresh ? '?fresh=1' : ''}`, options);

export const getHarnessUpdateReference = (id, options) => request(
  `/harnesses/update-reference?runtime=${encodeURIComponent(id)}`, options,
);

/**
 * Re-read one harness's own model catalog and write it to every provider drawing from it; resolves `{ models, updated }`, rejects with the server's reason when it can't list models or is signed out.
 */
export const refreshHarnessModels = (id, options) => request(
  `/harnesses/models/refresh?runtime=${encodeURIComponent(id)}`,
  { method: 'POST', ...options },
);
