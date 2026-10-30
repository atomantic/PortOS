import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  updateSyncStatus: vi.fn(async () => ({})),
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
import { updateSyncStatus } from './calendarAccounts.js';
import { pushSyncEvents } from './calendarGoogleSync.js';

const ACCOUNT_ID = '33333333-3333-3333-3333-333333333333';
const CAL_ID = 'work@example.com';

const account = () => ({
  id: ACCOUNT_ID,
  name: 'Example Account',
  type: 'google-calendar',
  subcalendars: [{ calendarId: CAL_ID, name: 'Work', enabled: true, dormant: false }],
});

const accountWithCalendars = () => ({
  ...account(),
  subcalendars: [
    { calendarId: 'work@example.com', name: 'Work', enabled: true, dormant: false },
    { calendarId: 'personal@example.com', name: 'Personal', enabled: true, dormant: false },
  ],
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

  it('syncs healthy calendars when another fetch fails and preserves failed-calendar cache data', async () => {
    getAccount.mockResolvedValue(accountWithCalendars());
    const list = vi.fn(({ calendarId }) => calendarId === 'work@example.com'
      ? Promise.resolve({ data: { items: [apiItem({ start: { dateTime: '2026-03-02T10:00:00-05:00' } })] } })
      : Promise.reject(new Error('calendar permission revoked')));
    calendar.mockReturnValue({ events: { list } });
    const io = { emit: vi.fn() };

    const result = await apiSyncAccount(ACCOUNT_ID, io);

    expect(result.status).toBe('partial');
    expect(result.calendars).toEqual(expect.arrayContaining([
      expect.objectContaining({ calendarId: 'work@example.com', status: 'success' }),
      expect.objectContaining({ calendarId: 'personal@example.com', status: 'error', error: 'calendar permission revoked' }),
    ]));
    expect(pushSyncEvents).toHaveBeenCalledTimes(1);
    expect(pushSyncEvents).toHaveBeenCalledWith(
      ACCOUNT_ID,
      'work@example.com',
      'Work',
      [expect.objectContaining({ start: { dateTime: '2026-03-02T10:00:00-05:00' } })],
      null,
      expect.objectContaining({ dateRange: expect.any(Object) }),
    );
    expect(updateSyncStatus).toHaveBeenLastCalledWith(ACCOUNT_ID, 'partial');
    expect(io.emit).toHaveBeenCalledWith('calendar:sync:completed', expect.objectContaining({
      status: 'partial',
      failedCalendars: [expect.objectContaining({ calendarId: 'personal@example.com' })],
    }));
  });

  it('records an error and emits failure when every calendar fetch fails, then allows retry', async () => {
    getAccount.mockResolvedValue(accountWithCalendars());
    const list = vi.fn().mockRejectedValue(new Error('temporary Google outage'));
    calendar.mockReturnValue({ events: { list } });
    const io = { emit: vi.fn() };

    await expect(apiSyncAccount(ACCOUNT_ID, io)).rejects.toThrow('Google API sync failed for all calendars');
    expect(pushSyncEvents).not.toHaveBeenCalled();
    expect(updateSyncStatus).toHaveBeenLastCalledWith(ACCOUNT_ID, 'error');
    expect(io.emit).toHaveBeenCalledWith('calendar:sync:failed', expect.objectContaining({
      method: 'api', calendars: expect.arrayContaining([expect.objectContaining({ error: 'temporary Google outage' })]),
    }));

    calendar.mockReturnValue({ events: { list: vi.fn().mockResolvedValue({ data: { items: [] } }) } });
    await expect(apiSyncAccount(ACCOUNT_ID, null)).resolves.toMatchObject({ status: 'success' });
    expect(pushSyncEvents).toHaveBeenCalledTimes(2);
    expect(updateSyncStatus).toHaveBeenLastCalledWith(ACCOUNT_ID, 'success');
  });

  it('records rejected OAuth lookup and emits failure, then releases the account lock for retry', async () => {
    const authError = Object.assign(new Error('OAuth token refresh failed'), { code: 'EAUTH' });
    getAuthenticatedClient.mockRejectedValueOnce(authError);
    const io = { emit: vi.fn() };

    await expect(apiSyncAccount(ACCOUNT_ID, io)).rejects.toBe(authError);
    expect(updateSyncStatus).toHaveBeenLastCalledWith(ACCOUNT_ID, 'error');
    expect(io.emit).toHaveBeenCalledWith('calendar:sync:failed', expect.objectContaining({
      accountId: ACCOUNT_ID, error: 'OAuth token refresh failed', method: 'api',
    }));
    expect(pushSyncEvents).not.toHaveBeenCalled();

    mockListPage([]);
    await expect(apiSyncAccount(ACCOUNT_ID, null)).resolves.toMatchObject({ status: 'success' });
    expect(updateSyncStatus).toHaveBeenLastCalledWith(ACCOUNT_ID, 'success');
  });

  it('discards a failed calendar after a partial first page while syncing a healthy calendar', async () => {
    getAccount.mockResolvedValue(accountWithCalendars());
    const list = vi.fn(({ calendarId, pageToken }) => {
      if (calendarId === 'work@example.com') return Promise.resolve({ data: { items: [apiItem({ id: 'healthy-event' })] } });
      if (pageToken) return Promise.reject(Object.assign(new Error('second page unavailable'), { code: 'ETIMEDOUT' }));
      return Promise.resolve({ data: { items: [apiItem({ id: 'partial-event' })], nextPageToken: 'page-2' } });
    });
    calendar.mockReturnValue({ events: { list } });

    const result = await apiSyncAccount(ACCOUNT_ID, null);

    expect(result.status).toBe('partial');
    expect(result.calendars).toEqual(expect.arrayContaining([
      expect.objectContaining({ calendarId: 'personal@example.com', status: 'error', code: 'ETIMEDOUT' }),
    ]));
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ calendarId: 'personal@example.com', pageToken: undefined }));
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ calendarId: 'personal@example.com', pageToken: 'page-2' }));
    expect(pushSyncEvents).toHaveBeenCalledTimes(1);
    expect(pushSyncEvents).toHaveBeenCalledWith(
      ACCOUNT_ID, 'work@example.com', 'Work', [expect.objectContaining({ id: 'healthy-event' })], null, expect.any(Object),
    );
    expect(pushSyncEvents.mock.calls.some(([, calendarId]) => calendarId === 'personal@example.com')).toBe(false);
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
      expect(await result).toMatchObject({ error: { cause: { code: 'TimeoutError' } } });
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

// #14157: account and calendar display names (often mailbox addresses) and raw
// provider error text must stay out of the forwarded log stream.
describe('apiSyncAccount log privacy (#14157)', () => {
  let lines;
  beforeEach(() => {
    vi.clearAllMocks();
    lines = [];
    const sink = (...args) => { lines.push(args.join(' ')); };
    vi.spyOn(console, 'log').mockImplementation(sink);
    vi.spyOn(console, 'error').mockImplementation(sink);
    vi.spyOn(console, 'warn').mockImplementation(sink);
    getAccount.mockResolvedValue({
      ...accountWithCalendars(),
      name: 'zz-marker-owner@example.com',
      subcalendars: [
        { calendarId: 'zz-marker-cal-a@example.com', name: 'zz-marker-cal-a-name', enabled: true, dormant: false },
        { calendarId: 'zz-marker-cal-b@example.com', name: 'zz-marker-cal-b-name', enabled: true, dormant: false },
      ],
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const expectNoMarkers = () => {
    const out = lines.join('\n');
    expect(out).toContain(ACCOUNT_ID);
    expect(out).not.toContain('zz-marker');
    return out;
  };

  it('logs account id and status on success without names', async () => {
    mockListPage([apiItem()]);
    await apiSyncAccount(ACCOUNT_ID, null);
    expect(expectNoMarkers()).toContain('sync success');
  });

  it('logs the failure without the provider message or calendar names', async () => {
    const list = vi.fn().mockRejectedValue(new Error('no access to zz-marker-cal-a@example.com'));
    calendar.mockReturnValue({ events: { list } });
    await expect(apiSyncAccount(ACCOUNT_ID, null)).rejects.toThrow();
    expect(expectNoMarkers()).toContain('sync failed');
  });
});
