import { recordingOperatorIo } from '../test/recordingOperatorIo.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { basename } from 'path';

vi.mock('../lib/fileUtils.js', async importOriginal => ({
  ...await importOriginal(), ensureDir: vi.fn(async () => {}),
  readJSONFile: vi.fn(), atomicWrite: vi.fn(),
}));
vi.mock('fs/promises', () => ({ readdir: vi.fn(), unlink: vi.fn() }));
vi.mock('./calendarAccounts.js', () => ({
  getAccount: vi.fn(), listAccounts: vi.fn(), updateSyncStatus: vi.fn(async () => {}),
  updateSubcalendars: vi.fn(), mergeDiscoveredSubcalendars: vi.fn(), deleteAccount: vi.fn(),
}));
vi.mock('./calendarApiSync.js', () => ({ syncOutlookCalendarApi: vi.fn() }));
vi.mock('../lib/db.js', () => ({}));
vi.mock('./humanActivity.js', async importOriginal => ({
  ...await importOriginal(), recordEvents: vi.fn(), deleteEvents: vi.fn(),
}));
vi.mock('./tribe.js', () => ({ autoLogTouchpoints: vi.fn(), deleteAutoTouchpoints: vi.fn() }));
vi.mock('./dailyReview.js', () => ({}));
vi.mock('./googleOAuthAutoConfig.js', () => ({}));
vi.mock('./messageTokenExtractor.js', () => ({}));
vi.mock('./userTimezone.js', () => ({ getUserTimezone: vi.fn(async () => 'UTC') }));
vi.mock('./provider/providers.js', () => ({ getAllProviders: vi.fn(async () => ({ providers: {} })) }));
vi.mock('./settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock('../lib/cliProviderRun.js', () => ({
  pickCliProvider: vi.fn(), runCliProviderPrompt: vi.fn(),
}));
vi.mock('./googleAuth.js', () => ({ getAuthenticatedClient: vi.fn(), GOOGLE_API_TIMEOUT_MS: 30_000 }));
vi.mock('./calendarApi.js', () => ({ createCalendarApi: vi.fn() }));

import { atomicWrite, readJSONFile } from '../lib/fileUtils.js';
import { request } from '../lib/testHelper.js';
import { pickCliProvider, runCliProviderPrompt } from '../lib/cliProviderRun.js';
import { readdir, unlink } from 'fs/promises';
import { createCalendarApi } from './calendarApi.js';
import calendarRoutes from '../routes/calendar.js';
import { deleteAccount, getAccount, listAccounts, updateSubcalendars, updateSyncStatus } from './calendarAccounts.js';
import { syncOutlookCalendarApi } from './calendarApiSync.js';
import { deleteCache, getEvent, getEvents, loadCache, purgeDisabledSubcalendars, syncAccount } from './calendarSync.js';
import { mcpSyncAccount, pushSyncEvents } from './calendarGoogleSync.js';
import { apiSyncAccount } from './calendarGoogleApiSync.js';
import { getAuthenticatedClient } from './googleAuth.js';
import { recordEvents, deleteEvents } from './humanActivity.js';
import { autoLogTouchpoints, deleteAutoTouchpoints } from './tribe.js';

const ACCOUNT = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
let accounts;
let persisted;

function barrier() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}
const raw = id => ({ id, summary: id, start: { dateTime: '2099-01-01T10:00:00Z' } });
const push = (calendarId, id, accountId = ACCOUNT) =>
  pushSyncEvents(accountId, calendarId, calendarId, [raw(id)], null);

// Pause before persistence to expose competing stale reads. No sleeps or live I/O.
function holdFirstWrite() {
  const entered = barrier();
  const gate = barrier();
  atomicWrite.mockImplementationOnce(async (path, cache) => {
    entered.release();
    await gate.promise;
    persisted.set(basename(path, '.json'), structuredClone(cache));
  });
  return { entered: entered.promise, release: gate.release };
}

beforeEach(() => {
  vi.clearAllMocks();
  accounts = new Map([ACCOUNT, OTHER].map(id => [id, {
    id, name: 'Example Account', enabled: true, type: 'google-calendar',
    subcalendars: [{ calendarId: 'a', enabled: true }, { calendarId: 'b', enabled: true }],
  }]));
  persisted = new Map();
  getAccount.mockImplementation(async id => structuredClone(accounts.get(id) ?? null));
  listAccounts.mockImplementation(async () => structuredClone([...accounts.values()]));
  deleteAccount.mockImplementation(async id => accounts.delete(id));
  autoLogTouchpoints.mockResolvedValue({ created: 0, matched: 0 });
  readdir.mockImplementation(async () => [...persisted.keys()].map(id => `${id}.json`));
  readJSONFile.mockImplementation(async (path, fallback) =>
    persisted.has(basename(path, '.json'))
      ? structuredClone(persisted.get(basename(path, '.json')))
      : fallback);
  atomicWrite.mockImplementation(async (path, cache) => {
    persisted.set(basename(path, '.json'), structuredClone(cache));
  });
  unlink.mockImplementation(async path => { persisted.delete(basename(path, '.json')); });
});

describe('calendar cache mutation ownership', () => {
  it('preserves simultaneous pushes and counts while another account progresses', async () => {
    const write = holdFirstWrite();
    const first = push('a', 'event-a');
    await write.entered;
    const second = push('b', 'event-b');
    expect(await push('a', 'other-event', OTHER)).toMatchObject({ newEvents: 1, total: 1 });
    write.release();
    expect(await first).toMatchObject({ newEvents: 1, updated: 0, total: 1 });
    expect(await second).toMatchObject({ newEvents: 1, updated: 0, total: 2 });
    expect(persisted.get(ACCOUNT).events.map(e => e.apiId)).toEqual(['event-a', 'event-b']);
    expect(await push('a', 'event-a')).toMatchObject({ newEvents: 0, updated: 1, total: 2 });
  });

  it('purges against the completed push and rejects a delayed disabled-calendar push', async () => {
    await push('b', 'disabled-event');
    const write = holdFirstWrite();
    const refresh = push('a', 'fresh-event');
    await write.entered;
    accounts.get(ACCOUNT).subcalendars[1].enabled = false;
    const purge = purgeDisabledSubcalendars(ACCOUNT);
    const stalePush = push('b', 'late-event').catch(error => error);
    write.release();
    await refresh;
    expect(await purge).toEqual({ purged: 1, remaining: 1 });
    expect(await stalePush).toMatchObject({ status: 409 });
    expect(persisted.get(ACCOUNT).events.map(e => e.apiId)).toEqual(['fresh-event']);
  });

  it('drains an admitted write before deletion and refuses writes after account removal', async () => {
    const write = holdFirstWrite();
    const first = push('a', 'event-a');
    await write.entered;
    accounts.delete(ACCOUNT); // Account DELETE persists this before deleteCache.
    const deletion = deleteCache(ACCOUNT);
    const late = push('b', 'event-b').catch(error => error);
    write.release();
    await Promise.all([first, deletion]);
    expect(await late).toMatchObject({ status: 404 });
    expect(persisted.has(ACCOUNT)).toBe(false);
  });

  it('orders a cache-only clear before a new push without restoring old events', async () => {
    await push('a', 'old-event');
    await Promise.all([deleteCache(ACCOUNT), push('b', 'fresh-event')]);
    expect(persisted.get(ACCOUNT).events.map(e => e.apiId)).toEqual(['fresh-event']);
  });

  // Catches swallowed unlink failures, orphan events escaping any read surface,
  // or a rejected deletion poisoning the queue so cleanup cannot be retried.
  it('reports failed deletion, hides its orphan cache, and retries without admitting delayed writes', async () => {
    await push('a', 'removed-event');
    await push('a', 'kept-event', OTHER);
    accounts.get(OTHER).enabled = false; // Existing disabled accounts remain visible.
    const expected = await getEvents({ accountId: OTHER });
    accounts.delete(ACCOUNT);
    const failure = Object.assign(new Error('Synthetic cache deletion denied'), { code: 'EACCES' });
    unlink.mockRejectedValueOnce(failure);
    await expect(deleteCache(ACCOUNT)).rejects.toBe(failure);
    expect(persisted.has(ACCOUNT)).toBe(true);
    expect(await getEvents()).toEqual(expected);
    expect(await getEvents({ accountId: ACCOUNT })).toEqual({ events: [], total: 0 });
    expect(await getEvent(ACCOUNT, persisted.get(ACCOUNT).events[0].id)).toBeNull();
    expect(await getEvent(OTHER, expected.events[0].id)).toEqual(expected.events[0]);
    await expect(push('b', 'late-event')).rejects.toMatchObject({ status: 404 });
    await deleteCache(ACCOUNT);
    expect(persisted.has(ACCOUNT)).toBe(false);
    // An absent cache is a successful repeat deletion, not an I/O failure.
    unlink.mockRejectedValueOnce(Object.assign(new Error('Synthetic missing cache'), { code: 'ENOENT' }));
    await expect(deleteCache(ACCOUNT)).resolves.toBeUndefined();
  });

  it.each([false, true])('reconciles Outlook after clear (account removed: %s)', async removed => {
    accounts.get(ACCOUNT).type = 'outlook-calendar';
    persisted.set(ACCOUNT, { events: [{ externalId: 'old', title: 'Old event' }] });
    const fetched = barrier();
    const entered = barrier();
    syncOutlookCalendarApi.mockImplementationOnce(async () => {
      entered.release();
      return fetched.promise;
    });
    const run = syncAccount(ACCOUNT, null).catch(error => error);
    await entered.promise;
    if (removed) accounts.delete(ACCOUNT);
    await deleteCache(ACCOUNT);
    fetched.release({ events: [{ externalId: 'fresh', title: 'Fresh event' }], status: 'partial' });
    const result = await run;
    if (removed) {
      expect(result).toMatchObject({ status: 404 });
      expect(persisted.has(ACCOUNT)).toBe(false);
    } else {
      expect(result).toMatchObject({ newEvents: 1, total: 1, pruned: 0, status: 'partial' });
      expect(persisted.get(ACCOUNT).events.map(e => e.externalId)).toEqual(['fresh']);
    }
  });

  it('preserves partial Outlook results and releases admission after provider failure', async () => {
    accounts.get(ACCOUNT).type = 'outlook-calendar';
    persisted.set(ACCOUNT, { events: [{ externalId: 'old' }] });
    syncOutlookCalendarApi.mockRejectedValueOnce(new Error('Provider failed'));
    await expect(syncAccount(ACCOUNT, null)).rejects.toMatchObject({ status: 502 });
    syncOutlookCalendarApi.mockResolvedValueOnce({ events: [{ externalId: 'fresh' }], status: 'partial' });
    expect(await syncAccount(ACCOUNT, null)).toMatchObject({ total: 2, pruned: 0, status: 'partial' });
  });

  it('recovers after a failed save and does not share missing-cache arrays', async () => {
    atomicWrite.mockRejectedValueOnce(new Error('Write failed'));
    await expect(push('a', 'failed')).rejects.toThrow('Write failed');
    expect(await push('b', 'saved')).toMatchObject({ total: 1 });
    readJSONFile.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const missing = await loadCache(OTHER);
    missing.events.push({ id: 'unsaved' });
    expect((await loadCache(OTHER)).events).toEqual([]);
  });
});

describe.each(['Google', 'Outlook'])('%s derived calendar records', provider => {
  let app;
  let timeline;
  let touchpoints;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/calendar', calendarRoutes);
    timeline = new Map();
    touchpoints = new Map();
    recordEvents.mockImplementation(async rows => {
      for (const row of rows) timeline.set(row.dedupeKey, row);
    });
    autoLogTouchpoints.mockImplementation(async rows => {
      for (const row of rows) touchpoints.set(row.dedupeKey, row);
      return { created: rows.length, matched: rows.length };
    });
    deleteEvents.mockImplementation(async ({ accountId, subcalendarIds, calendarEventIds }) => {
      if (!subcalendarIds && !calendarEventIds) {
        for (const [k, v] of timeline) if (v.accountId === accountId) timeline.delete(k);
        return;
      }
      const subs = new Set(subcalendarIds || []);
      const evts = new Set(calendarEventIds || []);
      for (const [k, v] of timeline) {
        if (v.accountId === accountId && (subs.has(v.metadata?.subcalendarId) || (!v.metadata?.subcalendarId && evts.has(v.metadata?.externalId)))) {
          timeline.delete(k);
        }
      }
    });
    deleteAutoTouchpoints.mockImplementation(async ({ accountId, subcalendarIds, calendarEventIds }) => {
      if (!subcalendarIds && !calendarEventIds) {
        for (const [k, v] of touchpoints) if (v.calendarAccountId === accountId) touchpoints.delete(k);
        return;
      }
      const subs = new Set(subcalendarIds || []);
      const evts = new Set(calendarEventIds || []);
      for (const [k, v] of touchpoints) {
        if (v.calendarAccountId === accountId && (subs.has(v.metadata?.subcalendarId) || (!v.metadata?.subcalendarId && evts.has(v.calendarEventId)))) {
          touchpoints.delete(k);
        }
      }
    });
    updateSubcalendars.mockImplementation(async (id, subcalendars) => {
      const account = accounts.get(id);
      if (!account) return null;
      account.subcalendars = subcalendars;
      return structuredClone(account);
    });
  });

  function syncFinishedEvent(beforeResponse = async () => {}) {
    const endTime = new Date(Date.now() - 60_000).toISOString();
    const startTime = new Date(Date.now() - 120_000).toISOString();
    const title = 'Finished meeting';
    const organizer = { email: 'alice@example.com' };
    if (provider === 'Outlook') {
      accounts.get(ACCOUNT).type = 'outlook-calendar';
      syncOutlookCalendarApi.mockImplementationOnce(async () => {
        await beforeResponse();
        return { events: [{ externalId: 'finished', title, startTime, endTime, organizer }], status: 'success' };
      });
      return syncAccount(ACCOUNT, null);
    }

    accounts.get(ACCOUNT).subcalendars = [{ calendarId: 'a', enabled: true }];
    getAuthenticatedClient.mockResolvedValueOnce({});
    createCalendarApi.mockReturnValueOnce({ listEvents: async () => {
      await beforeResponse();
      return { data: { items: [{ id: 'finished', summary: title, start: { dateTime: startTime }, end: { dateTime: endTime }, organizer }] } };
    } });
    return apiSyncAccount(ACCOUNT, null);
  }

  it.each(['Tribe', 'Timeline'])('writes finished events and drains a paused %s write before deletion', async store => {
    expect(await syncFinishedEvent()).toMatchObject({ status: 'success', newEvents: 1 });
    expect([...timeline.values()]).toMatchObject([{ accountId: ACCOUNT, title: 'Finished meeting' }]);
    expect([...touchpoints.values()]).toMatchObject([{ calendarAccountId: ACCOUNT, summary: 'Finished meeting' }]);

    const writing = barrier();
    const resume = barrier();
    const metadataRemoved = barrier();
    const record = store === 'Tribe' ? autoLogTouchpoints : recordEvents;
    const storeRows = record.getMockImplementation();
    record.mockImplementationOnce(async rows => {
      writing.release();
      await resume.promise;
      return storeRows(rows);
    });
    deleteAccount.mockImplementationOnce(async id => {
      const removed = accounts.delete(id);
      metadataRemoved.release();
      return removed;
    });
    const syncing = syncFinishedEvent();
    await writing.promise;
    const deleting = request(app).delete(`/calendar/accounts/${ACCOUNT}`).then(response => response);
    await metadataRemoved.promise;
    // Give the delete route's microtasks a turn to reach the cache queue.
    await new Promise(resolve => setImmediate(resolve));
    const unlinkedWhileWriting = unlink.mock.calls.length > 0;
    resume.release();
    const [syncResult, deleteResponse] = await Promise.all([syncing, deleting]);

    expect(syncResult.status).toBe('success');
    expect(deleteResponse.status).toBe(204);
    expect(unlinkedWhileWriting).toBe(false);
    expect(accounts.has(ACCOUNT)).toBe(false);
    expect(persisted.has(ACCOUNT)).toBe(false);
    expect(timeline.size).toBe(0);
    expect(touchpoints.size).toBe(0);
  });

  it('refuses provider results returned after deletion without writing any copies', async () => {
    const fetching = barrier();
    const response = barrier();
    const syncing = syncFinishedEvent(() => {
      fetching.release();
      return response.promise;
    }).catch(error => error);
    await fetching.promise;
    const deleted = await request(app).delete(`/calendar/accounts/${ACCOUNT}`);
    response.release();

    expect(deleted.status).toBe(204);
    expect(await syncing).toMatchObject({ status: 404 });
    expect(atomicWrite).not.toHaveBeenCalled();
    expect(recordEvents).not.toHaveBeenCalled();
    expect(autoLogTouchpoints).not.toHaveBeenCalled();
  });

  it('keeps sync successful when either derived store fails', async () => {
    autoLogTouchpoints.mockRejectedValueOnce(new Error('Synthetic Tribe write failure'));
    expect(await syncFinishedEvent()).toMatchObject({ status: 'success' });
    expect(timeline.size).toBe(1);
    expect(touchpoints.size).toBe(0);

    recordEvents.mockRejectedValueOnce(new Error('Synthetic Timeline write failure'));
    expect(await syncFinishedEvent()).toMatchObject({ status: 'success' });
    expect(touchpoints.size).toBe(1);
  });

  if (provider === 'Google') {
    it('PUT /calendar/accounts/:id/subcalendars erases cache, Timeline, and Tribe rows for disabled subcalendars while keeping enabled ones (#18229)', async () => {
      const endTime = new Date(Date.now() - 60_000).toISOString();
      const startTime = new Date(Date.now() - 120_000).toISOString();
      accounts.get(ACCOUNT).subcalendars = [
        { calendarId: 'a', name: 'Work', enabled: true, dormant: false },
        { calendarId: 'b', name: 'Personal', enabled: true, dormant: false },
      ];
      getAuthenticatedClient.mockResolvedValueOnce({});
      createCalendarApi.mockReturnValueOnce({
        listEvents: async ({ calendarId }) => ({
          data: {
            items: [{
              id: `evt-${calendarId}`,
              summary: `Meeting on ${calendarId}`,
              start: { dateTime: startTime },
              end: { dateTime: endTime },
              organizer: { email: 'alice@example.com' },
            }],
          },
        }),
      });
      await apiSyncAccount(ACCOUNT, null);
      expect(persisted.get(ACCOUNT).events.map(e => e.subcalendarId).sort()).toEqual(['a', 'b']);
      expect(timeline.size).toBe(2);
      expect(touchpoints.size).toBe(2);

      const response = await request(app)
        .put(`/calendar/accounts/${ACCOUNT}/subcalendars`)
        .send({
          subcalendars: [
            { calendarId: 'a', name: 'Work', enabled: true, dormant: false },
            { calendarId: 'b', name: 'Personal', enabled: false, dormant: false },
          ],
        });

      expect(response.status).toBe(200);
      expect(persisted.get(ACCOUNT).events.map(e => e.subcalendarId)).toEqual(['a']);
      expect([...timeline.values()].map(e => e.metadata.subcalendarId)).toEqual(['a']);
      expect([...touchpoints.values()].map(t => t.metadata.subcalendarId)).toEqual(['a']);
    });
  }
});

describe('Google provider event identity', () => {
  function syncMcp(io, ...pages) {
    pickCliProvider.mockReturnValueOnce({ provider: { id: 'claude-code' } });
    runCliProviderPrompt.mockImplementationOnce(async ({ prompt }) => {
      const [, timeMin, timeMax] = prompt.match(/date range (\S+Z) to (\S+Z)/);
      return {
        text: JSON.stringify({
          calendars: [{ calendarId: 'a', timeMin, timeMax, complete: true, nextPageToken: null, events: pages.flat() }],
        }),
        exitCode: 0,
      };
    });
    return mcpSyncAccount(ACCOUNT, io);
  }

  function syncApi(io, ...pages) {
    getAuthenticatedClient.mockResolvedValueOnce({});
    const list = vi.fn();
    for (const [index, items] of pages.entries()) {
      list.mockResolvedValueOnce({ data: { items, nextPageToken: index + 1 < pages.length ? `page-${index + 2}` : undefined } });
    }
    createCalendarApi.mockReturnValueOnce({ listEvents: list });
    return apiSyncAccount(ACCOUNT, io);
  }

  it.each([['MCP', syncMcp], ['API', syncApi]])(
    'skips unidentified %s events on every replay and resumes windowed pruning on a clean batch',
    async (_provider, sync) => {
      accounts.get(ACCOUNT).subcalendars = [{ calendarId: 'a', name: 'Work', enabled: true }];
      const io = recordingOperatorIo();
      const start = { dateTime: new Date(Date.now() - 120_000).toISOString() };
      const end = { dateTime: new Date(Date.now() - 60_000).toISOString() };
      const valid = { id: 'stable', summary: 'Finished meeting', start, end, organizer: { email: 'alice@example.com' } };
      const malformed = [undefined, '', '  ', 7].map(id => ({ ...valid, id, summary: 'Unidentified meeting' }));
      malformed.push(null);
      await pushSyncEvents(ACCOUNT, 'a', 'Work', [
        { id: 'omitted', start, end },
        { id: 'outside-window', start: { dateTime: '2000-01-01T10:00:00Z' } },
      ]);
      recordEvents.mockClear();
      autoLogTouchpoints.mockClear();

      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await sync(io, malformed)).toMatchObject({
          status: 'partial', newEvents: 0, pruned: 0, reason: expect.stringContaining('invalid provider event IDs'),
        });
      }
      expect(recordEvents).not.toHaveBeenCalled();
      expect(autoLogTouchpoints).not.toHaveBeenCalled();

      const mixed = await sync(io, malformed, [valid]);
      expect(mixed).toMatchObject({
        status: 'partial', newEvents: 1, pruned: 0,
        calendars: [{ calendarId: 'a', status: 'partial' }],
      });
      expect(updateSyncStatus).toHaveBeenLastCalledWith(ACCOUNT, 'partial');
      expect(io.emit).toHaveBeenCalledWith('calendar:sync:completed', expect.objectContaining({
        status: 'partial', reason: expect.stringContaining('invalid provider event IDs'),
      }));
      const cached = persisted.get(ACCOUNT).events;
      expect(cached.map(event => event.apiId)).toEqual(['omitted', 'outside-window', 'stable']);
      const { id, externalId } = cached.find(event => event.apiId === valid.id);
      const [activity] = recordEvents.mock.lastCall;
      const [touchpoints] = autoLogTouchpoints.mock.lastCall;
      expect(activity).toMatchObject([{ title: valid.summary, metadata: { externalId } }]);
      expect(touchpoints).toMatchObject([{ summary: valid.summary, calendarEventId: externalId }]);

      expect(await sync(io, [valid])).toMatchObject({ status: 'success', newEvents: 0, updated: 1, pruned: 1 });
      expect(persisted.get(ACCOUNT).events.map(event => event.apiId)).toEqual(['outside-window', 'stable']);
      expect(persisted.get(ACCOUNT).events[1]).toMatchObject({ id, externalId });
      expect(recordEvents.mock.lastCall[0]).toMatchObject([{ dedupeKey: activity[0].dedupeKey }]);
      expect(autoLogTouchpoints.mock.lastCall[0]).toMatchObject([{ dedupeKey: touchpoints[0].dedupeKey }]);
    },
  );
});

describe.each([
  ['Outlook', syncAccount], ['MCP', mcpSyncAccount], ['Google API', apiSyncAccount],
])('%s provider admission', (_name, sync) => {
  it('reserves before lookup and releases on lookup failure', async () => {
    const lookup = barrier();
    getAccount.mockImplementationOnce(() => lookup.promise);
    const first = sync(ACCOUNT, null).catch(error => error);
    await expect(sync(ACCOUNT, null)).rejects.toMatchObject({ status: 409 });
    lookup.release(null);
    expect(await first).toMatchObject({ status: 404 });
    getAccount.mockResolvedValueOnce(null);
    await expect(sync(ACCOUNT, null)).rejects.toMatchObject({ status: 404 });
  });
});
