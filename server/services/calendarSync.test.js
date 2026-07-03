import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./calendarAccounts.js', () => ({
  getAccount: vi.fn(),
  updateSyncStatus: vi.fn(),
  updateSubcalendars: vi.fn(),
  mergeDiscoveredSubcalendars: vi.fn()
}));

// Force the "no OAuth configured" path deterministically. Without this mock
// the test reads the developer's REAL Google credentials/tokens off disk —
// on a machine with credentials configured, the auth client materializes and
// the sync fails later with a GaxiosError (400 invalid_grant) instead of the
// 401 this test pins.
vi.mock('./googleAuth.js', () => ({
  getAuthenticatedClient: vi.fn(async () => null),
}));

// tribe.js is loaded dynamically by logCalendarTouchpoints; mock it so the
// producer test asserts the candidates without a live Postgres.
vi.mock('./tribe.js', () => ({
  autoLogTouchpoints: vi.fn().mockResolvedValue({ created: 0, matched: 0 }),
}));

import { syncAccount, logCalendarTouchpoints } from './calendarSync.js';
import { autoLogTouchpoints } from './tribe.js';
import { mcpSyncAccount, mcpDiscoverCalendars } from './calendarGoogleSync.js';
import { apiSyncAccount, apiDiscoverCalendars } from './calendarGoogleApiSync.js';
import { getAccount } from './calendarAccounts.js';

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';

// Pins the service-level ServerError statuses the calendar routes rely on —
// routes/calendar.test.js covers the route↔envelope mapping with mocked
// services, so without these a service status regression wouldn't fail CI.
describe('calendar sync services throw ServerError with the documented statuses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('calendarSync.syncAccount', () => {
    it('throws 404 for an unknown account', async () => {
      getAccount.mockResolvedValue(null);
      await expect(syncAccount(ACCOUNT_ID, null)).rejects.toMatchObject({ status: 404, message: 'Account not found' });
    });

    it('throws 400 for a disabled account', async () => {
      getAccount.mockResolvedValue({ id: ACCOUNT_ID, enabled: false });
      await expect(syncAccount(ACCOUNT_ID, null)).rejects.toMatchObject({ status: 400, message: 'Account is disabled' });
    });
  });

  describe('calendarGoogleSync.mcpSyncAccount', () => {
    it('throws 404 for an unknown account', async () => {
      getAccount.mockResolvedValue(null);
      await expect(mcpSyncAccount(ACCOUNT_ID, null)).rejects.toMatchObject({ status: 404 });
    });

    it('throws 400 for a non-Google account', async () => {
      getAccount.mockResolvedValue({ id: ACCOUNT_ID, type: 'outlook-calendar' });
      await expect(mcpSyncAccount(ACCOUNT_ID, null)).rejects.toMatchObject({ status: 400, message: 'Not a Google Calendar account' });
    });

    it('throws 400 when no subcalendars are enabled', async () => {
      getAccount.mockResolvedValue({ id: ACCOUNT_ID, type: 'google-calendar', subcalendars: [{ calendarId: 'a', enabled: false }] });
      await expect(mcpSyncAccount(ACCOUNT_ID, null)).rejects.toMatchObject({ status: 400, message: 'No enabled subcalendars' });
    });
  });

  describe('calendarGoogleSync.mcpDiscoverCalendars', () => {
    it('throws 404 for an unknown account', async () => {
      getAccount.mockResolvedValue(null);
      await expect(mcpDiscoverCalendars(ACCOUNT_ID, null)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('calendarGoogleApiSync', () => {
    it('apiSyncAccount throws 401 when Google OAuth is not configured', async () => {
      // No credentials/tokens on disk in the test env → getAuthenticatedClient() is null.
      getAccount.mockResolvedValue({ id: ACCOUNT_ID, type: 'google-calendar', subcalendars: [{ calendarId: 'a', enabled: true }] });
      await expect(apiSyncAccount(ACCOUNT_ID, null)).rejects.toMatchObject({ status: 401 });
    });

    it('apiDiscoverCalendars throws 404 for an unknown account', async () => {
      getAccount.mockResolvedValue(null);
      await expect(apiDiscoverCalendars(ACCOUNT_ID)).rejects.toMatchObject({ status: 404 });
    });
  });
});

describe('logCalendarTouchpoints — candidate building (#2033)', () => {
  const PAST = '2020-01-01T10:00:00Z';
  const FUTURE = new Date(Date.now() + 7 * 86400000).toISOString();

  beforeEach(() => {
    autoLogTouchpoints.mockClear();
    autoLogTouchpoints.mockResolvedValue({ created: 1, matched: 1 });
  });

  it('builds a calendar candidate with a stable per-event dedupe key', async () => {
    await logCalendarTouchpoints(ACCOUNT_ID, [{
      externalId: 'evt-1',
      title: 'Coffee with Ada',
      location: 'Cafe',
      startTime: PAST,
      organizer: { name: 'Ada', email: 'ada@work.com' },
      attendees: [{ name: 'Me', email: 'me@x.com' }],
    }]);

    expect(autoLogTouchpoints).toHaveBeenCalledTimes(1);
    const [candidates] = autoLogTouchpoints.mock.calls[0];
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      source: 'calendar',
      dedupeKey: `cal:${ACCOUNT_ID}:evt-1`,
      calendarEventId: 'evt-1',
      happenedAt: PAST,
      summary: 'Coffee with Ada',
    });
    expect(candidates[0].identities).toHaveLength(2);
  });

  it('skips future, cancelled, declined, and attendee-less events', async () => {
    await logCalendarTouchpoints(ACCOUNT_ID, [
      { externalId: 'future', startTime: FUTURE, attendees: [{ email: 'ada@work.com' }] },
      { externalId: 'cancelled', startTime: PAST, isCancelled: true, attendees: [{ email: 'ada@work.com' }] },
      { externalId: 'declined', startTime: PAST, myStatus: 'declined', attendees: [{ email: 'ada@work.com' }] },
      { externalId: 'empty', startTime: PAST, attendees: [] },
    ]);
    // All four filtered out → producer never calls the logger.
    expect(autoLogTouchpoints).not.toHaveBeenCalled();
  });
});
