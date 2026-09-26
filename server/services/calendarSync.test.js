import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

import { readFile, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

vi.mock('./calendarAccounts.js', () => ({
  getAccount: vi.fn(),
  listAccounts: vi.fn(),
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

vi.mock('../lib/fileUtils.js', async importOriginal => ({
  ...makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('calendar-cache-defaults-') }),
  ensureDir: vi.fn(),
  readJSONFile: vi.fn(),
  atomicWrite: vi.fn(),
}));
vi.mock('./calendarApiSync.js', () => ({ syncOutlookCalendarApi: vi.fn() }));
vi.mock('./humanActivity.js', () => ({
  calendarActivityCandidates: vi.fn(() => []),
  recordEvents: vi.fn(),
}));
vi.mock('./userTimezone.js', () => ({ getUserTimezone: vi.fn(async () => 'UTC') }));

import { readJSONFile, atomicWrite, ensureDir } from '../lib/fileUtils.js';
import { syncOutlookCalendarApi } from './calendarApiSync.js';
import { syncAccount, logCalendarTouchpoints, loadCache, getEvents, CACHE_DIR } from './calendarSync.js';
import { autoLogTouchpoints } from './tribe.js';
import { mcpSyncAccount, mcpDiscoverCalendars, pushSyncEvents } from './calendarGoogleSync.js';
import { apiSyncAccount, apiDiscoverCalendars } from './calendarGoogleApiSync.js';
import { getAccount, listAccounts } from './calendarAccounts.js';

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


describe('Outlook batch identity reconciliation (#8635)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAccount.mockResolvedValue({
      id: ACCOUNT_ID, name: 'Example Account', enabled: true, type: 'outlook-calendar',
    });
    readJSONFile.mockResolvedValue({ events: [] });
  });

  it('counts overlapping page events once and retains the last mutable fields', async () => {
    syncOutlookCalendarApi.mockResolvedValue([
      { id: 'first', externalId: 'a', title: 'Earlier' },
      { id: 'second', externalId: 'a', title: 'Latest' },
    ]);
    expect(await syncAccount(ACCOUNT_ID)).toMatchObject({ newEvents: 1, total: 1 });
    expect(atomicWrite.mock.calls.at(-1)[1].events).toEqual([
      { id: 'first', externalId: 'a', title: 'Latest' },
    ]);
  });

  it.each(['success', 'partial'])('heals old duplicates with a stable id during %s sync', async status => {
    const omitted = { id: 'omitted', externalId: 'b' };
    readJSONFile.mockResolvedValue({ events: [
      { id: 'retained', externalId: 'a', title: 'Old' },
      { id: 'duplicate', externalId: 'a', title: 'Stale' },
      omitted,
    ] });
    syncOutlookCalendarApi.mockResolvedValue({
      status, events: [{ id: 'incoming', externalId: 'a', title: 'Current' }],
    });
    expect(await syncAccount(ACCOUNT_ID)).toMatchObject({
      newEvents: 0, total: status === 'partial' ? 2 : 1,
      pruned: status === 'partial' ? 0 : 1,
    });
    expect(atomicWrite.mock.calls.at(-1)[1].events).toEqual([
      { id: 'retained', externalId: 'a', title: 'Current' },
      ...(status === 'partial' ? [omitted] : []),
    ]);
  });
});

// Real file I/O is essential: cloning a mock's ENOENT fallback hides the bug.
afterAll(cleanupTempDataRoots);

describe('calendar cache default isolation', () => {
  const OTHER_ID = '22222222-2222-2222-2222-222222222222';

  beforeEach(async () => {
    vi.clearAllMocks();
    const actual = await vi.importActual('../lib/fileUtils.js');
    ensureDir.mockImplementation(actual.ensureDir);
    readJSONFile.mockImplementation(actual.readJSONFile);
    atomicWrite.mockImplementation(actual.atomicWrite);
    await rm(CACHE_DIR, { recursive: true, force: true });
    const accounts = [ACCOUNT_ID, OTHER_ID].map(id => ({ id, type: 'google-calendar' }));
    getAccount.mockImplementation(async id => accounts.find(account => account.id === id));
    listAccounts.mockResolvedValue(accounts);
  });

  it('keeps first Google pushes and aggregate events in their own account caches', async () => {
    const rawEvent = id => ({
      id, summary: id,
      start: { dateTime: '2099-01-01T10:00:00Z' },
      end: { dateTime: '2099-01-01T11:00:00Z' }
    });
    await pushSyncEvents(ACCOUNT_ID, 'calendar-a', 'Example A', [rawEvent('event-a')]);
    const first = await loadCache(ACCOUNT_ID);
    const absent = await loadCache(OTHER_ID);
    const anotherAbsent = await loadCache(OTHER_ID);
    expect(absent).toEqual({ syncCursor: null, events: [] });
    expect(absent).not.toBe(first);
    expect(absent.events).not.toBe(first.events);
    expect(absent).not.toBe(anotherAbsent);
    expect(absent.events).not.toBe(anotherAbsent.events);

    await pushSyncEvents(OTHER_ID, 'calendar-b', 'Example B', [rawEvent('event-b')]);
    const persisted = JSON.parse(await readFile(join(CACHE_DIR, `${OTHER_ID}.json`), 'utf8'));
    expect(persisted.events.map(event => event.apiId)).toEqual(['event-b']);
    const aggregate = await getEvents();
    expect(aggregate.total).toBe(2);
    expect(aggregate.events.map(event => [event.apiId, event.accountId])).toEqual(
      expect.arrayContaining([['event-a', ACCOUNT_ID], ['event-b', OTHER_ID]])
    );
  });

  it('isolates invalid-shape fallbacks and preserves valid stored caches', async () => {
    await ensureDir(CACHE_DIR);
    await writeFile(join(CACHE_DIR, `${ACCOUNT_ID}.json`), JSON.stringify({ events: null }));
    await writeFile(join(CACHE_DIR, `${OTHER_ID}.json`), JSON.stringify({ events: {} }));
    const first = await loadCache(ACCOUNT_ID);
    const second = await loadCache(OTHER_ID);
    expect(first).not.toBe(second);
    expect(first.events).not.toBe(second.events);
    first.events.push({ id: 'unsaved' });
    first.syncCursor = 'unsaved-cursor';
    expect(second).toEqual({ syncCursor: null, events: [] });
    expect(await loadCache(ACCOUNT_ID)).toEqual({ syncCursor: null, events: [] });

    const valid = { syncCursor: 'example-cursor', events: [{ id: 'stored-event' }], extra: true };
    const serialized = JSON.stringify(valid);
    await writeFile(join(CACHE_DIR, `${ACCOUNT_ID}.json`), serialized);
    expect(await loadCache(ACCOUNT_ID)).toEqual(valid);
    expect(await readFile(join(CACHE_DIR, `${ACCOUNT_ID}.json`), 'utf8')).toBe(serialized);
  });
});
