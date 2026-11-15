/**
 * Re-export of `server/lib/scopeAdherenceReasons.js` — the one definition of
 * the operator-facing labels for a scope-adherence failure code.
 *
 * Re-export of `server/lib/scopeAdherenceReasons.js` — operator-facing labels for a scope-adherence
 * failure code (`SCOPE_ADHERENCE_REASONS`, `SCOPE_ADHERENCE_REASON_FALLBACK`,
 * `scopeAdherenceReasonLabel`). Every label reads as "no advisory", never as a verdict. One
 * definition, no mirror to keep in parity.
 *
 * A re-export rather than a mirror: a mirror would need a parity test, and a
 * parity test would need a server file importing a client file, which
 * `scripts/server-imports-no-client.test.js` forbids. The server leaf has no
 * imports of its own, so it is safe to pull into the browser bundle.
 */

export {
  SCOPE_ADHERENCE_REASONS,
  SCOPE_ADHERENCE_REASON_FALLBACK,
  scopeAdherenceReasonLabel,
} from '../../../server/lib/scopeAdherenceReasons.js';
