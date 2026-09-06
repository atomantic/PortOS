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

vi.mock('../services/userTimezone.js', () => ({
  getUserTimezone: vi.fn()
}));

import calendarRoutes from './calendar.js';
import * as calendarAccounts from '../services/calendarAccounts.js';
import * as calendarSync from '../services/calendarSync.js';
import { getUserTimezone } from '../services/userTimezone.js';
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
    app.get('/messages/config', (req, res) => res.json({ landed: true, destination: 'messages', oauthError: req.query.oauthError ?? null }));
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
      expect(googleAuth.getAuthUrl).toHaveBeenCalledWith('calendar');
    });

    it('GET /google/auth/url preserves a Messages return target', async () => {
      googleAuth.getAuthUrl.mockResolvedValue({ url: 'https://accounts.google.com/o/oauth2/auth?state=messages' });

      const response = await request(app).get('/api/calendar/google/auth/url?returnTo=messages');

      expect(response.status).toBe(200);
      expect(googleAuth.getAuthUrl).toHaveBeenCalledWith('messages');
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

    it('returns today\'s window in the user timezone with trimmed event fields', async () => {
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

      // The bounds are the user's LOCAL day expressed in UTC: startDate is
      // local midnight in the configured timezone and the window spans 24h.
      const [{ startDate, endDate, limit }] = calendarSync.getEvents.mock.calls[0];
      expect(limit).toBe(8);
      const localStart = new Date(startDate).toLocaleTimeString('en-US', {
        timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit'
      });
      expect(localStart).toBe('00:00');
      expect(new Date(endDate).getTime() - new Date(startDate).getTime()).toBe(86399999);
      expect(response.body.date).toBe(
        new Date(startDate).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
      );
    });
  });

  describe('GET /google/oauth/callback stays browser-friendly (redirects, never JSON errors)', () => {
    it('redirects to the config page on success', async () => {
      googleAuth.handleCallback.mockResolvedValue({ success: true });

      const response = await request(app).get('/api/calendar/google/oauth/callback?code=ok');

      expect(response.body).toEqual({ landed: true, oauthError: null });
      expect(googleAuth.handleCallback).toHaveBeenCalledWith('ok');
    });

    it('returns to Messages when authorization started there', async () => {
      googleAuth.handleCallback.mockResolvedValue({ success: true });

      const response = await request(app).get('/api/calendar/google/oauth/callback?code=ok&state=messages');

      expect(response.body).toEqual({ landed: true, destination: 'messages', oauthError: null });
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

// #6289: the push route is the HTTP ingress for Google conference metadata.
// Zod strips whatever a schema doesn't name, so the regression this pins is the
// route silently dropping the conference fields before the service can project
// them — the join link would then never reach the cache from a push sync.
describe('Calendar Routes — push sync carries Google conference metadata (#6289)', () => {
  let app;

  const push = (events) =>
    request(app).post(`/api/calendar/sync/${ACCOUNT_ID}/push`).send({
      calendarId: 'work@example.com',
      calendarName: 'Work',
      events,
    });

  const pushedEvents = () => calendarGoogleSync.pushSyncEvents.mock.calls.at(-1)[3];

  const baseEvent = {
    id: 'upstream-1',
    summary: 'Design review',
    start: { dateTime: '2026-03-02T10:00:00Z' },
    end: { dateTime: '2026-03-02T11:00:00Z' },
  };

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/calendar', calendarRoutes);
    vi.clearAllMocks();
    calendarGoogleSync.pushSyncEvents.mockResolvedValue({ newEvents: 1, updated: 0, pruned: 0, total: 1 });
  });

  it('forwards conferenceData entry points and hangoutLink to the service', async () => {
    const response = await push([{
      ...baseEvent,
      hangoutLink: 'https://meet.example.com/legacy-abc',
      conferenceData: {
        entryPoints: [
          { entryPointType: 'phone', uri: 'tel:+15550100' },
          { entryPointType: 'video', uri: 'https://meet.example.com/video-xyz' },
        ],
      },
    }]);

    expect(response.status).toBe(200);
    expect(pushedEvents()[0]).toMatchObject({
      hangoutLink: 'https://meet.example.com/legacy-abc',
      conferenceData: {
        entryPoints: [
          { entryPointType: 'phone', uri: 'tel:+15550100' },
          { entryPointType: 'video', uri: 'https://meet.example.com/video-xyz' },
        ],
      },
    });
  });

  it('strips conference passwords and dial-in PINs riding alongside the URI', async () => {
    await push([{
      ...baseEvent,
      conferenceData: {
        conferenceId: 'abc-defg-hij',
        entryPoints: [{ entryPointType: 'video', uri: 'https://meet.example.com/video-xyz', password: 'hunter2', pin: '987654' }],
      },
    }]);

    const forwarded = pushedEvents()[0];
    expect(forwarded.conferenceData.entryPoints[0]).toEqual({
      entryPointType: 'video',
      uri: 'https://meet.example.com/video-xyz',
    });
    expect(JSON.stringify(forwarded)).not.toContain('hunter2');
    expect(JSON.stringify(forwarded)).not.toContain('987654');
  });

  it('preserves the OMISSION of both fields rather than defaulting them', async () => {
    await push([baseEvent]);

    const forwarded = pushedEvents()[0];
    // The service reads key PRESENCE to tell an intentional clear from a legacy
    // producer, so a default here would make every legacy push wipe cached links.
    expect('hangoutLink' in forwarded).toBe(false);
    expect('conferenceData' in forwarded).toBe(false);
  });

  it('passes an explicit null through as the clear signal', async () => {
    await push([{ ...baseEvent, hangoutLink: null, conferenceData: null }]);

    expect(pushedEvents()[0]).toMatchObject({ hangoutLink: null, conferenceData: null });
  });

  // The bounds FAIL SOFT. Throwing would 400 the whole batch, so one malformed
  // event — even on an entry-point type the selector ignores — would silently
  // stop the user's entire calendar from syncing. Collapsing to null instead
  // says "conferencing was described, nothing usable came of it", which is
  // true, and every other event in the payload still lands.
  it('collapses an over-long entry point without erasing a usable sibling', async () => {
    // The granularity that matters: a malformed `phone` entry the selector
    // would ignore anyway must not take the usable video link down with it.
    const response = await push([{
      ...baseEvent,
      conferenceData: {
        entryPoints: [
          { entryPointType: 'video', uri: 'https://meet.example.com/video-xyz' },
          { entryPointType: 'phone', uri: `tel:${'1'.repeat(1300)}` },
        ],
      },
    }]);

    expect(response.status).toBe(200);
    const entryPoints = pushedEvents()[0].conferenceData.entryPoints;
    expect(entryPoints[0]).toEqual({ entryPointType: 'video', uri: 'https://meet.example.com/video-xyz' });
    // The bad entry survives only as an inert placeholder the selector skips.
    expect(entryPoints[1]).toEqual({});
  });

  it('collapses a genuinely over-long hangoutLink to null without failing the batch', async () => {
    const response = await push([{
      ...baseEvent,
      hangoutLink: `https://meet.example.com/${'a'.repeat(1300)}`,
    }]);

    expect(response.status).toBe(200);
    expect(pushedEvents()[0]).toMatchObject({ hangoutLink: null });
  });

  // This ingress must not be needlessly STRICTER than the selector it feeds:
  // anything it rejects that the selector would have accepted reads downstream
  // as "this meeting has no conference" and CLEARS a link the API and MCP paths
  // keep for the identical input. These two pin the cases where a naive bound
  // did exactly that. (Truncation past 100 entries can still drop a candidate —
  // the deliberate residue of having any bound; see the schema's comment.)
  it('keeps a padded URL the selector would trim and accept', async () => {
    const response = await push([{ ...baseEvent, hangoutLink: `${' '.repeat(1300)}https://meet.example.com/room` }]);

    expect(response.status).toBe(200);
    expect(pushedEvents()[0].hangoutLink).toBe('https://meet.example.com/room');
  });

  it('caps an over-long entry-point array instead of discarding the valid lead entry', async () => {
    const response = await push([{
      ...baseEvent,
      conferenceData: {
        entryPoints: [
          { entryPointType: 'video', uri: 'https://meet.example.com/video-xyz' },
          ...Array.from({ length: 100 }, () => null),
        ],
      },
    }]);

    expect(response.status).toBe(200);
    const entryPoints = pushedEvents()[0].conferenceData.entryPoints;
    expect(entryPoints).toHaveLength(100);
    expect(entryPoints[0]).toEqual({ entryPointType: 'video', uri: 'https://meet.example.com/video-xyz' });
  });

  it('bounds an unbounded entry-point array at 100 entries', async () => {
    const response = await push([{
      ...baseEvent,
      conferenceData: {
        entryPoints: Array.from({ length: 500 }, () => ({ entryPointType: 'more', uri: 'https://meet.example.com/x' })),
      },
    }]);

    expect(response.status).toBe(200);
    expect(pushedEvents()[0].conferenceData.entryPoints).toHaveLength(100);
  });

  it('keeps the rest of a batch syncing when one event has malformed conference data', async () => {
    const response = await push([
      { ...baseEvent, id: 'bad', conferenceData: 'not-an-object' },
      {
        ...baseEvent,
        id: 'good',
        conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.example.com/video-xyz' }] },
      },
    ]);

    expect(response.status).toBe(200);
    const forwarded = pushedEvents();
    expect(forwarded).toHaveLength(2);
    expect(forwarded[0].conferenceData).toBeNull();
    expect(forwarded[1].conferenceData.entryPoints[0].uri).toBe('https://meet.example.com/video-xyz');
  });
});
