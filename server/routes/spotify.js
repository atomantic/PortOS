import { Router } from 'express';
import { oauthCallbackQuerySchema } from '../lib/queryValidation.js';
import { z } from 'zod';

import { asyncHandler } from '../lib/errorHandler.js';
import { INVALID_OAUTH_STATE_MESSAGE } from '../lib/oauthState.js';
import { validateRequest } from '../lib/validateRequest.js';
import { requestOriginFrom as requestOrigin } from '../lib/beeperOAuthOrigin.js';
import * as spotifyAuth from '../services/spotifyAuth.js';
import * as spotifySync from '../services/spotifySync.js';
import * as spotifyPlaylists from '../services/spotifyPlaylists.js';
import { requireSyncResult } from './mediaSyncResult.js';

const router = Router();

// OAuth uses the origin the request arrived on (Host + socket scheme), never X-Forwarded-*.

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
  const result = await spotifyPlaylists.syncSpotifyPlaylists();
  // The service returns warnings only after writing the playlist snapshot.
  res.json(result.warnings?.length ? result : requireSyncResult(result, 'SPOTIFY_PLAYLIST_SYNC_FAILED'));
}));

// Save the user-created Spotify developer app credentials (client id/secret).
router.post('/auth/credentials', asyncHandler(async (req, res) => {
  const schema = z.object({
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
  });
  const data = validateRequest(schema, req.body);
  const result = await spotifyAuth.saveCredentials(data, requestRedirectOptions(req));
  res.set('Cache-Control', 'no-store');
  res.json(result);
}));

// Build the Spotify authorize URL (the SPA opens it to start the OAuth flow).
router.post('/auth/url', asyncHandler(async (req, res) => {
  const result = await spotifyAuth.getAuthUrl(requestRedirectOptions(req));
  res.set('Cache-Control', 'no-store');
  res.json(result);
}));

// OAuth redirect target — hit by a BROWSER redirect from Spotify, not the SPA —
// so render every outcome as a redirect to the Brain Spotify tab (which toasts
// the oauthError param) instead of the JSON envelope the middleware would send.
router.get('/oauth/callback', asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const settingsUrl = (error) => (error
    ? `/brain/spotify?oauthError=${encodeURIComponent(error)}`
    : '/brain/spotify?oauthConnected=1');
  const parsed = oauthCallbackQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.redirect(settingsUrl(INVALID_OAUTH_STATE_MESSAGE));
  const { error } = await spotifyAuth.handleCallback(parsed.data)
    .catch((err) => {
      // This catch replaces asyncHandler's logging (the redirect swallows the
      // throw), so keep the failure visible in server logs.
      console.error(`❌ Spotify OAuth callback failed: ${err.message}`);
      return { error: err.message || 'Spotify OAuth callback failed' };
    });
  res.redirect(settingsUrl(error));
}));

// Disconnect — clear stored tokens (leaves the client id/secret in place).
router.post('/auth/clear', asyncHandler(async (req, res) => {
  const result = await spotifyAuth.clearAuth();
  res.json(result);
}));

// Run one incremental sync pass now (explicit user action).
router.post('/sync', asyncHandler(async (req, res) => {
  const result = await spotifySync.runSync();
  res.json(requireSyncResult(result, 'SPOTIFY_SYNC_FAILED'));
}));

export default router;
