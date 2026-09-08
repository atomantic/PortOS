/**
 * Deterministic day-based rotation for POST practice selection.
 *
 * Re-export of `server/lib/postRotation.js` — the one definition of this rule,
 * imported rather than copied so the two runtimes cannot drift. The file stays
 * so every `lib/postRotation` import path in the client is unchanged.
 */
export { dayRotationIndex, orderByRecencyRotation } from '../../../server/lib/postRotation.js';
