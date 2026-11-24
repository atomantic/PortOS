import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { chmod, readFile, stat, writeFile } from 'fs/promises';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as fsPromises from 'fs/promises';

// Every wrapped fs/promises function delegates to the real implementation by default;
// individual tests override with `mockRejectedValueOnce` etc. (see fileUtils.testFixtures.js).
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    mkdir: vi.fn((...args) => actual.mkdir(...args)),
    open: vi.fn((...args) => actual.open(...args)),
    readFile: vi.fn((...args) => actual.readFile(...args)),
    rename: vi.fn((...args) => actual.rename(...args)),
    writeFile: vi.fn((...args) => actual.writeFile(...args)),
    chmod: vi.fn((...args) => actual.chmod(...args)),
    readdir: vi.fn((...args) => actual.readdir(...args)),
    stat: vi.fn((...args) => actual.stat(...args)),
  };
});

import { createCachedStore } from './jsonIo.js';
import { restoreFsMocks, realFsPromises, loadRealFsPromises } from './fileUtils.testFixtures.js';

beforeAll(loadRealFsPromises);

// =============================================================================
// createCachedStore — cached JSON store with serialized writes (#2539)
// =============================================================================

describe('createCachedStore', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cached-store-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads the default when the file is absent, then round-trips a save', async () => {
    const store = createCachedStore(join(dir, 'x.json'), { n: 0 });
    expect(await store.load()).toEqual({ n: 0 });
    await store.save({ n: 5 });
    expect(await store.load()).toEqual({ n: 5 });
  });

  it('mutate persists the fn result and returns it', async () => {
    const store = createCachedStore(join(dir, 'x.json'), { n: 0 });
    const out = await store.mutate((data) => { data.n = 9; });
    expect(out).toEqual({ n: 9 });
    // Persisted to disk, not just cache
    expect(JSON.parse(await readFile(join(dir, 'x.json'), 'utf-8'))).toEqual({ n: 9 });
  });

  it('serializes concurrent read-modify-write so no update is lost', async () => {
    const file = join(dir, 'counter.json');
    const store = createCachedStore(file, { n: 0 }, { ttl: 0 });
    // ttl:0 forces every load to re-read from disk — the worst case for the
    // classic load→mutate→save clobber. Without serialization, N concurrent
    // increments race down to ~1; mutate() must land all N.
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, () => store.mutate(async (data) => {
        const current = data.n;
        await Promise.resolve(); // yield — invites interleaving
        data.n = current + 1;
      }))
    );
    expect((await store.load()).n).toBe(N);
    expect(JSON.parse(await readFile(file, 'utf-8')).n).toBe(N);
  });

  it('does not let an in-flight stale read replace a persisted mutation', async () => {
    const file = join(dir, 'feed-state.json');
    const store = createCachedStore(file, { items: [] }, { ttl: 60_000 });
    await store.save({ items: [] });
    store.invalidateCache();

    let releaseRead;
    let signalReadStarted;
    const heldRead = new Promise((resolve) => { releaseRead = resolve; });
    const readStarted = new Promise((resolve) => { signalReadStarted = resolve; });
    fsPromises.readFile.mockImplementationOnce(async (...args) => {
      const bytes = await realFsPromises.readFile(...args);
      signalReadStarted();
      await heldRead;
      return bytes;
    });

    const staleRead = store.load();
    await readStarted;
    try {
      await store.mutate((data) => { data.items.push('first'); });
      releaseRead();
      await expect(staleRead).resolves.toEqual({ items: ['first'] });

      await store.mutate((data) => { data.items.push('second'); });
      expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual({ items: ['first', 'second'] });
    } finally {
      releaseRead();
      restoreFsMocks();
    }
  });

  it('re-reads after an in-flight stale read races a persist and cache invalidation', async () => {
    const file = join(dir, 'invalidated-state.json');
    const store = createCachedStore(file, { items: [] }, { ttl: 60_000 });
    await store.save({ items: [] });
    store.invalidateCache();

    let releaseRead;
    let signalReadStarted;
    const heldRead = new Promise((resolve) => { releaseRead = resolve; });
    const readStarted = new Promise((resolve) => { signalReadStarted = resolve; });
    fsPromises.readFile.mockImplementationOnce(async (...args) => {
      const bytes = await realFsPromises.readFile(...args);
      signalReadStarted();
      await heldRead;
      return bytes;
    });

    const staleRead = store.load();
    await readStarted;
    try {
      await store.mutate((data) => { data.items.push('first'); });
      store.invalidateCache();
      releaseRead();
      await expect(staleRead).resolves.toEqual({ items: ['first'] });

      await store.mutate((data) => { data.items.push('second'); });
      expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual({ items: ['first', 'second'] });
    } finally {
      releaseRead();
      restoreFsMocks();
    }
  });

  it('mutate that returns undefined persists the mutated input', async () => {
    const store = createCachedStore(join(dir, 'x.json'), { items: [] });
    await store.mutate((data) => { data.items.push('a'); });
    await store.mutate((data) => { data.items.push('b'); });
    expect((await store.load()).items).toEqual(['a', 'b']);
  });

  it('keeps a rejected disk write out of cached reads and the next queued mutation', async () => {
    const file = join(dir, 'accounts.json');
    const store = createCachedStore(file, {}, { ttl: 60_000 });
    const original = { accounts: { example: { status: 'pending' } }, count: 0 };
    await store.save(structuredClone(original));
    const cached = await store.load();
    const diskError = Object.assign(new Error('synthetic replacement failure'), { code: 'EIO' });
    vi.mocked(fsPromises.rename).mockRejectedValueOnce(diskError);

    const rejected = store.mutate((data) => { delete data.accounts.example; });
    const rejection = expect(rejected).rejects.toBe(diskError);
    const next = store.mutate((data) => {
      expect(data.accounts.example).toEqual({ status: 'pending' });
      data.count += 1;
    });
    await rejection;
    await next;

    expect(cached).toEqual(original);
    const expected = { accounts: { example: { status: 'pending' } }, count: 1 };
    expect(await store.load()).toEqual(expected);
    expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual(expected);
  });

  it('hides an in-flight edit and discards it if the mutation callback rejects', async () => {
    const file = join(dir, 'accounts.json');
    const store = createCachedStore(file, {}, { ttl: 60_000 });
    const original = { accounts: { example: { status: 'pending' } }, count: 0 };
    await store.save(structuredClone(original));
    let signalStarted;
    let rejectEdit;
    const started = new Promise((resolve) => { signalStarted = resolve; });
    const editing = new Promise((_resolve, reject) => { rejectEdit = reject; });
    const failed = store.mutate(async (data) => {
      data.accounts.example.status = 'uncommitted';
      signalStarted();
      await editing;
    });
    const callbackError = new Error('synthetic callback failure');
    const rejection = expect(failed).rejects.toBe(callbackError);
    await started;
    const duringEdit = await store.load();
    rejectEdit(callbackError);
    await rejection;

    expect(duringEdit).toEqual(original);
    expect(await store.load()).toEqual(original);
    expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual(original);
    await store.mutate((data) => { data.count += 1; });
    expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual({ ...original, count: 1 });
  });

  it('invalidateCache forces a re-read from disk', async () => {
    const file = join(dir, 'x.json');
    const store = createCachedStore(file, { n: 0 });
    await store.load();
    await writeFile(file, JSON.stringify({ n: 42 }));
    store.invalidateCache();
    expect((await store.load()).n).toBe(42);
  });

  // Strict-read regression (#4115). Every consumer (accounts, feeds, schedules,
  // personalities) mutates through `mutate`, which persists whatever `load`
  // returned — so a corrupt file that read as the default was rewritten as the
  // default on the next mutation, deleting every record it held. Corrupt JSON is
  // the portable "present but unreadable" (same `ok: false` branch as EACCES).
  describe('strict reads (#4115)', () => {
    const CORRUPT = '{"accounts": {"a": 1},';

    it('load rejects on a corrupt file instead of fabricating the default', async () => {
      const file = join(dir, 'x.json');
      await writeFile(file, CORRUPT);
      const store = createCachedStore(file, { accounts: {} }, { context: 'accounts' });
      await expect(store.load()).rejects.toThrow(/Unreadable JSON file/);
    });

    it('mutate leaves a corrupt file byte-for-byte intact', async () => {
      const file = join(dir, 'x.json');
      await writeFile(file, CORRUPT);
      const store = createCachedStore(file, { accounts: {} });
      await expect(store.mutate((data) => { data.accounts.b = 2; })).rejects.toThrow(/Unreadable JSON file/);
      expect(await readFile(file, 'utf-8'), 'the default must never be written over the file we could not read').toBe(CORRUPT);
    });

    it('recovers once the file is repaired', async () => {
      const file = join(dir, 'x.json');
      await writeFile(file, CORRUPT);
      const store = createCachedStore(file, { accounts: {} });
      await expect(store.load()).rejects.toThrow(/Unreadable JSON file/);
      await writeFile(file, JSON.stringify({ accounts: { a: 1 } }));
      expect((await store.mutate((data) => { data.accounts.b = 2; })).accounts).toEqual({ a: 1, b: 2 });
    });
  });

  describe.skipIf(process.platform === 'win32')('file mode option (#18129)', () => {
    it('applies mode 0o600 on create and tightens existing 0o644 files on write', async () => {
      const file = join(dir, 'secret.json');
      const store = createCachedStore(file, { accounts: {} }, { mode: 0o600 });
      await store.mutate((data) => { data.accounts.a = 1; });
      expect((await stat(file)).mode & 0o777).toBe(0o600);

      await chmod(file, 0o644);
      expect((await stat(file)).mode & 0o777).toBe(0o644);

      await store.save({ accounts: { a: 2 } });
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    });
  });
});
