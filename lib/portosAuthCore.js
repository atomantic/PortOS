/**
 * portosAuthCore — zero-dependency primitives shared by the main PortOS server
 * (`server/services/auth.js`, `server/lib/authGate.js`) and by sidecar
 * processes that must honour the same password gate (`autofixer/ui.js` via
 * `lib/sidecarAuthGate.js`).
 *
 * Sidecars run as separate PM2 processes with their own `package.json`, so they
 * cannot import the server's service layer (settings.js, zod, the error
 * middleware…). Everything here is Node builtins only, no side effects at
 * import time — same contract as `lib/tailscale-https.js`.
 *
 * The constants below are the WIRE/AT-REST format of the auth system. Changing
 * SCRYPT_PARAMS, COOKIE_NAME, or the token hashing invalidates stored
 * credentials/sessions across every install, so treat them as a migration.
 */
import { createHash, timingSafeEqual, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

export const COOKIE_NAME = 'portos_auth';
export const SALT_BYTES = 16;
export const HASH_BYTES = 64;
export const TOKEN_BYTES = 32;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// scrypt cost parameters per OWASP 2023 password-storage guidance for
// interactive logins. Node's default `maxmem` of 32 MiB rejects this N;
// OpenSSL needs headroom over the canonical 128·N·r working set (~128 MiB
// here), so 256 MiB is allocated.
export const SCRYPT_PARAMS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

export const hashPassword = async (password, salt) => {
  const buf = await scryptAsync(password, salt, HASH_BYTES, SCRYPT_PARAMS);
  return buf.toString('hex');
};

export const constantEqual = (aHex, bHex) => {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

// Verify a plaintext password against a stored `secrets.auth` record
// ({ enabled, passwordHash, salt }). Returns false for any incomplete record
// so callers never have to re-derive the "is this configured" checks.
export const verifyPasswordAgainst = async (auth, password) => {
  if (!auth?.enabled || !auth.passwordHash || !auth.salt) return false;
  if (typeof password !== 'string' || password.length === 0) return false;
  return constantEqual(await hashPassword(password, auth.salt), auth.passwordHash);
};

// Parse a single cookie out of a `Cookie` header. Express doesn't ship a
// cookie parser and we only need one name — a manual parse keeps the sidecar
// dependency-free.
export const parseCookie = (cookieHeader, name) => {
  if (typeof cookieHeader !== 'string') return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    // decodeURIComponent throws on malformed %XX sequences. An attacker
    // sending `portos_auth=%E0` would otherwise turn every gated request into
    // a 500 instead of a clean 401. Treat a malformed cookie as "no token".
    try { return decodeURIComponent(raw); }
    catch { return null; }
  }
  return null;
};

export const parseCookieToken = (cookieHeader) => parseCookie(cookieHeader, COOKIE_NAME);

// Pull the session token from a request — cookie first, then
// `Authorization: Bearer`. Bearer support lets curl/scripts authenticate
// without juggling cookies. Header names are lowercased by both Node's HTTP
// parser and Socket.IO's handshake, so no uppercase fallback is needed.
export const extractToken = (req) => {
  const cookie = parseCookieToken(req.headers?.cookie);
  if (cookie) return cookie;
  const authHeader = req.headers?.authorization;
  // RFC 6750: the Bearer scheme name is case-insensitive.
  if (typeof authHeader === 'string' && authHeader.length > 7
      && authHeader.slice(0, 7).toLowerCase() === 'bearer ') {
    return authHeader.slice(7).trim();
  }
  return null;
};

// Extract the password from an `Authorization: Basic <base64>` header. PortOS
// is single-user so the username is ignored; only the password is validated.
// Used by peer-to-peer federation probes and by scripts hitting a sidecar.
export const extractBasicPassword = (req) => {
  const authHeader = req.headers?.authorization;
  if (typeof authHeader !== 'string') return null;
  if (authHeader.slice(0, 6).toLowerCase() !== 'basic ') return null;
  const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
  const colonIdx = decoded.indexOf(':');
  return colonIdx === -1 ? decoded : decoded.slice(colonIdx + 1);
};

// Reject cross-origin requests when auth is on. PortOS reflects `Origin` with
// `Access-Control-Allow-Credentials: true` so the UI works from any tailnet
// hostname / IP — but combined with the session cookie that becomes a CSRF
// surface: a malicious page on another tailnet host can fetch PortOS APIs with
// `credentials: 'include'` after the user has logged in (Tailscale's `ts.net`
// is on the Public Suffix List, so SameSite=Lax doesn't help — same-tailnet
// hosts are same-site). Compare the `Origin` header's host:port against the
// request's own `Host`; any mismatch is cross-origin. Requests with no
// `Origin` (server-to-server, curl, the loopback mirror) pass through.
// Hostnames are case-insensitive (RFC 3986 §3.2.2).
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

export const isCrossOrigin = (req) => {
  const origin = req.headers?.origin;
  if (!origin || origin === 'null') return false;
  const host = req.headers?.host;
  if (!host) return false;
  // URL parses scheme://authority — we only compare the authority. A malformed
  // Origin (URL constructor throws) is treated as cross-origin.
  let parsed;
  try { parsed = new URL(origin); }
  catch { return true; }
  if (parsed.host.toLowerCase() === host.toLowerCase()) return false;
  // Dev/sidecar workflow exemption: Vite proxies :5554 → :5555 with
  // changeOrigin, and the autofixer UI on :5560 is opened from the main UI —
  // so a real same-machine browser request can arrive as
  // `Origin: http://localhost:5554` / `Host: localhost:5555`. Treat any
  // loopback-to-loopback pairing as same-origin regardless of port — the CSRF
  // threat is from attackers on OTHER machines.
  if (isLoopback(stripPort(parsed.host)) && isLoopback(stripPort(host))) return false;
  return true;
};

// Sliding-window login throttle. Auth is normally tailnet-only so this is
// defense in depth against a sidecar burning CPU on scrypt verifications.
// In-memory only (a restart resets the counters — acceptable for a
// defense-in-depth control on a single-user install).
export const createLoginThrottle = ({ maxAttempts = 10, windowMs = 60 * 1000 } = {}) => {
  const attempts = new Map();
  const trim = (timestamps, cutoff) => {
    let i = 0;
    while (i < timestamps.length && timestamps[i] < cutoff) i++;
    return i === 0 ? timestamps : timestamps.slice(i);
  };
  const recentFor = (ip) => {
    const cutoff = Date.now() - windowMs;
    const recent = trim(attempts.get(ip) || [], cutoff);
    if (recent.length === 0) attempts.delete(ip);
    else attempts.set(ip, recent);
    return recent;
  };
  return {
    isLimited: (ip) => (typeof ip === 'string' && ip.length > 0
      ? recentFor(ip).length >= maxAttempts
      : false),
    recordFailure: (ip) => {
      if (typeof ip !== 'string' || ip.length === 0) return;
      const recent = recentFor(ip);
      recent.push(Date.now());
      attempts.set(ip, recent);
    },
    clear: (ip) => { if (typeof ip === 'string') attempts.delete(ip); },
  };
};
