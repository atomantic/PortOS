import { Router } from 'express';
import { z } from 'zod';
import * as signalManage from '../services/signalManage.js';

import { asyncHandler } from '../lib/errorHandler.js';
import * as signalSync from '../services/signalSync.js';

const router = Router();

// The shared validation module re-exports every domain's schemas; load it when a
// conversation handler runs so importing this route does not evaluate them all.
const validateRequest = async (schema, data) => (await import('../lib/validation.js')).validateRequest(schema, data);

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

const listSchema = z.object({ q: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(2000).optional() });
router.get('/conversations', asyncHandler(async (req, res) => {
  const options = await validateRequest(listSchema, req.query);
  res.json({ conversations: await signalManage.listConversations(options) });
}));
const conversationSchema = z.object({ conversationId: z.string().trim().min(1).max(1000), purgeExisting: z.boolean().optional() });
router.post('/purge', asyncHandler(async (req, res) => {
  const body = await validateRequest(conversationSchema, req.body);
  res.json(await signalManage.purgeConversation(body.conversationId));
}));
router.post('/blocklist/conversations', asyncHandler(async (req, res) => {
  const body = await validateRequest(conversationSchema, req.body);
  res.json(await signalManage.blockConversation(body.conversationId, body));
}));
router.get('/blocklist', asyncHandler(async (req, res) => {
  res.json(await signalManage.readBlocklist());
}));
const blocklistSchema = z.object({
  handles: z.array(z.string().trim().min(1).max(200)).max(5000),
  conversationIds: z.array(z.string().trim().min(1).max(1000)).max(5000),
});
router.put('/blocklist', asyncHandler(async (req, res) => {
  const body = await validateRequest(blocklistSchema, req.body);
  res.json(await signalManage.setBlocklist(body));
}));
export default router;
