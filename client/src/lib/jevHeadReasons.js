/**
 * Re-export of `server/lib/jevHeadReasons.js` — the one definition of the
 * operator-facing labels for why a trained project head cannot be adopted.
 *
 * A re-export rather than a mirror, exactly as `scopeAdherenceReasons.js` is: a
 * mirror would need a parity test, and a parity test would need a server file
 * importing a client file, which `scripts/server-imports-no-client.test.js`
 * forbids. The server leaf has no imports of its own, so it is safe to pull
 * into the browser bundle.
 */

export {
  JEV_HEAD_BLOCKER_REASONS,
  JEV_HEAD_BLOCKER_FALLBACK,
  jevHeadBlockerLabel,
} from '../../../server/lib/jevHeadReasons.js';
