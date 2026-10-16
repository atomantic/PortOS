import { describe, it, expect, vi, beforeEach } from 'vitest';

// The direct Google API path projects each `events.list` item into a smaller
// object before handing it to `pushSyncEvents`. That projection is a real
// stripping boundary: a field it forgets can never reach the cache, however
// well the normalizer downstream handles it. These tests pin the conference
// metadata's survival across it, and the explicit-null contract that makes an
// API response authoritative enough to clear a stale join link (#6289).
vi.mock('@googleapis/calendar', () => ({ calendar: vi.fn() }));

vi.mock('./googleAuth.js', () => ({ getAuthenticatedClient: vi.fn(), GOOGLE_API_TIMEOUT_MS: 30_000 }));

vi.mock('./calendarAccounts.js', () => ({
  getAccount: vi.fn(),
  updateSubcalendars: vi.fn(async () => ({})),
  mergeDiscoveredSubcalendars: vi.fn((existing, discovered) => discovered),
}));

vi.mock('./calendarGoogleSync.js', () => ({
  pushSyncEvents: vi.fn(async () => ({ newEvents: 1, updated: 0, pruned: 0, total: 1 })),
  getSyncDateRange: vi.fn(() => ({ pastDate: new Date('2026-03-01T00:00:00Z'), futureDate: new Date('2026-04-01T00:00:00Z') })),
}));

import { apiSyncAccount } from './calendarGoogleApiSync.js';
import { calendar } from '@googleapis/calendar';
import { getAuthenticatedClient } from './googleAuth.js';
import { getAccount } from './calendarAccounts.js';
import { pushSyncEvents } from './calendarGoogleSync.js';

const ACCOUNT_ID = '33333333-3333-3333-3333-333333333333';
const CAL_ID = 'work@example.com';

const account = () => ({
  id: ACCOUNT_ID,
  name: 'Example Account',
  type: 'google-calendar',
  subcalendars: [{ calendarId: CAL_ID, name: 'Work', enabled: true, dormant: false }],
});

const apiItem = (overrides = {}) => ({
  id: 'upstream-1',
  summary: 'Design review',
  start: { dateTime: '2026-03-02T10:00:00Z' },
  end: { dateTime: '2026-03-02T11:00:00Z' },
  status: 'confirmed',
  ...overrides,
});

/** Stub one `events.list` page holding the given raw API items. */
const mockListPage = (items) => {
  const list = vi.fn(async () => ({ data: { items, nextPageToken: undefined } }));
  calendar.mockReturnValue({ events: { list } });
  return list;
};

/** The raw events the API mapper handed to the shared sync service. */
const syncedEvents = () => pushSyncEvents.mock.calls.at(-1)[3];

describe('apiSyncAccount conference-metadata projection (#6289)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAccount.mockResolvedValue(account());
    getAuthenticatedClient.mockResolvedValue({});
    pushSyncEvents.mockResolvedValue({ newEvents: 1, updated: 0, pruned: 0, total: 1 });
  });

  it('carries the video entry point and hangoutLink through to the cache write', async () => {
    mockListPage([apiItem({
      hangoutLink: 'https://meet.example.com/legacy-abc',
      conferenceData: {
        entryPoints: [
          { entryPointType: 'phone', uri: 'tel:+15550100' },
          { entryPointType: 'video', uri: 'https://meet.example.com/video-xyz' },
        ],
      },
    })]);

    await apiSyncAccount(ACCOUNT_ID, null);

    expect(syncedEvents()[0]).toMatchObject({
      hangoutLink: 'https://meet.example.com/legacy-abc',
      conferenceData: {
        entryPoints: [
          { entryPointType: 'phone', uri: 'tel:+15550100' },
          { entryPointType: 'video', uri: 'https://meet.example.com/video-xyz' },
        ],
      },
    });
  });

  it('drops conference passwords and dial-in PINs at the projection boundary', async () => {
    mockListPage([apiItem({
      conferenceData: {
        conferenceId: 'abc-defg-hij',
        notes: 'Ask the host for the passcode',
        entryPoints: [{ entryPointType: 'video', uri: 'https://meet.example.com/video-xyz', password: 'hunter2', pin: '987654' }],
      },
    })]);

    await apiSyncAccount(ACCOUNT_ID, null);

    const forwarded = syncedEvents()[0];
    expect(forwarded.conferenceData).toEqual({
      entryPoints: [{ entryPointType: 'video', uri: 'https://meet.example.com/video-xyz' }],
    });
    expect(JSON.stringify(forwarded)).not.toContain('hunter2');
    expect(JSON.stringify(forwarded)).not.toContain('987654');
  });

  it('emits EXPLICIT nulls for an event with no conference metadata', async () => {
    mockListPage([apiItem()]);

    await apiSyncAccount(ACCOUNT_ID, null);

    // Not omission: a direct API response is the authoritative snapshot, and an
    // explicit null is what lets it clear a link the meeting no longer has.
    expect(syncedEvents()[0]).toMatchObject({ hangoutLink: null, conferenceData: null });
  });

  it('paginates the full event range before writing the cache once per calendar', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ data: { items: [apiItem({ id: 'page-1' })], nextPageToken: 'more' } })
      .mockResolvedValueOnce({ data: { items: [apiItem({ id: 'page-2' })], nextPageToken: undefined } });
    calendar.mockReturnValue({ events: { list } });

    const result = await apiSyncAccount(ACCOUNT_ID, null);

    expect(list).toHaveBeenCalledTimes(2);
    expect(syncedEvents().map((e) => e.id)).toEqual(['page-1', 'page-2']);
    expect(pushSyncEvents).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('success');
  });

  it('refuses to sync without configured OAuth rather than writing an empty cache', async () => {
    getAuthenticatedClient.mockResolvedValue(null);

    await expect(apiSyncAccount(ACCOUNT_ID, null)).rejects.toMatchObject({ status: 401 });
    expect(pushSyncEvents).not.toHaveBeenCalled();
  });

  it('aborts stalled SDK requests at the default deadline and releases the account lock', async () => {
    const sdk = await vi.importActual('@googleapis/calendar');
    vi.useFakeTimers();
    // Node's native AbortSignal timer bypasses fake timers. Inject only its
    // clock; the real SDK and transport still create and consume the deadline.
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    const cleanup = new AbortController();
    const started = Promise.withResolvers();
    const attempts = [];
    let healthy = false;
    const auth = new sdk.auth.OAuth2({ transporterOptions: {
      signal: cleanup.signal,
      fetchImplementation: async (_url, { signal }) => {
        if (healthy) return Response.json({ items: [] });
        const attempt = { startedAt: Date.now(), signal, abortedAt: null };
        attempts.push(attempt);
        started.resolve();
        return new Promise((_resolve, reject) => {
          const abort = () => { attempt.abortedAt = Date.now(); reject(signal.reason); };
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
      },
    } });
    auth.setCredentials({ access_token: 'synthetic-token', expiry_date: Date.now() + 3_600_000 });
    getAuthenticatedClient.mockResolvedValue(auth);
    calendar.mockImplementation(sdk.calendar);
    // Observe rejection immediately so advancing the clock cannot create an
    // unhandled rejection before the assertions inspect the final SDK error.
    const result = apiSyncAccount(ACCOUNT_ID, null).then(value => ({ value }), error => ({ error }));
    try {
      await started.promise;
      await expect(apiSyncAccount(ACCOUNT_ID, null)).rejects.toMatchObject({ status: 409 });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(attempts[0].signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts[0].signal.aborted).toBe(true);
      // Keep the SDK's normal retry policy: each attempted request owns a
      // fresh deadline, rather than treating 30s as a whole-sync timeout.
      await vi.runAllTimersAsync();
      expect(await result).toMatchObject({ error: { code: 'TimeoutError' } });
      expect(attempts.every(attempt => attempt.abortedAt - attempt.startedAt === 30_000)).toBe(true);
      expect(pushSyncEvents).not.toHaveBeenCalled();
      healthy = true;
      await expect(apiSyncAccount(ACCOUNT_ID, null)).resolves.toMatchObject({ status: 'success' });
      expect(pushSyncEvents).toHaveBeenCalledOnce();
    } finally {
      cleanup.abort();
      await vi.runAllTimersAsync();
      await result;
      timeout.mockRestore();
      vi.useRealTimers();
      calendar.mockReset();
    }
  });
});
