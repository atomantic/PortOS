import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as imessageSync from '../services/imessageSync.js';
import * as imessageManage from '../services/imessageManage.js';

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

// ---------------------------------------------------------------------------
// Manager surface (#2413) — browse / purge / blocklist. PortOS-side only;
// never opens chat.db writable.
// ---------------------------------------------------------------------------

const listConversationsQuerySchema = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});

router.get('/conversations', asyncHandler(async (req, res) => {
  const q = validateRequest(listConversationsQuerySchema, req.query);
  const conversations = await imessageManage.listConversations(q);
  res.json({ conversations });
}));

const eventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(2000).optional(),
  before: z.string().datetime().optional(),
});

router.get('/conversations/:chatKey/events', asyncHandler(async (req, res) => {
  const chatKey = String(req.params.chatKey || '');
  if (!chatKey) throw new ServerError('chatKey is required', { status: 400, code: 'BAD_REQUEST' });
  const q = validateRequest(eventsQuerySchema, req.query);
  const payload = await imessageManage.listConversationEvents(chatKey, q);
  if (payload.chatGuid == null) {
    throw new ServerError('Invalid chat key', { status: 400, code: 'BAD_REQUEST' });
  }
  res.json(payload);
}));

router.delete('/conversations/:chatKey', asyncHandler(async (req, res) => {
  const chatKey = String(req.params.chatKey || '');
  if (!chatKey) throw new ServerError('chatKey is required', { status: 400, code: 'BAD_REQUEST' });
  const result = await imessageManage.purgeConversation(chatKey);
  if (result.chatGuid == null) {
    throw new ServerError('Invalid chat key', { status: 400, code: 'BAD_REQUEST' });
  }
  res.json(result);
}));

router.delete('/events/:id', asyncHandler(async (req, res) => {
  const id = String(req.params.id || '');
  if (!id) throw new ServerError('id is required', { status: 400, code: 'BAD_REQUEST' });
  const result = await imessageManage.deleteEvent(id);
  res.json(result);
}));

router.get('/blocklist', asyncHandler(async (req, res) => {
  const list = await imessageManage.readBlocklist();
  res.json(list);
}));

const blocklistPutSchema = z.object({
  handles: z.array(z.string().min(1).max(200)).max(5000),
});

router.put('/blocklist', asyncHandler(async (req, res) => {
  const body = validateRequest(blocklistPutSchema, req.body);
  const saved = await imessageManage.setBlocklist(body.handles);
  res.json(saved);
}));

const blocklistAddSchema = z.object({
  handles: z.union([z.string().min(1).max(200), z.array(z.string().min(1).max(200)).min(1).max(100)]),
  purgeExisting: z.boolean().optional().default(false),
});

router.post('/blocklist', asyncHandler(async (req, res) => {
  const body = validateRequest(blocklistAddSchema, req.body);
  const handles = Array.isArray(body.handles) ? body.handles : [body.handles];
  const result = await imessageManage.addToBlocklist(handles, { purgeExisting: body.purgeExisting });
  res.json(result);
}));

router.delete('/blocklist/:handle', asyncHandler(async (req, res) => {
  // Handles are E.164 / emails — may contain `+` which Express already decodes.
  const handle = decodeURIComponent(String(req.params.handle || ''));
  if (!handle) throw new ServerError('handle is required', { status: 400, code: 'BAD_REQUEST' });
  const result = await imessageManage.removeFromBlocklist(handle);
  res.json(result);
}));

router.get('/stats', asyncHandler(async (req, res) => {
  const stats = await imessageManage.getStats();
  res.json(stats);
}));

export default router;
