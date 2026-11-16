/**
 * Receiver-side authorization for peer PULL requests (#3659, #5663). Covers the per-record
 * `/api/peer-sync/*` routes, the snapshot transport `/api/sync/:category/*`, and the brain,
 * memory and catalog delta pulls, which gate on their sync category.
 *
 * Resolves WHO is asking and runs the SAME predicates as the push path (`peerAllowsOutbound` +
 * `peerHasCategory`, peerSyncPush.js); no second authorization predicate lives here, because
 * push/pull divergence is how the gap appeared.
 *
 * `X-PortOS-Instance-Id` is *identification*, not authentication (self-asserted, spoofable
 * on a tailnet); the real control is the optional instance password (`authGate.js`).
 *
 * WARN-FIRST (peers upgrade independently): a request with no id, an unknown id, or a
 * disallowed peer is still SERVED with one throttled `⚠️` per caller per boot. Only
 * `settings.federation.strictPullAuthorization === true` makes a denied pull a 403.
 * `alwaysEnforce` opts a route out of that ramp: denial is always 403. Personal snapshot
 * categories (brain, memory) always honor the configured audience.
 */
import { ServerError } from '../../lib/errorHandler.js';
import { findPeerById, peerAllowsOutbound, peerOutboundEligible, peerAllowsCategoryPull, peerHasCategory } from './peerSyncShared.js';
import { getSettings } from '../settings.js';
import { getPeers } from '../instances.js';
import { UNKNOWN_INSTANCE_ID } from '../instanceIdentity.js';

// Lower-cased because Node/Express normalize incoming header names (outbound spelling: lib/peerHttpClient.js).
export const PEER_INSTANCE_ID_HEADER = 'x-portos-instance-id';

// Denial reasons match the push path's strings so log lines read the same in both directions.
export const PULL_DENY_UNIDENTIFIED = 'unidentified-peer';
export const PULL_DENY_UNKNOWN_PEER = 'unknown-peer';
export const PULL_DENY_OUTBOUND = 'peer-disallows-outbound';
export const PULL_DENY_CATEGORY = 'category-disabled';

// One warning per caller per boot, keyed by resolved peer id or the `PULL_DENY_UNIDENTIFIED` bucket.
const warnedCallers = new Set();
// The key space is caller-supplied, so it recycles past this many callers (worst case: a re-logged line).
const WARNED_CALLERS_MAX = 500;

/**
 * Read the caller's self-asserted instance id off the request headers.
 * Returns `null` for absent/blank/sentinel values so callers get one
 * "unidentified" shape instead of three.
 */
export function readCallerInstanceId(req) {
  const header = req?.headers?.[PEER_INSTANCE_ID_HEADER];
  // A header sent twice reaches Express as an array or `"a, b"`; read the first value (the id is self-asserted anyway).
  const raw = Array.isArray(header) ? header[0] : header;
  const value = typeof raw === 'string' ? raw.split(',')[0].trim() : '';
  if (!value || value === UNKNOWN_INSTANCE_ID) return null;
  return value;
}

/**
 * Resolve the calling peer's instanceId. Auth context uses the registry id, sharing predicates
 * use instanceId; a removed or unidentified authenticated peer never falls back to the header.
 */
export async function resolveCallerInstanceId(req) {
  return req?.portosAuthContext?.method === 'peer'
    ? (await getPeers()).find((peer) => peer.id && peer.id === req.portosAuthContext.peerId)?.instanceId ?? null
    : readCallerInstanceId(req);
}

/**
 * Decide whether a pull should be served, WITHOUT consulting the strict setting or logging,
 * so tests can assert it agrees with the push path. Scope, at most one of:
 *  - `recordKind`: a per-record `/api/peer-sync/*` read, gated on `peerAllowsOutbound` + `peerHasCategory`.
 *  - `syncCategory`: a whole-category read (snapshot or brain/memory/catalog delta), gated on
 *    `peerAllowsCategoryPull`, which folds the master switch into the category map so a
 *    default-ON category still flows for a peer with other sync off.
 *  - neither: the manifest routes (`/library-manifest`, `/cos-history-manifest`, `/cos-tasks`),
 *    gated on `peerAllowsOutbound` alone.
 * Returns `{ allowed, reason, peer, callerId }`.
 */
export async function decidePeerPull({ callerId, recordKind = null, syncCategory = null }) {
  if (!callerId) return { allowed: false, reason: PULL_DENY_UNIDENTIFIED, peer: null, callerId: null };
  const peer = await findPeerById(callerId);
  if (!peer) return { allowed: false, reason: PULL_DENY_UNKNOWN_PEER, peer: null, callerId };
  if (syncCategory) {
    // Keep the two denials distinct so the reason matches the record routes: "no sharing at all" vs "not THIS".
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

// The "served anyway" and "refused" lines share a key space (distinct prefixes), so a caller tripping both gets one of each.
function logOnce(key, message, log = console.warn) {
  if (warnedCallers.has(key)) return;
  if (warnedCallers.size >= WARNED_CALLERS_MAX) warnedCallers.clear();
  warnedCallers.add(key);
  log(message);
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
  logOnce(`deny:${key}`, `🔒 Refused peer-sync ${route} for ${describeCaller(decision)} (${decision.reason}) — this data only federates to a configured, outbound-allowed peer`, console.log);
}

// `severity: 'warning'` suppresses `asyncHandler`'s `❌ Route error` line: a refusal is a POLICY
// outcome that repeats (an unidentified peer re-polls every few seconds). The throttled `🔒` line
// from `refuseOnce` is the log of record; the 403 is unchanged.
const pullForbidden = (decision) => new ServerError('peer not authorized for this record', {
  status: 403,
  code: 'PEER_PULL_FORBIDDEN',
  severity: 'warning',
  context: { reason: decision.reason },
});

/**
 * Gate a pull route. Throws a 403 ServerError when denied AND (`alwaysEnforce` or
 * `federation.strictPullAuthorization`); otherwise serves and warns once per caller per boot.
 * `allowOperator` preserves local/operator reads; scoped credentials stay subject to peer
 * sharing settings. Returns the decision.
 */
export async function authorizePeerPull(req, { recordKind = null, syncCategory = null, route, alwaysEnforce = false, allowOperator = false } = {}) {
  if (allowOperator && req?.portosAuthContext && req.portosAuthContext.method !== 'peer') {
    const { requestHasHostControl } = await import('../authGate.js');
    if (requestHasHostControl(req)) return { allowed: true, reason: null, peer: null, callerId: null };
  }
  const callerId = await resolveCallerInstanceId(req);
  const decision = await decidePeerPull({ callerId, recordKind, syncCategory });
  if (decision.allowed) return decision;
  const label = route || 'pull';
  // Both routes to a 403 log the same throttled line (the route handler no longer self-logs, and
  // strict mode would otherwise refuse silently). `alwaysEnforce` skips the settings read: it can't change the answer.
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
