import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pinPlatform } from './testHelper.js';
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

import { tryReadFileStrict, readJSONFileStrict } from './jsonIo.js';
import { restoreFsMocks, loadRealFsPromises } from './fileUtils.testFixtures.js';

beforeAll(loadRealFsPromises);

// =============================================================================
// Windows swap-window retries (#4095)
//
// On win32 `atomicWrite`'s fallback backup swap renames the destination away and
// back, so for an instant the file DOES NOT EXIST. A read landing in that window
// used to get ENOENT and report it as a trustworthy "nothing here yet", handing
// the caller its default instead of the real contents. These tests pin both
// halves of the fix and that POSIX still pays nothing for it.
// =============================================================================

describe('Windows swap-window retries (#4095)', () => {
  const lockError = (code) => Object.assign(new Error(`${code}: simulated windows lock`), { code });

  let tmpRoot;
  let restorePlatform = null;

  // Parks the restore for afterEach; each case pins exactly once.
  const fakePlatform = (value) => { restorePlatform = pinPlatform(value); };

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'fileutils-winswap-'));
    // Other suites exercise the same fs mocks — start from a
    // clean call log so the call-count assertions below mean what they say.
    fsPromises.readFile.mockClear();
    fsPromises.rename.mockClear();
    fsPromises.readdir.mockClear();
  });

  afterEach(() => {
    if (restorePlatform) restorePlatform();
    restorePlatform = null;
    // Drop any unconsumed `*Once` queues AND re-establish the delegating
    // implementations the rest of this file relies on.
    restoreFsMocks();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('readJSONFileStrict', () => {
    it('retries a locked read on win32 and returns the real contents as trustworthy', async () => {
      const target = join(tmpRoot, 'locked.json');
      writeFileSync(target, JSON.stringify({ real: true }));
      fakePlatform('win32');
      fsPromises.readFile.mockRejectedValueOnce(lockError('EBUSY'));

      expect(await readJSONFileStrict(target, { fallback: true })).toEqual({ ok: true, value: { real: true } });
      expect(fsPromises.readFile).toHaveBeenCalledTimes(2);
    });

    it('retries an ENOENT on win32 when a swap sibling shows a write is in flight', async () => {
      const target = join(tmpRoot, 'swapping.json');
      writeFileSync(target, JSON.stringify({ real: true }));
      // The debris `atomicWrite` leaves visible while a swap is mid-flight.
      writeFileSync(`${target}.1234.5678.bak`, '{"real":true}');
      fakePlatform('win32');
      fsPromises.readFile.mockRejectedValueOnce(lockError('ENOENT'));

      expect(await readJSONFileStrict(target, { fallback: true })).toEqual({ ok: true, value: { real: true } });
      expect(fsPromises.readdir).toHaveBeenCalled();
    });

    it('matches a swap sibling whose casing differs — NTFS/FAT are case-insensitive', async () => {
      const target = join(tmpRoot, 'casing.json');
      writeFileSync(target, JSON.stringify({ real: true }));
      // The writer may have created the file (and therefore its swap debris)
      // under different casing than the reader's path — legal on Windows.
      writeFileSync(join(tmpRoot, 'Casing.json.1234.5678.BAK'), '{"real":true}');
      fakePlatform('win32');
      fsPromises.readFile.mockRejectedValueOnce(lockError('ENOENT'));

      expect(await readJSONFileStrict(target, { fallback: true })).toEqual({ ok: true, value: { real: true } });
    });

    it('does NOT treat a .tmp sibling as a swap — a first-ever write is not a vanished file', async () => {
      // `atomicWrite` writes a `.tmp` on EVERY write, including the first create
      // of a file that has no destination yet. Retrying on that would make a
      // legitimate "not written yet" read block for the in-flight write and
      // return its brand-new contents. Only the `.bak` marks the swap window.
      const missing = join(tmpRoot, 'first-write.json');
      writeFileSync(`${missing}.4321.8765.tmp`, '{"brand":"new"}');
      fakePlatform('win32');

      expect(await readJSONFileStrict(missing, { fallback: true })).toEqual({ ok: true, value: { fallback: true } });
      expect(fsPromises.readFile).toHaveBeenCalledTimes(1);
    });

    it('reports a missing file with a legacy .bak sibling as recovery-required, never empty (#9556)', async () => {
      const target = join(tmpRoot, 'orphaned.json');
      writeFileSync(`${target}.1234.5678.bak`, '{"secret":"original"}');
      fakePlatform('win32');

      expect(await readJSONFileStrict(target, { fallback: true }, { logError: false }))
        .toEqual({ ok: false, value: { fallback: true } });
      expect(await tryReadFileStrict(target)).toEqual({ ok: false, value: null });
    });

    it('does not retry a plain missing file on win32 — no sibling, no second read', async () => {
      const missing = join(tmpRoot, 'never-written.json');
      fakePlatform('win32');

      expect(await readJSONFileStrict(missing, { fallback: true })).toEqual({ ok: true, value: { fallback: true } });
      expect(fsPromises.readFile).toHaveBeenCalledTimes(1);
    });

    it('costs a plain missing file nothing off win32 — one read, no directory scan', async () => {
      const missing = join(tmpRoot, 'never-written.json');
      fakePlatform('linux');

      expect(await readJSONFileStrict(missing, { fallback: true })).toEqual({ ok: true, value: { fallback: true } });
      expect(fsPromises.readFile).toHaveBeenCalledTimes(1);
      expect(fsPromises.readdir).not.toHaveBeenCalled();
    });

    it('does not retry a locked read off win32 — the read stays untrustworthy', async () => {
      const target = join(tmpRoot, 'posix-locked.json');
      writeFileSync(target, JSON.stringify({ real: true }));
      fakePlatform('linux');
      fsPromises.readFile.mockRejectedValueOnce(lockError('EBUSY'));

      expect(await readJSONFileStrict(target, { fallback: true }, { logError: false }))
        .toEqual({ ok: false, value: { fallback: true } });
      expect(fsPromises.readFile).toHaveBeenCalledTimes(1);
    });
  });
});
