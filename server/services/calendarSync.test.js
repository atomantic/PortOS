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

import { syncAccount } from './calendarSync.js';
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
