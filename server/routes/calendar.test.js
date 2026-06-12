import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { ServerError } from '../lib/errorHandler.js';

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
  getSyncStatus: vi.fn(),
  getEvents: vi.fn(),
  getEvent: vi.fn(),
  deleteCache: vi.fn(),
  purgeDisabledSubcalendars: vi.fn()
}));

vi.mock('../services/calendarGoogleSync.js', () => ({
  pushSyncEvents: vi.fn(),
  mcpDiscoverCalendars: vi.fn(),
  mcpSyncAccount: vi.fn()
}));

vi.mock('../services/dailyReview.js', () => ({
  getDailyReview: vi.fn(),
  getDailyReviewHistory: vi.fn(),
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
  captureCredentials: vi.fn(),
  runAutomatedSetup: vi.fn()
}));

vi.mock('../services/messageTokenExtractor.js', () => ({
  getToken: vi.fn(),
  getTokenStatus: vi.fn(),
  clearTokenCache: vi.fn()
}));

import calendarRoutes from './calendar.js';
import * as calendarSync from '../services/calendarSync.js';
import * as calendarGoogleSync from '../services/calendarGoogleSync.js';
import * as calendarGoogleApiSync from '../services/calendarGoogleApiSync.js';
import * as googleAuth from '../services/googleAuth.js';
import * as googleOAuthAutoConfig from '../services/googleOAuthAutoConfig.js';

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';

describe('Calendar Routes — normalized error handling', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/calendar', calendarRoutes);
    // The OAuth callback redirects the BROWSER here — echo the query so tests
    // can assert what landed (fetch follows redirects by default).
    app.get('/calendar/config', (req, res) => res.json({ landed: true, oauthError: req.query.oauthError ?? null }));
    vi.clearAllMocks();
  });

  describe('thrown ServerErrors map to the standard JSON envelope', () => {
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

    it('GET /google/auth/url surfaces a 400 when no credentials are configured', async () => {
      googleAuth.getAuthUrl.mockRejectedValue(new ServerError('No Google OAuth credentials configured', { status: 400 }));

      const response = await request(app).get('/api/calendar/google/auth/url');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('No Google OAuth credentials configured');
    });

    it('POST /google/auto-configure/capture surfaces a 404 with the partial clientId in context', async () => {
      googleOAuthAutoConfig.captureCredentials.mockRejectedValue(
        new ServerError('Found Client ID but not secret. Click "Information and summary" on the client detail page first.', {
          status: 404,
          context: { clientId: 'abc.apps.googleusercontent.com' },
        }),
      );

      const response = await request(app).post('/api/calendar/google/auto-configure/capture');

      expect(response.status).toBe(404);
      expect(response.body.error).toMatch(/Found Client ID but not secret/);
      expect(response.body.context).toEqual({ clientId: 'abc.apps.googleusercontent.com' });
    });
  });

  describe('success passthrough', () => {
    it('POST /sync/:accountId returns the sync result as-is', async () => {
      calendarSync.syncAccount.mockResolvedValue({ newEvents: 3, pruned: 1, total: 42, status: 'success' });

      const response = await request(app).post(`/api/calendar/sync/${ACCOUNT_ID}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ newEvents: 3, pruned: 1, total: 42, status: 'success' });
    });

    it('GET /google/auth/url returns the url', async () => {
      googleAuth.getAuthUrl.mockResolvedValue({ url: 'https://accounts.google.com/o/oauth2/auth?x=1' });

      const response = await request(app).get('/api/calendar/google/auth/url');

      expect(response.status).toBe(200);
      expect(response.body.url).toMatch(/^https:\/\/accounts\.google\.com/);
    });
  });

  describe('GET /google/oauth/callback stays browser-friendly (redirects, never JSON errors)', () => {
    it('redirects to the config page on success', async () => {
      googleAuth.handleCallback.mockResolvedValue({ success: true });

      const response = await request(app).get('/api/calendar/google/oauth/callback?code=ok');

      expect(response.body).toEqual({ landed: true, oauthError: null });
      expect(googleAuth.handleCallback).toHaveBeenCalledWith('ok');
    });

    it('redirects with oauthError when the code is missing', async () => {
      const response = await request(app).get('/api/calendar/google/oauth/callback');

      expect(response.body.landed).toBe(true);
      expect(response.body.oauthError).toBe('Missing authorization code');
      expect(googleAuth.handleCallback).not.toHaveBeenCalled();
    });

    it('redirects with oauthError when the token exchange fails', async () => {
      googleAuth.handleCallback.mockRejectedValue(new ServerError('invalid_grant', { status: 400 }));

      const response = await request(app).get('/api/calendar/google/oauth/callback?code=bad');

      expect(response.body.landed).toBe(true);
      expect(response.body.oauthError).toBe('invalid_grant');
    });
  });
});
