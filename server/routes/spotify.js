import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as spotifyAuth from '../services/spotifyAuth.js';
import * as spotifySync from '../services/spotifySync.js';
import * as spotifyPlaylists from '../services/spotifyPlaylists.js';

const router = Router();

// OAuth must use the same public origin the browser used to reach this request.
// Certificate metadata is not guaranteed to be present on every HTTPS install,
// while the request host is authoritative for the current callback round-trip.
function requestOrigin(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http')
    .toString().split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '')
    .toString().split(',')[0].trim();
  return ['http', 'https'].includes(proto) && host ? `${proto}://${host}` : null;
}

function requestRedirectOptions(req) {
  return { origin: requestOrigin(req) };
}

// Status — config (enabled/interval) + machine-local cursor state + OAuth status.
// No API call, so cheap and safe to poll from the settings tab.
router.get('/status', asyncHandler(async (req, res) => {
  const status = await spotifySync.getStatus(requestRedirectOptions(req));
  res.json(status);
}));

// Read the last machine-local playlist snapshot without contacting Spotify.
router.get('/playlists', asyncHandler(async (_req, res) => {
  const snapshot = await spotifyPlaylists.getStoredPlaylists();
  res.json({ snapshot, summary: spotifyPlaylists.playlistSnapshotSummary(snapshot) });
}));

// Explicit user action — fetch current playlists and their track metadata.
router.post('/playlists/sync', asyncHandler(async (_req, res) => {
  res.json(await spotifyPlaylists.syncSpotifyPlaylists());
}));

// Save the user-created Spotify developer app credentials (client id/secret).
router.post('/auth/credentials', asyncHandler(async (req, res) => {
  const schema = z.object({
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
  });
  const data = validateRequest(schema, req.body);
  const result = await spotifyAuth.saveCredentials(data, requestRedirectOptions(req));
  res.json(result);
}));

// Build the Spotify authorize URL (the SPA opens it to start the OAuth flow).
router.get('/auth/url', asyncHandler(async (req, res) => {
  const result = await spotifyAuth.getAuthUrl(requestRedirectOptions(req));
  res.json(result);
}));

// OAuth redirect target — hit by a BROWSER redirect from Spotify, not the SPA —
// so render every outcome as a redirect to the Brain Spotify tab (which toasts
// the oauthError param) instead of the JSON envelope the middleware would send.
router.get('/oauth/callback', asyncHandler(async (req, res) => {
  const settingsUrl = (error) => (error
    ? `/brain/spotify?oauthError=${encodeURIComponent(error)}`
    : '/brain/spotify?oauthConnected=1');
  const { code, error: authError } = req.query;
  if (authError) return res.redirect(settingsUrl(String(authError)));
  if (!code) return res.redirect(settingsUrl('Missing authorization code'));
  const callback = await spotifyAuth.handleCallback(String(code), requestRedirectOptions(req)).then((result) => ({ result }))
    .catch((err) => {
      // This catch replaces asyncHandler's logging (the redirect swallows the
      // throw), so keep the failure visible in server logs.
      console.error(`❌ Spotify OAuth callback failed: ${err.message}`);
      return { error: err.message || 'Spotify OAuth callback failed' };
    });
  if (callback.error) return res.redirect(settingsUrl(callback.error));
  console.log(callback.result?.duplicate
    ? '🎧 Spotify OAuth callback replay ignored; tokens already stored'
    : '🎧 Spotify OAuth callback processed, tokens stored');
  res.redirect(settingsUrl());
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
