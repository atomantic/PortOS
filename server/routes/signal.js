import { Router } from 'express';

import { asyncHandler } from '../lib/errorHandler.js';
import * as signalSync from '../services/signalSync.js';

const router = Router();

// Setup check — resolve the DB key, decrypt a snapshot, and probe the schema.
// Reports an actionable error (missing install, key failure, unsupported schema)
// when blocked. Never throws (checkSetup returns a report), so a keychain denial
// or an unsupported Signal version surfaces as a clean JSON error the UI renders.
router.get('/setup-check', asyncHandler(async (req, res) => {
  const report = await signalSync.checkSetup();
  res.json(report);
}));

// Status — current config (enabled/interval) + machine-local cursor state. No DB
// open / key read, so this is cheap and safe to poll from the settings tab.
router.get('/status', asyncHandler(async (req, res) => {
  const status = await signalSync.getStatus();
  res.json(status);
}));

// Run one incremental sync pass now (explicit user action). Returns the pass
// summary, or an actionable error report when the key/DB can't be read.
router.post('/sync', asyncHandler(async (req, res) => {
  const result = await signalSync.runSync();
  res.json(result);
}));

export default router;
