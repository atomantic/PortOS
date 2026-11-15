/**
 * `isExtensionError(payload)` — true when an error report came from a browser extension's injected
 * content script rather than from PortOS.
 *
 * Re-exported from `server/lib/extensionErrors.js`, which the ingest route filters on.
 */

/**
 * Browser-extension error classification.
 *
 * Re-export of `server/lib/extensionErrors.js` — the one definition of this rule,
 * imported rather than copied so the two runtimes cannot drift. The file stays
 * so every `lib/extensionErrors` import path in the client is unchanged.
 */
export { isExtensionError } from '../../../server/lib/extensionErrors.js';
