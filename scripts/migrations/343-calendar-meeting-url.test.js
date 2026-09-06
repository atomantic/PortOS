import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './343-calendar-meeting-url.js';

const ACCOUNT_A = '44444444-4444-4444-4444-444444444444';

describe('migration 343 — stamp meetingUrl onto cached Google events', () => {
  let rootDir;
  let cacheDir;

  const cachePath = (accountId) => join(cacheDir, `${accountId}.json`);
  const writeCache = (accountId, cache) => {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath(accountId), `${JSON.stringify(cache, null, 2)}\n`);
  };
  const readCache = (accountId) => JSON.parse(readFileSync(cachePath(accountId), 'utf8'));

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-343-'));
    cacheDir = join(rootDir, 'data', 'calendar', 'cache');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('is a no-op on a fresh install with no calendar cache directory', async () => {
    await expect(migration.up({ rootDir })).resolves.toMatchObject({
      stamped: 0,
      reason: 'no calendar cache directory',
    });
    // It must not conjure cache data an install never had.
    expect(() => readFileSync(cachePath(ACCOUNT_A), 'utf8')).toThrow();
  });

  it('stamps null on Google events lacking the field, preserving every other value', async () => {
    writeCache(ACCOUNT_A, {
      syncCursor: 'cursor-token-1',
      events: [{
        id: 'evt-1',
        externalId: 'gcal-aaaaaaaaaaaa',
        apiId: 'upstream-1',
        title: 'Design review',
        description: 'Bring mockups',
        location: 'Room 2',
        startTime: '2026-03-02T10:00:00Z',
        endTime: '2026-03-02T11:00:00Z',
        isAllDay: false,
        isCancelled: false,
        organizer: { name: 'Alice Example', email: 'alice@example.com' },
        attendees: [{ name: 'Bob Example', email: 'bob@example.com', status: 'accepted' }],
        subcalendarId: 'work@example.com',
        source: 'google-calendar',
        syncMethod: 'push',
      }],
    });

    await expect(migration.up({ rootDir })).resolves.toMatchObject({ stamped: 1, files: 1 });

    const cache = readCache(ACCOUNT_A);
    expect(cache.syncCursor).toBe('cursor-token-1');
    expect(cache.events[0]).toMatchObject({
      id: 'evt-1',
      externalId: 'gcal-aaaaaaaaaaaa',
      title: 'Design review',
      organizer: { name: 'Alice Example', email: 'alice@example.com' },
      attendees: [{ name: 'Bob Example', email: 'bob@example.com', status: 'accepted' }],
      meetingUrl: null,
    });
  });

  it('leaves an existing link intact and skips non-Google events', async () => {
    writeCache(ACCOUNT_A, {
      syncCursor: null,
      events: [
        { id: 'evt-linked', source: 'google-calendar', meetingUrl: 'https://meet.example.com/room-abc' },
        { id: 'evt-ical', source: 'ical', title: 'Imported' },
        { id: 'evt-plain', source: 'google-calendar', title: 'Needs stamping' },
      ],
    });

    await expect(migration.up({ rootDir })).resolves.toMatchObject({ stamped: 1 });

    const events = readCache(ACCOUNT_A).events;
    expect(events[0].meetingUrl).toBe('https://meet.example.com/room-abc');
    expect('meetingUrl' in events[1]).toBe(false);
    expect(events[2].meetingUrl).toBeNull();
  });

  it('is idempotent — a second run stamps nothing and rewrites no file', async () => {
    writeCache(ACCOUNT_A, { syncCursor: null, events: [{ id: 'evt-1', source: 'google-calendar' }] });

    await migration.up({ rootDir });
    const afterFirst = readFileSync(cachePath(ACCOUNT_A), 'utf8');

    await expect(migration.up({ rootDir })).resolves.toMatchObject({ stamped: 0, files: 0 });
    expect(readFileSync(cachePath(ACCOUNT_A), 'utf8')).toBe(afterFirst);
  });

  it('leaves a malformed or wrong-shaped cache file byte-identical', async () => {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath(ACCOUNT_A), '{ this is not json');
    const wrongShape = '55555555-5555-5555-5555-555555555555';
    writeCache(wrongShape, { syncCursor: null, events: 'not-an-array' });
    const malformedBefore = readFileSync(cachePath(ACCOUNT_A), 'utf8');
    const wrongShapeBefore = readFileSync(cachePath(wrongShape), 'utf8');

    await expect(migration.up({ rootDir })).resolves.toMatchObject({ stamped: 0, skipped: 2 });

    expect(readFileSync(cachePath(ACCOUNT_A), 'utf8')).toBe(malformedBefore);
    expect(readFileSync(cachePath(wrongShape), 'utf8')).toBe(wrongShapeBefore);
  });
});
