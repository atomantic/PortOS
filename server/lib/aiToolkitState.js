/**
 * Shared module-level singleton holding the AI Toolkit instance.
 *
 * `server/index.js` wires the toolkit once at boot and the three service shims
 * (`providers.js`, `runner.js`, `promptService.js`) all read it through here
 * — replacing three identical `let aiToolkitInstance = null` + `requireToolkit()`
 * pairs that previously lived in each shim.
 *
 * `requireToolkit()` throws a typed `ServerError` so callers can gate on
 * `err.code === 'AI_TOOLKIT_NOT_INITIALIZED'` rather than message-match; status
 * 503 because the toolkit warms at boot and a not-initialized state means the
 * service hasn't finished starting. `getAIToolkitInstance()` is the no-throw
 * variant used by cleanup paths (e.g. `unregisterActiveRun`) that should be
 * tolerant of running after the toolkit is gone.
 */

import { ServerError } from './errorHandler.js';

let aiToolkitInstance = null;

export function setAIToolkitInstance(toolkit) {
  aiToolkitInstance = toolkit;
}

export function getAIToolkitInstance() {
  return aiToolkitInstance;
}

export function requireToolkit() {
  if (aiToolkitInstance) return aiToolkitInstance;
  throw new ServerError('AI Toolkit not initialized', {
    status: 503,
    code: 'AI_TOOLKIT_NOT_INITIALIZED',
  });
}
