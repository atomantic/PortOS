import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_ENTRIES_PER_TEST, MAX_ENTRY_AGE_MS, mergeMemoStore, pruneMemoStore, readMemoEntry, readMemoRecord, resolveMemoDir, writeMemoEntry, writeMemoRecord } from './testMemoStore.js';

const KEY = 'a'.repeat(64);
const META = { test: 'server/lib/a.test.js', workspace: 'server', source: 'local', commit: 'abc' };

describe('test memo store', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  it('resolves the directory from the environment and turns off for nested test runs', () => {
    expect(resolveMemoDir({}, '/home/x')).toBe(join('/home/x', '.portos', 'test-memo'));
    expect(resolveMemoDir({ PORTOS_TEST_MEMO_DIR: '/scratch' }, '/home/x')).toBe('/scratch');
    expect(resolveMemoDir({ PORTOS_TEST_MEMO: 'off', PORTOS_TEST_MEMO_DIR: '/scratch' }, '/home/x')).toBeNull();
    expect(resolveMemoDir({ VITEST: 'true' }, '/home/x')).toBeNull();
    expect(resolveMemoDir({ VITEST: 'true', PORTOS_TEST_MEMO_DIR: '/scratch' }, '/home/x')).toBe('/scratch');
  });

  it('adds the read-only directories after the one it writes to', () => {
    const readDirs = ['/shards/0', '/shards/1'].join(delimiter);
    expect(resolveMemoDir({ PORTOS_TEST_MEMO_DIR: '/scratch', PORTOS_TEST_MEMO_READ_DIRS: readDirs }, '/home/x')).toEqual(['/scratch', '/shards/0', '/shards/1']);
    expect(resolveMemoDir({ PORTOS_TEST_MEMO_READ_DIRS: readDirs }, '/home/x')).toEqual([join('/home/x', '.portos', 'test-memo'), '/shards/0', '/shards/1']);
    // A Windows runner lists them with `;` (the composite action picks the separator).
    expect(resolveMemoDir({ PORTOS_TEST_MEMO_DIR: 'D:\\t\\memo', PORTOS_TEST_MEMO_READ_DIRS: 'D:\\t\\0;D:\\t\\1' }, '/home/x', ';')).toEqual(['D:\\t\\memo', 'D:\\t\\0', 'D:\\t\\1']);
    expect(resolveMemoDir({ PORTOS_TEST_MEMO_DIR: '/scratch', PORTOS_TEST_MEMO_READ_DIRS: '' }, '/home/x')).toBe('/scratch');
    // Off and nested-Vitest rules win over the read list.
    expect(resolveMemoDir({ PORTOS_TEST_MEMO: 'off', PORTOS_TEST_MEMO_READ_DIRS: readDirs }, '/home/x')).toBeNull();
    expect(resolveMemoDir({ VITEST: 'true', PORTOS_TEST_MEMO_READ_DIRS: readDirs }, '/home/x')).toBeNull();
  });

  it('round-trips entries and records, and reads corruption or a foreign entry as a miss', () => {
    dir = mkdtempSync(join(tmpdir(), 'portos-memo-store-'));
    expect(readMemoEntry(dir, KEY, META)).toBeNull();
    writeMemoEntry(dir, KEY, META);
    expect(readMemoEntry(dir, KEY, META)).toMatchObject({ ...META, verifiedAt: expect.any(String) });
    expect(readMemoEntry(dir, KEY, { ...META, test: 'server/lib/other.test.js' })).toBeNull();
    expect(readMemoEntry(dir, 'not-a-key', META)).toBeNull();
    // An entry ages out so a nightly re-verifies what it keeps skipping.
    expect(readMemoEntry(dir, KEY, { ...META, now: Date.now() + MAX_ENTRY_AGE_MS + 1 })).toBeNull();
    expect(readMemoEntry(dir, KEY, { ...META, now: Date.now() + MAX_ENTRY_AGE_MS - 60_000 })).not.toBeNull();
    expect(readdirSync(join(dir, 'entries', 'aa')).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    writeFileSync(join(dir, 'entries', 'aa', `${KEY}.json`), '{ corrupt');
    expect(readMemoEntry(dir, KEY, META)).toBeNull();

    expect(readMemoRecord(dir, 'server', META.test)).toBeNull();
    // Without a digest for every module the record is written in the old shape: no narrowing.
    writeMemoRecord(dir, 'server', META.test, ['server/lib/b.js', 'server/lib/a.js']);
    expect(readMemoRecord(dir, 'server', META.test)).toEqual({ modules: ['server/lib/a.js', 'server/lib/b.js'], digests: null });
    const digests = { 'server/lib/a.js': '1'.repeat(16), 'server/lib/b.js': '2'.repeat(16) };
    writeMemoRecord(dir, 'server', META.test, ['server/lib/b.js', 'server/lib/a.js'], (rel) => digests[rel] ?? null);
    expect(readMemoRecord(dir, 'server', META.test)).toEqual({ modules: ['server/lib/a.js', 'server/lib/b.js'], digests: ['1'.repeat(16), '2'.repeat(16)] });
    writeMemoRecord(dir, 'server', META.test, ['server/lib/a.js', 'server/lib/c.js'], (rel) => digests[rel] ?? null);
    expect(readMemoRecord(dir, 'server', META.test).digests).toBeNull();
    mkdirSync(join(dir, 'records', 'client'), { recursive: true });
    expect(readMemoRecord(dir, 'client', META.test)).toBeNull();
    expect(readMemoEntry(null, KEY, META)).toBeNull();
  });

  it('merges shard lineages: keeps the newer record per test, copies live entries, and skips expired or foreign files', () => {
    dir = mkdtempSync(join(tmpdir(), 'portos-memo-merge-'));
    const target = join(dir, 'target');
    const source = join(dir, 'source');
    const test = META.test;
    const other = 'server/lib/other.test.js';
    writeMemoRecord(target, 'server', test, ['server/lib/old.js']);
    writeMemoRecord(source, 'server', test, ['server/lib/new.js']);
    writeMemoRecord(source, 'server', other, ['server/lib/other.js']);
    writeMemoEntry(source, KEY, META);
    const expired = 'b'.repeat(64);
    writeMemoEntry(source, expired, META);
    const expiredPath = join(source, 'entries', 'bb', `${expired}.json`);
    writeFileSync(expiredPath, JSON.stringify({ ...JSON.parse(readFileSync(expiredPath, 'utf8')), verifiedAt: new Date(Date.now() - MAX_ENTRY_AGE_MS - 1000).toISOString() }));
    mkdirSync(join(source, 'records', 'server'), { recursive: true });
    writeFileSync(join(source, 'records', 'server', 'not-a-hash.json'), JSON.stringify({ test, modules: [], recordedAt: new Date().toISOString() }));
    // The source's record of `test` is newer than the target's.
    const sourceRecord = readdirSync(join(source, 'records', 'server')).map((name) => join(source, 'records', 'server', name))
      .find((path) => JSON.parse(readFileSync(path, 'utf8')).modules.includes('server/lib/new.js'));
    writeFileSync(sourceRecord, JSON.stringify({ ...JSON.parse(readFileSync(sourceRecord, 'utf8')), recordedAt: new Date(Date.now() + 60_000).toISOString() }));

    expect(mergeMemoStore(target, source)).toEqual({ entries: 1, records: 2 });
    expect(readMemoRecord(target, 'server', test).modules).toEqual(['server/lib/new.js']);
    expect(readMemoRecord(target, 'server', other).modules).toEqual(['server/lib/other.js']);
    expect(readMemoEntry(target, KEY, META)).not.toBeNull();
    expect(readMemoEntry(target, expired, { ...META, now: 0 })).toBeNull();
    // Merging again copies nothing: the target is now as new as the source.
    expect(mergeMemoStore(target, source)).toEqual({ entries: 0, records: 0 });
    // An older source record never replaces a newer target one.
    writeMemoRecord(target, 'server', other, ['server/lib/latest.js']);
    const older = join(dir, 'older');
    writeMemoRecord(older, 'server', other, ['server/lib/stale.js']);
    const olderPath = join(older, 'records', 'server', readdirSync(join(older, 'records', 'server'))[0]);
    writeFileSync(olderPath, JSON.stringify({ ...JSON.parse(readFileSync(olderPath, 'utf8')), recordedAt: '2020-01-01T00:00:00.000Z' }));
    expect(mergeMemoStore(target, older)).toEqual({ entries: 0, records: 0 });
    expect(readMemoRecord(target, 'server', other).modules).toEqual(['server/lib/latest.js']);
    expect(mergeMemoStore(target, join(dir, 'absent'))).toEqual({ entries: 0, records: 0 });
  });

  // A pull request reads the parked shard lineages in place (#17617): the
  // same answer the merge into one directory gave, without copying a file.
  it('reads several directories: the first valid entry and the newest record per test, writing to the first', () => {
    dir = mkdtempSync(join(tmpdir(), 'portos-memo-dirs-'));
    const [first, second, third] = ['0', '1', '2'].map((name) => join(dir, name));
    const store = [first, second, third];
    const other = 'server/lib/other.test.js';
    const setRecordedAt = (root, test, recordedAt) => {
      const path = join(root, 'records', 'server', readdirSync(join(root, 'records', 'server'))
        .find((name) => JSON.parse(readFileSync(join(root, 'records', 'server', name), 'utf8')).test === test));
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), recordedAt }));
    };
    writeMemoRecord(first, 'server', META.test, ['server/lib/old.js']);
    setRecordedAt(first, META.test, '2026-01-01T00:00:00.000Z');
    writeMemoRecord(second, 'server', META.test, ['server/lib/newest.js']);
    setRecordedAt(second, META.test, '2026-01-03T00:00:00.000Z');
    writeMemoRecord(third, 'server', META.test, ['server/lib/middle.js']);
    setRecordedAt(third, META.test, '2026-01-02T00:00:00.000Z');
    expect(readMemoRecord(store, 'server', META.test).modules).toEqual(['server/lib/newest.js']);
    // A tie keeps the earlier directory, as the merge's ">=" did.
    setRecordedAt(first, META.test, '2026-01-03T00:00:00.000Z');
    expect(readMemoRecord(store, 'server', META.test).modules).toEqual(['server/lib/old.js']);
    // A corrupt record in one directory does not hide a good one in another.
    writeMemoRecord(third, 'server', other, ['server/lib/other.js']);
    writeMemoRecord(first, 'server', other, ['server/lib/ignored.js']);
    const corrupt = join(first, 'records', 'server', readdirSync(join(first, 'records', 'server'))
      .find((name) => readFileSync(join(first, 'records', 'server', name), 'utf8').includes('ignored.js')));
    writeFileSync(corrupt, '{ corrupt');
    expect(readMemoRecord(store, 'server', other).modules).toEqual(['server/lib/other.js']);
    expect(readMemoRecord(store, 'client', other)).toBeNull();

    // An expired or foreign entry in an earlier directory falls through to a live one later.
    writeMemoEntry(first, KEY, META);
    const firstEntry = join(first, 'entries', 'aa', `${KEY}.json`);
    writeFileSync(firstEntry, JSON.stringify({ ...JSON.parse(readFileSync(firstEntry, 'utf8')), verifiedAt: new Date(Date.now() - MAX_ENTRY_AGE_MS - 1000).toISOString() }));
    expect(readMemoEntry(store, KEY, META)).toBeNull();
    writeMemoEntry(third, KEY, { ...META, commit: 'third' });
    expect(readMemoEntry(store, KEY, META)).toMatchObject({ commit: 'third' });
    expect(readMemoEntry([first, second], KEY, META)).toBeNull();

    // Writes land in the first directory only.
    const fresh = 'c'.repeat(64);
    writeMemoEntry(store, fresh, META);
    writeMemoRecord(store, 'client', META.test, ['client/src/a.js']);
    expect(readMemoEntry(first, fresh, META)).not.toBeNull();
    expect(readMemoEntry([second, third], fresh, META)).toBeNull();
    expect(readMemoRecord(first, 'client', META.test).modules).toEqual(['client/src/a.js']);
    expect(readMemoRecord([second, third], 'client', META.test)).toBeNull();
  });

  it('prunes expired, corrupt and surplus entries, and the files of deleted tests', () => {
    dir = mkdtempSync(join(tmpdir(), 'portos-memo-prune-'));
    const now = Date.parse('2026-11-23T12:00:00.000Z');
    const at = (offsetMs) => new Date(now - offsetMs).toISOString();
    const key = (index) => index.toString(16).padStart(64, '0');
    const put = (index, entry) => {
      const k = key(index);
      mkdirSync(join(dir, 'entries', k.slice(0, 2)), { recursive: true });
      writeFileSync(join(dir, 'entries', k.slice(0, 2), `${k}.json`), typeof entry === 'string' ? entry : JSON.stringify(entry));
    };
    const live = { ...META, test: 'server/lib/live.test.js' };
    const gone = { ...META, test: 'server/lib/deleted.test.js' };
    // Five entries for one test, newest first by index; the cap keeps three.
    for (let index = 1; index <= 5; index += 1) put(index, { ...live, verifiedAt: at(index * 60_000) });
    // The same test in another workspace is its own group.
    put(6, { ...live, workspace: 'db', verifiedAt: at(60_000) });
    put(7, { ...live, test: 'server/lib/other.test.js', verifiedAt: at(MAX_ENTRY_AGE_MS + 1) });
    put(8, '{ corrupt');
    put(9, { ...gone, verifiedAt: at(60_000) });
    // An in-flight temp file is not an entry and stays.
    writeFileSync(join(dir, 'entries', '00', `${key(1)}.json.123.abcd.tmp`), '{}');
    writeMemoRecord(dir, 'server', live.test, ['server/lib/live.js']);
    writeMemoRecord(dir, 'server', gone.test, ['server/lib/gone.js']);
    mkdirSync(join(dir, 'records', 'server'), { recursive: true });
    writeFileSync(join(dir, 'records', 'server', 'not-a-hash.json'), JSON.stringify({ test: live.test, modules: [] }));

    const testExists = (_workspace, test) => test !== gone.test;
    expect(pruneMemoStore(dir, { now, testExists })).toEqual({ entries: MAX_ENTRIES_PER_TEST + 1, records: 1, removedEntries: 2 + 1 + 1 + 1, removedRecords: 2 });
    const remaining = readdirSync(join(dir, 'entries', '00')).sort();
    expect(remaining).toEqual([...[1, 2, 3, 6].map((index) => `${key(index)}.json`), `${key(1)}.json.123.abcd.tmp`].sort());
    expect(readMemoRecord(dir, 'server', live.test).modules).toEqual(['server/lib/live.js']);
    expect(readMemoRecord(dir, 'server', gone.test)).toBeNull();
    // Pruning again removes nothing.
    expect(pruneMemoStore(dir, { now, testExists })).toMatchObject({ removedEntries: 0, removedRecords: 0 });

    // The shared developer store passes no cap and no existence check: only age counts.
    put(10, { ...gone, verifiedAt: at(60_000) });
    expect(pruneMemoStore(dir, { now, maxEntriesPerTest: Number.POSITIVE_INFINITY })).toEqual({ entries: 5, records: 1, removedEntries: 0, removedRecords: 0 });
    expect(pruneMemoStore(dir, { now: now + MAX_ENTRY_AGE_MS })).toMatchObject({ entries: 0, removedEntries: 5 });
    expect(pruneMemoStore(join(dir, 'absent'))).toEqual({ entries: 0, records: 0, removedEntries: 0, removedRecords: 0 });
  });
});
