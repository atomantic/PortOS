/**
 * Receiver-side authorization for peer PULL requests (#3659, #5663).
 *
 * Covers BOTH pull transports: the per-record `/api/peer-sync/*` routes
 * (`server/routes/peerSync.js`) and the older snapshot transport
 * `/api/sync/:category/*` (`server/routes/dataSync.js`).
 *
 * The push direction has always been gated on the user's per-peer sharing
 * config (`peerAllowsOutbound` + `peerHasCategory`, see peerSyncPush.js). The
 * pull direction — `GET /api/peer-sync/record`, plus the manifest routes —
 * had no counterpart: it served any subscribable record by id to anything that
 * could reach the port, so a peer configured for "universes only" (or with
 * sync disabled entirely) could still read every series / collection /
 * writers-room record. This module closes that gap by resolving WHO is asking
 * and running the SAME predicates the push path uses. Deliberately no second
 * authorization predicate lives here — divergence between the push and pull
 * rules is exactly how the gap appeared.
 *
 * Honest framing: `X-PortOS-Instance-Id` is *identification*, not
 * authentication — it is self-asserted and spoofable on an unauthenticated
 * tailnet. The real authentication control remains the optional instance
 * password (`server/services/authGate.js`). The value here is that the pull path
 * honors the sharing config the user actually configured.
 *
 * Compatibility (required by the distribution model — peers upgrade
 * independently): this is WARN-FIRST. A request with no id, an unknown id, or
 * an id whose peer config disallows the read is still SERVED, and logs a
 * single throttled `⚠️` per caller per boot. Only when the user opts in via
 * `settings.federation.strictPullAuthorization === true` does a denied pull
 * get a 403. The default flips in a later release once peers have upgraded.
 *
 * `alwaysEnforce` opts a route OUT of that ramp: a denial is a 403 whatever the
 * setting says. It exists for the PII snapshot categories, which root
 * `AGENTS.md` forbids on the federation layer at all — the ramp protects
 * creative-work sync from breaking mid-upgrade, and no compatibility argument
 * covers shipping an identity record to a host we cannot name.
 */
import { ServerError } from '../../lib/errorHandler.js';
import { findPeerById, peerAllowsOutbound, peerOutboundEligible, peerAllowsCategoryPull, peerHasCategory } from './peerSyncShared.js';
import { getSettings } from '../settings.js';
import { UNKNOWN_INSTANCE_ID } from '../instances.js';

// Lower-cased because Node/Express normalize incoming header names. The
// outbound spelling (`X-PortOS-Instance-Id`) lives in lib/peerHttpClient.js.
export const PEER_INSTANCE_ID_HEADER = 'x-portos-instance-id';

// Denial reasons — deliberately the same strings the push path returns for the
// equivalent decisions, so a log line reads the same in either direction.
export const PULL_DENY_UNIDENTIFIED = 'unidentified-peer';
export const PULL_DENY_UNKNOWN_PEER = 'unknown-peer';
export const PULL_DENY_OUTBOUND = 'peer-disallows-outbound';
export const PULL_DENY_CATEGORY = 'category-disabled';

// One warning per caller per boot (the acceptance criterion). Keyed by the
// resolved peer id, or the literal `PULL_DENY_UNIDENTIFIED` bucket when there
// is no id at all — so an install with three not-yet-upgraded peers logs once
// for the absent-header case rather than once per request.
const warnedCallers = new Set();
// The key space is caller-supplied, so a peer sending a fresh random id per
// request would grow this without bound. Recycle rather than cap-and-stop
// warning: past this many distinct callers the throttle resets, which at worst
// re-logs a line the user has already seen.
const WARNED_CALLERS_MAX = 500;

/**
 * Read the caller's self-asserted instance id off the request headers.
 * Returns `null` for absent/blank/sentinel values so callers get one
 * "unidentified" shape instead of three.
 */
export function readCallerInstanceId(req) {
  const header = req?.headers?.[PEER_INSTANCE_ID_HEADER];
  // A header sent twice (a proxy re-adding it, a caller overriding under a
  // different casing) reaches Express as an array or a `"a, b"` string. Read
  // the first value rather than collapsing to "unidentified" — the id is
  // self-asserted either way, so nothing is gained by being strict here.
  const raw = Array.isArray(header) ? header[0] : header;
  const value = typeof raw === 'string' ? raw.split(',')[0].trim() : '';
  if (!value || value === UNKNOWN_INSTANCE_ID) return null;
  return value;
}

/**
 * Decide whether a pull should be served, WITHOUT consulting the strict
 * setting or logging — the pure-ish decision half, so tests can assert it
 * agrees with the push path for a given peer/kind pair.
 *
 * Scope, at most one of:
 *  - `recordKind` — a per-record `/api/peer-sync/*` read. Gated on
 *    `peerAllowsOutbound` + `peerHasCategory`, the predicates the push path uses.
 *  - `syncCategory` — a whole-category `/api/sync/*` snapshot read. Gated on
 *    `peerAllowsCategoryPull`, which folds the master switch into the resolved
 *    category map instead of checking it separately, so a default-ON category
 *    still flows for a peer whose other sync the user turned off.
 *  - neither — the manifest routes (`/library-manifest`, `/cos-history-manifest`,
 *    `/cos-tasks`) aren't scoped to one kind, so they gate on
 *    `peerAllowsOutbound` alone.
 *
 * Returns `{ allowed, reason, peer, callerId }`.
 */
export async function decidePeerPull({ callerId, recordKind = null, syncCategory = null }) {
  if (!callerId) return { allowed: false, reason: PULL_DENY_UNIDENTIFIED, peer: null, callerId: null };
  const peer = await findPeerById(callerId);
  if (!peer) return { allowed: false, reason: PULL_DENY_UNKNOWN_PEER, peer: null, callerId };
  if (syncCategory) {
    // Split the two denials so the reason a caller/log sees means the same
    // thing it does on the record routes: "we don't share with you at all" vs
    // "we don't share THIS with you".
    if (!peerOutboundEligible(peer)) return { allowed: false, reason: PULL_DENY_OUTBOUND, peer, callerId };
    if (!peerAllowsCategoryPull(peer, syncCategory)) {
      return { allowed: false, reason: PULL_DENY_CATEGORY, peer, callerId };
    }
    return { allowed: true, reason: null, peer, callerId };
  }
  if (!peerAllowsOutbound(peer)) return { allowed: false, reason: PULL_DENY_OUTBOUND, peer, callerId };
  if (recordKind && !peerHasCategory(peer, recordKind)) {
    return { allowed: false, reason: PULL_DENY_CATEGORY, peer, callerId };
  }
  return { allowed: true, reason: null, peer, callerId };
}

async function strictPullAuthorizationEnabled() {
  const settings = await getSettings().catch(() => null);
  return settings?.federation?.strictPullAuthorization === true;
}

// Throttle key space is shared by the "served anyway" and "refused" lines, so
// a caller that trips both still gets one of each (distinct prefixes).
function logOnce(key, message) {
  if (warnedCallers.has(key)) return;
  if (warnedCallers.size >= WARNED_CALLERS_MAX) warnedCallers.clear();
  warnedCallers.add(key);
  console.warn(message);
}

function describeCaller(decision) {
  if (decision.peer?.name) return `peer "${decision.peer.name}"`;
  return decision.callerId ? `instance ${decision.callerId.slice(0, 8)}…` : 'an unidentified caller';
}

function warnOnce(decision, route) {
  const key = decision.callerId || PULL_DENY_UNIDENTIFIED;
  logOnce(`serve:${key}`, `⚠️ Serving peer-sync ${route} to ${describeCaller(decision)} that sharing config would deny (${decision.reason}) — enable federation.strictPullAuthorization to enforce`);
}

function refuseOnce(decision, route) {
  const key = decision.callerId || PULL_DENY_UNIDENTIFIED;
  logOnce(`deny:${key}`, `🔒 Refused peer-sync ${route} for ${describeCaller(decision)} (${decision.reason}) — this data only federates to a configured, outbound-allowed peer`);
}

// `severity: 'warning'` suppresses `asyncHandler`'s generic `❌ Route error`
// line for this code. A refusal here is a POLICY outcome, not a fault, and it
// repeats forever: a peer that can't be identified re-polls its sync categories
// every few seconds, so the error line arrived every ~10s per category for the
// life of the process and buried genuine errors in the log. The throttled `🔒`
// line from `refuseOnce` is this path's log of record — once per caller per
// boot, which is exactly what the throttle exists to guarantee. The 403 the
// caller receives is unchanged.
const pullForbidden = (decision) => new ServerError('peer not authorized for this record', {
  status: 403,
  code: 'PEER_PULL_FORBIDDEN',
  severity: 'warning',
  context: { reason: decision.reason },
});

/**
 * Gate a pull route. Throws a 403 ServerError when the request is denied AND
 * either `alwaysEnforce` is set for this route or
 * `federation.strictPullAuthorization` is on; otherwise serves the request and
 * warns at most once per caller per boot.
 *
 * Returns the decision so a caller can branch further if it ever needs to.
 */
export async function authorizePeerPull(req, { recordKind = null, syncCategory = null, route, alwaysEnforce = false } = {}) {
  const decision = await decidePeerPull({ callerId: readCallerInstanceId(req), recordKind, syncCategory });
  if (decision.allowed) return decision;
  const label = route || 'pull';
  // Both ways of reaching a 403 refuse for the same reason, so both log the same
  // throttled line — strict mode used to throw silently, and now that the 403 no
  // longer self-logs through the route handler, that would leave a user who
  // turned strict mode on with no indication of why a peer stopped syncing.
  // `alwaysEnforce` still short-circuits the settings read: it cannot change the
  // answer.
  if (alwaysEnforce || await strictPullAuthorizationEnabled()) {
    refuseOnce(decision, label);
    throw pullForbidden(decision);
  }
  warnOnce(decision, label);
  return decision;
}


/** Test-support: clear the per-boot warn throttle. */
export function __resetPullWarnThrottleForTests() {
  warnedCallers.clear();
}
