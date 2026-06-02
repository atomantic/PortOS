import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the token source and the HTTP client so the sync runs offline.
vi.mock('./messageTokenExtractor.js', () => ({
  getToken: vi.fn(),
  clearTokenCache: vi.fn(),
}));
vi.mock('../lib/fetchWithTimeout.js', () => ({
  fetchWithTimeout: vi.fn(),
}));

import { getToken } from './messageTokenExtractor.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { mockJsonResponse, mockTextResponse } from '../lib/testHelper.js';
import { syncOutlookCalendarApi } from './calendarApiSync.js';

const ACCOUNT = { id: 'acc-1', email: 'a@example.com' };

describe('syncOutlookCalendarApi — malformed-body masquerade guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getToken.mockResolvedValue({ token: 'fake-token' });
  });

  // The regression this guards: a non-JSON 200 body used to become
  // { events: [], status: 'success' }, and calendarSync.js prunes every cached
  // event absent from a "success" fetch — so a transient HTML error page would
  // wipe the calendar cache. It must surface as api-error (no prune) instead.
  it('returns api-error (not empty success) on a non-JSON 200 body', async () => {
    fetchWithTimeout.mockResolvedValue(mockTextResponse('<html><body>502 Bad Gateway</body></html>'));
    const result = await syncOutlookCalendarApi(ACCOUNT, { events: [] }, null);
    expect(result).toEqual({ events: [], status: 'api-error' });
  });

  it('returns api-error on a blank 200 body', async () => {
    fetchWithTimeout.mockResolvedValue(mockTextResponse(''));
    const result = await syncOutlookCalendarApi(ACCOUNT, { events: [] }, null);
    expect(result.status).toBe('api-error');
  });

  // A legitimately-empty calendar still reports success (so the reconcile can
  // prune correctly) — the guard must not conflate valid-empty with malformed.
  it('still reports success for a valid empty { value: [] } body', async () => {
    fetchWithTimeout.mockResolvedValue(mockJsonResponse({ value: [] }));
    const result = await syncOutlookCalendarApi(ACCOUNT, { events: [] }, null);
    expect(result.status).toBe('success');
    expect(result.events).toEqual([]);
  });

  it('parses events from a valid populated body', async () => {
    fetchWithTimeout.mockResolvedValue(mockJsonResponse({ value: [{ Id: 'evt-1', Subject: 'Standup' }] }));
    const result = await syncOutlookCalendarApi(ACCOUNT, { events: [] }, null);
    expect(result.status).toBe('success');
    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('Standup');
  });
});
