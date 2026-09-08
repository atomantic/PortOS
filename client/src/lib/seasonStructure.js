/**
 * Season/episode structure vocabulary.
 *
 * Re-export of `server/lib/seasonStructure.js` — the one definition of this rule,
 * imported rather than copied so the two runtimes cannot drift. The file stays
 * so every `lib/seasonStructure` import path in the client is unchanged.
 */
export { describeStructure, recommendStructure } from '../../../server/lib/seasonStructure.js';
