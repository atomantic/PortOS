import { Router } from 'express';

import { asyncHandler } from '../lib/errorHandler.js';
import * as imessageSync from '../services/imessageSync.js';

const router = Router();

// Setup check — attempt a read-only open of chat.db and report an actionable
// Full Disk Access error when blocked. Never throws (checkSetup returns a report),
// so a denied macOS TCC prompt surfaces as a clean JSON error the UI can render.
router.get('/setup-check', asyncHandler(async (req, res) => {
  const report = await imessageSync.checkSetup();
  res.json(report);
}));

// Status — current config (enabled/interval) + machine-local cursor state. No
// chat.db open, so this is cheap and safe to poll from the settings tab.
router.get('/status', asyncHandler(async (req, res) => {
  const status = await imessageSync.getStatus();
  res.json(status);
}));

// Run one incremental sync pass now (explicit user action). Returns the pass
// summary, or a Full-Disk-Access error report when chat.db can't be opened.
router.post('/sync', asyncHandler(async (req, res) => {
  const result = await imessageSync.runSync();
  res.json(result);
}));

export default router;
