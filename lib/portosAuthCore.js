/**
 * portosAuthCore — zero-dependency primitives shared by the main PortOS server
 * (`server/services/auth.js`, `server/services/authGate.js`) and by sidecar
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
import { isIP } from 'node:net';
import { hostname as osHostname } from 'node:os';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// The bundled dev proxy overwrites this with its socket peer on every API hop.
// Consumers may use it only to RESTRICT loopback access, never to grant it.
export const DEV_PROXY_CLIENT_ADDRESS_HEADER = 'x-portos-dev-proxy-client-address';

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

const derivePasswordHash = async (password, salt, scryptParams) => {
  const buf = await scryptAsync(password, salt, HASH_BYTES, scryptParams);
  return buf.toString('hex');
};

export const hashPassword = (password, salt) =>
  derivePasswordHash(password, salt, SCRYPT_PARAMS);

// Test-only: high-level auth suites verify service/middleware behavior with a
// cheap real-scrypt profile. The production hashPassword contract above stays
// pinned to SCRYPT_PARAMS so callers cannot accidentally create an incompatible
// stored credential.
export const __hashPasswordWithParamsForTests = (password, salt, scryptParams) =>
  derivePasswordHash(password, salt, scryptParams);

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

// Cookies are scoped by host, NOT port (RFC 6265 §8.5). Two PortOS installs a
// browser reaches on the same host — e.g. a Mac's own PortOS on
// https://127.0.0.1:5555 and a remote box tunnelled to http://127.0.0.1:15555
// by `tailcat forward` — used to share one `portos_auth` cookie slot, so each
// login clobbered the other's session. Worse: once the HTTPS install stored a
// `Secure` `portos_auth`, browsers that treat http://127.0.0.1 as insecure
// (Safari/WebKit, Firefox) refuse to let the plain-HTTP install set a cookie
// of the same name at all ("leave secure cookies alone", RFC 6265bis §5.7),
// so its login succeeded server-side and the SPA bounced straight back to
// /login with no cookie stored. The session cookie name therefore carries the
// port the browser used (from `Host`), falling back to the legacy bare name
// when the origin uses the scheme's default port. Readers accept every
// PortOS session cookie (legacy + any port-scoped one) and verify each, so
// a sidecar on another port (Autofixer UI on :5560) still inherits the main
// UI's session, and a foreign install's cookie is simply not a valid token.
const SCOPED_COOKIE_RE = /^portos_auth_(\d{1,5})$/;
// Bound the per-request work a hostile Cookie header can cause.
const MAX_SESSION_COOKIES = 8;

export const sessionCookieNameFor = (hostHeader) => {
  if (typeof hostHeader !== 'string') return COOKIE_NAME;
  const match = /:(\d{1,5})$/.exec(hostHeader.trim());
  if (!match) return COOKIE_NAME;
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return COOKIE_NAME;
  return `${COOKIE_NAME}_${port}`;
};

export const isSessionCookieName = (name) => name === COOKIE_NAME || SCOPED_COOKIE_RE.test(name);

// Every PortOS session cookie value in a `Cookie` header, in header order,
// de-duplicated. `{ name, value }` so callers can tell legacy from scoped.
export const parseSessionCookies = (cookieHeader) => {
  const found = [];
  if (typeof cookieHeader !== 'string') return found;
  const seen = new Set();
  for (const part of cookieHeader.split(';')) {
    if (found.length >= MAX_SESSION_COOKIES) break;
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!isSessionCookieName(name)) continue;
    let value;
    try { value = decodeURIComponent(part.slice(eq + 1).trim()); }
    catch { continue; }
    if (!value || seen.has(`${name}=${value}`)) continue;
    seen.add(`${name}=${value}`);
    found.push({ name, value });
  }
  return found;
};

const bearerToken = (req) => {
  const authHeader = req.headers?.authorization;
  // RFC 6750: the Bearer scheme name is case-insensitive.
  if (typeof authHeader === 'string' && authHeader.length > 7
      && authHeader.slice(0, 7).toLowerCase() === 'bearer ') {
    return authHeader.slice(7).trim() || null;
  }
  return null;
};

// Every candidate session token on a request: all PortOS session cookies
// (the one for this request's own port first), then `Authorization: Bearer`.
// Callers must accept the request if ANY candidate verifies — a stale or
// foreign cookie must not mask a valid one.
export const extractTokens = (req) => {
  const own = sessionCookieNameFor(req.headers?.host);
  const cookies = parseSessionCookies(req.headers?.cookie);
  const ordered = [
    ...cookies.filter((c) => c.name === own),
    ...cookies.filter((c) => c.name !== own),
  ].map((c) => c.value);
  const bearer = bearerToken(req);
  if (bearer) ordered.push(bearer);
  return [...new Set(ordered)];
};

// Pull the first candidate session token from a request — cookie first, then
// `Authorization: Bearer`. Bearer support lets curl/scripts authenticate
// without juggling cookies. Header names are lowercased by both Node's HTTP
// parser and Socket.IO's handshake, so no uppercase fallback is needed.
// Prefer `extractTokens` + verify-any for authorization decisions.
export const extractToken = (req) => extractTokens(req)[0] ?? null;

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

// Reject cross-origin browser requests in both auth modes (see
// browserRequestRefusal below). PortOS reflects `Origin` with
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
  if (!origin) return false;
  // An opaque origin (sandboxed iframe, data: URL, cross-origin redirect) is
  // never this install's own UI — a hidden sandboxed form would otherwise slip
  // through as "no Origin".
  if (origin === 'null') return true;
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

// DNS rebinding defeats the Origin-vs-Host comparison above: a hostname the
// attacker controls resolves to this machine, so the page's Origin and the
// request's Host match. A browser request therefore must also address PortOS
// by a name no public site can rebind — an IP literal, a single-label name
// (`localhost`, a MagicDNS short name), a private-use suffix, the machine's
// own hostname, its configured PORTOS_HOST, or an operator-listed name in
// PORTOS_ALLOWED_HOSTS (comma-separated; a leading dot allows every subdomain).
const PRIVATE_HOST_SUFFIXES = ['.localhost', '.ts.net', '.local', '.home.arpa', '.internal', '.lan'];

const normalizeHostname = (value) => stripPort(String(value).trim().toLowerCase()).replace(/\.$/, '');

const configuredHosts = (env) => [env?.PORTOS_HOST, env?.PORTOS_ALLOWED_HOSTS].filter(Boolean).join(',')
  .split(',').map((entry) => entry.trim())
  .map((entry) => (entry.startsWith('.') ? `.${normalizeHostname(entry.slice(1))}` : normalizeHostname(entry)))
  .filter((entry) => entry && entry !== '.');

const MACHINE_HOSTNAME = osHostname();

export const isAllowedHost = (hostHeader, { env = process.env, machineHostname = MACHINE_HOSTNAME } = {}) => {
  if (typeof hostHeader !== 'string' || !hostHeader.trim()) return false;
  const host = normalizeHostname(hostHeader);
  if (!host) return false;
  if (isIP(host) || (host.startsWith('[') && isIP(host.slice(1, -1)) === 6)) return true;
  if (!host.includes('.')) return true;
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (typeof machineHostname === 'string' && host === machineHostname.toLowerCase().replace(/\.$/, '')) return true;
  return configuredHosts(env).some((entry) => (entry.startsWith('.')
    ? host.endsWith(entry) || host === entry.slice(1)
    : host === entry));
};

// Browsers stamp every request with `Sec-Fetch-Site` and every cross-origin or
// state-changing one with `Origin`; curl, agents, peers, and native companion
// apps send neither, so they never reach the checks below.
const isBrowserRequest = (req) => Boolean(req.headers?.origin || req.headers?.['sec-fetch-site']);

// The browser-relay guard. Applies whether or not the optional password is
// set: without it, any page the user opens could drive loopback APIs (a
// hidden form POST needs no preflight). Returns the refusal code, or null
// when the request may proceed.
export const browserRequestRefusal = (req, options) => {
  if (!isBrowserRequest(req)) return null;
  if (isCrossOrigin(req)) return 'CROSS_ORIGIN_BLOCKED';
  if (!isAllowedHost(req.headers?.host, options)) return 'HOST_NOT_ALLOWED';
  return null;
};

// The Vite dev proxy (:5554 → :5555, changeOrigin) rewrites Host to the API
// target but forwards the browser's Origin, so a tailnet browser on
// `https://<name>.ts.net:5554` would look cross-origin to the API. The proxy
// vouches for a request that is same-origin to ITSELF by re-stamping Origin as
// the target's; a foreign Origin is forwarded untouched and the API refuses it.
// Returns the Origin to forward, or null to leave the header alone.
export const devProxyForwardedOrigin = (req, target) => {
  if (!req.headers?.origin || isCrossOrigin(req)) return null;
  return new URL(target).origin;
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
