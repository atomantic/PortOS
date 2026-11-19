import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'fs';
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

import { atomicWrite, setAtomicWriteDurabilityForTests } from './fileCore.js';
import { restoreFsMocks, loadRealFsPromises } from './fileUtils.testFixtures.js';

beforeAll(loadRealFsPromises);
// Workers default to non-durable writes (#16864); the Windows flush assertion needs the production path.
setAtomicWriteDurabilityForTests(true);

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
  // Matches WIN_RETRY_ATTEMPTS in fileCore.js.
  const RETRY_ATTEMPTS = 5;
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

  describe('atomicWrite', () => {
    it('fsyncs the temp file but skips the directory sync, which Windows cannot open a handle for (#12025)', async () => {
      const target = join(tmpRoot, 'state.json');
      fakePlatform('win32');
      fsPromises.open.mockClear();

      await atomicWrite(target, { v: 1 });

      expect(fsPromises.writeFile).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ flush: true }));
      expect(fsPromises.open).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ v: 1 });
    });

    it('retries the atomic rename on a transient lock instead of opening the destination-missing window', async () => {
      const target = join(tmpRoot, 'state.json');
      writeFileSync(target, JSON.stringify({ v: 1 }));
      fakePlatform('win32');
      fsPromises.rename.mockRejectedValueOnce(lockError('EPERM'));

      await atomicWrite(target, { v: 2 });

      expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ v: 2 });
      // The backup swap is identified by a rename whose SOURCE is the
      // destination itself (`rename(filePath, bak)`). The retry path must never
      // move the destination aside — that is the window this fix closes.
      const movedDestinationAside = fsPromises.rename.mock.calls.some(([from]) => from === target);
      expect(movedDestinationAside).toBe(false);
      expect(fsPromises.rename).toHaveBeenCalledTimes(2);
    });

    it('retries a transient EBUSY lock on the atomic rename', async () => {
      const target = join(tmpRoot, 'busy.json');
      writeFileSync(target, JSON.stringify({ v: 1 }));
      fakePlatform('win32');
      fsPromises.rename.mockRejectedValueOnce(lockError('EBUSY'));

      await atomicWrite(target, { v: 2 });

      expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ v: 2 });
      expect(fsPromises.rename).toHaveBeenCalledTimes(2);
      expect(fsPromises.rename.mock.calls.some(([from]) => from === target)).toBe(false);
    });

    it('preserves the original bytes and removes only the temp file when every retry stays locked (#9556)', async () => {
      const target = join(tmpRoot, 'stubborn.json');
      writeFileSync(target, JSON.stringify({ v: 1 }));
      fakePlatform('win32');
      fsPromises.rename.mockRejectedValue(lockError('EPERM'));

      await expect(atomicWrite(target, { v: 2 })).rejects.toMatchObject({
        code: 'EPERM',
        message: expect.stringContaining('existing file was left untouched'),
      });

      // The destination is never moved aside — no backup swap exists any more.
      expect(fsPromises.rename.mock.calls.some(([from]) => from === target)).toBe(false);
      expect(fsPromises.rename).toHaveBeenCalledTimes(RETRY_ATTEMPTS);
      expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ v: 1 });
      expect(readdirSync(tmpRoot)).toEqual(['stubborn.json']);
    });

    it('does not retry off win32 — a rename failure still surfaces immediately', async () => {
      const target = join(tmpRoot, 'posix.json');
      writeFileSync(target, JSON.stringify({ v: 1 }));
      // Pinned explicitly, not inherited from the host — this suite also runs on
      // a real Windows CI runner, where the un-faked platform IS win32.
      fakePlatform('linux');
      fsPromises.rename.mockRejectedValueOnce(lockError('EPERM'));

      await expect(atomicWrite(target, { v: 2 })).rejects.toThrow(/EPERM/);

      expect(fsPromises.rename).toHaveBeenCalledTimes(1);
      // The original file is untouched and no temp debris is left behind.
      expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ v: 1 });
      expect(readdirSync(tmpRoot)).toEqual(['posix.json']);
    });
  });
});
