import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_ENTRY_AGE_MS, readMemoEntry, readMemoRecord, resolveMemoDir, writeMemoEntry, writeMemoRecord } from './testMemoStore.js';

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
    writeMemoRecord(dir, 'server', META.test, ['server/lib/b.js', 'server/lib/a.js']);
    expect(readMemoRecord(dir, 'server', META.test)).toEqual(['server/lib/a.js', 'server/lib/b.js']);
    mkdirSync(join(dir, 'records', 'client'), { recursive: true });
    expect(readMemoRecord(dir, 'client', META.test)).toBeNull();
    expect(readMemoEntry(null, KEY, META)).toBeNull();
  });
});
