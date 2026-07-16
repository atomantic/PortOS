import { createHash } from 'node:crypto';
import { extractToken, isAuthEnabled, verifyPassword, verifySession } from '../services/auth.js';
import { getSettings, settingsEvents } from '../services/settings.js';
import { isRegistryPublic } from './apiRegistry.js';

// Paths that bypass the auth gate even when a password is set:
//   - /api/auth/status, /api/auth/whoami, /api/auth/login → the login UI
//     itself needs to reach these to render and sign in.
//   - /api/system/health — Tailscale's reachability check shouldn't need a
//     session.
// Anything not on this list returns 401 when auth is on and the request has
// no valid token.
const PUBLIC_API_PATHS = new Set([
  '/api/auth/status',
  '/api/auth/whoami',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/system/health',
]);

// Non-`/api` API surfaces that must also be gated. `/sdapi/v1/*` is the
// AUTOMATIC1111-compatible image-gen mount served by sdapiRoutes — it accepts
// generation requests and exposes the LoRA / model catalog, so a sidecar with
// network reach but no auth must NOT be able to hit it. Add to this list any
// future routes that live outside `/api`.
const GATED_NON_API_PREFIXES = ['/sdapi/'];

// Extract the password from an `Authorization: Basic <base64>` header.
// PortOS is single-user so the username is ignored; only the password is
// validated. Used by peer-to-peer federation: a remote PortOS instance probes
// us with HTTP Basic credentials (set in the Instances UI) rather than a
// browser session cookie.
const extractBasicPassword = (req) => {
  const authHeader = req.headers?.authorization;
  if (typeof authHeader !== 'string') return null;
  if (authHeader.slice(0, 6).toLowerCase() !== 'basic ') return null;
  const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
  const colonIdx = decoded.indexOf(':');
  return colonIdx === -1 ? decoded : decoded.slice(colonIdx + 1);
};

// Short-lived cache for Basic-auth scrypt results so probe cycles (3 parallel
// HTTP requests every 30s) don't re-run scrypt each time. Keyed by sha256 of
// the password so the plaintext never lives in the Map. Flushed on any
// settings write (covers password rotation).
const basicAuthCache = new Map();
const BASIC_AUTH_CACHE_TTL_MS = 60_000;
settingsEvents.on('settings:updated', () => basicAuthCache.clear());

const verifyBasicPassword = async (password) => {
  const key = createHash('sha256').update(password).digest('hex');
  const cached = basicAuthCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.ok;
  const ok = await verifyPassword(password);
  basicAuthCache.set(key, { ok, expiresAt: Date.now() + BASIC_AUTH_CACHE_TTL_MS });
  return ok;
};

const isPublicPath = (path) => {
  if (PUBLIC_API_PATHS.has(path)) return true;
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

// Reject cross-origin requests when auth is on. PortOS's CORS middleware
// reflects `Origin` with `Access-Control-Allow-Credentials: true` so the UI
// works from any tailnet hostname / IP — but combined with the session
// cookie that becomes a CSRF surface: a malicious page on another tailnet
// host can fetch PortOS APIs with `credentials: 'include'` after the user
// has logged in (Tailscale's `ts.net` is on the Public Suffix List, so
// SameSite=Lax doesn't help — same-tailnet hosts are same-site). Match the
// `Origin` header's host:port against the request's own `Host` header; any
// mismatch is a cross-origin attempt and gets 403 before the session is
// even consulted. Requests with no `Origin` header (server-to-server,
// curl, the loopback mirror) pass through.
// Hostnames are case-insensitive (RFC 3986 §3.2.2). Node's `URL` already
// lowercases the parsed authority; lowercase the raw `Host` header too so a
// client that sends mixed-case isn't 403'd as cross-origin.
const stripPort = (hostHeader) => {
  // Bracketed IPv6 host: `[::1]:port` → `[::1]`.
  if (hostHeader.startsWith('[')) {
    const close = hostHeader.indexOf(']');
    return close === -1 ? hostHeader : hostHeader.slice(0, close + 1);
  }
  const colon = hostHeader.indexOf(':');
  return colon === -1 ? hostHeader : hostHeader.slice(0, colon);
};
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const isLoopback = (hostname) => LOOPBACK_HOSTS.has(hostname.toLowerCase());

const isCrossOrigin = (req) => {
  const origin = req.headers?.origin;
  if (!origin || origin === 'null') return false;
  const host = req.headers?.host;
  if (!host) return false;
  // URL parses scheme://authority — we only compare the authority. A
  // malformed Origin (URL constructor throws) is treated as cross-origin.
  let parsed;
  try { parsed = new URL(origin); }
  catch { return true; }
  if (parsed.host.toLowerCase() === host.toLowerCase()) return false;
  // Dev workflow exemption: Vite proxies :5554 → :5555 with changeOrigin,
  // so a real same-origin browser request arrives as
  // `Origin: http://localhost:5554` / `Host: localhost:5555`. Treat any
  // loopback-to-loopback pairing as same-origin regardless of port — the
  // CSRF threat is from attackers on OTHER machines, not from a local
  // dev server on the same loopback interface.
  if (isLoopback(stripPort(parsed.host)) && isLoopback(stripPort(host))) return false;
  return true;
};

// Express middleware. Bypasses everything when auth is off. When it's on,
// allows the small public set above; gates the rest behind a valid token in
// the cookie or Authorization: Bearer header.
export const authGate = async (req, res, next) => {
  const enabled = await isAuthEnabled();
  if (!enabled) return next();
  // CSRF guard runs FIRST, before isPublicPath — public endpoints like
  // /api/auth/logout still mutate state (clear the cookie + revoke the
  // session), so a same-tailnet attacker could force-logout a user
  // cross-origin if the guard sat behind the public-path bypass.
  if (isCrossOrigin(req)) {
    res.status(403).json({ error: 'Cross-origin request rejected', code: 'CROSS_ORIGIN_BLOCKED' });
    return;
  }
  const path = req.path;
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
  const token = extractToken(req);
  if (await verifySession(token)) return next();
  // Also accept HTTP Basic auth — used by peer-to-peer federation probes.
  // The peer sends `Authorization: Basic <base64(:password)>` (the Instances
  // UI stores username + password; only the password is validated here since
  // PortOS is single-user). scrypt verification is intentionally slow but runs
  // in libuv's thread pool so it doesn't block the event loop.
  const basicPassword = extractBasicPassword(req);
  if (basicPassword && await verifyBasicPassword(basicPassword)) return next();
  // /data/* is hit directly by <img>/<audio>/<video> tags which don't show a
  // structured-JSON error — return a plain 401 there. API callers expect the
  // PortOS error envelope.
  if (path.startsWith('/data/')) {
    res.status(401).type('text/plain').send('Unauthorized');
    return;
  }
  res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
};

// Socket.IO middleware. Run after a successful HTTP-side handshake — same
// `req.headers.cookie` is available on `socket.handshake.headers`. When auth
// is off, every connection is allowed; when on, the handshake must carry a
// valid cookie/header.
//
// NOTE: there is intentionally NO `isRegistryPublic` check here. The public
// API surface (apiRegistry) is HTTP-only — external callers hit REST endpoints,
// not the interactive socket. The socket carries the authenticated UI session
// (voice streaming, live updates) and must stay fully gated when auth is on.
export const socketAuthGate = async (socket, next) => {
  const enabled = await isAuthEnabled();
  if (!enabled) return next();
  const fakeReq = { headers: socket.handshake?.headers || {} };
  if (isCrossOrigin(fakeReq)) {
    const err = new Error('Cross-origin request rejected');
    err.data = { code: 'CROSS_ORIGIN_BLOCKED' };
    return next(err);
  }
  const token = extractToken(fakeReq);
  if (await verifySession(token)) return next();
  // Also accept HTTP Basic auth for peer socket relay connections.
  const basicPassword = extractBasicPassword(fakeReq);
  if (basicPassword && await verifyBasicPassword(basicPassword)) return next();
  const err = new Error('Authentication required');
  err.data = { code: 'AUTH_REQUIRED' };
  next(err);
};
