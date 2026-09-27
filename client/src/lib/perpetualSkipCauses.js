/**
 * Re-export of `server/lib/perpetualSkipCauses.js` — the one definition of the
 * skip-cause rendering, imported rather than copied so the PM2 park log line
 * and the on-demand toast cannot drift apart in wording. The file stays so
 * every `lib/perpetualSkipCauses` import path in the client is unchanged.
 */
export { formatSkipCauses } from '../../../server/lib/perpetualSkipCauses.js';
