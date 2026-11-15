/**
 * Re-export of `server/lib/jevHeadReasons.js` — the one definition of the
 * operator-facing labels for why a trained project head cannot be adopted.
 *
 * Re-export of `server/lib/jevHeadReasons.js` - operator-facing labels for why a trained jev project
 * head cannot be adopted (`JEV_HEAD_BLOCKER_REASONS`, `JEV_HEAD_BLOCKER_FALLBACK`,
 * `jevHeadBlockerLabel`). Each label names WHICH baseline the head lost to, because the stock scorer
 * and the majority class send an operator to different places. One definition, no mirror to keep in
 * parity.
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
