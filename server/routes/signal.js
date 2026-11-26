import { Router } from 'express';
import { signalConversationSchema, signalBlocklistSchema, signalBlocklistHandlesSchema, signalListSchema } from '../lib/signalValidation.js';
import * as signalManage from '../services/signalManage.js';

import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
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

router.get('/conversations', asyncHandler(async (req, res) => {
  const options = await validateRequest(signalListSchema, req.query);
  res.json({ conversations: await signalManage.listConversations(options) });
}));
router.post('/purge', asyncHandler(async (req, res) => {
  const body = await validateRequest(signalConversationSchema, req.body);
  res.json(await signalManage.purgeConversation(body.conversationId));
}));
router.post('/blocklist/conversations', asyncHandler(async (req, res) => {
  const body = await validateRequest(signalConversationSchema, req.body);
  res.json(await signalManage.blockConversation(body.conversationId, body));
}));
router.get('/blocklist', asyncHandler(async (req, res) => {
  res.json(await signalManage.readBlocklist());
}));
router.post('/blocklist/handles', asyncHandler(async (req, res) => {
  const { handles, purgeExisting } = await validateRequest(signalBlocklistHandlesSchema, req.body);
  res.json(await signalManage.addBlockedHandles(handles, { purgeExisting }));
}));
router.put('/blocklist', asyncHandler(async (req, res) => {
  const body = await validateRequest(signalBlocklistSchema, req.body);
  res.json(await signalManage.setBlocklist(body));
}));
export default router;
