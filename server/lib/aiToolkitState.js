/**
 * Shared module-level singleton holding the AI Toolkit instance.
 *
 * `server/index.js` wires the toolkit once at boot; the `providers`/`runner`/`promptService`
 * shims read it here. `requireToolkit()` throws a typed `ServerError`
 * (`AI_TOOLKIT_NOT_INITIALIZED`, 503: still starting); `getAIToolkitInstance()` is
 * the no-throw variant for cleanup paths that may run after the toolkit is gone.
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
