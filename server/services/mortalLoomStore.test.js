import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

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

vi.mock('child_process', () => ({
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
}));

vi.mock('../lib/objects.js', () => ({
  isPlainObject: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
}));

const store = await import('./mortalLoomStore.js');
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
  it('returns null when file does not exist', async () => {
    existsResult = false;
    const result = await store.readStore();
    expect(result).toBeNull();
    expect(readFileMock).not.toHaveBeenCalled();
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
});

describe('updateStore', () => {
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
    // existsSync sequence: (1) inside readStoreAtPath → true (read attempted),
    // (2) post-read check in updateStore's guard → false (file vanished).
    // The post-read recheck must discriminate this from a transient/corrupt
    // case so we don't reject a legitimate seed.
    existsQueue.push(true, false);
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
    // existsSync sequence: (1) inside readStoreAtPath → false (file absent at
    // the start of the read), (2) post-read check in updateStore's guard →
    // true (iCloud just finished downloading the file). Even though we'd be
    // happy to seed a fresh store, the now-present file's content is unknown,
    // so we must not blindly clobber it.
    existsQueue.push(false, true);
    writeFileMock.mockResolvedValue(undefined);
    await expect(
      store.updateStore((s) => { s.goals.push({ id: 'should-not-write' }); })
    ).rejects.toThrow(/unreadable; refusing to overwrite/);
    expect(writeFileMock).not.toHaveBeenCalled();
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
  const makeFakeChild = () => {
    const handlers = {};
    const child = {
      on: vi.fn(function (evt, cb) { handlers[evt] = cb; return child; }),
      unref: vi.fn(),
      _emit: (evt, ...args) => handlers[evt]?.(...args),
    };
    return child;
  };

  // process.platform overrides aren't restored by vi.restoreAllMocks(). Capture
  // the original property descriptor before each test and restore it in
  // afterEach so an assertion failure can't leak the mutated platform into
  // unrelated test files (mirrors the updateExecutor.test.js pattern).
  let originalPlatformDescriptor;
  beforeEach(() => {
    settingsEvents.removeAllListeners('settings:updated');
    store._resetMortalLoomInitForTest();
    originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  });
  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });

  it('spawns brctl download when sync is enabled (darwin only)', async () => {
    // Force darwin so the platform guard doesn't short-circuit the test.
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    settings = { mortalloom: { enabled: true, path: '/icloud/MortalLoom.json' } };

    await store.initMortalLoomStore();

    // Spawn options must include detached:true so the child doesn't keep the
    // Node process alive on shutdown; unref() is the matching half of the
    // pattern. Without both, a slow brctl download blocks process exit.
    expect(spawnMock).toHaveBeenCalledWith(
      'brctl',
      ['download', '/icloud/MortalLoom.json'],
      expect.objectContaining({ detached: true, stdio: 'ignore' })
    );
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it('re-pins when settings:updated flips enabled on with a new path', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

    spawnMock.mockReturnValue(makeFakeChild());
    settings = { mortalloom: { enabled: true, path: '/icloud/MortalLoom.json' } };
    await store.initMortalLoomStore();
    const initialCalls = spawnMock.mock.calls.length;

    // Same path: deduped, no new spawn.
    settingsEvents.emit('settings:updated', { mortalloom: { enabled: true, path: '/icloud/MortalLoom.json' } });
    expect(spawnMock.mock.calls.length).toBe(initialCalls);

    // New path: re-pins.
    settingsEvents.emit('settings:updated', { mortalloom: { enabled: true, path: '/icloud/other/MortalLoom.json' } });
    expect(spawnMock).toHaveBeenLastCalledWith('brctl', ['download', '/icloud/other/MortalLoom.json'], expect.any(Object));
  });

  it('no-ops on non-darwin platforms (init pin AND settings-change re-pin both guarded)', async () => {
    // Earlier this test only emitted settings:updated without calling
    // initMortalLoomStore(), so the listener was never attached and the
    // assertion passed for the wrong reason. Fix: call init() so the listener
    // IS attached and the platform guard inside pinAgainstEviction is the
    // thing under test on both the immediate-pin and the event-driven path.
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    settings = { mortalloom: { enabled: true, path: '/icloud/MortalLoom.json' } };
    await store.initMortalLoomStore();
    expect(spawnMock).not.toHaveBeenCalled();

    settingsEvents.emit('settings:updated', { mortalloom: { enabled: true, path: '/icloud/MortalLoom.json' } });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('attaches the settings:updated listener even when getSettings throws during init', async () => {
    // Regression: if isMortalLoomEnabled() rejects (transient settings.json
    // read failure at boot), the listener must STILL be attached so a later
    // settings:updated event can re-pin. Earlier code set initialized=true
    // and ran the await BEFORE attaching the listener, so a throw left the
    // listener gone forever.
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

    spawnMock.mockReturnValue(makeFakeChild());
    const { getSettings } = await import('./settings.js');
    getSettings.mockRejectedValueOnce(new Error('settings.json read failed'));

    await expect(store.initMortalLoomStore()).rejects.toThrow('settings.json read failed');
    expect(spawnMock).not.toHaveBeenCalled();

    // Listener was attached before the failing await, so a later event still
    // fires pinAgainstEviction.
    settingsEvents.emit('settings:updated', { mortalloom: { enabled: true, path: '/icloud/MortalLoom.json' } });
    expect(spawnMock).toHaveBeenCalledWith('brctl', ['download', '/icloud/MortalLoom.json'], expect.any(Object));
  });

  it('reads settings exactly once during init (no half-fail window)', async () => {
    // Regression: an earlier shape called isMortalLoomEnabled() and then
    // resolvePath() — each invoking getSettings() — so init read settings
    // twice. A transient failure on the second read could skip the boot
    // pin even though the first read confirmed sync enabled. Reading once
    // and deriving both fields collapses the partial-failure window.
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

    spawnMock.mockReturnValue(makeFakeChild());
    const { getSettings } = await import('./settings.js');
    // Other tests in this file accumulate calls on the shared getSettings
    // mock — clear before asserting count to isolate this test's call pattern.
    getSettings.mockClear();
    settings = { mortalloom: { enabled: true, path: '/icloud/MortalLoom.json' } };

    await store.initMortalLoomStore();

    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith('brctl', ['download', '/icloud/MortalLoom.json'], expect.any(Object));
  });

  it('retries the initial pin on a subsequent call when the first attempt threw', async () => {
    // Regression for the listenerAttached/didInitialPin split: if
    // isMortalLoomEnabled() rejects, didInitialPin must stay false so a
    // subsequent initMortalLoomStore() call can retry the pin. The listener
    // must NOT be re-attached (otherwise events fire twice).
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

    spawnMock.mockReturnValue(makeFakeChild());
    const { getSettings } = await import('./settings.js');
    getSettings.mockRejectedValueOnce(new Error('settings.json read failed'));

    await expect(store.initMortalLoomStore()).rejects.toThrow('settings.json read failed');
    expect(spawnMock).not.toHaveBeenCalled();

    // Second call: getSettings recovers, initial pin proceeds.
    settings = { mortalloom: { enabled: true, path: '/icloud/MortalLoom.json' } };
    await store.initMortalLoomStore();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith('brctl', ['download', '/icloud/MortalLoom.json'], expect.any(Object));

    // Listener was attached on the first call, not the second — emitting once
    // must fire pinAgainstEviction once, not twice.
    spawnMock.mockClear();
    settingsEvents.emit('settings:updated', { mortalloom: { enabled: true, path: '/icloud/other/MortalLoom.json' } });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('re-pins after a disable → re-enable cycle with the same path', async () => {
    // Without resetting the dedup cache on disable, toggling sync off then
    // back on (without changing the path) silently no-ops. Settings.json
    // listeners must clear `lastPinnedPath` on disable so a subsequent
    // enable with the same path materializes again.
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

    spawnMock.mockReturnValue(makeFakeChild());
    settings = { mortalloom: { enabled: true, path: '/icloud/MortalLoom.json' } };
    await store.initMortalLoomStore();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // User disables sync — no spawn, but the dedup cache must clear.
    settingsEvents.emit('settings:updated', { mortalloom: { enabled: false, path: '/icloud/MortalLoom.json' } });
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Re-enable with the SAME path — should re-spawn brctl, not be deduped.
    settingsEvents.emit('settings:updated', { mortalloom: { enabled: true, path: '/icloud/MortalLoom.json' } });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock).toHaveBeenLastCalledWith('brctl', ['download', '/icloud/MortalLoom.json'], expect.any(Object));
  });

  it('clears lastPinnedPath when brctl is signal-killed so a later event can retry', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    settings = { mortalloom: { enabled: true, path: '/icloud/MortalLoom.json' } };
    await store.initMortalLoomStore();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Simulate signal-kill: exit handler fires with code=null, signal='SIGTERM'.
    // Earlier code skipped the cache-clear in this branch, so the dedup cache
    // would stay poisoned and a subsequent settings:updated for the same path
    // would no-op forever.
    child._emit('exit', null, 'SIGTERM');
    settingsEvents.emit('settings:updated', { mortalloom: { enabled: true, path: '/icloud/MortalLoom.json' } });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('warns once when brctl is missing, then dedupes on subsequent settings changes', async () => {
    // Regression: the brctl pin comment promised "we just log and rely on the
    // retry path" but the error handler silently swallowed ENOENT entirely.
    // Operators in a sandboxed darwin env had no signal that pinning was a
    // no-op. Now we surface ENOENT once per process, then dedupe via
    // brctlMissingWarned so settings churn doesn't spam the same warning.
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

    const child1 = makeFakeChild();
    const child2 = makeFakeChild();
    spawnMock.mockReturnValueOnce(child1).mockReturnValueOnce(child2);
    settings = { mortalloom: { enabled: true, path: '/icloud/MortalLoom.json' } };
    await store.initMortalLoomStore();

    // First brctl process fires error with ENOENT.
    child1._emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' }));
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenLastCalledWith(
      expect.stringContaining('brctl not found on PATH')
    );

    // Re-emit settings:updated with a DIFFERENT path so dedupe doesn't gate.
    settingsEvents.emit('settings:updated', { mortalloom: { enabled: true, path: '/icloud/other.json' } });
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
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

    const child1 = makeFakeChild();
    const child2 = makeFakeChild();
    spawnMock.mockReturnValueOnce(child1).mockReturnValueOnce(child2);
    settings = { mortalloom: { enabled: true, path: '/icloud/A.json' } };
    await store.initMortalLoomStore();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Newer pin for path B kicks off (e.g. user changed path before A's
    // child finished). Cache now points to B, child2 is in flight.
    settingsEvents.emit('settings:updated', { mortalloom: { enabled: true, path: '/icloud/B.json' } });
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // Stale child1 finally errors. Must NOT clear the B cache.
    child1._emit('error', Object.assign(new Error('boom'), { code: 'EAGAIN' }));

    // Re-emit settings:updated for B — dedupe should still hold (no spawn).
    settingsEvents.emit('settings:updated', { mortalloom: { enabled: true, path: '/icloud/B.json' } });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('tolerates non-string path in settings without throwing in the listener', async () => {
    // Regression: settings.json is shallow-merged and not schema-validated, so
    // mortalloom.path can land as a number / array / object. Calling .trim()
    // on a non-string throws — and an unhandled throw inside the EventEmitter
    // listener can crash the process. Listener must normalize via type-check.
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

    spawnMock.mockReturnValue(makeFakeChild());
    settings = { mortalloom: { enabled: true, path: '/icloud/MortalLoom.json' } };
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
});
