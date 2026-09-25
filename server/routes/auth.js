import { Router } from 'express';
import { z } from 'zod';
import {
  getPasswordRiskStatus,
  buildClearCookie,
  buildSessionCookie,
  clearLoginFailures,
  clearPassword,
  createSession,
  extractTokens,
  getAuthStatus,
  isAuthEnabled,
  isLoginRateLimited,
  listSessions,
  parseSessionCookies,
  recordLoginFailure,
  revokeSession,
  revokeSessionById,
  sessionCookieNameFor,
  setPassword,
  verifyPassword,
  verifyRequestSession,
  verifySession,
} from '../services/auth.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';

const router = Router();

const loginSchema = z.object({ password: z.string().min(1).max(256) }).strict();
const setPasswordSchema = z.object({
  newPassword: z.string().min(8).max(256),
  currentPassword: z.string().max(256).optional(),
}).strict();
const clearPasswordSchema = z.object({ currentPassword: z.string().min(1).max(256) }).strict();
const sessionIdParamSchema = z.object({ id: z.string().min(1).max(64).regex(/^[a-f0-9]+$/) }).strict();

// Whether the request reached us over HTTPS (so the cookie should carry the
// Secure flag). `req.secure` reflects the actual socket; we don't trust
// X-Forwarded-Proto since PortOS isn't behind a reverse proxy in its normal
// deployment topology.
const isSecure = (req) => !!req.secure;

// The session cookie name is port-scoped from the browser-facing `Host` (see
// sessionCookieNameFor in lib/portosAuthCore.js) — e.g. `portos_auth_15555`
// behind a `tailcat forward 15555:5555` — so this install never shares (or is
// blocked by a `Secure`) cookie slot with another PortOS on the same host.
const sessionCookieFor = (req, token) =>
  buildSessionCookie(token, { secure: isSecure(req), name: sessionCookieNameFor(req.headers?.host) });

// Names of this install's OTHER session cookies on the request (e.g. a legacy
// bare `portos_auth` minted before the port-scoped name) — only those whose
// token is live HERE, so we never clear a sibling install's cookie that
// happens to share the host.
const ownedStaleCookieNames = async (req) => {
  const own = sessionCookieNameFor(req.headers?.host);
  const names = [];
  for (const { name, value } of parseSessionCookies(req.headers?.cookie)) {
    if (name === own || names.includes(name)) continue;
    if (await verifySession(value)) names.push(name);
  }
  return names;
};

const clearCookiesFor = (req, extraNames = []) => {
  const secure = isSecure(req);
  const names = [sessionCookieNameFor(req.headers?.host), ...extraNames];
  return [...new Set(names)].map((name) => buildClearCookie({ secure, name }));
};

// GET /api/auth/status — always reachable. The UI uses this to know whether
// to render the login gate at all.
router.get('/status', asyncHandler(async (_req, res) => {
  res.json(await getAuthStatus());
}));

router.get('/password-risk', asyncHandler(async (_req, res) => {
  res.json(await getPasswordRiskStatus());
}));

// GET /api/auth/whoami — confirm the current cookie/header is still valid.
// Returns { authenticated: true|false, required: true|false } so the client
// can disambiguate "auth off" from "auth on, you're signed in" from "auth on,
// you're not signed in".
router.get('/whoami', asyncHandler(async (req, res) => {
  const required = await isAuthEnabled();
  if (!required) {
    res.json({ authenticated: true, required: false });
    return;
  }
  const authenticated = !!(await verifyRequestSession(req));
  res.json({ authenticated, required: true });
}));

// POST /api/auth/login
router.post('/login', asyncHandler(async (req, res) => {
  const { password } = validateRequest(loginSchema, req.body || {});
  if (!(await isAuthEnabled())) {
    throw new ServerError('Authentication is not enabled', { status: 400, code: 'AUTH_NOT_ENABLED' });
  }
  // Throttle check runs BEFORE scrypt so a sidecar can't pin the CPU by
  // looping bad guesses. The IP comes from Express's `req.ip` (we don't
  // sit behind a reverse proxy in normal PortOS deployments).
  const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
  if (isLoginRateLimited(clientIp)) {
    throw new ServerError('Too many login attempts — try again in a minute', {
      status: 429,
      code: 'AUTH_RATE_LIMITED',
    });
  }
  if (!(await verifyPassword(password))) {
    recordLoginFailure(clientIp);
    throw new ServerError('Invalid password', { status: 401, code: 'AUTH_BAD_PASSWORD' });
  }
  // Success clears the throttle so a user who mistyped a few times then got
  // it right isn't kept locked out.
  clearLoginFailures(clientIp);
  const { token } = await createSession();
  res.setHeader('Set-Cookie', sessionCookieFor(req, token));
  res.json({ authenticated: true });
}));

// POST /api/auth/logout — best-effort revoke + clear cookie. Idempotent so a
// double-click on Sign Out doesn't 401.
router.post('/logout', asyncHandler(async (req, res) => {
  // Revoke every live token the request carries (port-scoped cookie, a
  // pre-upgrade legacy cookie, Bearer) so signing out can't leave a second
  // valid cookie behind. revokeSession is a no-op for foreign tokens.
  const stale = await ownedStaleCookieNames(req);
  for (const token of extractTokens(req)) await revokeSession(token);
  res.setHeader('Set-Cookie', clearCookiesFor(req, stale));
  res.json({ ok: true });
}));

// POST /api/auth/password — set or rotate the password. When auth is already
// on, the caller must include their current password. When it's off, this is
// the first-time-set path and `currentPassword` is ignored. Returns a fresh
// session cookie so the user stays signed in.
router.post('/password', asyncHandler(async (req, res) => {
  const body = validateRequest(setPasswordSchema, req.body || {});
  const alreadyEnabled = await isAuthEnabled();
  // First-time set is the ONLY public mutation here — once auth is on, the
  // route is gated by the API auth middleware in server/index.js, so we
  // reach this branch only with a valid session.
  const stale = await ownedStaleCookieNames(req);
  const { token } = await setPassword({
    newPassword: body.newPassword,
    currentPassword: alreadyEnabled ? body.currentPassword : null,
  });
  const secure = isSecure(req);
  res.setHeader('Set-Cookie', [
    sessionCookieFor(req, token),
    ...stale.map((name) => buildClearCookie({ secure, name })),
  ]);
  res.json({ enabled: true });
}));

// DELETE /api/auth/password — turn auth off. Requires the current password
// so an attacker holding only a session token (without the password) can't
// silently disable the gate.
router.delete('/password', asyncHandler(async (req, res) => {
  const { currentPassword } = validateRequest(clearPasswordSchema, req.body || {});
  const stale = await ownedStaleCookieNames(req);
  await clearPassword({ currentPassword });
  res.setHeader('Set-Cookie', clearCookiesFor(req, stale));
  res.json({ enabled: false });
}));

// GET /api/auth/sessions — list live sessions for Settings → Security. Gated
// exactly like the rest of /api/auth/* (not in the always-public set), so
// this only reveals anything to a caller who is already authenticated.
// Never returns the token or its hash — just what identifies a session on
// screen (label, expiry) and what addresses it for a scoped revoke (id).
router.get('/sessions', asyncHandler(async (_req, res) => {
  const sessions = await listSessions();
  res.json({ sessions, count: sessions.length });
}));

// DELETE /api/auth/sessions/:id — revoke exactly one session (e.g. the
// agent's loopback credential) without touching the caller's own browser
// session, unlike DELETE /api/auth/password (which revokes every session).
router.delete('/sessions/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(sessionIdParamSchema, req.params);
  const revoked = await revokeSessionById(id);
  if (!revoked) {
    throw new ServerError('Session not found', { status: 404, code: 'AUTH_SESSION_NOT_FOUND' });
  }
  res.json({ ok: true });
}));

export default router;
