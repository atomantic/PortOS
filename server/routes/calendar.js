import { emitToOperatorsOn } from '../services/socketIo.js';
import express from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { limitQuerySchema, oauthCallbackQuerySchema, parsePagination } from '../lib/queryValidation.js';
import { INVALID_OAUTH_STATE_MESSAGE } from '../lib/oauthState.js';
import { UUID_RE } from '../lib/fileUtils.js';
import * as calendarAccounts from '../services/calendarAccounts.js';
import * as calendarSync from '../services/calendarSync.js';
import * as calendarGoogleSync from '../services/calendarGoogleSync.js';
import * as dailyReview from '../services/dailyReview.js';
import * as googleAuth from '../services/googleAuth.js';
import * as calendarGoogleApiSync from '../services/calendarGoogleApiSync.js';
import * as googleOAuthAutoConfig from '../services/googleOAuthAutoConfig.js';
import { getToken, getTokenStatus, clearTokenCache } from '../services/messageTokenExtractor.js';
import { getUserTimezone } from '../services/userTimezone.js';
import { localDayWindowUtc } from '../lib/timezone.js';
import {
  calendarAutoConfigureBodySchema,
  dailyReviewQuerySchema,
  createAccountSchema,
  updateAccountSchema,
  updateSubcalendarsSchema,
  confirmEventSchema,
  eventsQuerySchema,
  googleCalendarCredentialsSchema,
  googleCalendarAuthUrlQuerySchema,
} from '../lib/calendarValidation.js';

const router = express.Router();

// === Account Routes ===
router.get('/accounts', asyncHandler(async (req, res) => {
  const accounts = await calendarAccounts.listAccounts();
  res.json(accounts);
}));

router.post('/accounts', asyncHandler(async (req, res) => {
  const data = validateRequest(createAccountSchema, req.body);
  const account = await calendarAccounts.createAccount(data);
  emitToOperatorsOn(req.app.get('io'), 'calendar:changed', {});
  res.status(201).json(account);
}));

router.put('/accounts/:id', asyncHandler(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    throw new ServerError('Invalid account ID format', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const updates = validateRequest(updateAccountSchema, req.body);
  const account = await calendarAccounts.updateAccount(req.params.id, updates);
  if (!account) throw new ServerError('Account not found', { status: 404, code: 'NOT_FOUND' });
  emitToOperatorsOn(req.app.get('io'), 'calendar:changed', {});
  res.json(account);
}));

router.delete('/accounts/:id', asyncHandler(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    throw new ServerError('Invalid account ID format', { status: 400, code: 'VALIDATION_ERROR' });
  }
  // Remove metadata to refuse new sync writes. Deleting the cache drains
  // admitted syncs before removing their derived rows. Cleanup remains retryable
  // when an earlier attempt already removed the account.
  await calendarAccounts.deleteAccount(req.params.id);
  await calendarSync.deleteCache(req.params.id);
  // Derived copies (titles, attendees) live in the Timeline and Tribe (#12984).
  // Lazy: these reach settings/DB modules that most route suites (and boot) never need.
  const [humanActivity, { deleteAutoTouchpoints }] = await Promise.all([import('../services/humanActivity.js'), import('../services/tribe.js')]);
  await humanActivity.deleteEvents({ accountId: req.params.id });
  await deleteAutoTouchpoints({ accountId: req.params.id });
  emitToOperatorsOn(req.app.get('io'), 'calendar:changed', {});
  res.status(204).send();
}));

// === Sync Routes ===
router.post('/sync/:accountId', asyncHandler(async (req, res) => {
  if (!UUID_RE.test(req.params.accountId)) {
    throw new ServerError('Invalid account ID format', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const io = req.app.get('io');
  const result = await calendarSync.syncAccount(req.params.accountId, io);
  res.json(result);
}));

// === Event Routes ===

// Today's agenda in the user's timezone — the dashboard widget's read. The
// day window comes from localDayWindowUtc (shared with the voice
// calendar_today tool) so DST-transition days keep the right bounds.
router.get('/agenda', asyncHandler(async (req, res) => {
  const { limit } = parsePagination(validateRequest(limitQuerySchema, req.query), { defaultLimit: 8, maxLimit: 20 });
  const accounts = await calendarAccounts.listAccounts();
  const accountCount = accounts.filter((a) => a.enabled !== false).length;
  if (accountCount === 0) {
    return res.json({ date: null, timezone: null, accountCount: 0, events: [], total: 0 });
  }
  const timezone = await getUserTimezone();
  const { date, startDate, endDate } = localDayWindowUtc(timezone);
  const { events = [], total = 0 } = await calendarSync.getEvents({ startDate, endDate, limit });
  res.json({
    date,
    timezone,
    accountCount,
    events: events.map((e) => ({
      id: e.id,
      accountId: e.accountId,
      title: e.title || 'Untitled event',
      startTime: e.startTime,
      endTime: e.endTime ?? null,
      isAllDay: !!e.isAllDay,
      location: e.location || null
    })),
    total
  });
}));

router.get('/events', asyncHandler(async (req, res) => {
  const query = validateRequest(eventsQuerySchema, req.query);
  const { accountId, search, startDate, endDate } = query;
  if (accountId && !UUID_RE.test(accountId)) {
    throw new ServerError('Invalid accountId format', { status: 400 });
  }
  const { limit: parsedLimit, offset: parsedOffset } = parsePagination(query, { defaultLimit: 50, maxLimit: 200 });
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

// === Subcalendar Routes ===
router.get('/accounts/:id/subcalendars', asyncHandler(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    throw new ServerError('Invalid account ID format', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const account = await calendarAccounts.getAccount(req.params.id);
  if (!account) throw new ServerError('Account not found', { status: 404, code: 'NOT_FOUND' });
  res.json(account.subcalendars || []);
}));

router.put('/accounts/:id/subcalendars', asyncHandler(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    throw new ServerError('Invalid account ID format', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const { subcalendars } = validateRequest(updateSubcalendarsSchema, req.body);
  const account = await calendarAccounts.updateSubcalendars(req.params.id, subcalendars);
  if (!account) throw new ServerError('Account not found', { status: 404, code: 'NOT_FOUND' });
  // Auto-purge cached and derived events for disabled subcalendars
  await calendarSync.purgeDisabledSubcalendars(req.params.id);
  emitToOperatorsOn(req.app.get('io'), 'calendar:changed', {});
  res.json(account);
}));

// === MCP Discover Calendars Route ===
router.post('/sync/:accountId/discover', asyncHandler(async (req, res) => {
  if (!UUID_RE.test(req.params.accountId)) {
    throw new ServerError('Invalid account ID format', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const io = req.app.get('io');
  const result = await calendarGoogleSync.mcpDiscoverCalendars(req.params.accountId, io);
  emitToOperatorsOn(req.app.get('io'), 'calendar:changed', {});
  res.json(result);
}));

// === MCP Sync Route ===
router.post('/sync/:accountId/google', asyncHandler(async (req, res) => {
  if (!UUID_RE.test(req.params.accountId)) {
    throw new ServerError('Invalid account ID format', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const io = req.app.get('io');
  const result = await calendarGoogleSync.mcpSyncAccount(req.params.accountId, io);
  res.json(result);
}));

// === Google OAuth Routes ===
router.get('/google/auth/status', asyncHandler(async (req, res) => {
  const status = await googleAuth.getAuthStatus();
  res.json(status);
}));

router.post('/google/auth/credentials', asyncHandler(async (req, res) => {
  const data = validateRequest(googleCalendarCredentialsSchema, req.body);
  const result = await googleAuth.saveCredentials(data);
  res.set('Cache-Control', 'no-store');
  res.json(result);
}));

router.post('/google/auth/url', asyncHandler(async (req, res) => {
  const { returnTo } = validateRequest(
    googleCalendarAuthUrlQuerySchema,
    req.query
  );
  const result = await googleAuth.getAuthUrl(returnTo);
  res.set('Cache-Control', 'no-store');
  res.json(result);
}));

router.get('/google/oauth/callback', asyncHandler(async (req, res) => {
  // The config page displays OAuth errors after the browser follows this redirect.
  res.set('Cache-Control', 'no-store');
  const parsed = oauthCallbackQuerySchema.safeParse(req.query);
  const { returnTo, error } = parsed.success
    ? await googleAuth.handleCallback(parsed.data)
    : { error: INVALID_OAUTH_STATE_MESSAGE };
  const configPath = returnTo === 'messages' ? '/messages/config' : '/calendar/config';
  res.redirect(error
    ? `${configPath}?oauthError=${encodeURIComponent(error)}`
    : configPath);
}));

router.post('/google/auth/clear', asyncHandler(async (req, res) => {
  await googleAuth.clearAuth();
  res.json({ cleared: true });
}));

// === Google OAuth Auto-Configure via CDP Browser ===
router.post('/google/auto-configure/start', asyncHandler(async (req, res) => {
  const io = req.app.get('io');
  const result = await googleOAuthAutoConfig.startAutoConfig(io);
  res.json(result);
}));

router.post('/google/auto-configure/run', asyncHandler(async (req, res) => {
  const io = req.app.get('io');
  const { email = '', requestId } = validateRequest(calendarAutoConfigureBodySchema, req.body ?? {});
  const result = await googleOAuthAutoConfig.runAutomatedSetup(email, io, requestId);
  res.json(result);
}));

// === Google API Sync Routes ===
router.post('/sync/:accountId/api', asyncHandler(async (req, res) => {
  if (!UUID_RE.test(req.params.accountId)) {
    throw new ServerError('Invalid account ID format', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const io = req.app.get('io');
  const result = await calendarGoogleApiSync.apiSyncAccount(req.params.accountId, io);
  res.json(result);
}));

router.post('/sync/:accountId/discover-api', asyncHandler(async (req, res) => {
  if (!UUID_RE.test(req.params.accountId)) {
    throw new ServerError('Invalid account ID format', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const result = await calendarGoogleApiSync.apiDiscoverCalendars(req.params.accountId);
  emitToOperatorsOn(req.app.get('io'), 'calendar:changed', {});
  res.json(result);
}));

// === Daily Review Routes ===
router.get('/review/:date', asyncHandler(async (req, res) => {
  const dateStr = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new ServerError('Invalid date format, use YYYY-MM-DD', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const { limit, offset } = validateRequest(dailyReviewQuerySchema, req.query);
  const review = await dailyReview.getDailyReview(dateStr, { limit, offset });
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
  if (tokenResult.error) {
    throw new ServerError(tokenResult.message || tokenResult.error, {
      status: 503,
      context: { reason: tokenResult.error, provider: tokenResult.provider }
    });
  }

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
