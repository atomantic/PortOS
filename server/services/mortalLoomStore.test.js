import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { pinPlatform } from '../lib/testHelper.js';

let existsResult = true;
// Queue of return values for sequential existsSync() calls. When empty, falls
// back to `existsResult`. Used to simulate ENOENT races where the file exists
// at the first check but disappears before the second.
const existsQueue = [];
const readFileMock = vi.fn();
const statMock = vi.fn();
const writeFileMock = vi.fn();
const spawnMock = vi.fn();

vi.mock('fs', () => ({
  existsSync: vi.fn(() => (existsQueue.length ? existsQueue.shift() : existsResult)),
}));

vi.mock('fs/promises', () => ({
  readFile: (...args) => readFileMock(...args),
  writeFile: (...args) => writeFileMock(...args),
  stat: (...args) => statMock(...args),
}));

vi.mock('../lib/childProcess.js', () => ({
  spawn: (...args) => spawnMock(...args),
}));

let settings = { mortalloom: { enabled: true } };
const settingsEvents = new EventEmitter();
vi.mock('./settings.js', () => ({
  getSettings: vi.fn(async () => settings),
  settingsEvents,
}));

vi.mock('../lib/fileUtils.js', () => ({
  safeJSONParse: vi.fn((raw, fallback) => {
    if (typeof raw !== 'string' || !raw) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
  }),
  readJSONFile: vi.fn(async () => null),
  dataPath: (...segs) => `/mock/data/${segs.join('/')}`,
  ensureDir: vi.fn(async () => {}),
  // atomicWrite replaced the raw writeFile(JSON.stringify) sites (#1837); route
  // it through the mocked fs/promises.writeFile (writeFileMock) so the existing
  // writeFileMock.toHaveBeenCalled / JSON.parse(calls[0][1]) asserts keep working.
  atomicWrite: vi.fn(async (filePath, data) => {
    const payload = (typeof data === 'string' || Buffer.isBuffer(data)) ? data : JSON.stringify(data, null, 2);
    const { writeFile } = await import('fs/promises');
    return writeFile(filePath, payload);
  }),
}));

vi.mock('../lib/objects.js', () => ({
  isPlainObject: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
}));

const store = await import('./mortalLoomStore.js');
// Same module instance mortalLoomStore.js imports (ESM singleton). The
// once-per-process "brctl missing" flag and the in-flight/dedupe state live
// here now, so reset them in the file-level beforeEach below for clean isolation
// across every describe block (not just the pinning/evicted ones).
const icloud = await import('../lib/icloudFile.js');
// Tests must not pay the 50ms+100ms retry backoff on every transient-error
// case. Zero delays keep the suite fast while still exercising the retry path.
// Set up + restore the original through beforeAll/afterAll so the mutation
// can't leak into other test files that import mortalLoomStore.js in the same
// Vitest worker (when isolation is disabled).
const ORIGINAL_RETRY_DELAYS = store.TRANSIENT_RETRY_DELAYS_MS;
beforeAll(() => store._setRetryDelaysForTest([0, 0]));
afterAll(() => store._setRetryDelaysForTest(ORIGINAL_RETRY_DELAYS));

beforeEach(() => {
  existsResult = true;
  existsQueue.length = 0;
  readFileMock.mockReset();
  statMock.mockReset();
  writeFileMock.mockReset();
  spawnMock.mockReset();
  icloud._resetICloudFileStateForTest(); // clears the shared brctl-missing flag + in-flight/dedupe state
  settings = { mortalloom: { enabled: true, path: '/icloud/MortalLoom.json' } };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  // Restore every spy so the console.warn replacement above doesn't leak
  // into other test files (Vitest doesn't restoreMocks by default here).
  vi.restoreAllMocks();
});

describe('readStore', () => {
  it('returns null when the store is absent (readFile ENOENT)', async () => {
    readFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    existsResult = false;
    const result = await store.readStore();
    expect(result).toBeNull();
    expect(console.warn).not.toHaveBeenCalled(); // a missing store is normal, not warn-worthy
  });

  it('returns parsed data on success', async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ goals: [{ id: 'g1' }] }));
    const result = await store.readStore();
    expect(result).toEqual({ goals: [{ id: 'g1' }] });
  });

  it('returns null and logs a warning on EAGAIN read failure', async () => {
    const err = Object.assign(new Error('Unknown system error -11: Unknown system error -11, read'), {
      code: 'EAGAIN',
      errno: -11,
      syscall: 'read',
    });
    readFileMock.mockRejectedValue(err);

    const result = await store.readStore();

    expect(result).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('MortalLoom store unavailable (EAGAIN)')
    );
  });

  it('returns null on unknown errno without code', async () => {
    const err = Object.assign(new Error('Unknown system error -11, read'), { errno: -11 });
    readFileMock.mockRejectedValue(err);

    const result = await store.readStore();

    expect(result).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('MortalLoom store unavailable (-11)')
    );
  });

  it('does not warn when file disappears between existsSync and readFile (ENOENT race)', async () => {
    const err = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    readFileMock.mockRejectedValue(err);

    const result = await store.readStore();

    expect(result).toBeNull();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('returns null when the parsed JSON is a top-level array (unexpected shape)', async () => {
    // Every consumer expects { alcoholDrinks: [...], goals: [...], ... }.
    // A bare array slipping through would let callers misread "no fields
    // missing" as "store available," reporting empty counts. Treat as null.
    readFileMock.mockResolvedValue(JSON.stringify([{ id: 'a1' }, { id: 'a2' }]));
    const result = await store.readStore();
    expect(result).toBeNull();
  });

  it('returns null when the parsed JSON is a primitive', async () => {
    readFileMock.mockResolvedValue(JSON.stringify('legacy-string-blob'));
    const result = await store.readStore();
    expect(result).toBeNull();
  });
});

describe('mlArrayIfEnabled', () => {
  it('returns null when sync disabled', async () => {
    settings = { mortalloom: { enabled: false } };
    const result = await store.mlArrayIfEnabled('goals');
    expect(result).toBeNull();
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it('returns null when store read fails transiently (regression: goals endpoint must not 500)', async () => {
    readFileMock.mockRejectedValue(Object.assign(new Error('boom'), { code: 'EAGAIN' }));
    const result = await store.mlArrayIfEnabled('goals');
    expect(result).toBeNull();
  });

  it('returns array when present', async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ goals: [{ id: 'g1' }, { id: 'g2' }] }));
    const result = await store.mlArrayIfEnabled('goals');
    expect(result).toEqual([{ id: 'g1' }, { id: 'g2' }]);
  });

  // #2742: under strict, "sync disabled" and "sync enabled but store unreadable"
  // must NOT share the null fall-through — the second is a failure a counting
  // caller has to surface as unavailable, not a fake 0.
  describe('strict distinguishes disabled from enabled-but-unreadable (#2742)', () => {
    it('returns null (no throw) when sync is disabled, even under strict', async () => {
      settings = { mortalloom: { enabled: false } };
      await expect(store.mlArrayIfEnabled('goals', { strict: true })).resolves.toBeNull();
      expect(readFileMock).not.toHaveBeenCalled();
    });

    it('returns null (no throw) when the store is genuinely absent, even under strict', async () => {
      // ENOENT: never written by either device → trustworthy empty.
      readFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      existsResult = false;
      await expect(store.mlArrayIfEnabled('goals', { strict: true })).resolves.toBeNull();
    });

    it('throws when enabled but the store read fails (EACCES) under strict', async () => {
      readFileMock.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
      await expect(store.mlArrayIfEnabled('goals', { strict: true }))
        .rejects.toThrow(/unreadable/i);
    });

    it('throws when enabled but the store is corrupt JSON under strict', async () => {
      readFileMock.mockResolvedValue('{"goals": [');
      await expect(store.mlArrayIfEnabled('goals', { strict: true }))
        .rejects.toThrow(/unreadable/i);
    });

    it('does NOT throw when the store is readable but simply lacks the key (legitimate empty)', async () => {
      // The semantic decision: a readable store with no `goals` array is "no such
      // records," not a failure — fall through to the local mirror as always.
      readFileMock.mockResolvedValue(JSON.stringify({ alcoholDrinks: [] }));
      await expect(store.mlArrayIfEnabled('goals', { strict: true })).resolves.toBeNull();
    });

    it('throws under strict when the key is PRESENT but not an array (corruption, not omitted)', async () => {
      readFileMock.mockResolvedValue(JSON.stringify({ goals: { not: 'an array' } }));
      await expect(store.mlArrayIfEnabled('goals', { strict: true }))
        .rejects.toThrow(/not an array/i);
    });

    it('non-strict treats a present-but-non-array key as null (fall through, unchanged)', async () => {
      readFileMock.mockResolvedValue(JSON.stringify({ goals: { not: 'an array' } }));
      await expect(store.mlArrayIfEnabled('goals')).resolves.toBeNull();
    });

    it('treats ENOENT as trustworthy-absent under strict regardless of sibling paths (#3716)', async () => {
      // The read path no longer probes for a pre-APFS `.MortalLoom.json.icloud`
      // sibling — that representation does not occur on supported macOS (measured:
      // zero placeholders across 223 iCloud containers holding 373 evicted files).
      // ENOENT is therefore an unqualified "no file," never a reclassify-to-
      // unreadable. Eviction cannot reach this branch: a dataless file keeps its
      // path and rejects with ICLOUD_NOT_MATERIALIZED instead.
      readFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      existsResult = true; // what the removed placeholder probe would have read as "present"
      await expect(store.mlArrayIfEnabled('goals', { strict: true })).resolves.toBeNull();
      expect(console.warn).not.toHaveBeenCalled();
    });

    it('non-strict swallows an unreadable store (unchanged): returns null', async () => {
      readFileMock.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
      await expect(store.mlArrayIfEnabled('goals')).resolves.toBeNull();
    });
  });
});

describe('readDailyLogIfEnabled strict (#2742)', () => {
  it('throws when enabled but the store is unreadable', async () => {
    readFileMock.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(store.readDailyLogIfEnabled({ strict: true })).rejects.toThrow(/unreadable/i);
  });

  it('non-strict swallows the unreadable store and returns null (unchanged)', async () => {
    readFileMock.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(store.readDailyLogIfEnabled()).resolves.toBeNull();
  });

  it('returns a real (empty) daily log when the store is readable but has no records', async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ profile: {} }));
    const result = await store.readDailyLogIfEnabled({ strict: true });
    expect(result).toEqual({ entries: [], lastEntryDate: null });
  });

  it('throws under strict when a daily-log source is present but not an array', async () => {
    // A truthy non-array (e.g. a string) would otherwise degrade to an empty log.
    readFileMock.mockResolvedValue(JSON.stringify({ alcoholDrinks: 'nope' }));
    await expect(store.readDailyLogIfEnabled({ strict: true })).rejects.toThrow(/not an array/i);
  });

  it('non-strict composes an empty log from a wrong-typed source (unchanged)', async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ alcoholDrinks: 'nope' }));
    const result = await store.readDailyLogIfEnabled();
    expect(result).toEqual({ entries: [], lastEntryDate: null });
  });
});

describe('updateStore', () => {
  // updateStore now force-materializes an evicted iCloud file (brctl download)
  // before refusing to overwrite. These baseline tests assert the refuse/seed
  // semantics WITHOUT the materialize path interfering, so pin the platform to
  // linux — materializeNow() short-circuits to `false` off darwin, leaving the
  // pre-existing guard behavior exactly as it was. The darwin materialize
  // behavior gets its own describe block below. (process.platform overrides
  // aren't restored by vi.restoreAllMocks(), so capture+restore explicitly.)
  let restorePlatform = () => {};
  beforeEach(() => {
    restorePlatform = pinPlatform('linux');
  });
  afterEach(() => restorePlatform());

  it('seeds a fresh store when the file does not exist', async () => {
    existsResult = false;
    writeFileMock.mockResolvedValue(undefined);
    const result = await store.updateStore((s) => {
      s.goals.push({ id: 'new-1' });
      return s.goals[0];
    });
    expect(result).toEqual({ id: 'new-1' });
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    const written = JSON.parse(writeFileMock.mock.calls[0][1]);
    expect(written.goals).toEqual([{ id: 'new-1' }]);
  });

  it('refuses to overwrite when file exists but read fails (regression: no silent truncation)', async () => {
    existsResult = true;
    readFileMock.mockRejectedValue(Object.assign(new Error('boom'), { code: 'EAGAIN' }));
    writeFileMock.mockResolvedValue(undefined);
    await expect(
      store.updateStore((s) => { s.goals.push({ id: 'should-not-write' }); })
    ).rejects.toThrow(/unreadable; refusing to overwrite/);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('throws a path-free message so route handlers do not leak the iCloud path to clients', async () => {
    existsResult = true;
    readFileMock.mockRejectedValue(Object.assign(new Error('boom'), { code: 'EAGAIN' }));
    writeFileMock.mockResolvedValue(undefined);
    let caught;
    await store.updateStore((s) => { s.goals.push({ id: 'x' }); }).catch((err) => { caught = err; });
    expect(caught).toBeDefined();
    expect(caught.message).not.toContain('/icloud/MortalLoom.json');
    expect(caught.message).not.toContain('/');
    // The full path still goes to server logs for diagnostics.
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('/icloud/MortalLoom.json')
    );
  });

  it('refuses to overwrite when file exists but JSON is corrupt', async () => {
    existsResult = true;
    readFileMock.mockResolvedValue('{not json');
    writeFileMock.mockResolvedValue(undefined);
    await expect(
      store.updateStore((s) => { s.goals.push({ id: 'should-not-write' }); })
    ).rejects.toThrow(/unreadable; refusing to overwrite/);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('refuses to overwrite when file parses as an array (truncation guard)', async () => {
    existsResult = true;
    readFileMock.mockResolvedValue(JSON.stringify(['unexpected', 'array', 'shape']));
    writeFileMock.mockResolvedValue(undefined);
    await expect(
      store.updateStore((s) => { s.goals.push({ id: 'should-not-write' }); })
    ).rejects.toThrow(/unreadable; refusing to overwrite/);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('seeds a fresh store when the file disappears between existsSync and read (ENOENT race)', async () => {
    // The read is attempted unconditionally (no existsSync gate — see
    // readStoreAtPathResult) and reports ENOENT, so updateStore's guard makes the
    // only existsSync call in the path: → false (file vanished). The post-read
    // recheck must discriminate this from a transient/corrupt case so we don't
    // reject a legitimate seed.
    existsQueue.push(false);
    readFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    writeFileMock.mockResolvedValue(undefined);
    const result = await store.updateStore((s) => {
      s.goals.push({ id: 'seeded' });
      return s.goals[0];
    });
    expect(result).toEqual({ id: 'seeded' });
    expect(writeFileMock).toHaveBeenCalledTimes(1);
  });

  it('refuses to overwrite when file was absent initially but appears unreadable mid-call (reverse race)', async () => {
    // The read runs first and finds nothing (file absent at the start of the
    // read); updateStore's guard then makes the only existsSync call → true
    // (iCloud just finished downloading the file). Even though we'd be happy to
    // seed a fresh store, the now-present file's content is unknown, so we must
    // not blindly clobber it.
    existsQueue.push(true);
    writeFileMock.mockResolvedValue(undefined);
    await expect(
      store.updateStore((s) => { s.goals.push({ id: 'should-not-write' }); })
    ).rejects.toThrow(/unreadable; refusing to overwrite/);
    expect(writeFileMock).not.toHaveBeenCalled();
  });
});

describe('updateStore — iCloud on-demand materialize (darwin)', () => {
  // A fake brctl child shaped for the shared bufferedSpawn helper, which reads
  // child.stdout/stderr and resolves on the `close` event. Its handler fires
  // asynchronously with the given exit code; the optional onClose hook lets a
  // test flip a flag (e.g. "now the file is materialized") atomically with the
  // close so the post-materialize re-read sees fresh state.
  const makeMaterializeChild = (exitCode, onClose) => {
    const noopStream = { on: vi.fn() };
    const child = {
      stdout: noopStream,
      stderr: noopStream,
      pid: 4242,
      on: vi.fn(function (evt, cb) {
        if (evt === 'close') setTimeout(() => { onClose?.(); cb(exitCode, null); }, 0);
        return child;
      }),
      kill: vi.fn(),
      unref: vi.fn(),
    };
    return child;
  };

  let restorePlatform = () => {};
  let originalTimeout;
  beforeEach(() => {
    restorePlatform = pinPlatform('darwin');
    originalTimeout = store.MATERIALIZE_TIMEOUT_MS;
    store._setMaterializeTimeoutForTest(50);
    store._resetMortalLoomInitForTest();
    writeFileMock.mockResolvedValue(undefined);
  });
  afterEach(() => {
    restorePlatform();
    store._setMaterializeTimeoutForTest(originalTimeout);
  });

  it('materializes an evicted dataless file then writes (the reported bug)', async () => {
    // File exists (dataless placeholder) but reads EAGAIN until brctl download
    // materializes it. updateStore must recover and write instead of refusing.
    existsResult = true;
    const eagain = Object.assign(new Error('EAGAIN'), { code: 'EAGAIN', errno: -11 });
    let materialized = false;
    readFileMock.mockImplementation(async () => {
      if (!materialized) throw eagain;
      return JSON.stringify({ goals: [{ id: 'existing' }] });
    });
    spawnMock.mockReturnValue(makeMaterializeChild(0, () => { materialized = true; }));

    const result = await store.updateStore((s) => {
      s.goals.push({ id: 'added-after-materialize' });
      return s.goals.length;
    });

    expect(spawnMock).toHaveBeenCalledWith('brctl', ['download', '/icloud/MortalLoom.json'], expect.objectContaining({ shell: false }));
    expect(result).toBe(2);
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    const written = JSON.parse(writeFileMock.mock.calls[0][1]);
    expect(written.goals).toEqual([{ id: 'existing' }, { id: 'added-after-materialize' }]);
  });

  it('still refuses when brctl exits non-zero (offline/evicted, materialize failed)', async () => {
    existsResult = true;
    readFileMock.mockRejectedValue(Object.assign(new Error('EAGAIN'), { code: 'EAGAIN', errno: -11 }));
    spawnMock.mockReturnValue(makeMaterializeChild(1));

    await expect(
      store.updateStore((s) => { s.goals.push({ id: 'should-not-write' }); })
    ).rejects.toThrow(/unreadable; refusing to overwrite/);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('refuses with an "even after materialize" diagnostic when JSON is still corrupt post-download', async () => {
    // brctl succeeds (file materialized) but the bytes are genuinely corrupt —
    // not an eviction problem. Refuse, and make the log distinguish this from
    // the never-materialized case.
    existsResult = true;
    readFileMock.mockResolvedValue('{ truncated json');
    spawnMock.mockReturnValue(makeMaterializeChild(0));

    await expect(
      store.updateStore((s) => { s.goals.push({ id: 'should-not-write' }); })
    ).rejects.toThrow(/unreadable; refusing to overwrite/);
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('even after iCloud materialize')
    );
  });

  it('seeds an absent path without a second existsSync probe for an `.icloud` placeholder (#3716)', async () => {
    // The overwrite guard used to fall back to `existsSync(.MortalLoom.json.icloud)`
    // whenever the real path was absent, and refuse the seed (paying a brctl
    // download) if that sibling existed. That representation does not occur on
    // supported macOS, so the probe is gone and an absent path just seeds.
    //
    // existsSync consumption is the assertion. The guard now makes exactly ONE
    // call (path → false, seed). The old code made three — a placeholder probe in
    // the read path, the guard's path check, then the guard's placeholder probe —
    // so it would consume the queued `true` last, refuse the seed and spawn brctl.
    // Restoring the old ternary makes this test fail (spawn called, no write),
    // which is what makes it a bypass probe rather than a restatement.
    existsQueue.push(false, false, true);
    readFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    writeFileMock.mockResolvedValue(undefined);

    const result = await store.updateStore((s) => {
      s.goals.push({ id: 'seeded' });
      return s.goals.length;
    });

    expect(result).toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    const written = JSON.parse(writeFileMock.mock.calls[0][1]);
    expect(written.goals).toEqual([{ id: 'seeded' }]);
  });

  it('does not materialize (no spawn) when seeding a genuinely new file', async () => {
    // No real file and no placeholder — a first-ever write. Must seed without
    // paying a brctl download.
    existsResult = false;
    const result = await store.updateStore((s) => { s.goals.push({ id: 'first' }); return 'ok'; });
    expect(result).toBe('ok');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(writeFileMock).toHaveBeenCalledTimes(1);
  });
});

describe('getStatus', () => {
  it('returns exists:false when file is missing', async () => {
    existsResult = false;
    const status = await store.getStatus();
    expect(status.exists).toBe(false);
    expect(status.size).toBe(0);
    expect(status.summary).toBeNull();
  });

  it('survives a transient stat/read failure with null summary and logs a warning', async () => {
    statMock.mockRejectedValue(Object.assign(new Error('boom'), { code: 'EAGAIN' }));
    const status = await store.getStatus();
    expect(status.exists).toBe(true);
    expect(status.size).toBe(0);
    expect(status.mtime).toBeNull();
    expect(status.summary).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('MortalLoom status stat unavailable (EAGAIN)')
    );
  });

  it('treats ENOENT during stat (file deleted after existsSync) as missing, not transient', async () => {
    statMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const status = await store.getStatus();
    expect(status.exists).toBe(false);
    expect(status.size).toBe(0);
    expect(status.mtime).toBeNull();
    expect(status.summary).toBeNull();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('treats ENOENT during readFile (file deleted after successful stat) as missing, not phantom', async () => {
    statMock.mockResolvedValue({ size: 42, mtime: new Date('2026-01-01T00:00:00Z') });
    readFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const status = await store.getStatus();
    expect(status.exists).toBe(false);
    expect(status.size).toBe(0);
    expect(status.mtime).toBeNull();
    expect(status.summary).toBeNull();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('returns null summary when file parses as a top-level array (unexpected shape)', async () => {
    statMock.mockResolvedValue({ size: 16, mtime: new Date('2026-01-01T00:00:00Z') });
    readFileMock.mockResolvedValue(JSON.stringify([{ id: 'a1' }, { id: 'a2' }]));
    const status = await store.getStatus();
    expect(status.exists).toBe(true);
    expect(status.size).toBe(16);
    expect(status.summary).toBeNull();
  });

  it('returns counts when file readable', async () => {
    statMock.mockResolvedValue({ size: 42, mtime: new Date('2026-01-01T00:00:00Z') });
    readFileMock.mockResolvedValue(JSON.stringify({
      goals: [{ id: 'g1' }],
      alcoholDrinks: [{ id: 'a1' }, { id: 'a2' }],
      profile: { biologicalSex: 'm' },
    }));
    const status = await store.getStatus();
    expect(status.exists).toBe(true);
    expect(status.size).toBe(42);
    expect(status.summary.goals).toBe(1);
    expect(status.summary.alcoholDrinks).toBe(2);
    expect(status.summary.hasProfile).toBe(true);
  });
});

describe('readStore — EBUSY / EIO retry (bird daemon contention)', () => {
  it('retries on EBUSY and succeeds on a later attempt', async () => {
    const transient = Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    readFileMock.mockRejectedValueOnce(transient);
    readFileMock.mockResolvedValueOnce(JSON.stringify({ goals: [{ id: 'busy-recovered' }] }));

    const result = await store.readStore();

    expect(result).toEqual({ goals: [{ id: 'busy-recovered' }] });
    expect(readFileMock).toHaveBeenCalledTimes(2);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('retries on EIO and succeeds on a later attempt', async () => {
    const transient = Object.assign(new Error('EIO'), { code: 'EIO' });
    readFileMock.mockRejectedValueOnce(transient);
    readFileMock.mockResolvedValueOnce(JSON.stringify({ goals: [{ id: 'eio-recovered' }] }));

    const result = await store.readStore();

    expect(result).toEqual({ goals: [{ id: 'eio-recovered' }] });
    expect(readFileMock).toHaveBeenCalledTimes(2);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('exhausts retries on persistent EBUSY (3 attempts total) and warns once', async () => {
    const transient = Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    readFileMock.mockRejectedValue(transient);

    const result = await store.readStore();

    expect(result).toBeNull();
    expect(readFileMock).toHaveBeenCalledTimes(3);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('MortalLoom store unavailable (EBUSY)'));
  });

  it('exhausts retries on persistent EIO (3 attempts total) and warns once', async () => {
    const transient = Object.assign(new Error('EIO'), { code: 'EIO' });
    readFileMock.mockRejectedValue(transient);

    const result = await store.readStore();

    expect(result).toBeNull();
    expect(readFileMock).toHaveBeenCalledTimes(3);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('MortalLoom store unavailable (EIO)'));
  });
});

describe('readStore — EAGAIN retry', () => {
  it('retries on transient EAGAIN and succeeds when a later attempt resolves', async () => {
    // First attempt: EAGAIN (iCloud coordination lock). Second attempt: success.
    // Without retry, the dashboard's proactive-alerts poll would surface stale
    // data + a warning every 2 minutes when iCloud is mid-coordination.
    const transient = Object.assign(new Error('EAGAIN'), { code: 'EAGAIN', errno: -11 });
    readFileMock.mockRejectedValueOnce(transient);
    readFileMock.mockResolvedValueOnce(JSON.stringify({ goals: [{ id: 'recovered' }] }));

    const result = await store.readStore();

    expect(result).toEqual({ goals: [{ id: 'recovered' }] });
    expect(readFileMock).toHaveBeenCalledTimes(2);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('does not retry on ENOENT — file-not-found is not a transient', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    readFileMock.mockRejectedValueOnce(enoent);

    const result = await store.readStore();

    expect(result).toBeNull();
    expect(readFileMock).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('exhausts retries on persistent EAGAIN (3 attempts total) and warns once', async () => {
    const transient = Object.assign(new Error('EAGAIN'), { code: 'EAGAIN', errno: -11 });
    readFileMock.mockRejectedValue(transient);

    const result = await store.readStore();

    expect(result).toBeNull();
    expect(readFileMock).toHaveBeenCalledTimes(3);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});

describe('initMortalLoomStore — brctl pinning', () => {
  // The pin now delegates to icloudFile.requestMaterialization, which only spawns
  // `brctl download` for genuinely healable iCloud paths (a path inside
  // `/Library/Mobile Documents/`). Use REAL ubiquity paths here — the ordinary
  // `/icloud/...` fixture the rest of this suite uses is deliberately NOT a
  // ubiquity path, so it would be (correctly) declined and never spawn. The
  // literal `/Library/Mobile Documents/` substring makes isHealablePath resolve
  // without a `realpath` (fs is mocked here), so these paths spawn as expected.
  const ubiq = (name) => `/Users/example/Library/Mobile Documents/iCloud~net~example~App/Documents/${name}`;

  const makeFakeChild = () => {
    const handlers = {};
    const child = {
      on: vi.fn(function (evt, cb) { handlers[evt] = cb; return child; }),
      unref: vi.fn(),
      _emit: (evt, ...args) => handlers[evt]?.(...args),
    };
    return child;
  };

  // process.platform overrides aren't restored by vi.restoreAllMocks(). Each
  // case here pins its own platform and parks the restore, which afterEach runs
  // so an assertion failure can't leak the mutated platform into unrelated test
  // files (mirrors the updateExecutor.test.js pattern).
  let restorePlatform = () => {};
  beforeEach(() => {
    settingsEvents.removeAllListeners('settings:updated');
    store._resetMortalLoomInitForTest();
    // The shared icloudFile state (including the once-per-process "brctl missing"
    // flag folded from the store's old local flag) is reset in the file-level
    // beforeEach above, so every block — this one included — starts clean.
    restorePlatform = () => {};
  });
  afterEach(() => restorePlatform());

  it('spawns brctl download when sync is enabled (darwin only)', async () => {
    // Force darwin so the platform guard doesn't short-circuit the test.
    restorePlatform = pinPlatform('darwin');

    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    settings = { mortalloom: { enabled: true, path: ubiq('MortalLoom.json') } };

    await store.initMortalLoomStore();

    // Spawn options must include detached:true so the child doesn't keep the
    // Node process alive on shutdown; unref() is the matching half of the
    // pattern. Without both, a slow brctl download blocks process exit.
    expect(spawnMock).toHaveBeenCalledWith(
      'brctl',
      ['download', ubiq('MortalLoom.json')],
      expect.objectContaining({ detached: true, stdio: 'ignore' })
    );
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it('re-pins when settings:updated flips enabled on with a new path', async () => {
    restorePlatform = pinPlatform('darwin');

    spawnMock.mockReturnValue(makeFakeChild());
    settings = { mortalloom: { enabled: true, path: ubiq('MortalLoom.json') } };
    await store.initMortalLoomStore();
    const initialCalls = spawnMock.mock.calls.length;

    // Same path: deduped, no new spawn.
    settingsEvents.emit('settings:updated', { mortalloom: { enabled: true, path: ubiq('MortalLoom.json') } });
    expect(spawnMock.mock.calls.length).toBe(initialCalls);

    // New path: re-pins.
    settingsEvents.emit('settings:updated', { mortalloom: { enabled: true, path: ubiq('other/MortalLoom.json') } });
    expect(spawnMock).toHaveBeenLastCalledWith('brctl', ['download', ubiq('other/MortalLoom.json')], expect.any(Object));
  });

  it('no-ops on non-darwin platforms (init pin AND settings-change re-pin both guarded)', async () => {
    // Earlier this test only emitted settings:updated without calling
    // initMortalLoomStore(), so the listener was never attached and the
    // assertion passed for the wrong reason. Fix: call init() so the listener
    // IS attached and the platform guard inside pinAgainstEviction is the
    // thing under test on both the immediate-pin and the event-driven path.
    restorePlatform = pinPlatform('linux');

    settings = { mortalloom: { enabled: true, path: ubiq('MortalLoom.json') } };
    await store.initMortalLoomStore();
    expect(spawnMock).not.toHaveBeenCalled();

    settingsEvents.emit('settings:updated', { mortalloom: { enabled: true, path: ubiq('MortalLoom.json') } });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('attaches the settings:updated listener even when getSettings throws during init', async () => {
    // Regression: if isMortalLoomEnabled() rejects (transient settings.json
    // read failure at boot), the listener must STILL be attached so a later
    // settings:updated event can re-pin. Earlier code set initialized=true
    // and ran the await BEFORE attaching the listener, so a throw left the
    // listener gone forever.
    restorePlatform = pinPlatform('darwin');

    spawnMock.mockReturnValue(makeFakeChild());
    const { getSettings } = await import('./settings.js');
    getSettings.mockRejectedValueOnce(new Error('settings.json read failed'));

    await expect(store.initMortalLoomStore()).rejects.toThrow('settings.json read failed');
    expect(spawnMock).not.toHaveBeenCalled();

    // Listener was attached before the failing await, so a later event still
    // fires pinAgainstEviction.
    settingsEvents.emit('settings:updated', { mortalloom: { enabled: true, path: ubiq('MortalLoom.json') } });
    expect(spawnMock).toHaveBeenCalledWith('brctl', ['download', ubiq('MortalLoom.json')], expect.any(Object));
  });

  it('reads settings exactly once during init (no half-fail window)', async () => {
    // Regression: an earlier shape called isMortalLoomEnabled() and then
    // resolvePath() — each invoking getSettings() — so init read settings
    // twice. A transient failure on the second read could skip the boot
    // pin even though the first read confirmed sync enabled. Reading once
    // and deriving both fields collapses the partial-failure window.
    restorePlatform = pinPlatform('darwin');

    spawnMock.mockReturnValue(makeFakeChild());
    const { getSettings } = await import('./settings.js');
    // Other tests in this file accumulate calls on the shared getSettings
    // mock — clear before asserting count to isolate this test's call pattern.
    getSettings.mockClear();
    settings = { mortalloom: { enabled: true, path: ubiq('MortalLoom.json') } };

    await store.initMortalLoomStore();

    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith('brctl', ['download', ubiq('MortalLoom.json')], expect.any(Object));
  });

  it('retries the initial pin on a subsequent call when the first attempt threw', async () => {
    // Regression for the listenerAttached/didInitialPin split: if
    // isMortalLoomEnabled() rejects, didInitialPin must stay false so a
    // subsequent initMortalLoomStore() call can retry the pin. The listener
    // must NOT be re-attached (otherwise events fire twice).
    restorePlatform = pinPlatform('darwin');

    spawnMock.mockReturnValue(makeFakeChild());
    const { getSettings } = await import('./settings.js');
    getSettings.mockRejectedValueOnce(new Error('settings.json read failed'));

    await expect(store.initMortalLoomStore()).rejects.toThrow('settings.json read failed');
    expect(spawnMock).not.toHaveBeenCalled();

    // Second call: getSettings recovers, initial pin proceeds.
    settings = { mortalloom: { enabled: true, path: ubiq('MortalLoom.json') } };
    await store.initMortalLoomStore();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith('brctl', ['download', ubiq('MortalLoom.json')], expect.any(Object));

    // Listener was attached on the first call, not the second — emitting once
    // must fire pinAgainstEviction once, not twice.
    spawnMock.mockClear();
    settingsEvents.emit('settings:updated', { mortalloom: { enabled: true, path: ubiq('other/MortalLoom.json') } });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('re-pins after a disable → re-enable cycle with the same path', async () => {
    // Without resetting the dedup cache on disable, toggling sync off then
    // back on (without changing the path) silently no-ops. Settings.json
    // listeners must clear `lastPinnedPath` on disable so a subsequent
    // enable with the same path materializes again.
    restorePlatform = pinPlatform('darwin');

    spawnMock.mockReturnValue(makeFakeChild());
    settings = { mortalloom: { enabled: true, path: ubiq('MortalLoom.json') } };
    await store.initMortalLoomStore();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // User disables sync — no spawn, but the dedup cache must clear.
    settingsEvents.emit('settings:updated', { mortalloom: { enabled: false, path: ubiq('MortalLoom.json') } });
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Re-enable with the SAME path — should re-spawn brctl, not be deduped.
    settingsEvents.emit('settings:updated', { mortalloom: { enabled: true, path: ubiq('MortalLoom.json') } });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock).toHaveBeenLastCalledWith('brctl', ['download', ubiq('MortalLoom.json')], expect.any(Object));
  });

  it('clears lastPinnedPath when brctl is signal-killed so a later event can retry', async () => {
    restorePlatform = pinPlatform('darwin');

    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    settings = { mortalloom: { enabled: true, path: ubiq('MortalLoom.json') } };
    await store.initMortalLoomStore();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Simulate signal-kill: exit handler fires with code=null, signal='SIGTERM'.
    // Earlier code skipped the cache-clear in this branch, so the dedup cache
    // would stay poisoned and a subsequent settings:updated for the same path
    // would no-op forever.
    child._emit('exit', null, 'SIGTERM');
    settingsEvents.emit('settings:updated', { mortalloom: { enabled: true, path: ubiq('MortalLoom.json') } });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('warns once when brctl is missing, then dedupes on subsequent settings changes', async () => {
    // Regression: the brctl pin comment promised "we just log and rely on the
    // retry path" but the error handler silently swallowed ENOENT entirely.
    // Operators in a sandboxed darwin env had no signal that pinning was a
    // no-op. Now we surface ENOENT once per process, then dedupe via
    // brctlMissingWarned so settings churn doesn't spam the same warning.
    restorePlatform = pinPlatform('darwin');

    const child1 = makeFakeChild();
    const child2 = makeFakeChild();
    spawnMock.mockReturnValueOnce(child1).mockReturnValueOnce(child2);
    settings = { mortalloom: { enabled: true, path: ubiq('MortalLoom.json') } };
    await store.initMortalLoomStore();

    // First brctl process fires error with ENOENT.
    child1._emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' }));
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenLastCalledWith(
      expect.stringContaining('brctl not found on PATH')
    );

    // Re-emit settings:updated with a DIFFERENT path so dedupe doesn't gate.
    settingsEvents.emit('settings:updated', { mortalloom: { enabled: true, path: ubiq('other.json') } });
    child2._emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' }));
    // No second warning — the missing-binary dedupe held.
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('stale-child error does not clear the cache for the current path', async () => {
    // Regression: error/exit handlers previously cleared lastPinnedPath
    // unconditionally. If a newer pinAgainstEviction() had already spawned a
    // second child for a different path, the older child's error would null
    // the cache for the *current* path, defeating dedupe and causing a
    // spurious re-spawn on the next settings:updated for the same current
    // path. Capturing `path` in the closure and comparing before clearing
    // confines each handler's cache invalidation to its own path.
    restorePlatform = pinPlatform('darwin');

    const child1 = makeFakeChild();
    const child2 = makeFakeChild();
    spawnMock.mockReturnValueOnce(child1).mockReturnValueOnce(child2);
    settings = { mortalloom: { enabled: true, path: ubiq('A.json') } };
    await store.initMortalLoomStore();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Newer pin for path B kicks off (e.g. user changed path before A's
    // child finished). Cache now points to B, child2 is in flight.
    settingsEvents.emit('settings:updated', { mortalloom: { enabled: true, path: ubiq('B.json') } });
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // Stale child1 finally errors. Must NOT clear the B cache.
    child1._emit('error', Object.assign(new Error('boom'), { code: 'EAGAIN' }));

    // Re-emit settings:updated for B — dedupe should still hold (no spawn).
    settingsEvents.emit('settings:updated', { mortalloom: { enabled: true, path: ubiq('B.json') } });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('a superseded pin for the SAME path does not clear the current pin (A → B → A)', async () => {
    // Path alone can't tell two children for the same path apart: with an
    // A → B → A settings churn, the FIRST A child is still in flight when the
    // second A pin starts. A path-only guard would let the first A child's late
    // failure clear the second A pin's sticky state, so the next settings:updated
    // for A would wrongly spawn a duplicate. The per-attempt generation guard
    // confines each failure's cache-clear to the pin that is still current.
    restorePlatform = pinPlatform('darwin');

    const childA1 = makeFakeChild();
    const childB = makeFakeChild();
    const childA2 = makeFakeChild();
    spawnMock.mockReturnValueOnce(childA1).mockReturnValueOnce(childB).mockReturnValueOnce(childA2);
    settings = { mortalloom: { enabled: true, path: ubiq('A.json') } };
    await store.initMortalLoomStore();                                                                 // childA1 (gen 1)
    settingsEvents.emit('settings:updated', { mortalloom: { enabled: true, path: ubiq('B.json') } });  // childB  (gen 2)
    settingsEvents.emit('settings:updated', { mortalloom: { enabled: true, path: ubiq('A.json') } });  // childA2 (gen 3), sticky = A
    expect(spawnMock).toHaveBeenCalledTimes(3);

    // The FIRST A child now fails — it is superseded, so it must NOT clear the
    // sticky path that belongs to the live second A pin.
    childA1._emit('exit', 1, null);

    // Re-emit A: still deduped by childA2's intact sticky, so no fourth spawn.
    settingsEvents.emit('settings:updated', { mortalloom: { enabled: true, path: ubiq('A.json') } });
    expect(spawnMock).toHaveBeenCalledTimes(3);
  });

  it('tolerates non-string path in settings without throwing in the listener', async () => {
    // Regression: settings.json is shallow-merged and not schema-validated, so
    // mortalloom.path can land as a number / array / object. Calling .trim()
    // on a non-string throws — and an unhandled throw inside the EventEmitter
    // listener can crash the process. Listener must normalize via type-check.
    restorePlatform = pinPlatform('darwin');

    spawnMock.mockReturnValue(makeFakeChild());
    settings = { mortalloom: { enabled: true, path: ubiq('MortalLoom.json') } };
    await store.initMortalLoomStore();
    spawnMock.mockClear();

    // Each non-string shape must be tolerated and fall back to the default
    // path rather than throwing.
    expect(() => {
      settingsEvents.emit('settings:updated', { mortalloom: { enabled: true, path: 42 } });
    }).not.toThrow();
    expect(() => {
      settingsEvents.emit('settings:updated', { mortalloom: { enabled: true, path: ['x'] } });
    }).not.toThrow();
    expect(() => {
      settingsEvents.emit('settings:updated', { mortalloom: { enabled: true, path: { wrapped: '/x' } } });
    }).not.toThrow();
    expect(() => {
      settingsEvents.emit('settings:updated', { mortalloom: { enabled: true, path: null } });
    }).not.toThrow();
  });

  it('does not spawn brctl for a non-iCloud (non-healable) configured path', async () => {
    // The shared helper only spawns `brctl download` for genuinely healable iCloud
    // paths. A configured path outside `/Library/Mobile Documents/` (here the
    // suite's ordinary `/icloud/...` fixture, which isHealablePath declines) must
    // not be handed a doomed download.
    restorePlatform = pinPlatform('darwin');

    spawnMock.mockReturnValue(makeFakeChild());
    settings = { mortalloom: { enabled: true, path: '/icloud/MortalLoom.json' } };
    await store.initMortalLoomStore();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('clears the sticky path when the helper declines to spawn, so the same path can retry', async () => {
    // Regression for the `if (!spawned && lastPinnedPath === path) lastPinnedPath = null`
    // guard: when requestMaterialization declines (here a synchronous spawn failure —
    // EMFILE — but equally a path that is non-healable at boot and healable once its
    // ubiquity container syncs in), the pin must NOT leave its sticky path set, or the
    // SAME path would be deduped as "already pinned" forever and never retry.
    restorePlatform = pinPlatform('darwin');

    // First spawn throws → the helper catches it and returns false (declined).
    spawnMock.mockImplementationOnce(() => { throw Object.assign(new Error('EMFILE'), { code: 'EMFILE' }); });
    settings = { mortalloom: { enabled: true, path: ubiq('MortalLoom.json') } };
    await store.initMortalLoomStore();
    expect(spawnMock).toHaveBeenCalledTimes(1); // attempted, threw — nothing in flight

    // A later settings:updated for the SAME path must re-attempt (not be deduped).
    spawnMock.mockReturnValue(makeFakeChild());
    settingsEvents.emit('settings:updated', { mortalloom: { enabled: true, path: ubiq('MortalLoom.json') } });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock).toHaveBeenLastCalledWith('brctl', ['download', ubiq('MortalLoom.json')], expect.any(Object));
  });
});

// =============================================================================
// Evicted (dataless) iCloud store — #3704
// =============================================================================
//
// Regression cover for the incident where a dataless MortalLoom.json blocked
// four libuv threadpool threads in an uncancellable read(2) and took the entire
// UI offline (express.static could no longer serve the client bundle). The fix
// is in server/lib/icloudFile.js: screen with stat() and refuse the read.
//
// These tests use a REAL ubiquity-container path — the guard is deliberately
// scoped to `/Library/Mobile Documents/` so it can't misfire on the ordinary
// `/icloud/...` fixture path the rest of this suite uses.
describe('evicted (dataless) iCloud store', () => {
  const UBIQUITY_PATH = '/Users/example/Library/Mobile Documents/iCloud~net~example~App/Documents/MortalLoom.json';
  // Dataless: real byte length, zero blocks allocated locally.
  const DATALESS_STATS = { size: 503098, blocks: 0, mtime: new Date('2026-08-08T14:35:00Z') };
  let platformSpy;

  function fakeBrctlChild() {
    const handlers = {};
    return {
      unref: vi.fn(),
      on(event, cb) { handlers[event] = cb; return this; },
      emit(event, ...args) { handlers[event]?.(...args); },
    };
  }

  beforeEach(async () => {
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    settings = { mortalloom: { enabled: true, path: UBIQUITY_PATH } };
    statMock.mockResolvedValue(DATALESS_STATS);
    spawnMock.mockReturnValue(fakeBrctlChild());
    const icloud = await import('../lib/icloudFile.js');
    icloud._resetICloudFileStateForTest();
  });

  afterEach(() => platformSpy.mockRestore());

  it('never issues a readFile against the evicted store', async () => {
    // THE regression assertion: pre-fix this called readFile and (on a real
    // wedged iCloud) never returned, stranding a threadpool thread forever.
    await store.readStore();
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it('reads as present-but-unreadable, never as a trustworthy empty', async () => {
    // Classifying an evicted store as "absent" would let a strict read report a
    // trustworthy 0 (and updateStore seed a fresh store on top of the user's
    // real, merely-offloaded data). Present-but-unreadable throws instead.
    await expect(store.mlArrayIfEnabled('goals', { strict: true }))
      .rejects.toThrow(/unreadable for key: goals/);
    // A non-strict read of the same state falls through to local data.
    await expect(store.mlArrayIfEnabled('goals')).resolves.toBeNull();
  });

  it('kicks a background brctl download so the next read can succeed', async () => {
    await store.readStore();
    expect(spawnMock).toHaveBeenCalledWith(
      'brctl',
      ['download', UBIQUITY_PATH],
      expect.objectContaining({ detached: true })
    );
  });

  it('reports the file in getStatus with a null summary, without reading it', async () => {
    const status = await store.getStatus();
    expect(status.exists).toBe(true);
    expect(status.size).toBe(503098);
    expect(status.summary).toBeNull();
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it('reads normally once iCloud materializes the file', async () => {
    statMock.mockResolvedValue({ size: 40, blocks: 8, mtime: new Date() });
    readFileMock.mockResolvedValue(JSON.stringify({ goals: [{ id: 'A' }] }));

    const result = await store.readStore();
    expect(result).toEqual({ goals: [{ id: 'A' }] });
    expect(readFileMock).toHaveBeenCalledWith(UBIQUITY_PATH, 'utf-8');
  });
});
