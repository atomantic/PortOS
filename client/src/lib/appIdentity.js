/**
 * The product name/tagline every surface prints.
 *
 * Re-export of `server/lib/appIdentity.js` — the one definition of this rule,
 * imported rather than copied so the two runtimes cannot drift. The file stays
 * so every `lib/appIdentity` import path in the client is unchanged.
 */
export { PORTOS_APP_ID } from '../../../server/lib/appIdentity.js';
