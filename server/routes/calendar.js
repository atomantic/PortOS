import express from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as calendarAccounts from '../services/calendarAccounts.js';
import * as calendarSync from '../services/calendarSync.js';
import { getToken, getTokenStatus, clearTokenCache } from '../services/messageTokenExtractor.js';

const router = express.Router();

// === Validation Schemas ===
const createAccountSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['outlook-calendar']),
  email: z.union([z.string().email(), z.literal('')]).optional().default(''),
  syncConfig: z.object({
    maxAge: z.string().optional(),
    syncInterval: z.number().int().positive().optional(),
    calendarIds: z.array(z.string()).optional()
  }).optional()
});

const updateAccountSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.union([z.string().email(), z.literal('')]).optional(),
  enabled: z.boolean().optional(),
  syncConfig: z.object({
    maxAge: z.string().optional(),
    syncInterval: z.number().int().positive().optional(),
    calendarIds: z.array(z.string()).optional()
  }).optional()
});

// === Account Routes ===
router.get('/accounts', asyncHandler(async (req, res) => {
  const accounts = await calendarAccounts.listAccounts();
  res.json(accounts);
}));

router.post('/accounts', asyncHandler(async (req, res) => {
  const data = validateRequest(createAccountSchema, req.body);
  const account = await calendarAccounts.createAccount(data);
  req.app.get('io')?.emit('calendar:changed', {});
  res.status(201).json(account);
}));

router.put('/accounts/:id', asyncHandler(async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    throw new ServerError('Invalid account ID format', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const updates = validateRequest(updateAccountSchema, req.body);
  const account = await calendarAccounts.updateAccount(req.params.id, updates);
  if (!account) throw new ServerError('Account not found', { status: 404, code: 'NOT_FOUND' });
  req.app.get('io')?.emit('calendar:changed', {});
  res.json(account);
}));

router.delete('/accounts/:id', asyncHandler(async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    throw new ServerError('Invalid account ID format', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const deleted = await calendarAccounts.deleteAccount(req.params.id);
  if (!deleted) throw new ServerError('Account not found', { status: 404, code: 'NOT_FOUND' });
  await calendarSync.deleteCache(req.params.id).catch(() => {});
  req.app.get('io')?.emit('calendar:changed', {});
  res.status(204).send();
}));

// === Sync Routes ===
router.post('/sync/:accountId', asyncHandler(async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.accountId).success) {
    throw new ServerError('Invalid account ID format', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const io = req.app.get('io');
  const result = await calendarSync.syncAccount(req.params.accountId, io);
  if (result.error) return res.status(result.status || 404).json({ error: result.error });
  res.json(result);
}));

router.get('/sync/:accountId/status', asyncHandler(async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.accountId).success) {
    throw new ServerError('Invalid account ID format', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const status = await calendarSync.getSyncStatus(req.params.accountId);
  if (!status) return res.status(404).json({ error: 'Account not found' });
  res.json(status);
}));

// === Event Routes ===
router.get('/events', asyncHandler(async (req, res) => {
  const { accountId, search, startDate, endDate, limit, offset } = req.query;
  if (accountId && !z.string().uuid().safeParse(accountId).success) {
    return res.status(400).json({ error: 'Invalid accountId format' });
  }
  let parsedLimit = limit !== undefined ? parseInt(limit, 10) : 50;
  if (Number.isNaN(parsedLimit) || parsedLimit <= 0) parsedLimit = 50;
  if (parsedLimit > 200) parsedLimit = 200;
  let parsedOffset = offset !== undefined ? parseInt(offset, 10) : 0;
  if (Number.isNaN(parsedOffset) || parsedOffset < 0) parsedOffset = 0;
  const result = await calendarSync.getEvents({
    accountId,
    search,
    startDate,
    endDate,
    limit: parsedLimit,
    offset: parsedOffset
  });
  res.json(result);
}));

router.get('/events/:accountId/:eventId', asyncHandler(async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.accountId).success) {
    return res.status(400).json({ error: 'Invalid accountId format' });
  }
  const event = await calendarSync.getEvent(req.params.accountId, req.params.eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  res.json(event);
}));

// === Debug: Token Status (reuse message token extractor) ===
router.get('/debug/token-status', asyncHandler(async (req, res) => {
  const statuses = ['outlook'].map(p => getTokenStatus(p));
  res.json({ providers: statuses });
}));

router.post('/debug/test-token', asyncHandler(async (req, res) => {
  const provider = 'outlook';
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

  res.json({ token: tokenInfo });
}));

router.post('/debug/clear-token', asyncHandler(async (req, res) => {
  clearTokenCache('outlook');
  res.json({ cleared: true, provider: 'outlook' });
}));

export default router;
