import { Router } from 'express';

import { asyncHandler } from '../lib/errorHandler.js';
import * as youtubeSync from '../services/youtubeSync.js';
import * as youtubePlaylists from '../services/youtubePlaylists.js';

const router = Router();

// Setup check — is the managed browser running and signed into YouTube? Never
// throws (checkSetup returns a report), so a signed-out profile surfaces as a
// clean JSON status the settings UI can render with a "log into YouTube" action.
router.get('/setup-check', asyncHandler(async (req, res) => {
  const report = await youtubeSync.checkSetup();
  res.json(report);
}));

// Status — current config (enabled/interval) + machine-local last-run state. No
// scrape, so this is cheap and safe to poll from the settings tab.
router.get('/status', asyncHandler(async (req, res) => {
  const status = await youtubeSync.getStatus();
  res.json(status);
}));

// Read the last machine-local playlist/video snapshot without opening the
// managed browser.
router.get('/playlists', asyncHandler(async (_req, res) => {
  const snapshot = await youtubePlaylists.getStoredYoutubePlaylists();
  res.json({ snapshot, summary: youtubePlaylists.youtubePlaylistSnapshotSummary(snapshot) });
}));

// Explicit user action — scrape playlists and their video rows in the managed
// browser. Downloading a video remains a separate, explicit downloader action.
router.post('/playlists/sync', asyncHandler(async (_req, res) => {
  res.json(await youtubePlaylists.syncYoutubePlaylists());
}));

// Run one scrape pass now (explicit user action). Returns the pass summary, or a
// status report when the browser isn't running / is signed out.
router.post('/sync', asyncHandler(async (req, res) => {
  const result = await youtubeSync.runSync();
  res.json(result);
}));

export default router;
