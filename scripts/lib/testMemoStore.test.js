import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_ENTRY_AGE_MS, mergeMemoStore, readMemoEntry, readMemoRecord, resolveMemoDir, writeMemoEntry, writeMemoRecord } from './testMemoStore.js';

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
    expect(readMemoRecord(dir, 'server', META.test)).toEqual({ modules: ['server/lib/a.js', 'server/lib/b.js'], digests: null, served: null });
    const digests = { 'server/lib/a.js': '1'.repeat(16), 'server/lib/b.js': '2'.repeat(16) };
    writeMemoRecord(dir, 'server', META.test, ['server/lib/b.js', 'server/lib/a.js'], (rel) => digests[rel] ?? null);
    expect(readMemoRecord(dir, 'server', META.test)).toEqual({ modules: ['server/lib/a.js', 'server/lib/b.js'], digests: ['1'.repeat(16), '2'.repeat(16)], served: null });
    writeMemoRecord(dir, 'server', META.test, ['server/lib/a.js', 'server/lib/c.js'], (rel) => digests[rel] ?? null);
    expect(readMemoRecord(dir, 'server', META.test).digests).toBeNull();
    mkdirSync(join(dir, 'records', 'client'), { recursive: true });
    expect(readMemoRecord(dir, 'client', META.test)).toBeNull();
    expect(readMemoEntry(null, KEY, META)).toBeNull();
  });

  // #17616: what a real-Chromium fixture served rides in the record, sorted and deduplicated.
  it('round-trips a served-file record and refuses a malformed one', () => {
    dir = mkdtempSync(join(tmpdir(), 'portos-memo-store-'));
    const served = { roots: ['client'], files: ['client/src/b.jsx', 'client/src/a.jsx', 'client/src/a.jsx'] };
    writeMemoRecord(dir, 'client', META.test, ['server/lib/a.js'], () => '1'.repeat(16), served);
    expect(readMemoRecord(dir, 'client', META.test)).toEqual({
      modules: ['server/lib/a.js'], digests: ['1'.repeat(16)], served: { roots: ['client'], files: ['client/src/a.jsx', 'client/src/b.jsx'] },
    });
    const path = join(dir, 'records', 'client', `${createHash('sha256').update(META.test).digest('hex')}.json`);
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    for (const bad of [{ roots: [], files: [] }, { roots: ['client'] }, { roots: ['client'], files: ['../outside.js'] },
      { roots: ['/abs'], files: [] }, { roots: ['client'], files: ['client/./a.js'] }, { roots: ['client'], files: ['C:/a.js'] }, 'client']) {
      writeFileSync(path, JSON.stringify({ ...stored, served: bad }));
      expect(readMemoRecord(dir, 'client', META.test).served, JSON.stringify(bad)).toBeNull();
    }
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
});
