import express from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errorHandler.js';
import * as messageAccounts from '../services/messageAccounts.js';
import * as messageSync from '../services/messageSync.js';
import * as messageDrafts from '../services/messageDrafts.js';
import * as messageSender from '../services/messageSender.js';
import { getSelectors, updateSelectors, testSelectors } from '../services/messagePlaywrightSync.js';

const router = express.Router();

// === Validation Schemas ===
const createAccountSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['gmail', 'outlook', 'teams']),
  email: z.string().email().optional().default(''),
  syncConfig: z.object({
    maxAge: z.string().optional(),
    maxMessages: z.number().int().positive().optional(),
    syncInterval: z.number().int().positive().optional()
  }).optional()
});

const updateAccountSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  enabled: z.boolean().optional(),
  syncConfig: z.object({
    maxAge: z.string().optional(),
    maxMessages: z.number().int().positive().optional(),
    syncInterval: z.number().int().positive().optional()
  }).optional()
});

const createDraftSchema = z.object({
  accountId: z.string().uuid(),
  replyToMessageId: z.string().optional(),
  threadId: z.string().optional(),
  to: z.array(z.string()).optional().default([]),
  cc: z.array(z.string()).optional().default([]),
  subject: z.string().optional().default(''),
  body: z.string().optional().default(''),
  generatedBy: z.enum(['ai', 'manual']).optional().default('manual'),
  sendVia: z.enum(['mcp', 'playwright']).optional().default('mcp')
});

const updateDraftSchema = z.object({
  to: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  status: z.enum(['draft', 'pending_review', 'approved']).optional()
});

const generateDraftSchema = z.object({
  accountId: z.string().uuid(),
  replyToMessageId: z.string().optional(),
  threadId: z.string().optional(),
  context: z.string().optional().default(''),
  instructions: z.string().optional().default('')
});

const updateSelectorsSchema = z.object({
  selectors: z.record(z.string())
});

// === Account Routes ===
router.get('/accounts', asyncHandler(async (req, res) => {
  const accounts = await messageAccounts.listAccounts();
  res.json(accounts);
}));

router.post('/accounts', asyncHandler(async (req, res) => {
  const data = createAccountSchema.parse(req.body);
  const account = await messageAccounts.createAccount(data);
  req.app.get('io')?.emit('messages:changed', {});
  res.status(201).json(account);
}));

router.put('/accounts/:id', asyncHandler(async (req, res) => {
  const updates = updateAccountSchema.parse(req.body);
  const account = await messageAccounts.updateAccount(req.params.id, updates);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  req.app.get('io')?.emit('messages:changed', {});
  res.json(account);
}));

router.delete('/accounts/:id', asyncHandler(async (req, res) => {
  const deleted = await messageAccounts.deleteAccount(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Account not found' });
  req.app.get('io')?.emit('messages:changed', {});
  res.status(204).send();
}));

// === Sync Routes ===
router.post('/sync/:accountId', asyncHandler(async (req, res) => {
  const io = req.app.get('io');
  const result = await messageSync.syncAccount(req.params.accountId, io);
  if (result.error) return res.status(404).json({ error: result.error });
  res.json(result);
}));

router.get('/sync/:accountId/status', asyncHandler(async (req, res) => {
  const status = await messageSync.getSyncStatus(req.params.accountId);
  if (!status) return res.status(404).json({ error: 'Account not found' });
  res.json(status);
}));

// === Inbox Routes ===
router.get('/inbox', asyncHandler(async (req, res) => {
  const { accountId, search, limit, offset } = req.query;
  let parsedLimit = limit !== undefined ? parseInt(limit, 10) : 50;
  if (Number.isNaN(parsedLimit) || parsedLimit <= 0) parsedLimit = 50;
  if (parsedLimit > 100) parsedLimit = 100;
  let parsedOffset = offset !== undefined ? parseInt(offset, 10) : 0;
  if (Number.isNaN(parsedOffset) || parsedOffset < 0) parsedOffset = 0;
  const result = await messageSync.getMessages({
    accountId,
    search,
    limit: parsedLimit,
    offset: parsedOffset
  });
  res.json(result);
}));

router.get('/:accountId/:messageId', asyncHandler(async (req, res) => {
  const message = await messageSync.getMessage(req.params.accountId, req.params.messageId);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  res.json(message);
}));

// === Draft Routes ===
router.get('/drafts', asyncHandler(async (req, res) => {
  const { accountId, status } = req.query;
  const drafts = await messageDrafts.listDrafts({ accountId, status });
  res.json(drafts);
}));

router.post('/drafts', asyncHandler(async (req, res) => {
  const data = createDraftSchema.parse(req.body);
  const draft = await messageDrafts.createDraft(data);
  req.app.get('io')?.emit('messages:draft:created', { draftId: draft.id });
  res.status(201).json(draft);
}));

router.post('/drafts/generate', asyncHandler(async (req, res) => {
  const data = generateDraftSchema.parse(req.body);
  const account = await messageAccounts.getAccount(data.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  // AI draft generation - stub for now
  // TODO: Use portos-ai-toolkit for provider selection and model tiers
  const draft = await messageDrafts.createDraft({
    accountId: data.accountId,
    replyToMessageId: data.replyToMessageId,
    threadId: data.threadId,
    subject: '',
    body: `[AI-generated reply placeholder]\n\nContext: ${data.context}\nInstructions: ${data.instructions}`,
    generatedBy: 'ai',
    sendVia: account.provider || (account.type === 'gmail' ? 'mcp' : 'playwright')
  });
  req.app.get('io')?.emit('messages:draft:created', { draftId: draft.id });
  res.status(201).json(draft);
}));

router.put('/drafts/:id', asyncHandler(async (req, res) => {
  const updates = updateDraftSchema.parse(req.body);
  const draft = await messageDrafts.updateDraft(req.params.id, updates);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  res.json(draft);
}));

router.post('/drafts/:id/approve', asyncHandler(async (req, res) => {
  const draft = await messageDrafts.approveDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  res.json(draft);
}));

router.post('/drafts/:id/send', asyncHandler(async (req, res) => {
  const io = req.app.get('io');
  const result = await messageSender.sendDraft(req.params.id, io);
  if (!result.success) {
    const status = result.error?.includes('not found') ? 404 : 400;
    return res.status(status).json({ error: result.error });
  }
  res.json(result);
}));

router.delete('/drafts/:id', asyncHandler(async (req, res) => {
  const deleted = await messageDrafts.deleteDraft(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Draft not found' });
  res.status(204).send();
}));

// === Selector Routes ===
router.get('/selectors', asyncHandler(async (req, res) => {
  const selectors = await getSelectors();
  res.json(selectors);
}));

router.put('/selectors/:provider', asyncHandler(async (req, res) => {
  const { selectors } = updateSelectorsSchema.parse(req.body);
  const updated = await updateSelectors(req.params.provider, selectors);
  res.json(updated);
}));

router.post('/selectors/:provider/test', asyncHandler(async (req, res) => {
  const result = await testSelectors(req.params.provider);
  res.json(result);
}));

export default router;
