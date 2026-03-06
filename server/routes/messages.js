import express from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as messageAccounts from '../services/messageAccounts.js';
import * as messageSync from '../services/messageSync.js';
import * as messageDrafts from '../services/messageDrafts.js';
import * as messageSender from '../services/messageSender.js';
import { getSelectors, updateSelectors, testSelectors, launchProvider } from '../services/messagePlaywrightSync.js';

const router = express.Router();

// === Validation Schemas ===
const createAccountSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['gmail', 'outlook', 'teams']),
  email: z.union([z.string().email(), z.literal('')]).optional().default(''),
  syncConfig: z.object({
    maxAge: z.string().optional(),
    maxMessages: z.number().int().positive().optional(),
    syncInterval: z.number().int().positive().optional()
  }).optional()
});

const updateAccountSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.union([z.string().email(), z.literal('')]).optional(),
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
  sendVia: z.enum(['mcp', 'playwright']).optional()
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
  const data = validateRequest(createAccountSchema, req.body);
  const account = await messageAccounts.createAccount(data);
  req.app.get('io')?.emit('messages:changed', {});
  res.status(201).json(account);
}));

router.put('/accounts/:id', asyncHandler(async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    return res.status(400).json({ error: 'Invalid account ID format' });
  }
  const updates = validateRequest(updateAccountSchema, req.body);
  const account = await messageAccounts.updateAccount(req.params.id, updates);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  req.app.get('io')?.emit('messages:changed', {});
  res.json(account);
}));

router.delete('/accounts/:id', asyncHandler(async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    return res.status(400).json({ error: 'Invalid account ID format' });
  }
  const deleted = await messageAccounts.deleteAccount(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Account not found' });
  // Clean up related data
  await messageSync.deleteCache(req.params.id).catch(() => {});
  await messageDrafts.deleteDraftsByAccountId(req.params.id).catch(() => {});
  req.app.get('io')?.emit('messages:changed', {});
  res.status(204).send();
}));

// === Sync Routes ===
router.post('/sync/:accountId', asyncHandler(async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.accountId).success) {
    return res.status(400).json({ error: 'Invalid account ID format' });
  }
  const io = req.app.get('io');
  const result = await messageSync.syncAccount(req.params.accountId, io);
  if (result.error) return res.status(404).json({ error: result.error });
  res.json(result);
}));

router.get('/sync/:accountId/status', asyncHandler(async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.accountId).success) {
    return res.status(400).json({ error: 'Invalid account ID format' });
  }
  const status = await messageSync.getSyncStatus(req.params.accountId);
  if (!status) return res.status(404).json({ error: 'Account not found' });
  res.json(status);
}));

// === Inbox Routes ===
router.get('/inbox', asyncHandler(async (req, res) => {
  const { accountId, search, limit, offset } = req.query;
  if (accountId && !z.string().uuid().safeParse(accountId).success) {
    return res.status(400).json({ error: 'Invalid accountId format' });
  }
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

// === Draft Routes ===
router.get('/drafts', asyncHandler(async (req, res) => {
  const { accountId, status } = req.query;
  const drafts = await messageDrafts.listDrafts({ accountId, status });
  res.json(drafts);
}));

router.post('/drafts', asyncHandler(async (req, res) => {
  const data = validateRequest(createDraftSchema, req.body);
  const account = await messageAccounts.getAccount(data.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  if (!data.sendVia) {
    data.sendVia = account.provider || (account.type === 'gmail' ? 'mcp' : 'playwright');
  }
  const draft = await messageDrafts.createDraft(data);
  req.app.get('io')?.emit('messages:draft:created', { draftId: draft.id });
  res.status(201).json(draft);
}));

router.post('/drafts/generate', asyncHandler(async (req, res) => {
  const data = validateRequest(generateDraftSchema, req.body);
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
  if (!z.string().uuid().safeParse(req.params.id).success) {
    return res.status(400).json({ error: 'Invalid draft ID format' });
  }
  const updates = validateRequest(updateDraftSchema, req.body);
  const draft = await messageDrafts.updateDraft(req.params.id, updates);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  res.json(draft);
}));

router.post('/drafts/:id/approve', asyncHandler(async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    return res.status(400).json({ error: 'Invalid draft ID format' });
  }
  const draft = await messageDrafts.approveDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  res.json(draft);
}));

router.post('/drafts/:id/send', asyncHandler(async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    return res.status(400).json({ error: 'Invalid draft ID format' });
  }
  const io = req.app.get('io');
  const result = await messageSender.sendDraft(req.params.id, io);
  if (!result.success) {
    const status = result.error?.includes('not found') ? 404 : 400;
    return res.status(status).json({ error: result.error });
  }
  res.json(result);
}));

router.delete('/drafts/:id', asyncHandler(async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    return res.status(400).json({ error: 'Invalid draft ID format' });
  }
  const deleted = await messageDrafts.deleteDraft(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Draft not found' });
  res.status(204).send();
}));

// === Message Detail Route (after drafts to avoid route collision) ===
const messageParamsSchema = z.object({
  accountId: z.string().uuid(),
  messageId: z.string().min(1)
});

router.get('/:accountId/:messageId', asyncHandler(async (req, res) => {
  const parsed = messageParamsSchema.safeParse(req.params);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid accountId or messageId format' });
  const message = await messageSync.getMessage(parsed.data.accountId, parsed.data.messageId);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  res.json(message);
}));

// === Browser Launch Route ===
router.post('/launch/:accountId', asyncHandler(async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.accountId).success) {
    return res.status(400).json({ error: 'Invalid account ID format' });
  }
  const account = await messageAccounts.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  if (account.type === 'gmail') return res.status(400).json({ error: 'Gmail uses MCP, not browser automation' });
  const result = await launchProvider(account.type);
  if (!result.success) return res.status(503).json({ error: result.error });
  res.json(result);
}));

// === Selector Routes ===
router.get('/selectors', asyncHandler(async (req, res) => {
  const selectors = await getSelectors();
  res.json(selectors);
}));

const ALLOWED_PROVIDERS = ['outlook', 'teams'];

router.put('/selectors/:provider', asyncHandler(async (req, res) => {
  if (!ALLOWED_PROVIDERS.includes(req.params.provider)) {
    return res.status(400).json({ error: 'Invalid provider' });
  }
  const { selectors } = validateRequest(updateSelectorsSchema, req.body);
  const updated = await updateSelectors(req.params.provider, selectors);
  res.json(updated);
}));

router.post('/selectors/:provider/test', asyncHandler(async (req, res) => {
  if (!ALLOWED_PROVIDERS.includes(req.params.provider)) {
    return res.status(400).json({ error: 'Invalid provider' });
  }
  const result = await testSelectors(req.params.provider);
  res.json(result);
}));

export default router;
