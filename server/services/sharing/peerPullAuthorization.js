/**
 * Receiver-side authorization for peer-sync PULL requests (#3659).
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
 * password (`server/lib/authGate.js`). The value here is that the pull path
 * honors the sharing config the user actually configured.
 *
 * Compatibility (required by the distribution model — peers upgrade
 * independently): this is WARN-FIRST. A request with no id, an unknown id, or
 * an id whose peer config disallows the read is still SERVED, and logs a
 * single throttled `⚠️` per caller per boot. Only when the user opts in via
 * `settings.federation.strictPullAuthorization === true` does a denied pull
 * get a 403. The default flips in a later release once peers have upgraded.
 */
import { ServerError } from '../../lib/errorHandler.js';
import { findPeerById, peerAllowsOutbound, peerHasCategory } from './peerSyncShared.js';
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
 * `recordKind` is optional: the manifest routes (`/library-manifest`,
 * `/cos-history-manifest`, `/cos-tasks`) aren't scoped to one record kind, so
 * they gate on `peerAllowsOutbound` alone.
 *
 * Returns `{ allowed, reason, peer, callerId }`.
 */
export async function decidePeerPull({ callerId, recordKind = null }) {
  if (!callerId) return { allowed: false, reason: PULL_DENY_UNIDENTIFIED, peer: null, callerId: null };
  const peer = await findPeerById(callerId);
  if (!peer) return { allowed: false, reason: PULL_DENY_UNKNOWN_PEER, peer: null, callerId };
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

function warnOnce(decision, route) {
  const key = decision.callerId || PULL_DENY_UNIDENTIFIED;
  if (warnedCallers.has(key)) return;
  if (warnedCallers.size >= WARNED_CALLERS_MAX) warnedCallers.clear();
  warnedCallers.add(key);
  const who = decision.peer?.name
    ? `peer "${decision.peer.name}"`
    : (decision.callerId ? `instance ${decision.callerId.slice(0, 8)}…` : 'an unidentified caller');
  console.warn(`⚠️ Serving peer-sync ${route} to ${who} that sharing config would deny (${decision.reason}) — enable federation.strictPullAuthorization to enforce`);
}

/**
 * Gate a pull route. Throws a 403 ServerError only when the request is denied
 * AND `federation.strictPullAuthorization` is on; otherwise serves the request
 * and warns at most once per caller per boot.
 *
 * Returns the decision so a caller can branch further if it ever needs to.
 */
export async function authorizePeerPull(req, { recordKind = null, route } = {}) {
  const decision = await decidePeerPull({ callerId: readCallerInstanceId(req), recordKind });
  if (decision.allowed) return decision;
  if (await strictPullAuthorizationEnabled()) {
    throw new ServerError('peer not authorized for this record', {
      status: 403,
      code: 'PEER_PULL_FORBIDDEN',
      context: { reason: decision.reason },
    });
  }
  warnOnce(decision, route || 'pull');
  return decision;
}

/** Test-support: clear the per-boot warn throttle. */
export function __resetPullWarnThrottleForTests() {
  warnedCallers.clear();
}
