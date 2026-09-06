/**
 * The bare-URL detector shared by capture and validation.
 *
 * Re-export of `server/lib/bareUrl.js` — the one definition of this rule,
 * imported rather than copied so the two runtimes cannot drift. The file stays
 * so every `lib/bareUrl` import path in the client is unchanged.
 */
export { parseBareUrl } from '../../../server/lib/bareUrl.js';
