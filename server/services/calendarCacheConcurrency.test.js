import { beforeEach, describe, expect, it, vi } from 'vitest';
import { basename } from 'path';

vi.mock('../lib/fileUtils.js', async importOriginal => ({
  ...await importOriginal(), ensureDir: vi.fn(async () => {}),
  readJSONFile: vi.fn(), atomicWrite: vi.fn(),
}));
vi.mock('fs/promises', () => ({ readdir: vi.fn(), unlink: vi.fn() }));
vi.mock('./calendarAccounts.js', () => ({
  getAccount: vi.fn(), updateSyncStatus: vi.fn(async () => {}),
  updateSubcalendars: vi.fn(), mergeDiscoveredSubcalendars: vi.fn(),
}));
vi.mock('./calendarApiSync.js', () => ({ syncOutlookCalendarApi: vi.fn() }));
vi.mock('./humanActivity.js', () => ({
  calendarActivityCandidates: vi.fn(() => []), recordEvents: vi.fn(),
}));
vi.mock('./userTimezone.js', () => ({ getUserTimezone: vi.fn(async () => 'UTC') }));
vi.mock('./providers.js', () => ({ getAllProviders: vi.fn() }));
vi.mock('./settings.js', () => ({ getSettings: vi.fn() }));
vi.mock('../lib/cliProviderRun.js', () => ({
  pickCliProvider: vi.fn(), runCliProviderPrompt: vi.fn(),
}));
vi.mock('./googleAuth.js', () => ({ getAuthenticatedClient: vi.fn() }));
vi.mock('@googleapis/calendar', () => ({ calendar: vi.fn() }));

import { atomicWrite, readJSONFile } from '../lib/fileUtils.js';
import { unlink } from 'fs/promises';
import { getAccount } from './calendarAccounts.js';
import { syncOutlookCalendarApi } from './calendarApiSync.js';
import { deleteCache, loadCache, purgeDisabledSubcalendars, syncAccount } from './calendarSync.js';
import { mcpSyncAccount, pushSyncEvents } from './calendarGoogleSync.js';
import { apiSyncAccount } from './calendarGoogleApiSync.js';

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
