/**
 * The one rule for whether a user-supplied href may be rendered as a link.
 *
 * Re-export of `server/lib/isSafeHref.js` — the one definition of this rule,
 * imported rather than copied so the two runtimes cannot drift. The file stays
 * so every `lib/isSafeHref` import path in the client is unchanged.
 */
export { isSafeHref } from '../../../server/lib/isSafeHref.js';
