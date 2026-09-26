import { join } from 'path';
import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import { stat } from 'fs/promises';
import { atomicWrite, PATHS, safeJSONParse, tryReadFile } from '../lib/fileUtils.js';
import {
  COOKIE_NAME,
  SESSION_TTL_MS,
  SALT_BYTES,
  TOKEN_BYTES,
  constantEqual,
  createLoginThrottle,
  extractToken,
  extractTokens,
  hashPassword,
  hashToken,
  parseCookieToken,
  parseSessionCookies,
  sessionCookieNameFor,
} from '../../lib/portosAuthCore.js';
import { getSettings, readSettingsStrict, settingsEvents, updateSettings } from './settings.js';
import { ServerError } from '../lib/errorHandler.js';

// Auth gates the PortOS UI + API behind a single user-set password. PortOS is
// single-user (one human per install) so there are no usernames or roles —
// just a password and a session token. The password hash + salt live under
// `secrets.auth` in settings.json so the existing GET /api/settings sanitizer
// (which strips `secrets`) keeps them off the wire.

// Event bus so the Socket.IO layer can react to auth-state changes (first-time
// enable, password rotation, full disable) without coupling the auth service
// to `io`. Consumers should kick every currently-connected socket and let
// clients re-handshake — the gate then re-validates each one against the
// fresh session store.
export const authEvents = new EventEmitter();
authEvents.setMaxListeners(50);

// The wire/at-rest constants (cookie name, scrypt cost, session TTL) and the
// crypto primitives live in `lib/portosAuthCore.js` so sidecar processes that
// must honour the same password gate — see `lib/sidecarAuthGate.js`, used by
// the Autofixer UI on :5560 — cannot drift from them.
const SESSIONS_FILE = join(PATHS.data, 'auth-sessions.json');
// Delay before kicking sockets on auth-state change. `setImmediate` fires in
// the same tick as the HTTP response flush — close enough that the
// disconnect frame can reach the browser before the new Set-Cookie header
// has been processed, bouncing the initiating tab to /login mid-change. A
// half-second tradeoff: long enough for the response round-trip + cookie
// application on a tailnet (typically <50ms), short enough to not feel
// laggy when a sibling tab needs to log out.
const KICK_DELAY_MS = 500;

// Bytes for the opaque per-session `id` exposed to callers (Settings UI,
// GET /api/auth/sessions). It addresses a session for display/scoped-revoke
// without ever exposing `tokenHash` — a cheap unguessable label, not a
// crypto primitive shared with sidecars, so it stays local to this module.
const SESSION_ID_BYTES = 8;

// In-memory session store. Keyed by `sha256(token)` → { expiresAt, label, id }.
// Persisted to disk on every mutation so tokens survive server restarts
// (handy when PM2 reloads on update). A single-user install rarely has more
// than a handful of live sessions; a Map keeps this simple. The plaintext
// token only ever lives in the response cookie — not in memory and not at
// rest — so an exfiltrated `auth-sessions.json` (e.g. from a backup or
// peer-sync mirror) doesn't yield usable credentials.
//
// `label` is a free-text marker (`null` for an ordinary browser session,
// `'agent'` for a PortOS-spawned agent's loopback credential) — display and
// scoped-revocation only, never an authorization dimension. `id` is an
// opaque per-session handle so a caller can address one record without ever
// seeing `tokenHash`.
const sessions = new Map();
// Single in-flight load promise — both callers await the SAME promise so a
// burst of concurrent verifySession calls after a restart can't observe an
// empty Map while the first call is still reading auth-sessions.json.
let loadPromise = null;
// Identity of auth-sessions.json at last read/write — used to pick up tokens
// minted out-of-process (see mergeSessionsFromDisk). mtime alone is not enough:
// file timestamps are kernel-tick coarse, so an out-of-process write landing in
// the same tick as ours looked "unchanged" and its token stayed invisible.
// atomicWrite renames a fresh inode over the file on every write, so inode +
// size + mtime changes on any rewrite.
let sessionsFileStamp = null;
const fileStamp = (st) => `${st.ino}:${st.size}:${st.mtimeMs}`;

const now = () => Date.now();

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
    // `label` and `id` were added after the initial ship — a record from an
    // older install (or one an older install just wrote back) lacks them.
    // Missing/unknown values must not invalidate the record: default the
    // label to an ordinary (unlabeled) session and mint a fresh id so the
    // session is still addressable this run.
    const label = typeof entry.label === 'string' ? entry.label : null;
    const id = typeof entry.id === 'string' ? entry.id : randomBytes(SESSION_ID_BYTES).toString('hex');
    sessions.set(entry.tokenHash, { expiresAt: entry.expiresAt, label, id });
  }
  try {
    sessionsFileStamp = fileStamp(await stat(SESSIONS_FILE));
  } catch {
    // leave prior stamp; miss path will retry
  }
};

const writeSessions = async () => {
  const tokens = [];
  for (const [tokenHash, { expiresAt, label, id }] of sessions) {
    tokens.push({ tokenHash, expiresAt, label, id });
  }
  await atomicWrite(SESSIONS_FILE, JSON.stringify({ tokens }, null, 2) + '\n');
  try {
    sessionsFileStamp = fileStamp(await stat(SESSIONS_FILE));
  } catch {
    // next miss will refresh
  }
};

const ensureLoaded = async () => {
  if (!loadPromise) {
    loadPromise = readSessions().catch((err) => {
      console.error(`❌ Failed to load auth sessions: ${err.message}`);
    });
  }
  return loadPromise;
};

// Out-of-process callers (box keepalive, a shell one-liner) mint sessions by
// importing this module against the same auth-sessions.json the running server
// owns. The server's Map is loaded once at first verify, so a token written
// after that load is invisible until restart — which made keepalive's
// POST /api/cos/start keep answering AUTH_REQUIRED after the instance password
// was enabled. On a miss, merge any newer disk records into the live Map;
// never drop in-memory entries a racing disk write might have omitted.
const mergeSessionsFromDisk = async () => {
  let stamp;
  try {
    stamp = fileStamp(await stat(SESSIONS_FILE));
  } catch {
    return;
  }
  if (stamp === sessionsFileStamp) return;
  await readSessions();
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

// The server only reports password posture. Risk acceptance lives in each
// browser, so an unauthenticated peer cannot dismiss another browser's warning.
// Password changes rotate the revision, invalidating even an offline browser's
// old acknowledgement. Absence enrolls existing installs without a migration.
export const getPasswordRiskStatus = async () => {
  const { corrupt, settings } = await readSettingsStrict();
  if (corrupt) throw new ServerError('Security settings could not be read', { status: 503, code: 'AUTH_SETTINGS_UNREADABLE' });
  const enabled = await isAuthEnabled();
  return { enabled, revision: settings.passwordRiskRevision || 'initial' };
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
  await updateSettings({ secrets, passwordRiskRevision: randomBytes(16).toString('hex') });
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
  await updateSettings({ secrets, passwordRiskRevision: randomBytes(16).toString('hex') });
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

// `label` is `null` for an ordinary browser session; the agent loopback
// credential (server/services/agentApiAuth.js) passes `'agent'`.
export const createSession = async ({ label = null } = {}) => {
  await ensureLoaded();
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  const expiresAt = now() + SESSION_TTL_MS;
  const id = randomBytes(SESSION_ID_BYTES).toString('hex');
  sessions.set(hashToken(token), { expiresAt, label, id });
  await writeSessions();
  return { token, expiresAt, maxAgeMs: SESSION_TTL_MS, id };
};

// Read-only listing for Settings → Security. Never returns `tokenHash` — an
// `id` is the only handle a caller gets for a scoped revoke.
export const listSessions = async () => {
  await ensureLoaded();
  const cutoff = now();
  const list = [];
  for (const { expiresAt, label, id } of sessions.values()) {
    if (expiresAt <= cutoff) continue;
    list.push({ id, label, expiresAt });
  }
  return list;
};

// Revoke exactly one session by its opaque id — e.g. the agent's loopback
// credential — without touching any other live session (unlike
// `revokeSession`/`revokeAllSessions`, this does not kick connected sockets:
// the sessions this addresses are non-interactive API credentials, not
// browser tabs). Returns whether a matching session was found.
export const revokeSessionById = async (id) => {
  await ensureLoaded();
  for (const [tokenHash, entry] of sessions) {
    if (entry.id !== id) continue;
    sessions.delete(tokenHash);
    await writeSessions();
    return true;
  }
  return false;
};

export const verifySession = async (token) => {
  if (typeof token !== 'string' || token.length === 0) return false;
  await ensureLoaded();
  const key = hashToken(token);
  let entry = sessions.get(key);
  if (!entry) {
    await mergeSessionsFromDisk();
    entry = sessions.get(key);
  }
  if (!entry) return false;
  if (entry.expiresAt <= now()) {
    sessions.delete(key);
    await writeSessions().catch(() => null);
    return false;
  }
  return true;
};

// Authorize a request against every candidate token it carries (all PortOS
// session cookies + Bearer — see extractTokens). Returns the first token that
// verifies, or null. A stale or foreign same-host cookie (another PortOS on a
// different port of the same host) must never mask this install's valid one.
export const verifyRequestSession = async (req) => {
  for (const token of extractTokens(req)) {
    if (await verifySession(token)) return token;
  }
  return null;
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

// Per-IP sliding-window login throttle — auth is normally tailnet-only, so
// this is defense in depth against a sidecar burning server CPU on scrypt
// verifications. Shared with sidecars so they throttle identically.
const loginThrottle = createLoginThrottle();

export const isLoginRateLimited = (ip) => loginThrottle.isLimited(ip);
export const recordLoginFailure = (ip) => loginThrottle.recordFailure(ip);
export const clearLoginFailures = (ip) => loginThrottle.clear(ip);

// Cookie parsing + token extraction are shared with sidecars. Re-exported here
// so existing importers of this module keep working unchanged.
export { parseCookieToken, parseSessionCookies, extractToken, extractTokens, sessionCookieNameFor };

export const buildSessionCookie = (token, { secure = false, name = COOKIE_NAME } = {}) => {
  // HttpOnly so XSS can't read it; SameSite=Lax so cross-origin GETs from the
  // browser address bar work but cross-site POSTs are blocked. `Secure` is
  // toggled by the caller based on the loopback-mirror vs HTTPS scheme of the
  // request — a `Secure` cookie on a plain-http request is silently dropped.
  // `name` is port-scoped by the caller (sessionCookieNameFor) so two
  // installs reached on one host never share a cookie slot.
  const parts = [
    `${name}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
};

export const buildClearCookie = ({ secure = false, name = COOKIE_NAME } = {}) => {
  // Mirror the `Secure` attribute on the clear so RFC 6265bis-conformant
  // browsers can match-and-delete by full attribute set. Today most
  // browsers still clear by name+path+domain alone; Chrome has been
  // tightening this, and a future change could leave the cookie
  // un-deletable on HTTPS sessions if we drop the attribute here.
  const parts = [
    `${name}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
};
