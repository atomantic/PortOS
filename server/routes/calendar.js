import express from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as calendarAccounts from '../services/calendarAccounts.js';
import * as calendarSync from '../services/calendarSync.js';
import * as calendarGoogleSync from '../services/calendarGoogleSync.js';
import * as dailyReview from '../services/dailyReview.js';
import * as googleAuth from '../services/googleAuth.js';
import * as calendarGoogleApiSync from '../services/calendarGoogleApiSync.js';
import * as googleOAuthAutoConfig from '../services/googleOAuthAutoConfig.js';
import { getToken, getTokenStatus, clearTokenCache } from '../services/messageTokenExtractor.js';

const router = express.Router();

// === Validation Schemas ===
const createAccountSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['outlook-calendar', 'google-calendar']),
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
  }).optional(),
  syncMethod: z.enum(['claude-mcp', 'google-api']).optional()
});

const subcalendarSchema = z.object({
  calendarId: z.string().min(1),
  name: z.string().min(1),
  color: z.string().optional().default(''),
  enabled: z.boolean().optional().default(true),
  dormant: z.boolean().optional().default(false),
  goalIds: z.array(z.string()).optional().default([]),
  addedAt: z.string().optional()
});

const updateSubcalendarsSchema = z.object({
  subcalendars: z.array(subcalendarSchema)
});

const pushSyncSchema = z.object({
  calendarId: z.string().min(1),
  calendarName: z.string().min(1),
  events: z.array(z.object({
    id: z.string().optional(),
    summary: z.string().optional().default(''),
    start: z.object({
      dateTime: z.string().optional(),
      date: z.string().optional()
    }).optional(),
    end: z.object({
      dateTime: z.string().optional(),
      date: z.string().optional()
    }).optional(),
    location: z.string().optional().default(''),
    description: z.string().optional().default(''),
    status: z.string().optional().default('confirmed'),
    htmlLink: z.string().optional()
  }))
});

const confirmEventSchema = z.object({
  eventId: z.string().min(1),
  happened: z.boolean(),
  goalId: z.string().optional(),
  durationMinutes: z.number().int().min(1).max(1440).optional(),
  note: z.string().max(1000).optional()
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

// === Subcalendar Routes ===
router.get('/accounts/:id/subcalendars', asyncHandler(async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    throw new ServerError('Invalid account ID format', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const account = await calendarAccounts.getAccount(req.params.id);
  if (!account) throw new ServerError('Account not found', { status: 404, code: 'NOT_FOUND' });
  res.json(account.subcalendars || []);
}));

router.put('/accounts/:id/subcalendars', asyncHandler(async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    throw new ServerError('Invalid account ID format', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const { subcalendars } = validateRequest(updateSubcalendarsSchema, req.body);
  const account = await calendarAccounts.updateSubcalendars(req.params.id, subcalendars);
  if (!account) throw new ServerError('Account not found', { status: 404, code: 'NOT_FOUND' });
  req.app.get('io')?.emit('calendar:changed', {});
  res.json(account);
}));

// === Push Sync Route ===
router.post('/sync/:accountId/push', asyncHandler(async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.accountId).success) {
    throw new ServerError('Invalid account ID format', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const data = validateRequest(pushSyncSchema, req.body);
  const io = req.app.get('io');
  const result = await calendarGoogleSync.pushSyncEvents(req.params.accountId, data.calendarId, data.calendarName, data.events, io);
  res.json(result);
}));

// === MCP Discover Calendars Route ===
router.post('/sync/:accountId/discover', asyncHandler(async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.accountId).success) {
    throw new ServerError('Invalid account ID format', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const io = req.app.get('io');
  const result = await calendarGoogleSync.mcpDiscoverCalendars(req.params.accountId, io);
  if (result.error) return res.status(result.status || 500).json({ error: result.error });
  req.app.get('io')?.emit('calendar:changed', {});
  res.json(result);
}));

// === MCP Sync Route ===
router.post('/sync/:accountId/google', asyncHandler(async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.accountId).success) {
    throw new ServerError('Invalid account ID format', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const io = req.app.get('io');
  const result = await calendarGoogleSync.mcpSyncAccount(req.params.accountId, io);
  if (result.error) return res.status(result.status || 500).json({ error: result.error });
  res.json(result);
}));

// === Google OAuth Routes ===
router.get('/google/auth/status', asyncHandler(async (req, res) => {
  const status = await googleAuth.getAuthStatus();
  res.json(status);
}));

router.post('/google/auth/credentials', asyncHandler(async (req, res) => {
  const schema = z.object({
    clientId: z.string().min(1),
    clientSecret: z.string().min(1)
  });
  const data = validateRequest(schema, req.body);
  const result = await googleAuth.saveCredentials(data);
  res.json(result);
}));

router.get('/google/auth/url', asyncHandler(async (req, res) => {
  const result = await googleAuth.getAuthUrl();
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
}));

router.get('/google/oauth/callback', asyncHandler(async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing authorization code');
  const result = await googleAuth.handleCallback(code);
  if (result.error) return res.status(500).send(result.error);
  // Redirect to calendar config page after successful auth
  res.redirect('/calendar/config');
}));

router.post('/google/auth/clear', asyncHandler(async (req, res) => {
  await googleAuth.clearAuth();
  res.json({ cleared: true });
}));

// === Google OAuth Auto-Configure via CDP Browser ===
router.post('/google/auto-configure/start', asyncHandler(async (req, res) => {
  const io = req.app.get('io');
  const result = await googleOAuthAutoConfig.startAutoConfig(io);
  if (result.error) return res.status(result.status || 500).json({ error: result.error });
  res.json(result);
}));

router.post('/google/auto-configure/navigate', asyncHandler(async (req, res) => {
  const { step } = req.body;
  if (!step) throw new ServerError('Step is required', { status: 400, code: 'VALIDATION_ERROR' });
  const io = req.app.get('io');
  const result = await googleOAuthAutoConfig.navigateToStep(step, io);
  if (result.error) return res.status(result.status || 500).json({ error: result.error });
  res.json(result);
}));

router.post('/google/auto-configure/capture', asyncHandler(async (req, res) => {
  const io = req.app.get('io');
  const result = await googleOAuthAutoConfig.captureCredentials(io);
  if (result.error) return res.status(result.status || 500).json({ error: result.error });
  res.json(result);
}));

router.post('/google/auto-configure/run', asyncHandler(async (req, res) => {
  const io = req.app.get('io');
  const email = req.body?.email || '';
  const result = await googleOAuthAutoConfig.runAutomatedSetup(email, io);
  if (result.status === 'error') return res.status(500).json(result);
  res.json(result);
}));

// === Google API Sync Routes ===
router.post('/sync/:accountId/api', asyncHandler(async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.accountId).success) {
    throw new ServerError('Invalid account ID format', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const io = req.app.get('io');
  const result = await calendarGoogleApiSync.apiSyncAccount(req.params.accountId, io);
  if (result.error) return res.status(result.status || 500).json({ error: result.error });
  res.json(result);
}));

router.post('/sync/:accountId/discover-api', asyncHandler(async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.accountId).success) {
    throw new ServerError('Invalid account ID format', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const result = await calendarGoogleApiSync.apiDiscoverCalendars(req.params.accountId);
  if (result.error) return res.status(result.status || 500).json({ error: result.error });
  req.app.get('io')?.emit('calendar:changed', {});
  res.json(result);
}));

// === Daily Review Routes ===
// NOTE: /review/history must come before /review/:date so Express doesn't match "history" as a date param
router.get('/review/history', asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.query;
  const history = await dailyReview.getDailyReviewHistory(startDate, endDate);
  res.json(history);
}));

router.get('/review/:date', asyncHandler(async (req, res) => {
  const dateStr = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new ServerError('Invalid date format, use YYYY-MM-DD', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const review = await dailyReview.getDailyReview(dateStr);
  res.json(review);
}));

router.post('/review/:date/confirm', asyncHandler(async (req, res) => {
  const dateStr = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new ServerError('Invalid date format, use YYYY-MM-DD', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const data = validateRequest(confirmEventSchema, req.body);
  const result = await dailyReview.confirmEvent(dateStr, data);
  res.json(result);
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
