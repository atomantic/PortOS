/**
 * `PORTOS_APP_ID` — stable id of the baseline PortOS app.
 *
 * Re-exported from `server/lib/appIdentity.js`; dependency-free so a module reachable from a server
 * test can import it.
 */

/**
 * The product name/tagline every surface prints.
 *
 * Re-export of `server/lib/appIdentity.js` — the one definition of this rule,
 * imported rather than copied so the two runtimes cannot drift. The file stays
 * so every `lib/appIdentity` import path in the client is unchanged.
 */
export { PORTOS_APP_ID } from '../../../server/lib/appIdentity.js';
