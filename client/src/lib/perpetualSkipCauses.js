/**
 * Re-export of server `formatSkipCauses(skipCauses, maxCauses?, excludeCause?)`, rendering a
 * skip-cause map as a compact largest-first string.
 *
 * Re-export of `server/lib/perpetualSkipCauses.js` — `formatSkipCauses(skipCauses, maxCauses?,
 * excludeCause?)` renders a perpetual work-detector's per-cause skip map (`{ 'needs-input': 49,
 * blocked: 17 }`) as a compact largest-first string; used by the on-demand "Run" toast and the
 * work-item picker.
 */

/**
 * Re-export of `server/lib/perpetualSkipCauses.js` — the one definition of the
 * skip-cause rendering, imported rather than copied so the PM2 park log line
 * and the on-demand toast cannot drift apart in wording. The file stays so
 * every `lib/perpetualSkipCauses` import path in the client is unchanged.
 */
export { formatSkipCauses } from '../../../server/lib/perpetualSkipCauses.js';
