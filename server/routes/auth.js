import { Router } from 'express';
import { z } from 'zod';
import {
  acknowledgePasswordRisk,
  getPasswordRiskStatus,
  buildClearCookie,
  buildSessionCookie,
  clearLoginFailures,
  clearPassword,
  createSession,
  extractToken,
  getAuthStatus,
  isAuthEnabled,
  isLoginRateLimited,
  listSessions,
  recordLoginFailure,
  revokeSession,
  revokeSessionById,
  setPassword,
  verifyPassword,
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
const passwordRiskSchema = z.object({ acceptRisk: z.literal(true) }).strict();

// Whether the request reached us over HTTPS (so the cookie should carry the
// Secure flag). `req.secure` reflects the actual socket; we don't trust
// X-Forwarded-Proto since PortOS isn't behind a reverse proxy in its normal
// deployment topology.
const isSecure = (req) => !!req.secure;

// GET /api/auth/status — always reachable. The UI uses this to know whether
// to render the login gate at all.
router.get('/status', asyncHandler(async (_req, res) => {
  res.json(await getAuthStatus());
}));

router.get('/password-risk', asyncHandler(async (_req, res) => {
  res.json(await getPasswordRiskStatus());
}));

router.post('/password-risk', asyncHandler(async (req, res) => {
  validateRequest(passwordRiskSchema, req.body || {});
  res.json(await acknowledgePasswordRisk());
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
  const token = extractToken(req);
  const authenticated = await verifySession(token);
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
  res.setHeader('Set-Cookie', buildSessionCookie(token, { secure: isSecure(req) }));
  res.json({ authenticated: true });
}));

// POST /api/auth/logout — best-effort revoke + clear cookie. Idempotent so a
// double-click on Sign Out doesn't 401.
router.post('/logout', asyncHandler(async (req, res) => {
  const token = extractToken(req);
  if (token) await revokeSession(token);
  res.setHeader('Set-Cookie', buildClearCookie({ secure: isSecure(req) }));
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
  const { token } = await setPassword({
    newPassword: body.newPassword,
    currentPassword: alreadyEnabled ? body.currentPassword : null,
  });
  res.setHeader('Set-Cookie', buildSessionCookie(token, { secure: isSecure(req) }));
  res.json({ enabled: true });
}));

// DELETE /api/auth/password — turn auth off. Requires the current password
// so an attacker holding only a session token (without the password) can't
// silently disable the gate.
router.delete('/password', asyncHandler(async (req, res) => {
  const { currentPassword } = validateRequest(clearPasswordSchema, req.body || {});
  await clearPassword({ currentPassword });
  res.setHeader('Set-Cookie', buildClearCookie({ secure: isSecure(req) }));
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
