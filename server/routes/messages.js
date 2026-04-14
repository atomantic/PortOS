import express from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest, parsePagination } from '../lib/validation.js';
import { UUID_RE } from '../lib/fileUtils.js';
import * as messageAccounts from '../services/messageAccounts.js';
import * as messageSync from '../services/messageSync.js';
import * as messageDrafts from '../services/messageDrafts.js';
import * as messageSender from '../services/messageSender.js';
import { getSelectors, updateSelectors, testSelectors, launchProvider } from '../services/messagePlaywrightSync.js';
import { evaluateMessages, generateReplyBody } from '../services/messageEvaluator.js';
import { executeAction } from '../services/messageActions.js';
import { listRules, deleteRule } from '../services/messageTriageRules.js';
import { getToken, getTokenStatus, testApi, clearTokenCache } from '../services/messageTokenExtractor.js';

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
  replyToMessageId: z.string().nullish(),
  threadId: z.string().nullish(),
  to: z.array(z.string()).optional().default([]),
  cc: z.array(z.string()).optional().default([]),
  subject: z.string().optional().default(''),
  body: z.string().optional().default(''),
  generatedBy: z.enum(['ai', 'manual']).optional().default('manual'),
  sendVia: z.enum(['api', 'playwright']).optional()
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
  replyToMessageId: z.string().nullish(),
  threadId: z.string().nullish(),
  context: z.string().optional().default(''),
  instructions: z.string().optional().default(''),
  useVoice: z.boolean().optional()
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
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid account ID format' });
  }
  const updates = validateRequest(updateAccountSchema, req.body);
  const account = await messageAccounts.updateAccount(req.params.id, updates);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  req.app.get('io')?.emit('messages:changed', {});
  res.json(account);
}));

router.delete('/accounts/:id', asyncHandler(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
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
  if (!UUID_RE.test(req.params.accountId)) {
    return res.status(400).json({ error: 'Invalid account ID format' });
  }
  const mode = ['unread', 'full'].includes(req.body?.mode) ? req.body.mode : 'unread';
  const io = req.app.get('io');
  const result = await messageSync.syncAccount(req.params.accountId, io, { mode });
  if (result.error) return res.status(result.status || 404).json({ error: result.error });
  res.json(result);
}));

router.get('/sync/:accountId/status', asyncHandler(async (req, res) => {
  if (!UUID_RE.test(req.params.accountId)) {
    return res.status(400).json({ error: 'Invalid account ID format' });
  }
  const status = await messageSync.getSyncStatus(req.params.accountId);
  if (!status) return res.status(404).json({ error: 'Account not found' });
  res.json(status);
}));

// === Inbox Routes ===
router.get('/inbox', asyncHandler(async (req, res) => {
  const { accountId, search } = req.query;
  if (accountId && !UUID_RE.test(accountId)) {
    return res.status(400).json({ error: 'Invalid accountId format' });
  }
  const { limit: parsedLimit, offset: parsedOffset } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 100 });
  const result = await messageSync.getMessages({
    accountId,
    search,
    limit: parsedLimit,
    offset: parsedOffset
  });
  res.json(result);
}));

// === Triage Rules Routes ===
router.get('/triage-rules', asyncHandler(async (req, res) => {
  const rules = await listRules();
  res.json({ rules });
}));

router.delete('/triage-rules/:index', asyncHandler(async (req, res) => {
  const index = parseInt(req.params.index, 10);
  if (Number.isNaN(index) || index < 0) return res.status(400).json({ error: 'Invalid rule index' });
  const deleted = await deleteRule(index);
  if (!deleted) return res.status(404).json({ error: 'Rule not found' });
  res.status(204).send();
}));

// === Evaluate Route ===
router.post('/evaluate', asyncHandler(async (req, res) => {
  const { accountId, messageIds } = req.body || {};
  // Get messages to evaluate
  let messages;
  if (messageIds && Array.isArray(messageIds)) {
    // Evaluate specific messages
    const allResult = await messageSync.getMessages({ accountId, limit: 100 });
    messages = allResult.messages.filter(m => messageIds.includes(m.id));
  } else {
    // Evaluate all unevaluated messages (up to 20)
    const allResult = await messageSync.getMessages({ accountId, limit: 50 });
    messages = allResult.messages.filter(m => !m.evaluation).slice(0, 20);
  }
  if (!messages.length) return res.json({ evaluations: {} });

  const result = await evaluateMessages(messages);

  // Store evaluations back on cached messages
  await messageSync.updateMessageEvaluations(result.evaluations);

  res.json(result);
}));

// === Draft Routes ===
router.get('/drafts', asyncHandler(async (req, res) => {
  const { accountId, status } = req.query;
  if (accountId && !UUID_RE.test(accountId)) {
    return res.status(400).json({ error: 'Invalid accountId format' });
  }
  const drafts = await messageDrafts.listDrafts({ accountId, status });
  res.json(drafts);
}));

router.post('/drafts', asyncHandler(async (req, res) => {
  const data = validateRequest(createDraftSchema, req.body);
  const account = await messageAccounts.getAccount(data.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const derivedSendVia = account.type === 'gmail' ? 'api' : 'playwright';
  if (data.sendVia && data.sendVia !== derivedSendVia) {
    return res.status(400).json({ error: `sendVia "${data.sendVia}" conflicts with account type "${account.type}" (expected "${derivedSendVia}")` });
  }
  data.sendVia = derivedSendVia;
  const draft = await messageDrafts.createDraft(data);
  req.app.get('io')?.emit('messages:draft:created', { draftId: draft.id });
  res.status(201).json(draft);
}));

router.post('/drafts/generate', asyncHandler(async (req, res) => {
  const data = validateRequest(generateDraftSchema, req.body);
  const account = await messageAccounts.getAccount(data.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  // Fetch the original message to build AI reply
  let replyBody = '';
  if (data.replyToMessageId) {
    const originalMsg = await messageSync.getMessage(data.accountId, data.replyToMessageId);
    if (originalMsg) {
      // Load thread context if available
      let threadMessages = null;
      if (data.threadId) {
        threadMessages = await messageSync.getThread(data.accountId, data.threadId).catch(() => null);
      }
      const aiResult = await generateReplyBody(originalMsg, data.instructions, {
        useVoice: data.useVoice,
        threadMessages
      }).catch(err => {
        console.log(`📧 AI reply generation failed, using placeholder: ${err.message}`);
        return null;
      });
      replyBody = aiResult?.body || `[AI generation failed — configure provider in Messages > Config]\n\nContext: ${data.context}`;
    }
  }
  if (!replyBody) {
    replyBody = `[No original message found]\n\nContext: ${data.context}\nInstructions: ${data.instructions}`;
  }

  const draft = await messageDrafts.createDraft({
    accountId: data.accountId,
    replyToMessageId: data.replyToMessageId,
    threadId: data.threadId,
    subject: '',
    body: replyBody,
    generatedBy: 'ai',
    sendVia: account.type === 'gmail' ? 'api' : 'playwright'
  });
  req.app.get('io')?.emit('messages:draft:created', { draftId: draft.id });
  res.status(201).json(draft);
}));

router.put('/drafts/:id', asyncHandler(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid draft ID format' });
  }
  const updates = validateRequest(updateDraftSchema, req.body);
  const draft = await messageDrafts.updateDraft(req.params.id, updates);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  res.json(draft);
}));

router.post('/drafts/:id/approve', asyncHandler(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid draft ID format' });
  }
  const draft = await messageDrafts.approveDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  res.json(draft);
}));

router.post('/drafts/:id/send', asyncHandler(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid draft ID format' });
  }
  const io = req.app.get('io');
  const result = await messageSender.sendDraft(req.params.id, io);
  if (!result.success) {
    return res.status(result.status || 500).json({ code: result.code, error: result.error });
  }
  res.json(result);
}));

router.delete('/drafts/:id', asyncHandler(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid draft ID format' });
  }
  const deleted = await messageDrafts.deleteDraft(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Draft not found' });
  res.status(204).send();
}));

// === Browser Launch Route ===
router.post('/launch/:accountId', asyncHandler(async (req, res) => {
  if (!UUID_RE.test(req.params.accountId)) {
    return res.status(400).json({ error: 'Invalid account ID format' });
  }
  const account = await messageAccounts.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  if (account.type === 'gmail') return res.status(400).json({ error: 'Gmail uses the Google API, not browser automation' });
  const result = await launchProvider(account.type);
  if (!result.success) return res.status(503).json({ error: result.error });
  res.json(result);
}));

// === Gmail API Enable Route ===
router.post('/gmail/enable-api', asyncHandler(async (req, res) => {
  const { getCredentials } = await import('../services/googleAuth.js');
  const credentials = await getCredentials();

  // Try to detect the project ID from the stored client ID
  const clientId = credentials?.clientId || '';
  const projectMatch = clientId.match(/^(\d+)-/);
  const projectId = projectMatch ? projectMatch[1] : '';
  const projectParam = projectId ? `?project=${projectId}` : '';
  const enableUrl = `https://console.cloud.google.com/apis/library/gmail.googleapis.com${projectParam}`;

  // Try to open in browser
  const { navigateToUrl } = await import('../services/browserService.js');
  const opened = await navigateToUrl(enableUrl).catch(() => null);

  res.json({
    success: !!opened,
    url: enableUrl,
    message: opened
      ? 'Opened Gmail API page in browser. Click "Enable" if not already enabled.'
      : 'Could not open browser. Visit the URL manually to enable the Gmail API.'
  });
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

// === Thread Route ===
router.get('/thread/:accountId/:threadId', asyncHandler(async (req, res) => {
  if (!UUID_RE.test(req.params.accountId)) {
    return res.status(400).json({ error: 'Invalid accountId format' });
  }
  if (!req.params.threadId) return res.status(400).json({ error: 'threadId is required' });
  const messages = await messageSync.getThread(req.params.accountId, req.params.threadId);
  res.json({ messages });
}));

// === Message params schema (shared by detail + refresh routes) ===
const messageParamsSchema = z.object({
  accountId: z.string().uuid(),
  messageId: z.string().min(1)
});

// === Per-message refresh ===
router.post('/:accountId/:messageId/refresh', asyncHandler(async (req, res) => {
  const parsed = messageParamsSchema.safeParse(req.params);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid accountId or messageId format' });
  const { accountId, messageId } = parsed.data;
  const message = await messageSync.getMessage(accountId, messageId);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  const result = await messageSync.refreshMessage(accountId, messageId);
  if (result?.error) {
    const status = result.error === 'no-browser' || result.error === 'auth-required' ? 503 : 502;
    return res.status(status).json({ error: result.message || result.error });
  }
  req.app.get('io')?.emit('messages:changed', {});
  res.json(result);
}));

// === Fetch full content for preview-only messages ===
router.post('/fetch-full/:accountId', asyncHandler(async (req, res) => {
  if (!UUID_RE.test(req.params.accountId)) {
    return res.status(400).json({ error: 'Invalid account ID format' });
  }
  const { accountId } = req.params;
  const account = await messageAccounts.getAccount(accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  if (account.type !== 'outlook') return res.json({ updated: 0, total: 0 });

  const force = req.body?.force === true;
  const allResult = await messageSync.getMessages({ accountId, limit: 1000 });
  const toRefresh = force ? allResult.messages : allResult.messages.filter(m => m.bodyFull === false);
  let updated = 0;

  for (const msg of toRefresh) {
    const result = await messageSync.refreshMessage(accountId, msg.id);
    if (result) updated++;
  }

  if (updated > 0) req.app.get('io')?.emit('messages:changed', {});
  res.json({ updated, total: toRefresh.length });
}));

// === Clear account cache ===
router.post('/accounts/:id/cache/clear', asyncHandler(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid account ID format' });
  }
  await messageSync.deleteCache(req.params.id);
  req.app.get('io')?.emit('messages:changed', {});
  res.status(204).send();
}));

// === Message Action Route (archive/delete) ===
router.post('/:accountId/:messageId/action', asyncHandler(async (req, res) => {
  const parsed = messageParamsSchema.safeParse(req.params);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid accountId or messageId format' });
  const { accountId, messageId } = parsed.data;
  const action = req.body?.action;
  if (!['archive', 'delete'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action — must be "archive" or "delete"' });
  }
  const result = await executeAction(accountId, messageId, action);
  req.app.get('io')?.emit('messages:changed', {});
  res.json(result);
}));

// === Debug: Token Extraction & API Testing ===
const ALLOWED_TOKEN_PROVIDERS = ['outlook', 'teams'];

router.get('/debug/token-status', asyncHandler(async (req, res) => {
  const statuses = ALLOWED_TOKEN_PROVIDERS.map(p => getTokenStatus(p));
  res.json({ providers: statuses });
}));

router.post('/debug/test-token', asyncHandler(async (req, res) => {
  const provider = ALLOWED_TOKEN_PROVIDERS.includes(req.body?.provider) ? req.body.provider : 'outlook';
  const tokenResult = await getToken(provider);
  if (tokenResult.error) return res.status(503).json(tokenResult);

  const decoded = tokenResult.decoded || {};
  const tokenInfo = {
    provider,
    fresh: tokenResult.fresh,
    length: tokenResult.token.length,
    expires: decoded.exp ? new Date(decoded.exp * 1000).toISOString() : 'unknown',
    audience: decoded.aud || 'unknown',
    scopes: decoded.scp || decoded.roles || 'unknown'
  };

  const apiResult = await testApi(provider, tokenResult.token, parseInt(req.query?.top, 10) || 5);

  res.json({ token: tokenInfo, api: apiResult });
}));

router.post('/debug/clear-token', asyncHandler(async (req, res) => {
  const provider = ALLOWED_TOKEN_PROVIDERS.includes(req.body?.provider) ? req.body.provider : null;
  clearTokenCache(provider);
  res.json({ cleared: true, provider: provider || 'all' });
}));

// === Message Detail Route (last to avoid capturing /launch, /selectors paths) ===

router.get('/:accountId/:messageId', asyncHandler(async (req, res) => {
  const parsed = messageParamsSchema.safeParse(req.params);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid accountId or messageId format' });
  const message = await messageSync.getMessage(parsed.data.accountId, parsed.data.messageId);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  res.json(message);
}));

export default router;
