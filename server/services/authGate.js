import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { isAuthEnabled, verifyPassword, verifyRequestSession } from './auth.js';
// Shared with sidecar processes (lib/sidecarAuthGate.js) so the Autofixer UI
// on :5560 applies byte-identical credential extraction and CSRF rules.
import { browserRequestRefusal, DEV_PROXY_CLIENT_ADDRESS_HEADER, extractBasicPassword } from '../../lib/portosAuthCore.js';
import { getSettings, settingsEvents } from './settings.js';
import { isRegistryPublic } from '../lib/apiRegistry.js';
import {
  GATED_NON_API_PREFIXES,
  isAlwaysPublicApiPath,
  isPeerApiRequestAllowed,
  isPeerBasicBootstrapRequest,
} from '../lib/apiAccessPolicy.js';
import { sendErrorResponse, ServerError } from '../lib/errorHandler.js';
import { isHostControlRoute } from '../lib/hostControlRoutes.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';
import { loadData as loadInstances } from './instanceIdentity.js';

// Paths that bypass the auth gate even when a password is set:
//   - /api/auth/status, /api/auth/whoami, /api/auth/login → the login UI
//     itself needs to reach these to render and sign in.
//   - /api/system/health — Tailscale's reachability check shouldn't need a
//     session.
// Anything not on this list returns 401 when auth is on and the request has
// no valid token.
// Short-lived cache for successful Basic-auth scrypt results so probe cycles
// (3 parallel HTTP requests every 30s) don't re-run scrypt each time. Failed
// results are deliberately not cached so a corrected credential is retried
// immediately. Keyed by sha256 so plaintext never lives in the Map. Flushed
// on any settings write (covers password rotation).
const basicAuthCache = new Map();
const BASIC_AUTH_CACHE_TTL_MS = 60_000;
settingsEvents.on('settings:updated', () => basicAuthCache.clear());

const verifyBasicPassword = async (password) => {
  if (typeof password !== 'string' || password.length === 0) return false;
  const key = createHash('sha256').update(password).digest('hex');
  const cached = basicAuthCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.ok;
  const ok = await verifyPassword(password);
  if (ok) {
    basicAuthCache.set(key, { ok: true, expiresAt: Date.now() + BASIC_AUTH_CACHE_TTL_MS });
  }
  return ok;
};

// A paired peer's token (#8356) resolves to its peer record. Only an enabled
// peer holding a pair secret can match; a corrupt/unreadable registry fails
// closed to "not a peer" so the request falls through to the other methods.
const pairedPeerFor = async (instanceId) => {
  if (typeof instanceId !== 'string' || !instanceId) return null;
  const data = await loadInstances().catch(() => null);
  const peers = Array.isArray(data?.peers) ? data.peers : [];
  return peers.find((p) => p?.instanceId === instanceId && p.enabled !== false
    && typeof p.syncSecret === 'string' && p.syncSecret.length >= 32) ?? null;
};

const verifyPeerToken = async (headers) => {
  const token = headers?.[PEER_AUTH_HEADER.toLowerCase()];
  const instanceId = headers?.[PEER_INSTANCE_HEADER.toLowerCase()];
  if (typeof token !== 'string' || !token) return null;
  const peer = await pairedPeerFor(instanceId);
  if (!peer) return null;
  const expected = Buffer.from(derivePeerAuthToken(peer.syncSecret, instanceId));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given) ? peer : null;
};

// A paired peer that still authenticates with this install's password (an
// older sender, or a pair secret that differs between the two machines) is
// told once per process: the password it holds is operator authority here.
const warnedBasicPeers = new Set();
const warnIfPairedPeerUsedBasic = async (headers) => {
  const instanceId = headers?.[PEER_INSTANCE_HEADER.toLowerCase()];
  if (typeof instanceId !== 'string' || warnedBasicPeers.has(instanceId)) return;
  const peer = await pairedPeerFor(instanceId);
  if (!peer) return;
  warnedBasicPeers.add(instanceId);
  console.warn(`⚠️ Paired peer ${peer.name || peer.id} authenticated with the instance password instead of its pair credential — pair it again, then remove the stored password on that machine`);
};

// Logged once per peer + method + path per process (bounded): an older or
// newer peer calling outside the contract should be diagnosable without
// flooding the log.
const warnedPeerScope = new Set();
const WARNED_PEER_SCOPE_MAX = 256;
const refusePeerScope = (req, res, path, peer) => {
  const key = `${peer.id} ${req.method} ${path}`;
  if (!warnedPeerScope.has(key)) {
    if (warnedPeerScope.size >= WARNED_PEER_SCOPE_MAX) warnedPeerScope.clear();
    warnedPeerScope.add(key);
    console.warn(`⛔ Peer ${peer.name || peer.id} refused outside the federation surface: ${req.method} ${path}`);
  }
  if (path.startsWith('/data/')) {
    res.status(403).type('text/plain').send('Forbidden');
    return;
  }
  sendErrorResponse(res, new ServerError('A peer credential only reaches the federation API.', {
    status: 403, code: 'PEER_SCOPE_FORBIDDEN',
  }));
};

export const __testing = { verifyBasicPassword };

const BROWSER_REFUSAL_MESSAGES = {
  CROSS_ORIGIN_BLOCKED: 'Cross-origin request rejected',
  HOST_NOT_ALLOWED: 'Browser requests must address PortOS by an IP, a local or tailnet name, or a host listed in PORTOS_ALLOWED_HOSTS',
};

const browserRefusalError = (code) => new ServerError(BROWSER_REFUSAL_MESSAGES[code], { status: 403, code });

const isPublicPath = (path) => {
  if (isAlwaysPublicApiPath(path)) return true;
  // /api/* and /data/* are always gated. /sdapi/* (and any future non-/api
  // API surface listed above) is also gated. Everything else is the static
  // client bundle — index.html / hashed JS+CSS / fonts — which is safe to
  // serve without a session: a sidecar can't do anything with it without a
  // token to hit the JSON API, and the login page itself must be reachable.
  if (path.startsWith('/api/') || path.startsWith('/data/')) return false;
  for (const prefix of GATED_NON_API_PREFIXES) {
    if (path.startsWith(prefix)) return false;
  }
  return true;
};

// Express middleware. The browser-relay guard (cross-origin + DNS-rebinding
// Host check) runs in both modes. With auth off everything else passes; with
// it on, allows the small public set above and gates the rest behind a valid
// token in the cookie or Authorization: Bearer header.
export const authGate = async (req, res, next) => {
  const enabled = await isAuthEnabled();
  // Downstream peer-provider routes need to distinguish a verified peer Basic
  // credential from an interactive browser session. The global gate is the
  // one authoritative verifier, so leave a request-local, non-secret marker
  // instead of re-running password verification in each provider route.
  req.portosAuthContext = { enabled, authenticated: false, method: null };
  // App credentials authorize only this exact local broker namespace, whether
  // or not the optional instance password is configured. Never exempt its admin API.
  if (/^\/api\/managed-visitors\/v1(?:\/|$)/i.test(req.path)) {
    const { authenticateManagedVisitorRequest } = await import('./managedVisitors.js');
    req.managedVisitorAuth = await authenticateManagedVisitorRequest(req);
    return next();
  }
  // Runs FIRST, before the auth-off bypass and isPublicPath: without a password
  // any web page the user opens could otherwise relay a hidden form POST onto
  // loopback (where requireHostControl trusts the socket peer), and public
  // endpoints like /api/auth/logout still mutate state.
  const refusal = browserRequestRefusal(req);
  if (refusal) {
    sendErrorResponse(res, browserRefusalError(refusal));
    return;
  }
  if (!enabled) {
    // The pair token is independent of the instance password, so a paired peer
    // stays identified after the password is removed: peer-provider routes
    // (federated media) require a verified peer and never take the auth-off
    // bypass. Only the federation surface is annotated; elsewhere the caller is
    // as anonymous as any other request to a password-free install.
    const peer = isPeerApiRequestAllowed(req.method, req.path.toLowerCase())
      ? await verifyPeerToken(req.headers) : null;
    if (peer) req.portosAuthContext = { enabled: false, authenticated: true, method: 'peer', peerId: peer.id };
    return next();
  }
  // Express mounts match case-insensitively. Use the same casing for every
  // authorization check, including public exceptions, without rewriting the
  // request URL: downstream record IDs and asset filenames may be case-sensitive.
  const path = req.path.toLowerCase();
  if (isPublicPath(path)) return next();
  // Per-API public exemptions. When the user has marked an API exposed +
  // passwordless in Settings (`apiAccess.<id>`), re-open ONLY its declared
  // public prefix (e.g. /api/voice/public/, /sdapi/). `isRegistryPublic`
  // matches only those prefixes, so config-mutation routes outside them
  // (/api/voice/config, etc.) stay gated. This sits AFTER the cross-origin
  // CSRF guard above (a public API is still not a CSRF bypass) and after the
  // static public-path set. `getSettings()` is a cheap file read; no cache is
  // introduced here so a Settings toggle takes effect on the very next request.
  const settings = await getSettings();
  if (isRegistryPublic(settings, path)) return next();
  if (await verifyRequestSession(req)) {
    req.portosAuthContext = { enabled: true, authenticated: true, method: 'session' };
    return next();
  }
  // A paired peer's scoped credential. Checked before Basic so a sender that
  // presents both during the upgrade handshake is identified as the peer.
  // Its authority ends at the federation surface (#8387): operator routes
  // refuse it outright rather than falling through to Basic, so a peer that
  // sends both never borrows the password's reach.
  const peer = await verifyPeerToken(req.headers);
  if (peer) {
    if (!isPeerApiRequestAllowed(req.method, path)) {
      refusePeerScope(req, res, path, peer);
      return;
    }
    req.portosAuthContext = { enabled: true, authenticated: true, method: 'peer', peerId: peer.id };
    return next();
  }
  // Also accept HTTP Basic auth — the legacy peer credential, kept so unpaired
  // and not-yet-upgraded peers keep federating (a paired peer that still uses
  // it is warned once per process). It yields `method: 'basic'`, never a session.
  // The peer sends `Authorization: Basic <base64(:password)>` (the Instances
  // UI stores username + password; only the password is validated here since
  // PortOS is single-user). scrypt verification is intentionally slow but runs
  // in libuv's thread pool so it doesn't block the event loop.
  const basicPassword = extractBasicPassword(req);
  if (basicPassword && await verifyBasicPassword(basicPassword)) {
    req.portosAuthContext = { enabled: true, authenticated: true, method: 'basic' };
    // Pair-secret setup intentionally uses the saved instance password once to
    // provision the scoped credential; this is not a fallback federation call.
    if (!isPeerBasicBootstrapRequest(req.method, path)) await warnIfPairedPeerUsedBasic(req.headers);
    return next();
  }
  // /data/* is hit directly by <img>/<audio>/<video> tags which don't show a
  // structured-JSON error — return a plain 401 there. API callers expect the
  // PortOS error envelope.
  if (path.startsWith('/data/')) {
    res.status(401).type('text/plain').send('Unauthorized');
    return;
  }
  sendErrorResponse(res, new ServerError('Authentication required', {
    status: 401, code: 'AUTH_REQUIRED',
  }));
};

const isLoopbackAddress = (value) => {
  if (typeof value !== 'string') return false;
  const address = value.replace(/^::ffff:/i, '');
  return address === '::1' || (isIP(address) === 4 && address.startsWith('127.'));
};

// A loopback connection, restricted further when it carries the dev proxy's
// client-address marker: Vite proxies every browser from its own loopback
// socket, so the marker's address is the real caller. A direct remote caller
// cannot gain authority by forging a loopback marker — its connection address
// is not loopback to begin with.
const isLocalConnection = (remoteAddress, headers) => {
  const proxyClient = headers?.[DEV_PROXY_CLIENT_ADDRESS_HEADER];
  return isLoopbackAddress(remoteAddress)
    && (proxyClient === undefined || isLoopbackAddress(proxyClient));
};

// Host execution needs operator authority: a peer's credential — the scoped
// peer token or the legacy Basic password — never qualifies. Password-free
// installs require a local connection (see isLocalConnection). Neither req.ip
// nor the machine-local warning acknowledgement can grant authority.
const hasHostControl = (auth, localConnection) =>
  (auth?.enabled === true && auth.authenticated === true && auth.method === 'session')
  || (auth?.enabled === false && localConnection === true);

export const HOST_CONTROL_FORBIDDEN_MESSAGE = 'Host control requires an operator session, or a local connection when no password is set. Set an instance password to use it remotely.';

// Mount after authGate: missing context fails closed.
export const requireHostControl = (req, res, next) => {
  if (hasHostControl(req.portosAuthContext, isLocalConnection(req.socket?.remoteAddress, req.headers))) return next();
  sendErrorResponse(res, new ServerError(HOST_CONTROL_FORBIDDEN_MESSAGE, {
    status: 403, code: 'HOST_CONTROL_FORBIDDEN',
  }));
};

// Applies requireHostControl to every route in the audited
// HOST_CONTROL_ROUTES list (lib/hostControlRoutes.js). Mounted once, right
// after authGate, so the list — not each route file — is the one place that
// says which HTTP routes execute on the host.
export const hostControlRouteGate = (req, res, next) => (
  isHostControlRoute(req.method, req.path) ? requireHostControl(req, res, next) : next()
);

// The socket twin of requireHostControl on a password-free install, for the
// per-event re-check in socket.js (with a password set, that re-check already
// admits only a verified session to host-control events). Locality is
// recorded at the handshake by socketAuthGate; a socket that never passed the
// gate carries none and fails closed.
export const socketHasHostControl = (socket) => hasHostControl({ enabled: false }, socket.data?.portosLocalConnection);

// Socket.IO middleware. Run after a successful HTTP-side handshake — same
// `req.headers.cookie` is available on `socket.handshake.headers`. When auth
// is off, every connection is allowed; when on, the handshake must carry a
// valid cookie/header. The browser-relay guard applies in both modes.
//
// NOTE: there is intentionally NO `isRegistryPublic` check here. The public
// API surface (apiRegistry) is HTTP-only — external callers hit REST endpoints,
// not the interactive socket. The socket carries the authenticated UI session
// (voice streaming, live updates) and must stay fully gated when auth is on.
// Records which credential passed the handshake so the per-event re-check in
// socket.js (registerAuthHandlers) can tell a real operator session from a
// peer relay connection. `socket.data` always exists on a real Socket.IO
// socket; guarded here only so the plain `{ handshake }` fixtures this
// module's own tests pass in don't throw.
const markAuthMethod = (socket, method) => {
  if (!socket.data) socket.data = {};
  socket.data.portosAuthMethod = method;
};

// engine.io `allowRequest` for the Socket.IO server: refuses the transport
// handshake itself (polling and websocket) for a foreign or rebindable browser
// request, before socketAuthGate ever runs.
export const allowSocketRequest = (req, callback) => callback(null, browserRequestRefusal(req) === null);

export const socketAuthGate = async (socket, next) => {
  if (!socket.data) socket.data = {};
  socket.data.portosLocalConnection = isLocalConnection(socket.handshake?.address, socket.handshake?.headers);
  const fakeReq = { headers: socket.handshake?.headers || {} };
  // Before the auth-off bypass: a foreign page must not drive shell:start /
  // iterm:input on a password-free install. server/index.js also refuses the
  // engine.io handshake itself with the same predicate.
  const refusal = browserRequestRefusal(fakeReq);
  if (refusal) {
    const err = new Error(BROWSER_REFUSAL_MESSAGES[refusal]);
    err.data = { code: refusal };
    return next(err);
  }
  const enabled = await isAuthEnabled();
  if (!enabled) return next();
  if (await verifyRequestSession(fakeReq)) {
    markAuthMethod(socket, 'session');
    return next();
  }
  // Peer relay connections: the paired peer token, else legacy Basic. Neither
  // grants operator authority — socket.js re-checks every inbound event and
  // allows a peer-authenticated socket only the minimal read-only
  // subscription events it needs (PEER_RELAY_ALLOWED_EVENTS).
  if (await verifyPeerToken(fakeReq.headers)) {
    markAuthMethod(socket, 'peer');
    return next();
  }
  const basicPassword = extractBasicPassword(fakeReq);
  if (basicPassword && await verifyBasicPassword(basicPassword)) {
    markAuthMethod(socket, 'basic');
    return next();
  }
  const err = new Error('Authentication required');
  err.data = { code: 'AUTH_REQUIRED' };
  next(err);
};
