import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `stat`/`readFile` are mocked so a dataless file can be simulated on any
// platform (an evicted iCloud file cannot be created in a test), and so the
// suite can assert that the guarded read never issues `readFile` at all.
const statMock = vi.fn();
const readFileMock = vi.fn();
const spawnMock = vi.fn();

// Partial mocks (spread the original) rather than bare replacements: icloudFile
// pulls in `bufferedSpawn` -> `spawnCwd` -> `fileUtils` for the awaited
// `materializeAndWait`, and those need the real `execFile`/`fs/promises` exports.
// A bare replacement makes the whole suite fail to import with "No X export is
// defined on the mock", which looks like 39 broken assertions rather than one
// missing export.
vi.mock('fs/promises', async (importOriginal) => ({
  ...await importOriginal(),
  stat: (...args) => statMock(...args),
  readFile: (...args) => readFileMock(...args),
}));

vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal(),
  spawn: (...args) => spawnMock(...args),
}));

const UBIQUITY_DIR = '/Users/example/Library/Mobile Documents/iCloud~com~example~App/Documents';
const ICLOUD_PATH = `${UBIQUITY_DIR}/Store.json`;
const LOCAL_PATH = '/Users/example/projects/app/data/store.json';

// A dataless (evicted) file: real byte length, zero blocks allocated locally.
const datalessStats = { size: 503098, blocks: 0 };
const materializedStats = { size: 503098, blocks: 984 };

// A stand-in for the detached `brctl download` child requestMaterialization spawns.
function makeFakeChild() {
  const handlers = {};
  return {
    unref: vi.fn(),
    on(event, cb) { handlers[event] = cb; return this; },
    emit(event, ...args) { handlers[event]?.(...args); },
  };
}

let icloud;
let warnSpy;
let logSpy;
let platformSpy;

beforeEach(async () => {
  vi.resetModules();
  statMock.mockReset();
  readFileMock.mockReset();
  spawnMock.mockReset();
  // The guard is macOS-only; pin the platform so the suite is deterministic on
  // Linux CI as well as a developer Mac.
  platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  spawnMock.mockReturnValue(makeFakeChild());
  icloud = await import('./icloudFile.js');
  icloud._resetICloudFileStateForTest();
});

afterEach(() => {
  platformSpy.mockRestore();
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

describe('isUbiquityPath', () => {
  it('recognizes a ubiquity-container path', () => {
    expect(icloud.isUbiquityPath(ICLOUD_PATH)).toBe(true);
  });

  it('rejects an ordinary path and non-strings', () => {
    expect(icloud.isUbiquityPath(LOCAL_PATH)).toBe(false);
    expect(icloud.isUbiquityPath(undefined)).toBe(false);
    expect(icloud.isUbiquityPath(42)).toBe(false);
  });
});

describe('isDatalessStats', () => {
  it('is true only for a non-empty file with zero local blocks', () => {
    expect(icloud.isDatalessStats(datalessStats)).toBe(true);
    expect(icloud.isDatalessStats(materializedStats)).toBe(false);
  });

  it('is false for a genuinely empty file (size 0), not dataless', () => {
    // A 0-byte file legitimately has 0 blocks — treating it as evicted would
    // refuse to read a real, readable, empty file forever.
    expect(icloud.isDatalessStats({ size: 0, blocks: 0 })).toBe(false);
  });

  it('is false for a missing stats object', () => {
    expect(icloud.isDatalessStats(null)).toBe(false);
    expect(icloud.isDatalessStats(undefined)).toBe(false);
  });
});

describe('isSuspectedDataless', () => {
  it('screens a dataless ubiquity file', async () => {
    statMock.mockResolvedValue(datalessStats);
    await expect(icloud.isSuspectedDataless(ICLOUD_PATH)).resolves.toBe(true);
  });

  it('does not stat a non-ubiquity path at all', async () => {
    // An ordinary APFS file can report blocks:0 when transparently compressed,
    // so the guard must never apply outside a ubiquity container.
    await expect(icloud.isSuspectedDataless(LOCAL_PATH)).resolves.toBe(false);
    expect(statMock).not.toHaveBeenCalled();
  });

  it('is inert off darwin', async () => {
    platformSpy.mockReturnValue('linux');
    await expect(icloud.isSuspectedDataless(ICLOUD_PATH)).resolves.toBe(false);
    expect(statMock).not.toHaveBeenCalled();
  });

  it('treats a stat failure as not-dataless (absent/EACCES is the caller\'s path)', async () => {
    statMock.mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' }));
    await expect(icloud.isSuspectedDataless(ICLOUD_PATH)).resolves.toBe(false);
  });
});

describe('readIfMaterialized', () => {
  it('issues ZERO readFile calls against a dataless file', async () => {
    statMock.mockResolvedValue(datalessStats);

    await expect(icloud.readIfMaterialized(ICLOUD_PATH)).rejects.toMatchObject({
      code: icloud.ICLOUD_NOT_MATERIALIZED,
    });
    // The whole point: the blocking read is never issued.
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it('kicks a background brctl download for an evicted file', async () => {
    statMock.mockResolvedValue(datalessStats);

    await icloud.readIfMaterialized(ICLOUD_PATH).catch(() => {});

    expect(spawnMock).toHaveBeenCalledWith(
      'brctl',
      ['download', ICLOUD_PATH],
      expect.objectContaining({ detached: true })
    );
  });

  it('reads normally when the file is materialized', async () => {
    statMock.mockResolvedValue(materializedStats);
    readFileMock.mockResolvedValue('{"ok":true}');

    await expect(icloud.readIfMaterialized(ICLOUD_PATH)).resolves.toBe('{"ok":true}');
    expect(readFileMock).toHaveBeenCalledWith(ICLOUD_PATH, 'utf-8');
  });

  it('reads a non-iCloud path without any stat overhead', async () => {
    readFileMock.mockResolvedValue('local');

    await expect(icloud.readIfMaterialized(LOCAL_PATH)).resolves.toBe('local');
    expect(statMock).not.toHaveBeenCalled();
  });

  it('propagates a normal read error unchanged', async () => {
    statMock.mockResolvedValue(materializedStats);
    readFileMock.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));

    await expect(icloud.readIfMaterialized(ICLOUD_PATH)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('coalesces concurrent reads of one path into a single read', async () => {
    statMock.mockResolvedValue(materializedStats);
    readFileMock.mockResolvedValue('shared');

    const results = await Promise.all([
      icloud.readIfMaterialized(ICLOUD_PATH),
      icloud.readIfMaterialized(ICLOUD_PATH),
      icloud.readIfMaterialized(ICLOUD_PATH),
    ]);

    expect(results).toEqual(['shared', 'shared', 'shared']);
    // Single-flight is what caps threadpool occupancy at one slot per path.
    expect(readFileMock).toHaveBeenCalledTimes(1);
  });

  it('does not cache across settled calls (coalesces concurrency only)', async () => {
    statMock.mockResolvedValue(materializedStats);
    readFileMock.mockResolvedValueOnce('first').mockResolvedValueOnce('second');

    await expect(icloud.readIfMaterialized(ICLOUD_PATH)).resolves.toBe('first');
    await expect(icloud.readIfMaterialized(ICLOUD_PATH)).resolves.toBe('second');
    expect(readFileMock).toHaveBeenCalledTimes(2);
  });

  it('shares a rejection with every concurrent caller and then clears', async () => {
    statMock.mockResolvedValue(datalessStats);

    const settled = await Promise.allSettled([
      icloud.readIfMaterialized(ICLOUD_PATH),
      icloud.readIfMaterialized(ICLOUD_PATH),
    ]);
    expect(settled.every(r => r.status === 'rejected')).toBe(true);
    expect(statMock).toHaveBeenCalledTimes(1);

    // The single-flight entry must be released even on rejection, or the path
    // would be permanently poisoned once iCloud recovers.
    statMock.mockResolvedValue(materializedStats);
    readFileMock.mockResolvedValue('healed');
    await expect(icloud.readIfMaterialized(ICLOUD_PATH)).resolves.toBe('healed');
  });

  it('does not coalesce distinct paths', async () => {
    statMock.mockResolvedValue(materializedStats);
    readFileMock.mockResolvedValue('x');

    await Promise.all([
      icloud.readIfMaterialized(`${UBIQUITY_DIR}/a.json`),
      icloud.readIfMaterialized(`${UBIQUITY_DIR}/b.json`),
    ]);

    expect(readFileMock).toHaveBeenCalledTimes(2);
  });
});

describe('requestMaterialization', () => {
  it('dedupes while a download is in flight, and retries after it exits', () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    expect(icloud.requestMaterialization(ICLOUD_PATH)).toBe(true);
    expect(icloud.requestMaterialization(ICLOUD_PATH)).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Once the child exits the dedupe entry clears, so a later read can retry.
    child.emit('exit', 0, null);
    expect(icloud.requestMaterialization(ICLOUD_PATH)).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('unrefs the child so a slow download cannot hold the process open', () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    icloud.requestMaterialization(ICLOUD_PATH);
    expect(child.unref).toHaveBeenCalled();
  });

  it('warns once when brctl is missing', () => {
    const first = makeFakeChild();
    spawnMock.mockReturnValue(first);
    icloud.requestMaterialization(`${UBIQUITY_DIR}/a.json`);
    first.emit('error', Object.assign(new Error('nope'), { code: 'ENOENT' }));

    const second = makeFakeChild();
    spawnMock.mockReturnValue(second);
    icloud.requestMaterialization(`${UBIQUITY_DIR}/b.json`);
    second.emit('error', Object.assign(new Error('nope'), { code: 'ENOENT' }));

    const missingWarns = warnSpy.mock.calls.filter(([m]) => String(m).includes('brctl not found'));
    expect(missingWarns).toHaveLength(1);
  });

  it('is a no-op off darwin', () => {
    platformSpy.mockReturnValue('linux');
    expect(icloud.requestMaterialization(ICLOUD_PATH)).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  // The pin path (mortalLoomStore) passes retryAfterExit:false: it owns its own
  // single-sticky-path dedupe, so the shared helper must NOT dedupe it in the
  // in-flight map, must NOT count it against the concurrency cap, and must route
  // its failures through onFailure so the pin can clear its sticky path.
  describe('retryAfterExit:false (the pin path)', () => {
    it('does not dedupe on the in-flight map — a second call for the same path spawns again', () => {
      spawnMock.mockImplementation(() => makeFakeChild());
      expect(icloud.requestMaterialization(ICLOUD_PATH, { retryAfterExit: false })).toBe(true);
      expect(icloud.requestMaterialization(ICLOUD_PATH, { retryAfterExit: false })).toBe(true);
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    it('neither consumes a concurrency slot nor is blocked by the cap', async () => {
      statMock.mockResolvedValue(datalessStats);
      // Fill all four tracked (read) slots with in-flight downloads.
      for (let i = 0; i < 4; i++) {
        await icloud.readIfMaterialized(`${UBIQUITY_DIR}/read-${i}.md`).catch(() => {});
      }
      expect(spawnMock).toHaveBeenCalledTimes(4);
      // An untracked (pin) request still spawns even though the cap is full…
      expect(icloud.requestMaterialization(`${UBIQUITY_DIR}/pin.json`, { retryAfterExit: false })).toBe(true);
      expect(spawnMock).toHaveBeenCalledTimes(5);
      // …and it did NOT occupy a slot: a fresh tracked read for a new path is
      // still refused because the four read slots remain full.
      await icloud.readIfMaterialized(`${UBIQUITY_DIR}/read-blocked.md`).catch(() => {});
      expect(spawnMock).toHaveBeenCalledTimes(5);
    });

    it('fires onFailure on a non-zero exit, a signal-kill, and an error — never on exit 0', () => {
      const runOne = (emit) => {
        const child = makeFakeChild();
        spawnMock.mockReturnValueOnce(child);
        const onFailure = vi.fn();
        icloud.requestMaterialization(ICLOUD_PATH, { retryAfterExit: false, onFailure });
        emit(child);
        return onFailure;
      };
      expect(runOne((c) => c.emit('exit', 0, null))).not.toHaveBeenCalled();
      expect(runOne((c) => c.emit('exit', 1, null))).toHaveBeenCalledTimes(1);
      expect(runOne((c) => c.emit('exit', null, 'SIGKILL'))).toHaveBeenCalledTimes(1);
      expect(runOne((c) => c.emit('error', Object.assign(new Error('boom'), { code: 'EAGAIN' })))).toHaveBeenCalledTimes(1);
    });

    it('fires onFailure at most once even if error is followed by exit', () => {
      const child = makeFakeChild();
      spawnMock.mockReturnValue(child);
      const onFailure = vi.fn();
      icloud.requestMaterialization(ICLOUD_PATH, { retryAfterExit: false, onFailure });
      child.emit('error', Object.assign(new Error('boom'), { code: 'EAGAIN' }));
      child.emit('exit', null, 'SIGKILL');
      expect(onFailure).toHaveBeenCalledTimes(1);
    });

    it('fires onFailure when the deadline kills a hung child that never exits', async () => {
      const originalDeadline = icloud.DOWNLOAD_DEADLINE_MS;
      icloud._setDownloadDeadlineForTest(10);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      try {
        const child = makeFakeChild();
        child.pid = 5150;
        spawnMock.mockReturnValue(child);
        const onFailure = vi.fn();
        icloud.requestMaterialization(ICLOUD_PATH, { retryAfterExit: false, onFailure });
        // The child never emits 'exit'; only the deadline can clear the sticky path.
        await new Promise((r) => setTimeout(r, 30));
        expect(killSpy).toHaveBeenCalled();
        expect(onFailure).toHaveBeenCalledTimes(1);
      } finally {
        killSpy.mockRestore();
        icloud._setDownloadDeadlineForTest(originalDeadline);
      }
    });
  });
});

describe('background-download safety caps', () => {
  it('caps concurrent brctl children so an evicted vault walk cannot fork thousands', async () => {
    statMock.mockResolvedValue(datalessStats);
    // A vault walk hits a distinct path per note. Without a cap this would be one
    // `brctl download` child per note.
    for (let i = 0; i < 50; i++) {
      await icloud.readIfMaterialized(`${UBIQUITY_DIR}/note-${i}.md`).catch(() => {});
    }
    expect(spawnMock.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('resumes healing later notes once earlier downloads exit', async () => {
    statMock.mockResolvedValue(datalessStats);
    const children = [];
    spawnMock.mockImplementation(() => { const c = makeFakeChild(); children.push(c); return c; });

    for (let i = 0; i < 10; i++) {
      await icloud.readIfMaterialized(`${UBIQUITY_DIR}/a-${i}.md`).catch(() => {});
    }
    expect(spawnMock).toHaveBeenCalledTimes(4);

    // Drain the in-flight set; the next read is free to kick a download again.
    children.forEach(c => c.emit('exit', 0, null));
    await icloud.readIfMaterialized(`${UBIQUITY_DIR}/b.md`).catch(() => {});
    expect(spawnMock).toHaveBeenCalledTimes(5);
  });

  it('does not hand a base64 caller the utf-8 caller\'s result', async () => {
    statMock.mockResolvedValue(materializedStats);
    readFileMock.mockImplementation((_p, enc) => Promise.resolve(`body-as-${enc}`));

    const [utf8, b64] = await Promise.all([
      icloud.readIfMaterialized(ICLOUD_PATH),
      icloud.readIfMaterialized(ICLOUD_PATH, { encoding: 'base64' }),
    ]);

    expect(utf8).toBe('body-as-utf-8');
    expect(b64).toBe('body-as-base64');
  });
});

// Skipped on Windows — deliberately, and this is the rare case where a platform
// skip is the honest answer rather than lost coverage. The behavior under test
// is macOS "Desktop & Documents Folders" sync symlinking ~/Documents into a
// ubiquity container, and CLOUD_MARKERS are POSIX literals
// ('/Library/Mobile Documents/') describing a macOS-only filesystem layout.
// There is no Windows equivalent to assert: fabricating that tree under a
// Windows path yields backslashes the markers can never match, so the test
// would only be checking that a macOS-only feature is inert off macOS.
describe.skipIf(process.platform === 'win32')('cloud-root detection beyond a literal path match', () => {
  // ~/Documents is a SYMLINK into the CloudDocs ubiquity container when macOS
  // "Desktop & Documents Folders" sync is on, so a path string can say nothing
  // about iCloud while the file is very much in it. Real dirs + a real symlink
  // here: `fs.realpathSync` is not mocked in this suite (only `fs/promises` is).
  const { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } = require('fs');
  const { tmpdir } = require('os');
  const { join } = require('path');

  let root, cloudDir, linkDir;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'portos-icloud-link-'));
    cloudDir = join(root, 'Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents', 'Vault');
    mkdirSync(cloudDir, { recursive: true });
    writeFileSync(join(cloudDir, 'note.md'), 'x');
    linkDir = join(root, 'Documents');
    symlinkSync(join(root, 'Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents'), linkDir);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('recognizes a symlinked route into a ubiquity container', () => {
    const viaLink = join(linkDir, 'Vault', 'note.md');
    // The literal string test fails here — only realpath resolution catches it.
    expect(viaLink.includes('/Library/Mobile Documents/')).toBe(false);
    expect(icloud.isUbiquityPath(viaLink)).toBe(true);
  });

  it('guards a read reached through that symlink', async () => {
    statMock.mockResolvedValue(datalessStats);
    const viaLink = join(linkDir, 'Vault', 'note.md');

    await expect(icloud.readIfMaterialized(viaLink)).rejects.toMatchObject({
      code: icloud.ICLOUD_NOT_MATERIALIZED,
    });
    // Pre-fix this fell through to a plain readFile — the original hang.
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it('still rejects an ordinary directory that resolves nowhere near a cloud root', () => {
    expect(icloud.isUbiquityPath(join(root, 'plain', 'file.md'))).toBe(false);
  });

  it('screens ~/Library/CloudStorage (Dropbox/Drive online-only) but does not spawn brctl for it', async () => {
    statMock.mockResolvedValue(datalessStats);
    const p = '/Users/example/Library/CloudStorage/Dropbox/Notes/a.md';

    await expect(icloud.readIfMaterialized(p)).rejects.toMatchObject({
      code: icloud.ICLOUD_NOT_MATERIALIZED,
    });
    // Refusing prevents the outage; `brctl` only speaks iCloud, so spawning it
    // for a third-party File Provider path would be a guaranteed-useless child.
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('isEvictedStats', () => {
  it('requires a cloud root, not just the dataless-looking numbers', () => {
    // A sparse or transparently-compressed ordinary file reports blocks:0 with a
    // real size; treating it as evicted would refuse a readable file forever.
    expect(icloud.isDatalessStats(datalessStats)).toBe(true);
    expect(icloud.isEvictedStats(LOCAL_PATH, datalessStats)).toBe(false);
    expect(icloud.isEvictedStats(ICLOUD_PATH, datalessStats)).toBe(true);
  });

  it('is false off darwin', () => {
    platformSpy.mockReturnValue('linux');
    expect(icloud.isEvictedStats(ICLOUD_PATH, datalessStats)).toBe(false);
  });

  it('is false for a materialized file in a cloud root', () => {
    expect(icloud.isEvictedStats(ICLOUD_PATH, materializedStats)).toBe(false);
  });
});

describe('background download deadline', () => {
  it('kills a hung brctl and frees its slot so healing resumes', async () => {
    const originalDeadline = icloud.DOWNLOAD_DEADLINE_MS;
    icloud._setDownloadDeadlineForTest(10);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      statMock.mockResolvedValue(datalessStats);
      // Four children that never exit would otherwise hold every slot forever —
      // which is exactly what a wedged iCloud does to `brctl`.
      for (let i = 0; i < 4; i++) {
        await icloud.readIfMaterialized(`${UBIQUITY_DIR}/hung-${i}.md`).catch(() => {});
      }
      expect(spawnMock).toHaveBeenCalledTimes(4);
      await icloud.readIfMaterialized(`${UBIQUITY_DIR}/blocked.md`).catch(() => {});
      expect(spawnMock).toHaveBeenCalledTimes(4);   // capped, as designed

      await new Promise(r => setTimeout(r, 40));    // let the deadlines fire

      expect(killSpy).toHaveBeenCalled();
      await icloud.readIfMaterialized(`${UBIQUITY_DIR}/after.md`).catch(() => {});
      expect(spawnMock).toHaveBeenCalledTimes(5);   // slots freed, healing resumed
    } finally {
      killSpy.mockRestore();
      icloud._setDownloadDeadlineForTest(originalDeadline);
    }
  });
});

describe('background download slot ownership', () => {
  it("a timed-out child's late exit must not release a replacement's slot", async () => {
    const originalDeadline = icloud.DOWNLOAD_DEADLINE_MS;
    icloud._setDownloadDeadlineForTest(10);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      statMock.mockResolvedValue(datalessStats);
      const children = [];
      spawnMock.mockImplementation(() => { const c = makeFakeChild(); c.pid = 1000 + children.length; children.push(c); return c; });

      const P = `${UBIQUITY_DIR}/contested.md`;
      await icloud.readIfMaterialized(P).catch(() => {});
      expect(spawnMock).toHaveBeenCalledTimes(1);

      // Deadline fires and frees the slot; a fresh read then starts a REPLACEMENT
      // child for the same path.
      await new Promise(r => setTimeout(r, 30));
      await icloud.readIfMaterialized(P).catch(() => {});
      expect(spawnMock).toHaveBeenCalledTimes(2);

      // Now the ORIGINAL child finally exits. Without identity-guarded cleanup it
      // would delete the replacement's entry, letting the next read spawn a
      // duplicate for a path already downloading — and eroding the 4-child cap.
      children[0].emit('exit', null, 'SIGKILL');
      await icloud.readIfMaterialized(P).catch(() => {});
      expect(spawnMock).toHaveBeenCalledTimes(2);

      // The replacement's own exit does release it.
      children[1].emit('exit', 0, null);
      await icloud.readIfMaterialized(P).catch(() => {});
      expect(spawnMock).toHaveBeenCalledTimes(3);
    } finally {
      killSpy.mockRestore();
      icloud._setDownloadDeadlineForTest(originalDeadline);
    }
  });
});

/**
 * The awaited, bounded write-path materialize (#3706).
 *
 * Distinct from `requestMaterialization` above in the one way that matters: a
 * write path cannot fire-and-forget, because skipping a write silently loses the
 * user's edit. So this one waits for brctl and reports whether it worked — and
 * bounds the wait, since brctl is exactly what hangs when iCloud is wedged.
 */
describe('materializeAndWait', () => {
  // Shaped for the shared bufferedSpawn helper, which reads child.stdout/stderr
  // and resolves on `close`. (The suite's global beforeEach already pins
  // platform=darwin and silences console; don't re-stub either here.)
  const makeChild = (exitCode) => {
    const noopStream = { on: vi.fn() };
    const child = {
      stdout: noopStream,
      stderr: noopStream,
      pid: 4242,
      on: vi.fn(function (evt, cb) {
        if (evt === 'close') setTimeout(() => cb(exitCode, null), 0);
        return child;
      }),
      kill: vi.fn(),
      unref: vi.fn(),
    };
    return child;
  };

  it('awaits brctl and resolves true on a clean exit', async () => {
    spawnMock.mockReturnValue(makeChild(0));
    await expect(icloud.materializeAndWait(ICLOUD_PATH)).resolves.toBe(true);
    expect(spawnMock).toHaveBeenCalledWith('brctl', ['download', ICLOUD_PATH], expect.objectContaining({ shell: false }));
  });

  it('resolves false on a non-zero exit so the caller refuses the write', async () => {
    spawnMock.mockReturnValue(makeChild(1));
    await expect(icloud.materializeAndWait(ICLOUD_PATH)).resolves.toBe(false);
  });

  it('is inert off darwin — no child spawned', async () => {
    platformSpy.mockReturnValue('linux');
    await expect(icloud.materializeAndWait(ICLOUD_PATH)).resolves.toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('resolves false for an empty path without spawning', async () => {
    await expect(icloud.materializeAndWait('')).resolves.toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('resolves false instead of THROWING when spawn fails synchronously', async () => {
    // bufferedSpawn lets a synchronous spawn throw (EMFILE under load) propagate.
    // Unguarded, that would surface from updateNote as a raw spawn error instead
    // of the clean NOTE_EVICTED refusal — turning a handled degradation into a 500.
    spawnMock.mockImplementation(() => { throw Object.assign(new Error('too many files'), { code: 'EMFILE' }); });
    await expect(icloud.materializeAndWait(ICLOUD_PATH)).resolves.toBe(false);
  });

  it('shares the once-per-process brctl-missing warning with the read paths', async () => {
    // Claiming it first (as a read path would) must silence the write path's copy,
    // so an operator sees ONE "brctl not found" line per process, not one per caller.
    expect(icloud.claimBrctlMissingWarning()).toBe(true);
    spawnMock.mockImplementation(() => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); });
    await expect(icloud.materializeAndWait(ICLOUD_PATH)).resolves.toBe(false);
    expect(warnSpy.mock.calls.flat().join(' ')).not.toMatch(/brctl not found/);
  });

  it('does warn when the flag has NOT already been claimed', async () => {
    spawnMock.mockImplementation(() => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); });
    await expect(icloud.materializeAndWait(ICLOUD_PATH)).resolves.toBe(false);
    expect(warnSpy.mock.calls.flat().join(' ')).toMatch(/brctl not found/);
  });
});
