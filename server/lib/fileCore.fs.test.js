import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { readFile, writeFile, rm, mkdir } from 'fs/promises';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { pinPlatform } from './testHelper.js';
import * as fsPromises from 'fs/promises';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('./childProcess.js', async (importOriginal) => ({
  ...await importOriginal(),
  execFile: execFileMock,
}));
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

import { watchForFile, ensureDir, pathExists, atomicWrite, formatDuration, listDirectoryByExtension, dirSize, sha256File, setAtomicWriteDurabilityForTests } from './fileCore.js';
import { restoreFsMocks, realFsPromises, loadRealFsPromises } from './fileUtils.testFixtures.js';

beforeAll(loadRealFsPromises);
// Workers default to non-durable writes (#16864); the atomicWrite sync-ordering tests below assert the production path.
setAtomicWriteDurabilityForTests(true);

describe('fileUtils', () => {
  describe('pathExists', () => {
    const tmpRoot = join(tmpdir(), `fileutils-pathexists-${process.pid}-${Date.now()}`);

    beforeEach(() => mkdir(tmpRoot, { recursive: true }));
    afterEach(() => rm(tmpRoot, { recursive: true, force: true }));

    it('resolves true for an existing file', async () => {
      const f = join(tmpRoot, 'present.txt');
      await writeFile(f, 'hi');
      expect(await pathExists(f)).toBe(true);
    });

    it('resolves true for an existing directory', async () => {
      expect(await pathExists(tmpRoot)).toBe(true);
    });

    it('resolves false for a missing path without throwing', async () => {
      expect(await pathExists(join(tmpRoot, 'nope.txt'))).toBe(false);
    });
  });

  describe('formatDuration', () => {
    it('should return "0m" for zero or falsy values', () => {
      expect(formatDuration(0)).toBe('0m');
      expect(formatDuration(null)).toBe('0m');
      expect(formatDuration(undefined)).toBe('0m');
    });

    it('should format minutes correctly', () => {
      expect(formatDuration(60000)).toBe('1m');
      expect(formatDuration(300000)).toBe('5m');
      expect(formatDuration(59 * 60000)).toBe('59m');
    });

    it('should format hours and minutes correctly', () => {
      expect(formatDuration(60 * 60000)).toBe('1h 0m');
      expect(formatDuration(90 * 60000)).toBe('1h 30m');
      expect(formatDuration(150 * 60000)).toBe('2h 30m');
    });

    it('should format days and hours correctly', () => {
      expect(formatDuration(24 * 60 * 60000)).toBe('1d 0h');
      expect(formatDuration(25 * 60 * 60000)).toBe('1d 1h');
      expect(formatDuration(48 * 60 * 60000)).toBe('2d 0h');
      expect(formatDuration(50 * 60 * 60000)).toBe('2d 2h');
    });
  });

  describe('listDirectoryByExtension', () => {
    const tmpRoot = join(tmpdir(), `portos-listdir-test-${process.pid}-${Date.now()}`);

    beforeEach(async () => {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      await mkdir(tmpRoot, { recursive: true });
    });

    afterEach(async () => {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    });

    it('returns [] when the directory does not exist', async () => {
      const res = await listDirectoryByExtension(join(tmpRoot, 'missing'), {
        extensions: ['.png'],
        mapEntry: (n) => ({ filename: n }),
      });
      expect(res).toEqual([]);
    });

    it('filters by extension (case-insensitive) and maps survivors', async () => {
      await writeFile(join(tmpRoot, 'a.png'), 'a');
      await writeFile(join(tmpRoot, 'b.PNG'), 'b');
      await writeFile(join(tmpRoot, 'c.jpg'), 'c');
      const res = await listDirectoryByExtension(tmpRoot, {
        extensions: ['.png'],
        mapEntry: (name, _full, s) => ({ name, sizeBytes: s.size }),
      });
      const names = res.map((r) => r.name).sort();
      expect(names).toEqual(['a.png', 'b.PNG']);
    });

    it('drops directories when requireRegularFile is true (default)', async () => {
      await writeFile(join(tmpRoot, 'real.safetensors'), 'data');
      await mkdir(join(tmpRoot, 'fake.safetensors'));
      const res = await listDirectoryByExtension(tmpRoot, {
        extensions: ['.safetensors'],
        mapEntry: (name) => ({ name }),
      });
      expect(res).toEqual([{ name: 'real.safetensors' }]);
    });

    it('keeps directories when requireRegularFile is false (gallery legacy)', async () => {
      await writeFile(join(tmpRoot, 'real.png'), 'data');
      await mkdir(join(tmpRoot, 'fake.png'));
      const res = await listDirectoryByExtension(tmpRoot, {
        extensions: ['.png'],
        requireRegularFile: false,
        mapEntry: (name) => ({ name }),
      });
      const names = res.map((r) => r.name).sort();
      expect(names).toEqual(['fake.png', 'real.png']);
    });

    it('drops entries whose mapEntry returns null', async () => {
      await writeFile(join(tmpRoot, 'a.json'), 'a');
      await writeFile(join(tmpRoot, 'b.json'), 'b');
      const res = await listDirectoryByExtension(tmpRoot, {
        extensions: ['.json'],
        mapEntry: (name) => (name === 'a.json' ? null : { name }),
      });
      expect(res).toEqual([{ name: 'b.json' }]);
    });

    it('throws if extensions is missing or empty', async () => {
      await expect(
        listDirectoryByExtension(tmpRoot, { mapEntry: (n) => n }),
      ).rejects.toThrow(/extensions allowlist/);
      await expect(
        listDirectoryByExtension(tmpRoot, { extensions: [], mapEntry: (n) => n }),
      ).rejects.toThrow(/extensions allowlist/);
    });

    it('throws if mapEntry is not a function', async () => {
      await expect(
        listDirectoryByExtension(tmpRoot, { extensions: ['.png'] }),
      ).rejects.toThrow(/mapEntry must be a function/);
    });
  });

  describe('dirSize strict scans', () => {
    let restorePlatform = null;

    afterEach(() => restoreFsMocks());

    afterEach(() => {
      if (restorePlatform) restorePlatform();
      restorePlatform = null;
    });

    it('rejects an unreadable path instead of reporting a real zero', async () => {
      const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      fsPromises.stat.mockRejectedValue(error);

      await expect(dirSize('/example/unreadable', { strict: true })).rejects.toBe(error);
    });

    it('treats a confirmed missing path as an empty directory', async () => {
      fsPromises.stat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));

      await expect(dirSize('/example/missing', { strict: true })).resolves.toBe(0);
    });

    it('treats empty PowerShell output as a zero byte Windows directory', async () => {
      restorePlatform = pinPlatform('win32');
      fsPromises.stat.mockResolvedValue({ isDirectory: () => true });
      execFileMock.mockImplementation((_command, _args, _options, callback) => {
        callback(null, { stdout: '', stderr: '' });
      });

      await expect(dirSize('/example/empty', { strict: true })).resolves.toBe(0);
      expect(execFileMock).toHaveBeenCalledWith('powershell', expect.any(Array), expect.objectContaining({
        env: expect.objectContaining({ DIRSIZE_TARGET: '/example/empty' }),
      }), expect.any(Function));
      execFileMock.mockReset();
    });
  });

  describe('sha256File', () => {
    let dir;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'portos-sha256-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it('hashes a small file in one shot and matches createHash digest', async () => {
      const p = join(dir, 'small.bin');
      writeFileSync(p, 'hello world');
      const expected = createHash('sha256').update('hello world').digest('hex');
      expect(await sha256File(p)).toBe(expected);
    });

    it('hashes a large file via streaming (>= 512KB)', async () => {
      const p = join(dir, 'big.bin');
      const buf = Buffer.alloc(600 * 1024, 0x42);
      writeFileSync(p, buf);
      const expected = createHash('sha256').update(buf).digest('hex');
      expect(await sha256File(p)).toBe(expected);
    });

    it('returns identical digests for identical content under different paths', async () => {
      const a = join(dir, 'a.bin'); const b = join(dir, 'b.bin');
      writeFileSync(a, 'same-content');
      writeFileSync(b, 'same-content');
      expect(await sha256File(a)).toBe(await sha256File(b));
    });

    it('returns different digests for different content', async () => {
      const a = join(dir, 'a.bin'); const b = join(dir, 'b.bin');
      writeFileSync(a, 'one');
      writeFileSync(b, 'two');
      expect(await sha256File(a)).not.toBe(await sha256File(b));
    });
  });

  describe('ensureDir', () => {
    let tmpRoot;

    beforeEach(() => {
      tmpRoot = mkdtempSync(join(tmpdir(), 'fileutils-ensuredir-'));
    });

    afterEach(() => {
      fsPromises.mkdir.mockClear();
      rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('creates a missing nested directory', async () => {
      const target = join(tmpRoot, 'a', 'b', 'c');
      await ensureDir(target);
      expect(existsSync(target)).toBe(true);
    });

    it('is idempotent — succeeds when the directory already exists', async () => {
      const target = join(tmpRoot, 'exists');
      await ensureDir(target);
      await expect(ensureDir(target)).resolves.toBeUndefined();
    });

    it('swallows a spurious Windows mkdir error when the dir already exists (regression)', async () => {
      const target = join(tmpRoot, 'preexisting');
      mkdirSync(target);
      // Simulate the Windows UNKNOWN/EPERM that fs.mkdir can throw even on an
      // existing directory (antivirus locks, OneDrive sync, mapped drives).
      const spurious = Object.assign(new Error('UNKNOWN: unknown error, mkdir'), { code: 'UNKNOWN' });
      fsPromises.mkdir.mockRejectedValueOnce(spurious);
      await expect(ensureDir(target)).resolves.toBeUndefined();
    });

    it('still rejects when mkdir fails and the path is not a directory afterward', async () => {
      const target = join(tmpRoot, 'never-created');
      const realFailure = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      fsPromises.mkdir.mockRejectedValueOnce(realFailure);
      await expect(ensureDir(target)).rejects.toThrow(/EACCES/);
    });
  });

  describe('atomicWrite', () => {
    let tmpRoot;

    beforeEach(() => {
      tmpRoot = mkdtempSync(join(tmpdir(), 'fileutils-atomicwrite-'));
    });

    afterEach(() => {
      restoreFsMocks();
      rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('serializes a plain object with 2-space indentation', async () => {
      const target = join(tmpRoot, 'obj.json');
      await atomicWrite(target, { b: 2, a: 1 });
      expect(await readFile(target, 'utf8')).toBe('{\n  "b": 2,\n  "a": 1\n}');
    });

    it('writes a string payload verbatim (preserving a trailing newline)', async () => {
      const target = join(tmpRoot, 'raw.json');
      await atomicWrite(target, '{"x":1}\n');
      expect(await readFile(target, 'utf8')).toBe('{"x":1}\n');
    });

    // Crash durability (#12025): the bytes reach the disk before the rename
    // publishes them, and the directory entry reaches the disk after. The
    // ordering is observed through the fs seam because a real power loss
    // cannot be staged in a unit test.
    it('fsyncs the temp file before the rename and the parent directory after it', async () => {
      const target = join(tmpRoot, 'durable.json');
      const calls = [];
      fsPromises.writeFile.mockImplementationOnce(async (path, data, options) => {
        calls.push(['writeFile', options?.flush]);
        return realFsPromises.writeFile(path, data, options);
      });
      fsPromises.rename.mockImplementationOnce(async (...args) => {
        calls.push(['rename']);
        return realFsPromises.rename(...args);
      });
      fsPromises.open.mockImplementationOnce(async (path, flags) => {
        const handle = await realFsPromises.open(path, flags);
        const sync = handle.sync.bind(handle);
        handle.sync = async () => { calls.push(['dirSync', path]); return sync(); };
        return handle;
      });

      await atomicWrite(target, { durable: true });

      // Windows cannot open a directory for fsync, so syncDirectory skips it there.
      const expectedCalls = [['writeFile', true], ['rename'], ...(process.platform === 'win32' ? [] : [['dirSync', tmpRoot]])];
      expect(calls).toEqual(expectedCalls);
      expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ durable: true });
    });

    it.skipIf(process.platform === 'win32')('keeps a published write when the directory cannot be fsynced, warning once per directory', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const target = join(tmpRoot, 'netfs.json');
        const failure = Object.assign(new Error('synthetic directory fsync failure'), { code: 'EINVAL' });
        fsPromises.open.mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);

        await atomicWrite(target, { v: 1 });
        await atomicWrite(target, { v: 2 });

        expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ v: 2 });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('EINVAL');
      } finally {
        warn.mockRestore();
      }
    });

    it('removes a partially written temp file after ENOSPC and allows a later retry', async () => {
      const target = join(tmpRoot, 'state.json');
      writeFileSync(target, 'original');
      const failure = Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' });
      fsPromises.writeFile.mockImplementationOnce(async (path, _data, options) => {
        await realFsPromises.writeFile(path, 'partial', options);
        throw failure;
      });

      await expect(atomicWrite(target, 'replacement')).rejects.toBe(failure);
      expect(readFileSync(target, 'utf8')).toBe('original');
      expect(readdirSync(tmpRoot)).toEqual(['state.json']);

      await atomicWrite(target, 'replacement');
      expect(readFileSync(target, 'utf8')).toBe('replacement');
      expect(readdirSync(tmpRoot)).toEqual(['state.json']);
    });

    it('preserves the destination when its permissions cannot be read', async () => {
      const target = join(tmpRoot, 'private.json');
      writeFileSync(target, 'original', { mode: 0o600 });
      const originalMode = (await realFsPromises.stat(target)).mode;
      const failure = Object.assign(new Error('synthetic stat failure'), { code: 'EIO' });
      fsPromises.stat.mockRejectedValueOnce(failure);

      await expect(atomicWrite(target, 'replacement')).rejects.toBe(failure);
      expect(readFileSync(target, 'utf8')).toBe('original');
      expect((await realFsPromises.stat(target)).mode).toBe(originalMode);
      expect(readdirSync(tmpRoot)).toEqual(['private.json']);
    });

    it('preserves the destination and removes the temp file when restoring its mode fails', async () => {
      const target = join(tmpRoot, 'private.json');
      writeFileSync(target, 'original', { mode: 0o600 });
      const failure = Object.assign(new Error('synthetic chmod failure'), { code: 'EACCES' });
      fsPromises.chmod.mockRejectedValueOnce(failure);

      await expect(atomicWrite(target, 'replacement')).rejects.toBe(failure);
      expect(readFileSync(target, 'utf8')).toBe('original');
      expect(readdirSync(tmpRoot)).toEqual(['private.json']);
    });

    it.skipIf(process.platform === 'win32')(
      'preserves the destination file\'s restrictive mode on rewrite (regression: #1837)',
      async () => {
        const target = join(tmpRoot, 'secret.json');
        // Seed a hand-restricted secret file (e.g. an OAuth tokens.json the user
        // chmod 600'd). The temp-write + rename must NOT widen it to the umask
        // default — a plain writeFile(existing) kept the inode's mode, and
        // atomicWrite mirrors that.
        writeFileSync(target, '{"token":"old"}', { mode: 0o600 });
        const { chmodSync } = await import('fs');
        chmodSync(target, 0o600); // ensure 600 regardless of umask at creation
        await atomicWrite(target, { token: 'new' });
        const { statSync } = await import('fs');
        expect(statSync(target).mode & 0o777).toBe(0o600);
        expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ token: 'new' });
      }
    );

    it.skipIf(process.platform === 'win32')(
      'creates the temp file with the destination\'s mode so a secret is never briefly world-readable',
      async () => {
        const target = join(tmpRoot, 'secret.json');
        writeFileSync(target, '{"token":"old"}', { mode: 0o600 });
        await realFsPromises.chmod(target, 0o600); // independent of the creation umask
        let modeAtCreation = null;
        let tempPath = null;
        // The final chmod would mask a missing creation mode, so observe the
        // temp file straight after its first write, before chmod/rename run.
        fsPromises.writeFile.mockImplementationOnce(async (path, data, options) => {
          await realFsPromises.writeFile(path, data, options);
          tempPath = path;
          modeAtCreation = (await realFsPromises.stat(path)).mode & 0o777;
        });

        await atomicWrite(target, { token: 'new' });

        expect(tempPath).not.toBe(target);
        expect(modeAtCreation).toBe(0o600);
        expect((await realFsPromises.stat(target)).mode & 0o777).toBe(0o600);
      }
    );

    it('creates a new file at the default mode when the destination does not exist', async () => {
      const target = join(tmpRoot, 'fresh.json');
      await atomicWrite(target, { created: true });
      expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ created: true });
    });

    it.skipIf(process.platform === 'win32')(
      'replaces a symlink target with a regular file rather than following it (design decision: #1893)',
      async () => {
        // Decision pinned by this test: temp+rename REPLACES the link, standard
        // atomic-write semantics — it does NOT follow the symlink to update the
        // backing file. Following would reintroduce the non-atomic in-place
        // truncate atomicWrite exists to avoid. See the JSDoc + issue #1893.
        const { symlinkSync, lstatSync } = await import('fs');
        const backing = join(tmpRoot, 'backing.json');
        const link = join(tmpRoot, 'link.json');
        writeFileSync(backing, '{"orig":true}');
        symlinkSync(backing, link);

        await atomicWrite(link, { replaced: true });

        // The link path is now a regular file holding the new content...
        expect(lstatSync(link).isSymbolicLink()).toBe(false);
        expect(JSON.parse(await readFile(link, 'utf8'))).toEqual({ replaced: true });
        // ...and the original backing file is untouched (link was not followed).
        expect(JSON.parse(await readFile(backing, 'utf8'))).toEqual({ orig: true });
      }
    );
  });
});

describe('watchForFile', () => {
  // Node 24's Windows libuv watcher can abort the worker in src/win/fs-event.c
  // after a watched temp directory is removed, even after FSWatcher emits
  // `close`. Linux covers the native integration; agentTuiSpawning tests cover
  // the close-event and process-exit races with a platform-neutral watcher.
  it.skipIf(process.platform === 'win32')('detects a newly written file with the event watcher and fallback poll', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'watch-file-test-'));
    const target = join(dir, 'done.sentinel');
    const detected = new Promise((resolve) => watchForFile(target, resolve, { settleMs: 0, pollMs: 10 }));
    await new Promise((resolve) => setImmediate(resolve));
    await writeFile(target, 'done');
    await expect(detected).resolves.toBeUndefined();
    // FSWatcher emits `close` before libuv's Windows endgame has fully released
    // the directory handle. Let that native cleanup finish before removing the
    // watched temp directory, or Node can abort in src/win/fs-event.c.
    await new Promise((resolve) => setImmediate(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
});
