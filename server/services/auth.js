import { join } from 'path';
import { EventEmitter } from 'events';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { atomicWrite, PATHS, safeJSONParse, tryReadFile } from '../lib/fileUtils.js';
import { getSettings, readSettingsStrict, settingsEvents, updateSettings } from './settings.js';
import { ServerError } from '../lib/errorHandler.js';

// Auth gates the PortOS UI + API behind a single user-set password. PortOS is
// single-user (one human per install) so there are no usernames or roles —
// just a password and a session token. The password hash + salt live under
// `secrets.auth` in settings.json so the existing GET /api/settings sanitizer
// (which strips `secrets`) keeps them off the wire.

const scryptAsync = promisify(scrypt);

// Event bus so the Socket.IO layer can react to auth-state changes (first-time
// enable, password rotation, full disable) without coupling the auth service
// to `io`. Consumers should kick every currently-connected socket and let
// clients re-handshake — the gate then re-validates each one against the
// fresh session store.
export const authEvents = new EventEmitter();
authEvents.setMaxListeners(50);

const SESSIONS_FILE = join(PATHS.data, 'auth-sessions.json');
const TOKEN_BYTES = 32;
const SALT_BYTES = 16;
const HASH_BYTES = 64;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const COOKIE_NAME = 'portos_auth';
// Login throttle — auth is normally tailnet-only so this is defense in depth
// against a sidecar burning server CPU on scrypt verifications. Per-IP
// sliding window: at most LOGIN_MAX_ATTEMPTS failed POSTs in
// LOGIN_WINDOW_MS, then 401s with no scrypt work until the window clears.
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 60 * 1000;
// scrypt cost parameters per OWASP 2023 password-storage guidance for
// interactive logins. PortOS has no rate limiting and the password hash +
// salt persist in `settings.json` (single-user trust model — local
// filesystem access already exists), so the realistic threat is offline
// cracking of an exfiltrated settings file. The higher N narrows the
// GPU/ASIC margin without making a one-per-tab login feel slow.
// Node's default `maxmem` of 32 MiB rejects this N. OpenSSL needs slightly
// more headroom than the canonical 128·N·r working set (≈128 MiB for these
// params), so allocate 256 MiB.
const SCRYPT_PARAMS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

// Delay before kicking sockets on auth-state change. `setImmediate` fires in
// the same tick as the HTTP response flush — close enough that the
// disconnect frame can reach the browser before the new Set-Cookie header
// has been processed, bouncing the initiating tab to /login mid-change. A
// half-second tradeoff: long enough for the response round-trip + cookie
// application on a tailnet (typically <50ms), short enough to not feel
// laggy when a sibling tab needs to log out.
const KICK_DELAY_MS = 500;

// In-memory session store. Keyed by `sha256(token)` → { expiresAt }. Persisted
// to disk on every mutation so tokens survive server restarts (handy when PM2
// reloads on update). A single-user install rarely has more than a handful of
// live sessions; a Map keeps this simple. The plaintext token only ever lives
// in the response cookie — not in memory and not at rest — so an exfiltrated
// `auth-sessions.json` (e.g. from a backup or peer-sync mirror) doesn't yield
// usable credentials.
const sessions = new Map();
// Single in-flight load promise — both callers await the SAME promise so a
// burst of concurrent verifySession calls after a restart can't observe an
// empty Map while the first call is still reading auth-sessions.json.
let loadPromise = null;

const now = () => Date.now();

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

const readSessions = async () => {
  const raw = await tryReadFile(SESSIONS_FILE);
  const parsed = safeJSONParse(raw ?? '{}', {});
  if (!Array.isArray(parsed.tokens)) return;
  const cutoff = now();
  for (const entry of parsed.tokens) {
    // Records carry `tokenHash` (sha256 hex). Records without it are
    // skipped — the feature ships with hashed storage from day one, so
    // a record missing `tokenHash` is corrupted, not legacy.
    if (typeof entry?.tokenHash !== 'string' || typeof entry.expiresAt !== 'number') continue;
    if (entry.expiresAt <= cutoff) continue;
    sessions.set(entry.tokenHash, { expiresAt: entry.expiresAt });
  }
};

const writeSessions = async () => {
  const tokens = [];
  for (const [tokenHash, { expiresAt }] of sessions) {
    tokens.push({ tokenHash, expiresAt });
  }
  await atomicWrite(SESSIONS_FILE, JSON.stringify({ tokens }, null, 2) + '\n');
};

const ensureLoaded = async () => {
  if (!loadPromise) {
    loadPromise = readSessions().catch((err) => {
      console.error(`❌ Failed to load auth sessions: ${err.message}`);
    });
  }
  return loadPromise;
};

const hashPassword = async (password, salt) => {
  const buf = await scryptAsync(password, salt, HASH_BYTES, SCRYPT_PARAMS);
  return buf.toString('hex');
};

const constantEqual = (aHex, bHex) => {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

const readAuthConfig = async () => {
  const settings = await getSettings();
  return settings?.secrets?.auth ?? null;
};

// isAuthEnabled is called on EVERY gated request and every socket event.
// Re-reading + parsing + stripping settings.json each time is a measurable
// I/O multiplier on active pages and high-frequency socket streams (shell
// input, voice frames). Cache the boolean and refresh it via the
// settings:updated event the settings service already emits on every
// updateSettings write.
let enabledCache = null;
const recomputeEnabledCache = (settings) => {
  const a = settings?.secrets?.auth;
  enabledCache = !!(a?.enabled && a?.passwordHash && a?.salt);
};
settingsEvents.on('settings:updated', recomputeEnabledCache);
// A corrupt reload (e.g. a backup restore of a malformed settings.json — see
// reloadSettings() in settings.js) emits this instead of a `{}`-valued
// settings:updated. Drop the cached boolean so the next isAuthEnabled() goes
// through the strict read and FAILS CLOSED rather than reopening the gate from a
// corrupt-derived empty snapshot. See #2684.
settingsEvents.on('settings:invalidated', () => { enabledCache = null; });

export const isAuthEnabled = async () => {
  if (enabledCache === null) {
    // Cold path: read settings.json STRICTLY so a corrupt/unreadable file fails
    // CLOSED (assume auth ON) instead of silently disabling the gate. A genuinely
    // absent file (fresh install) still means auth off, as before. See #2684.
    const { corrupt, settings } = await readSettingsStrict();
    // Double-check after the await — a concurrent updateSettings firing
    // settings:updated between the null check and this point would have
    // primed the cache already; clobbering it with the stale pre-write
    // snapshot would open a fail-open window if the concurrent write
    // was a first-time auth enable.
    if (enabledCache !== null) return enabledCache;
    if (corrupt) {
      // Fail closed WITHOUT caching: the file may be transiently unreadable (a
      // mid-write window, a momentary permission blip). Returning `true` blocks
      // gated routes for now, and leaving `enabledCache` null means the next
      // call re-reads — so the state self-heals on the first clean read (or the
      // next settings:updated event) without a restart. Paying one extra read
      // per request in this abnormal, security-relevant window is the right
      // trade for never silently disabling auth.
      return true;
    }
    recomputeEnabledCache(settings);
  }
  return enabledCache;
};

export const getAuthStatus = async () => {
  const enabled = await isAuthEnabled();
  return { enabled };
};

// Set or replace the password. When `currentPassword` is provided we verify it
// against the stored hash first; pass `null` for the first-time set. Returns a
// fresh session token so the caller can stay signed in after a change.
export const setPassword = async ({ newPassword, currentPassword = null }) => {
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    throw new ServerError('Password must be at least 8 characters', { status: 400, code: 'AUTH_PASSWORD_TOO_SHORT' });
  }
  if (newPassword.length > 256) {
    throw new ServerError('Password too long', { status: 400, code: 'AUTH_PASSWORD_TOO_LONG' });
  }
  const existing = await readAuthConfig();
  if (existing?.enabled) {
    const ok = typeof currentPassword === 'string'
      && existing.passwordHash
      && existing.salt
      && constantEqual(await hashPassword(currentPassword, existing.salt), existing.passwordHash);
    if (!ok) {
      throw new ServerError('Current password is incorrect', { status: 401, code: 'AUTH_BAD_CURRENT' });
    }
  }
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const passwordHash = await hashPassword(newPassword, salt);
  const settings = await getSettings();
  const secrets = { ...(settings.secrets || {}) };
  secrets.auth = {
    enabled: true,
    kdf: 'scrypt',
    passwordHash,
    salt,
    updatedAt: new Date().toISOString(),
  };
  await updateSettings({ secrets });
  // Existing sessions are invalidated on password change — the user (or anyone
  // holding a stolen token) starts over.
  await revokeAllSessions();
  return createSession();
};

// Clear the password entirely (turn auth off). Mirrors setPassword's
// current-password check so the disable can't happen without proof of identity.
export const clearPassword = async ({ currentPassword }) => {
  const existing = await readAuthConfig();
  if (!existing?.enabled) return { enabled: false };
  const ok = typeof currentPassword === 'string'
    && existing.passwordHash
    && existing.salt
    && constantEqual(await hashPassword(currentPassword, existing.salt), existing.passwordHash);
  if (!ok) {
    throw new ServerError('Current password is incorrect', { status: 401, code: 'AUTH_BAD_CURRENT' });
  }
  const settings = await getSettings();
  const secrets = { ...(settings.secrets || {}) };
  delete secrets.auth;
  await updateSettings({ secrets });
  await revokeAllSessions();
  return { enabled: false };
};

export const verifyPassword = async (password) => {
  const auth = await readAuthConfig();
  if (!auth?.enabled || !auth.passwordHash || !auth.salt) return false;
  if (typeof password !== 'string' || password.length === 0) return false;
  const candidate = await hashPassword(password, auth.salt);
  return constantEqual(candidate, auth.passwordHash);
};

export const createSession = async () => {
  await ensureLoaded();
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  const expiresAt = now() + SESSION_TTL_MS;
  sessions.set(hashToken(token), { expiresAt });
  await writeSessions();
  return { token, expiresAt, maxAgeMs: SESSION_TTL_MS };
};

export const verifySession = async (token) => {
  if (typeof token !== 'string' || token.length === 0) return false;
  await ensureLoaded();
  const key = hashToken(token);
  const entry = sessions.get(key);
  if (!entry) return false;
  if (entry.expiresAt <= now()) {
    sessions.delete(key);
    await writeSessions().catch(() => null);
    return false;
  }
  return true;
};

export const revokeSession = async (token) => {
  await ensureLoaded();
  if (sessions.delete(hashToken(token))) {
    await writeSessions();
    // Logging-out one tab kicks every connected socket too — the
    // single-user model means broadcast events shouldn't keep streaming
    // to a tab whose cookie was just cleared. Deferred so the logout
    // response's clear-cookie reaches the browser first.
    setTimeout(() => authEvents.emit('sessions:revoked-all'), KICK_DELAY_MS);
  }
};

export const revokeAllSessions = async () => {
  await ensureLoaded();
  sessions.clear();
  await writeSessions();
  // Notify the socket layer so connections established before the revoke
  // (e.g. a tab open before auth was enabled, or before a password rotation)
  // get kicked. Otherwise they'd keep emitting privileged events on the
  // already-accepted handshake until the page reloads.
  //
  // Defer the kick so the HTTP response that triggered this revoke (POST
  // /api/auth/password) has time to flush its new Set-Cookie header and
  // round-trip to the browser BEFORE we kick the requesting tab's socket.
  // Without the defer, the user's own password-change request kicks their
  // own socket, which reconnects with the OLD cookie (the new one hasn't
  // arrived yet) and bounces them to /login mid-change.
  setTimeout(() => authEvents.emit('sessions:revoked-all'), KICK_DELAY_MS);
};

// Sliding-window login-throttle map. Keys are client IPs; values are arrays
// of recent failed-attempt timestamps. Trimmed lazily on each call so it
// never grows unbounded. In-memory only (a sidecar restart resets the
// counters — acceptable for a defense-in-depth control on a single-user
// install, not the primary auth boundary).
const loginAttempts = new Map();

const trimLoginWindow = (timestamps, cutoff) => {
  let i = 0;
  while (i < timestamps.length && timestamps[i] < cutoff) i++;
  return i === 0 ? timestamps : timestamps.slice(i);
};

export const isLoginRateLimited = (ip) => {
  if (typeof ip !== 'string' || ip.length === 0) return false;
  const cutoff = now() - LOGIN_WINDOW_MS;
  const recent = trimLoginWindow(loginAttempts.get(ip) || [], cutoff);
  if (recent.length === 0) loginAttempts.delete(ip);
  else loginAttempts.set(ip, recent);
  return recent.length >= LOGIN_MAX_ATTEMPTS;
};

export const recordLoginFailure = (ip) => {
  if (typeof ip !== 'string' || ip.length === 0) return;
  const cutoff = now() - LOGIN_WINDOW_MS;
  const recent = trimLoginWindow(loginAttempts.get(ip) || [], cutoff);
  recent.push(now());
  loginAttempts.set(ip, recent);
};

export const clearLoginFailures = (ip) => {
  if (typeof ip === 'string') loginAttempts.delete(ip);
};

// Parse the `Cookie` header for our token. Express doesn't ship a cookie
// parser and we only need one cookie name — manual parse keeps the dep tree
// small (CLAUDE.md "Default to writing code yourself").
export const parseCookieToken = (cookieHeader) => {
  if (typeof cookieHeader !== 'string') return null;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name !== COOKIE_NAME) continue;
    const raw = part.slice(eq + 1).trim();
    // decodeURIComponent throws on malformed %XX sequences. An attacker
    // sending `portos_auth=%E0` would otherwise turn every gated request
    // into a 500 via the error middleware instead of a clean 401. Treat
    // a malformed cookie the same as "no token".
    try { return decodeURIComponent(raw); }
    catch { return null; }
  }
  return null;
};

// Pull the token from a request — cookie first, then Authorization: Bearer.
// Bearer support lets curl/scripts authenticate without juggling cookies.
// Header names are lowercased by both Node's HTTP parser and Socket.IO's
// handshake — no uppercase fallback needed.
export const extractToken = (req) => {
  const cookie = parseCookieToken(req.headers?.cookie);
  if (cookie) return cookie;
  const authHeader = req.headers?.authorization;
  // RFC 6750: Bearer scheme name is case-insensitive.
  if (typeof authHeader === 'string' && authHeader.length > 7
      && authHeader.slice(0, 7).toLowerCase() === 'bearer ') {
    return authHeader.slice(7).trim();
  }
  return null;
};

export const buildSessionCookie = (token, { secure = false } = {}) => {
  // HttpOnly so XSS can't read it; SameSite=Lax so cross-origin GETs from the
  // browser address bar work but cross-site POSTs are blocked. `Secure` is
  // toggled by the caller based on the loopback-mirror vs HTTPS scheme of the
  // request — a `Secure` cookie on a plain-http request is silently dropped.
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
};

export const buildClearCookie = ({ secure = false } = {}) => {
  // Mirror the `Secure` attribute on the clear so RFC 6265bis-conformant
  // browsers can match-and-delete by full attribute set. Today most
  // browsers still clear by name+path+domain alone; Chrome has been
  // tightening this, and a future change could leave the cookie
  // un-deletable on HTTPS sessions if we drop the attribute here.
  const parts = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
};
