import { recordingOperatorIo } from '../test/recordingOperatorIo.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { ServerError, errorEvents } from '../lib/errorHandler.js';

vi.mock('../services/humanActivity.js', () => ({ deleteEvents: vi.fn().mockResolvedValue({ deleted: 0 }) }));
vi.mock('../services/tribe.js', () => ({ deleteAutoTouchpoints: vi.fn().mockResolvedValue({ touchpoints: 0, auditRows: 0 }) }));
vi.mock('../services/calendarAccounts.js', () => ({
  listAccounts: vi.fn(),
  createAccount: vi.fn(),
  updateAccount: vi.fn(),
  deleteAccount: vi.fn(),
  getAccount: vi.fn(),
  updateSubcalendars: vi.fn()
}));

vi.mock('../services/calendarSync.js', () => ({
  syncAccount: vi.fn(),
  getEvents: vi.fn(),
  getEvent: vi.fn(),
  deleteCache: vi.fn(),
  purgeDisabledSubcalendars: vi.fn()
}));

vi.mock('../services/calendarGoogleSync.js', () => ({
  mcpDiscoverCalendars: vi.fn(),
  mcpSyncAccount: vi.fn()
}));

vi.mock('../services/dailyReview.js', () => ({
  getDailyReview: vi.fn(),
  confirmEvent: vi.fn()
}));

vi.mock('../services/googleAuth.js', () => ({
  getAuthStatus: vi.fn(),
  saveCredentials: vi.fn(),
  getAuthUrl: vi.fn(),
  handleCallback: vi.fn(),
  clearAuth: vi.fn()
}));

vi.mock('../services/calendarGoogleApiSync.js', () => ({
  apiSyncAccount: vi.fn(),
  apiDiscoverCalendars: vi.fn()
}));

vi.mock('../services/googleOAuthAutoConfig.js', () => ({
  startAutoConfig: vi.fn(),
  runAutomatedSetup: vi.fn()
}));

vi.mock('../services/messageTokenExtractor.js', () => ({
  getToken: vi.fn(),
  getTokenStatus: vi.fn(),
  clearTokenCache: vi.fn()
}));

vi.mock('../services/userTimezone.js', () => ({
  getUserTimezone: vi.fn()
}));

import calendarRoutes from './calendar.js';
import * as calendarAccounts from '../services/calendarAccounts.js';
import * as calendarSync from '../services/calendarSync.js';
import * as humanActivity from '../services/humanActivity.js';
import * as tribe from '../services/tribe.js';
import { getUserTimezone } from '../services/userTimezone.js';
import * as dailyReview from '../services/dailyReview.js';
import * as calendarGoogleSync from '../services/calendarGoogleSync.js';
import * as calendarGoogleApiSync from '../services/calendarGoogleApiSync.js';
import * as googleAuth from '../services/googleAuth.js';
import * as googleOAuthAutoConfig from '../services/googleOAuthAutoConfig.js';

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const observeError = vi.fn();
afterEach(() => {
  vi.useRealTimers();
  errorEvents.off('error', observeError);
});

describe('Calendar Routes — normalized error handling', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/calendar', calendarRoutes);
    // The OAuth callback redirects the BROWSER here — echo the query so tests
    // can assert what landed (fetch follows redirects by default).
    app.get('/calendar/config', (req, res) => res.json({ landed: true, oauthError: req.query.oauthError ?? null }));
    app.get('/messages/config', (req, res) => res.json({ landed: true, destination: 'messages', oauthError: req.query.oauthError ?? null }));
    vi.clearAllMocks();
  });

  describe('thrown ServerErrors map to the standard JSON envelope', () => {
    // Catches a false 204 when cleanup fails or a retry rejected merely because
    // account metadata was already removed; cleanup must follow metadata removal.
    it('reports account cleanup failure and accepts retries after account removal', async () => {
      const io = recordingOperatorIo();
      app.set('io', io);
      errorEvents.once('error', observeError);
      let present = true;
      calendarAccounts.deleteAccount.mockImplementation(async () => {
        const removed = present;
        present = false;
        return removed;
      });
      calendarSync.deleteCache.mockImplementationOnce(async () => {
        expect(present).toBe(false);
        throw Object.assign(new Error('Synthetic cache deletion denied'), { code: 'EACCES' });
      }).mockResolvedValue(undefined);
      const failed = await request(app).delete(`/api/calendar/accounts/${ACCOUNT_ID}`);
      expect(failed.status).toBe(500);
      expect(failed.body.error).toBe('Filesystem operation failed');
      expect(observeError).toHaveBeenCalledWith(expect.objectContaining({ status: 500 }), expect.any(Object));
      expect(io.emit).not.toHaveBeenCalledWith('calendar:changed', {});
      for (let attempt = 0; attempt < 2; attempt++) {
        const retried = await request(app).delete(`/api/calendar/accounts/${ACCOUNT_ID}`);
        expect(retried.status).toBe(204);
      }
      expect(calendarSync.deleteCache).toHaveBeenCalledTimes(3);
      expect(calendarSync.deleteCache).toHaveBeenLastCalledWith(ACCOUNT_ID);
      // Derived Timeline/Tribe copies go only after the cache is gone, and again on retry (#12984).
      expect(humanActivity.deleteEvents).toHaveBeenCalledTimes(2);
      expect(humanActivity.deleteEvents).toHaveBeenLastCalledWith({ accountId: ACCOUNT_ID });
      expect(tribe.deleteAutoTouchpoints).toHaveBeenLastCalledWith({ accountId: ACCOUNT_ID });
      expect(io.emit.mock.calls.filter(([event]) => event === 'calendar:changed')).toHaveLength(2);
    });

    it('GET /review/:date passes bounded page params to the service and defaults to the legacy first page', async () => {
      dailyReview.getDailyReview.mockResolvedValue({ events: [], total: 0 });
      await request(app).get('/api/calendar/review/2026-01-02');
      expect(dailyReview.getDailyReview).toHaveBeenLastCalledWith('2026-01-02', { limit: 200, offset: 0 });
      await request(app).get('/api/calendar/review/2026-01-02?limit=25&offset=200');
      expect(dailyReview.getDailyReview).toHaveBeenLastCalledWith('2026-01-02', { limit: 25, offset: 200 });
      dailyReview.getDailyReview.mockClear();
      for (const bad of ['limit=999', 'limit=0', 'offset=-4', 'offset=abc']) {
        const response = await request(app).get(`/api/calendar/review/2026-01-02?${bad}`);
        expect(response.status, bad).toBe(400);
      }
      expect(dailyReview.getDailyReview).not.toHaveBeenCalled();
    });

    it('POST /review/:date/confirm preserves typed missing-goal errors', async () => {
      dailyReview.confirmEvent.mockRejectedValue(new ServerError('Goal not found', { status: 404, code: 'GOAL_NOT_FOUND' }));
      const response = await request(app).post('/api/calendar/review/2026-01-02/confirm')
        .send({ eventId: 'event-a', happened: true, goalId: 'goal-a', durationMinutes: 30 });
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('GOAL_NOT_FOUND');
    });

    it('POST /sync/:accountId surfaces a 409 sync-lock conflict', async () => {
      calendarSync.syncAccount.mockRejectedValue(new ServerError('Sync already in progress', { status: 409 }));

      const response = await request(app).post(`/api/calendar/sync/${ACCOUNT_ID}`);

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('Sync already in progress');
      expect(response.body.code).toBe('CONFLICT');
    });

    it('POST /sync/:accountId/google surfaces a 404 unknown account', async () => {
      calendarGoogleSync.mcpSyncAccount.mockRejectedValue(new ServerError('Account not found', { status: 404 }));

      const response = await request(app).post(`/api/calendar/sync/${ACCOUNT_ID}/google`);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Account not found');
      expect(response.body.code).toBe('NOT_FOUND');
    });

    it('POST /sync/:accountId/api surfaces a 401 missing-OAuth error', async () => {
      calendarGoogleApiSync.apiSyncAccount.mockRejectedValue(
        new ServerError('Google OAuth not configured. Set up credentials in Config tab.', { status: 401 }),
      );

      const response = await request(app).post(`/api/calendar/sync/${ACCOUNT_ID}/api`);

      expect(response.status).toBe(401);
      expect(response.body.error).toMatch(/Google OAuth not configured/);
    });

    it('POST /google/auth/url surfaces a 400 when no credentials are configured', async () => {
      googleAuth.getAuthUrl.mockRejectedValue(new ServerError('No Google OAuth credentials configured', { status: 400 }));

      const response = await request(app).post('/api/calendar/google/auth/url');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('No Google OAuth credentials configured');
    });

  });

  describe('Google automation request correlation', () => {
    it('passes optional request IDs through and preserves email-only callers and responses', async () => {
      const io = recordingOperatorIo();
      app.set('io', io);
      const result = { status: 'success', clientId: 'synthetic-client', authUrl: null };
      googleOAuthAutoConfig.runAutomatedSetup.mockResolvedValue(result);
      for (const requestId of ['invented-run-1', undefined]) {
        const response = await request(app).post('/api/calendar/google/auto-configure/run')
          .send({ email: 'example@example.com', ...(requestId ? { requestId } : {}) });
        expect(response.status).toBe(200);
        expect(response.body).toEqual(result);
        expect(googleOAuthAutoConfig.runAutomatedSetup).toHaveBeenLastCalledWith('example@example.com', io, requestId);
      }
    });

    it.each(['', 'bad id', 'x'.repeat(129), 42, null])('rejects malformed request ID %j before automation', async (requestId) => {
      googleOAuthAutoConfig.runAutomatedSetup.mockClear();
      const response = await request(app).post('/api/calendar/google/auto-configure/run').send({ requestId });
      expect(response.status).toBe(400);
      expect(googleOAuthAutoConfig.runAutomatedSetup).not.toHaveBeenCalled();
    });
  });

  describe('success passthrough', () => {
    it('POST /sync/:accountId returns the sync result as-is', async () => {
      calendarSync.syncAccount.mockResolvedValue({ newEvents: 3, pruned: 1, total: 42, status: 'success' });

      const response = await request(app).post(`/api/calendar/sync/${ACCOUNT_ID}`);

      expect(response.status).toBe(200);
      expect(calendarSync.syncAccount.mock.calls[0][0]).toBe(ACCOUNT_ID);
    });

    it('POST /google/auth/url returns the url', async () => {
      googleAuth.getAuthUrl.mockResolvedValue({ url: 'https://accounts.google.com/o/oauth2/auth?x=1' });

      const response = await request(app).post('/api/calendar/google/auth/url');

      expect(response.status).toBe(200);
      expect(response.body.url).toMatch(/^https:\/\/accounts\.google\.com/);
      expect(googleAuth.getAuthUrl).toHaveBeenCalledWith('calendar');
    });

    it('POST /google/auth/url preserves a Messages return target', async () => {
      googleAuth.getAuthUrl.mockResolvedValue({ url: 'https://accounts.google.com/o/oauth2/auth?state=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });

      const response = await request(app).post('/api/calendar/google/auth/url?returnTo=messages');

      expect(response.status).toBe(200);
      expect(googleAuth.getAuthUrl).toHaveBeenCalledWith('messages');
    });

    it('PUT /accounts/:id/subcalendars updates subcalendars, triggers purge, and fails closed on purge errors (#18229)', async () => {
      const io = recordingOperatorIo();
      app.set('io', io);
      const subcalendars = [
        { calendarId: 'work', name: 'Work', enabled: true, dormant: false },
        { calendarId: 'personal', name: 'Personal', enabled: false, dormant: false },
      ];
      const updated = { id: ACCOUNT_ID, subcalendars };
      calendarAccounts.updateSubcalendars.mockResolvedValue(updated);
      calendarSync.purgeDisabledSubcalendars.mockResolvedValueOnce({ purged: 2, remaining: 1 });

      const ok = await request(app).put(`/api/calendar/accounts/${ACCOUNT_ID}/subcalendars`).send({ subcalendars });
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual(updated);
      expect(calendarSync.purgeDisabledSubcalendars).toHaveBeenCalledWith(ACCOUNT_ID);
      expect(io.emit).toHaveBeenCalledWith('calendar:changed', {});

      io.emit.mockClear();
      errorEvents.once('error', observeError);
      calendarSync.purgeDisabledSubcalendars.mockRejectedValueOnce(new Error('Synthetic DB outage'));
      const failed = await request(app).put(`/api/calendar/accounts/${ACCOUNT_ID}/subcalendars`).send({ subcalendars });
      expect(failed.status).toBe(500);
      expect(observeError).toHaveBeenCalledWith(expect.objectContaining({ status: 500 }), expect.any(Object));
      expect(io.emit).not.toHaveBeenCalledWith('calendar:changed', {});
    });
  });

  describe('POST /google/auth/credentials', () => {
    it('responds no-store without echoing the client secret', async () => {
      googleAuth.saveCredentials.mockResolvedValue({ hasCredentials: true, redirectUri: 'http://localhost/cb' });
      const res = await request(app).post('/api/calendar/google/auth/credentials').send({ clientId: 'cid', clientSecret: 'shh' });
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({ hasCredentials: true, redirectUri: 'http://localhost/cb' });
    });
  });

  describe('GET /agenda — today\'s events for the dashboard widget', () => {
    it('reports zero accounts without touching events when none are enabled', async () => {
      calendarAccounts.listAccounts.mockResolvedValue([{ id: ACCOUNT_ID, enabled: false }]);

      const response = await request(app).get('/api/calendar/agenda');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ date: null, timezone: null, accountCount: 0, events: [], total: 0 });
      expect(calendarSync.getEvents).not.toHaveBeenCalled();
    });

    it.each([
      ['2026-09-01T12:00:00Z', '2026-09-01', '2026-09-01T07:00:00.000Z', '2026-09-02T06:59:59.999Z'],
      ['2026-03-08T12:00:00Z', '2026-03-08', '2026-03-08T08:00:00.000Z', '2026-03-09T06:59:59.999Z'],
      ['2026-11-01T12:00:00Z', '2026-11-01', '2026-11-01T07:00:00.000Z', '2026-11-02T07:59:59.999Z'],
    ])('returns the local day and trimmed events at %s', async (now, date, start, end) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(now));
      calendarAccounts.listAccounts.mockResolvedValue([
        { id: ACCOUNT_ID, enabled: true },
        { id: '22222222-2222-2222-2222-222222222222', enabled: false }
      ]);
      getUserTimezone.mockResolvedValue('America/Los_Angeles');
      calendarSync.getEvents.mockResolvedValue({
        events: [
          {
            id: 'evt-1', accountId: ACCOUNT_ID, title: 'Standup',
            startTime: '2026-09-01T17:00:00Z', endTime: '2026-09-01T17:30:00Z',
            isAllDay: false, location: 'Room 4', description: 'secret notes stay server-side'
          },
          { id: 'evt-2', accountId: ACCOUNT_ID, title: '', startTime: '2026-09-01T20:00:00Z' }
        ],
        total: 2
      });

      const response = await request(app).get('/api/calendar/agenda');

      expect(response.status).toBe(200);
      expect(response.body.accountCount).toBe(1);
      expect(response.body.timezone).toBe('America/Los_Angeles');
      expect(response.body.total).toBe(2);
      expect(response.body.events).toEqual([
        {
          id: 'evt-1', accountId: ACCOUNT_ID, title: 'Standup',
          startTime: '2026-09-01T17:00:00Z', endTime: '2026-09-01T17:30:00Z',
          isAllDay: false, location: 'Room 4'
        },
        {
          id: 'evt-2', accountId: ACCOUNT_ID, title: 'Untitled event',
          startTime: '2026-09-01T20:00:00Z', endTime: null,
          isAllDay: false, location: null
        }
      ]);

      // The local day can span 23, 24, or 25 hours across DST transitions.
      const [{ startDate, endDate, limit }] = calendarSync.getEvents.mock.calls[0];
      expect(limit).toBe(8);
      expect(startDate).toBe(start);
      expect(endDate).toBe(end);
      expect(response.body.date).toBe(date);
    });
  });

  describe('GET /google/oauth/callback stays browser-friendly (redirects, never JSON errors)', () => {
    const state = 'a'.repeat(32);

    it('redirects to the config page on success', async () => {
      googleAuth.handleCallback.mockResolvedValue({ success: true, returnTo: 'calendar' });

      const response = await request(app).get(`/api/calendar/google/oauth/callback?code=ok&state=${state}`);

      expect(response.body).toEqual({ landed: true, oauthError: null });
      expect(googleAuth.handleCallback).toHaveBeenCalledWith({ code: 'ok', state });
    });

    it('returns to Messages when authorization started there', async () => {
      googleAuth.handleCallback.mockResolvedValue({ success: true, returnTo: 'messages' });

      const response = await request(app).get(`/api/calendar/google/oauth/callback?code=ok&state=${state}`);

      expect(response.body).toEqual({ landed: true, destination: 'messages', oauthError: null });
      expect(googleAuth.handleCallback).toHaveBeenCalledWith({ code: 'ok', state });
    });

    it('redirects with oauthError when state is missing', async () => {
      const response = await request(app).get('/api/calendar/google/oauth/callback?code=ok');

      expect(response.body.landed).toBe(true);
      expect(response.body.oauthError).toMatch(/OAuth state/);
      expect(googleAuth.handleCallback).not.toHaveBeenCalled();
    });

    it('rejects a malformed (repeated) code with a redirect', async () => {
      const response = await request(app).get(`/api/calendar/google/oauth/callback?code=a&code=b&state=${state}`);

      expect(response.body.landed).toBe(true);
      expect(response.body.oauthError).toMatch(/OAuth state/);
      expect(googleAuth.handleCallback).not.toHaveBeenCalled();
    });

    it('redirects with oauthError when the token exchange fails', async () => {
      googleAuth.handleCallback.mockResolvedValue({ returnTo: 'messages', error: 'invalid_grant' });

      const response = await request(app).get(`/api/calendar/google/oauth/callback?code=bad&state=${state}`);

      expect(response.body).toEqual({ landed: true, destination: 'messages', oauthError: 'invalid_grant' });
    });
  });
});
