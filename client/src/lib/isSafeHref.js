/**
 * Pure http(s)-only scheme check (`isSafeHref`) for user-supplied URL fields rendered as a clickable
 * `<a href>` — rejects `javascript:`/`data:`/etc. stored-XSS payloads.
 *
 * Re-exported from `server/lib/isSafeHref.js`; `utils/urlNormalize.js` re-exports it again as
 * `isHttpUrl`.
 */

/**
 * The one rule for whether a user-supplied href may be rendered as a link.
 *
 * Re-export of `server/lib/isSafeHref.js` — the one definition of this rule,
 * imported rather than copied so the two runtimes cannot drift. The file stays
 * so every `lib/isSafeHref` import path in the client is unchanged.
 */
export { isSafeHref } from '../../../server/lib/isSafeHref.js';
