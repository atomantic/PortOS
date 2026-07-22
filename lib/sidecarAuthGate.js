/**
 * sidecarAuthGate — the PortOS password gate for sidecar processes.
 *
 * PortOS's main server (`:5555`) can be put behind a single user-set password
 * (`server/services/auth.js`). Sidecars like the Autofixer UI (`:5560`) listen
 * on `0.0.0.0` for tailnet access and expose privileged endpoints (PM2
 * restart/stop, live log streams) — so when the install is password protected,
 * they MUST honour the same gate, otherwise the password on `:5555` is a
 * front door with the side door left open.
 *
 * Sidecars are separate PM2 processes with their own `package.json`, so this
 * module cannot import the server's service layer. It reads the same two files
 * the server owns:
 *   - `data/settings.json` → `secrets.auth` = { enabled, passwordHash, salt }
 *   - `data/auth-sessions.json` → { tokens: [{ tokenHash, expiresAt }] }
 * and is otherwise Node-builtins-only (see `lib/portosAuthCore.js`).
 *
 * Accepted credentials, in order:
 *   1. The sidecar's own cookie, issued by POST <loginPath> (see below).
 *   2. A `portos_auth` session cookie or `Authorization: Bearer <token>` minted
 *      by the main server. Cookies ignore port, so a browser already logged in
 *      to PortOS on the same host is authenticated here with no second login.
 *   3. `Authorization: Basic <base64(:password)>` — for curl/scripts.
 *
 * The sidecar NEVER writes `auth-sessions.json`: the main server keeps that
 * store in memory and rewrites it wholesale on every mutation, so a second
 * writer would silently clobber sessions. Instead its own cookie is stateless —
 * `<expiresAt>.<HMAC-SHA256(passwordHash+salt, expiresAt)>`. That keys the
 * signature to the stored password, so rotating or clearing the password
 * invalidates every outstanding sidecar cookie for free.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createLoginThrottle,
  extractBasicPassword,
  extractToken,
  hashToken,
  isCrossOrigin,
  parseCookie,
  verifyPasswordAgainst,
} from './portosAuthCore.js';

const SIDECAR_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
// settings.json / auth-sessions.json are re-read on a short TTL rather than
// cached for the process lifetime, so enabling auth (or rotating the password)
// on :5555 takes effect on the sidecar within seconds and without a restart.
const CONFIG_TTL_MS = 5_000;
const SESSIONS_TTL_MS = 2_000;

const readJson = async (file) => {
  // Distinguish "file absent" (fresh install, auth was never configured) from
  // "file present but unreadable/corrupt" (fail closed) — collapsing the two
  // would silently disable the gate on a mid-write read.
  const raw = await readFile(file, 'utf8').catch((err) => {
    if (err?.code === 'ENOENT') return null;
    throw err;
  });
  if (raw === null) return { missing: true, value: null };
  return { missing: false, value: JSON.parse(raw) };
};

const cached = (ttlMs, load) => {
  let value = null;
  let expiresAt = 0;
  return async () => {
    if (value !== null && expiresAt > Date.now()) return value;
    value = await load();
    expiresAt = Date.now() + ttlMs;
    return value;
  };
};

export const createSidecarAuthGate = ({
  dataDir,
  cookieName,
  loginPath = '/api/auth/login',
  logoutPath = '/api/auth/logout',
  statusPath = '/api/auth/status',
  publicPaths = [],
} = {}) => {
  if (!dataDir) throw new Error('createSidecarAuthGate requires a dataDir');
  if (!cookieName) throw new Error('createSidecarAuthGate requires a cookieName');

  const SETTINGS_FILE = join(dataDir, 'settings.json');
  const SESSIONS_FILE = join(dataDir, 'auth-sessions.json');
  const alwaysPublic = new Set([loginPath, logoutPath, statusPath, ...publicPaths]);
  const throttle = createLoginThrottle();

  // { auth, corrupt }. `corrupt` means settings.json exists but couldn't be
  // read/parsed — the gate then fails CLOSED (auth assumed on, and since no
  // password hash is available nothing verifies) instead of fail-open.
  const loadConfig = cached(CONFIG_TTL_MS, async () => {
    const { missing, value } = await readJson(SETTINGS_FILE).catch(() => ({ missing: false, value: null }));
    if (missing) return { auth: null, corrupt: false };
    if (!value || typeof value !== 'object') return { auth: null, corrupt: true };
    return { auth: value?.secrets?.auth ?? null, corrupt: false };
  });

  const loadSessions = cached(SESSIONS_TTL_MS, async () => {
    const { value } = await readJson(SESSIONS_FILE).catch(() => ({ value: null }));
    const tokens = Array.isArray(value?.tokens) ? value.tokens : [];
    const store = new Map();
    for (const entry of tokens) {
      if (typeof entry?.tokenHash !== 'string' || typeof entry.expiresAt !== 'number') continue;
      store.set(entry.tokenHash, entry.expiresAt);
    }
    return store;
  });

  const isEnabled = async () => {
    const { auth, corrupt } = await loadConfig();
    if (corrupt) return true;
    return !!(auth?.enabled && auth.passwordHash && auth.salt);
  };

  const signingKey = (auth) => `${auth.passwordHash}:${auth.salt}`;

  const macFor = (auth, expiresAt) =>
    createHmac('sha256', signingKey(auth)).update(String(expiresAt)).digest('hex');

  const signSidecarCookie = (auth, expiresAt) => `${expiresAt}.${macFor(auth, expiresAt)}`;

  const verifySidecarCookie = (auth, value) => {
    if (typeof value !== 'string') return false;
    const dot = value.indexOf('.');
    if (dot === -1) return false;
    const expiresAt = Number(value.slice(0, dot));
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
    const presented = Buffer.from(value.slice(dot + 1), 'hex');
    const expected = Buffer.from(macFor(auth, expiresAt), 'hex');
    if (presented.length !== expected.length || presented.length === 0) return false;
    return timingSafeEqual(presented, expected);
  };

  const verifyServerSession = async (token) => {
    if (typeof token !== 'string' || token.length === 0) return false;
    const sessions = await loadSessions();
    const expiresAt = sessions.get(hashToken(token));
    return typeof expiresAt === 'number' && expiresAt > Date.now();
  };

  const isAuthenticated = async (req) => {
    const { auth, corrupt } = await loadConfig();
    // Corrupt settings → no usable password hash → nothing can authenticate.
    if (corrupt || !auth?.passwordHash || !auth.salt) return false;
    if (verifySidecarCookie(auth, parseCookie(req.headers?.cookie, cookieName))) return true;
    if (await verifyServerSession(extractToken(req))) return true;
    const basic = extractBasicPassword(req);
    if (basic && await verifyPasswordAgainst(auth, basic)) return true;
    return false;
  };

  const isSecureRequest = (req) => req.secure === true
    || (req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

  const buildCookie = (value, { secure, maxAgeSeconds }) => {
    const parts = [
      `${cookieName}=${encodeURIComponent(value)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAgeSeconds}`,
    ];
    if (secure) parts.push('Secure');
    return parts.join('; ');
  };

  // Express middleware. No-ops entirely when the install has no password —
  // that's the documented PortOS trust model (single user on a private
  // tailnet), so an unprotected install keeps working exactly as before.
  const gate = async (req, res, next) => {
    if (!(await isEnabled())) return next();
    // The CSRF guard runs FIRST: the logout endpoint is public but still
    // mutates state, so a same-tailnet attacker could otherwise force actions
    // cross-origin through the public-path bypass.
    if (isCrossOrigin(req)) {
      return res.status(403).json({ error: 'Cross-origin request rejected', code: 'CROSS_ORIGIN_BLOCKED' });
    }
    if (alwaysPublic.has(req.path)) return next();
    if (await isAuthenticated(req)) return next();
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  };

  // GET <statusPath> → does this sidecar need a password, and does the caller
  // already have one? The UI polls this to decide whether to show its login
  // overlay, so it must stay reachable unauthenticated.
  const handleStatus = async (req, res) => {
    const enabled = await isEnabled();
    res.json({ enabled, authenticated: enabled ? await isAuthenticated(req) : true });
  };

  // POST <loginPath> { password } → sets the sidecar cookie.
  const handleLogin = async (req, res) => {
    if (!(await isEnabled())) return res.json({ success: true, enabled: false });
    const ip = req.ip || req.socket?.remoteAddress || '';
    if (throttle.isLimited(ip)) {
      return res.status(429).json({ error: 'Too many attempts, try again shortly', code: 'AUTH_RATE_LIMITED' });
    }
    const { auth } = await loadConfig();
    const password = req.body?.password;
    if (!(await verifyPasswordAgainst(auth, password))) {
      throttle.recordFailure(ip);
      return res.status(401).json({ error: 'Incorrect password', code: 'AUTH_BAD_PASSWORD' });
    }
    throttle.clear(ip);
    const expiresAt = Date.now() + SIDECAR_TTL_MS;
    res.setHeader('Set-Cookie', buildCookie(signSidecarCookie(auth, expiresAt), {
      secure: isSecureRequest(req),
      maxAgeSeconds: Math.floor(SIDECAR_TTL_MS / 1000),
    }));
    res.json({ success: true, expiresAt });
  };

  // POST <logoutPath> → clears the sidecar cookie. A `portos_auth` session
  // cookie from the main server is NOT touched — that one is the main UI's to
  // manage, and revoking it here would log the user out of PortOS itself.
  const handleLogout = (req, res) => {
    res.setHeader('Set-Cookie', buildCookie('', { secure: isSecureRequest(req), maxAgeSeconds: 0 }));
    res.json({ success: true });
  };

  return { gate, handleStatus, handleLogin, handleLogout, isEnabled, isAuthenticated };
};
