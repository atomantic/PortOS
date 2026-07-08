import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as spotifyAuth from '../services/spotifyAuth.js';
import * as spotifySync from '../services/spotifySync.js';

const router = Router();

// Status — config (enabled/interval) + machine-local cursor state + OAuth status.
// No API call, so cheap and safe to poll from the settings tab.
router.get('/status', asyncHandler(async (req, res) => {
  const status = await spotifySync.getStatus();
  res.json(status);
}));

// Save the user-created Spotify developer app credentials (client id/secret).
router.post('/auth/credentials', asyncHandler(async (req, res) => {
  const schema = z.object({
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
  });
  const data = validateRequest(schema, req.body);
  const result = await spotifyAuth.saveCredentials(data);
  res.json(result);
}));

// Build the Spotify authorize URL (the SPA opens it to start the OAuth flow).
router.get('/auth/url', asyncHandler(async (req, res) => {
  const result = await spotifyAuth.getAuthUrl();
  res.json(result);
}));

// OAuth redirect target — hit by a BROWSER redirect from Spotify, not the SPA —
// so render every outcome as a redirect to the settings tab (which toasts the
// oauthError param) instead of the JSON envelope the middleware would send.
router.get('/oauth/callback', asyncHandler(async (req, res) => {
  const settingsUrl = (error) => (error
    ? `/settings/spotify?oauthError=${encodeURIComponent(error)}`
    : '/settings/spotify?oauthConnected=1');
  const { code, error: authError } = req.query;
  if (authError) return res.redirect(settingsUrl(String(authError)));
  if (!code) return res.redirect(settingsUrl('Missing authorization code'));
  const error = await spotifyAuth.handleCallback(String(code)).then(() => null)
    .catch((err) => {
      // This catch replaces asyncHandler's logging (the redirect swallows the
      // throw), so keep the failure visible in server logs.
      console.error(`❌ Spotify OAuth callback failed: ${err.message}`);
      return err.message || 'Spotify OAuth callback failed';
    });
  res.redirect(settingsUrl(error));
}));

// Disconnect — clear stored tokens (leaves the client id/secret in place).
router.post('/auth/clear', asyncHandler(async (req, res) => {
  const result = await spotifyAuth.clearAuth();
  res.json(result);
}));

// Run one incremental sync pass now (explicit user action). Returns the pass
// summary, or a needsAuth report when Spotify isn't connected.
router.post('/sync', asyncHandler(async (req, res) => {
  const result = await spotifySync.runSync();
  res.json(result);
}));

export default router;
