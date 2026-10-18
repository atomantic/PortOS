import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fsPromises from 'fs/promises';
import { pinPlatform } from '../../testHelper.js';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    rename: vi.fn((...args) => actual.rename(...args)),
    writeFile: vi.fn((...args) => actual.writeFile(...args)),
    stat: vi.fn((...args) => actual.stat(...args)),
    chmod: vi.fn((...args) => actual.chmod(...args)),
    open: vi.fn((...args) => actual.open(...args)),
  };
});

import { atomicWrite } from './atomicWrite.js';

const realFsPromises = await vi.importActual('fs/promises');
const RETRY_ATTEMPTS = 5;
const lockError = (code) => Object.assign(new Error(`${code}: simulated windows lock`), { code });

let tmpRoot;
let restorePlatform = () => {};

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ai-toolkit-atomicwrite-'));
  fsPromises.rename.mockClear();
  fsPromises.rename.mockImplementation((...args) => realFsPromises.rename(...args));
});

afterEach(() => {
  restorePlatform();
  restorePlatform = () => {};
  for (const name of ['rename', 'writeFile', 'stat', 'chmod', 'open']) {
    fsPromises[name].mockReset();
    fsPromises[name].mockImplementation((...args) => realFsPromises[name](...args));
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('AI Toolkit atomicWrite Windows lock retries', () => {
  beforeEach(() => { restorePlatform = pinPlatform('win32'); });
  it('succeeds when the lock clears within the retry window', async () => {
    const target = join(tmpRoot, 'transient.json');
    writeFileSync(target, '{"v":1}');
    for (let i = 0; i < RETRY_ATTEMPTS - 1; i += 1) fsPromises.rename.mockRejectedValueOnce(lockError('EPERM'));

    await atomicWrite(target, { v: 2 });

    expect(readFileSync(target, 'utf8')).toBe('{\n  "v": 2\n}');
    expect(readdirSync(tmpRoot)).toEqual(['transient.json']);
  });

  it.each(['EPERM', 'EACCES', 'EBUSY'])('keeps the original bytes and removes only the temp file when %s persists', async (code) => {
    const target = join(tmpRoot, 'persistent.json');
    writeFileSync(target, '{"v":1}');
    for (let i = 0; i < RETRY_ATTEMPTS; i += 1) fsPromises.rename.mockRejectedValueOnce(lockError(code));

    await expect(atomicWrite(target, { v: 2 })).rejects.toMatchObject({ code });

    expect(readFileSync(target, 'utf8')).toBe('{"v":1}');
    expect(fsPromises.rename).toHaveBeenCalledTimes(RETRY_ATTEMPTS);
    expect(readdirSync(tmpRoot)).toEqual(['persistent.json']);
  });
});

describe('AI Toolkit atomicWrite crash durability (#12025, mirrors fileCore)', () => {
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

  it('skips the directory sync on Windows', async () => {
    restorePlatform = pinPlatform('win32');
    const target = join(tmpRoot, 'state.json');
    fsPromises.open.mockClear();

    await atomicWrite(target, { v: 1 });

    expect(fsPromises.open).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ v: 1 });
  });
});

describe('AI Toolkit atomicWrite preparation failures', () => {
  it('removes a partially written temp file and can retry without changing the original on failure', async () => {
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

  it.each(['stat', 'chmod'])('preserves the original when %s fails', async (operation) => {
    const target = join(tmpRoot, 'private.json');
    writeFileSync(target, 'original', { mode: 0o600 });
    const failure = Object.assign(new Error(`synthetic ${operation} failure`), { code: 'EIO' });
    fsPromises[operation].mockRejectedValueOnce(failure);

    await expect(atomicWrite(target, 'replacement')).rejects.toBe(failure);
    expect(readFileSync(target, 'utf8')).toBe('original');
    expect(readdirSync(tmpRoot)).toEqual(['private.json']);
  });

  it.skipIf(process.platform === 'win32')('preserves an existing owner-only mode', async () => {
    const target = join(tmpRoot, 'private.json');
    writeFileSync(target, 'original');
    chmodSync(target, 0o600);

    await atomicWrite(target, 'replacement');

    expect(readFileSync(target, 'utf8')).toBe('replacement');
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('creates a missing file and preserves binary bytes', async () => {
    const target = join(tmpRoot, 'new.bin');
    const bytes = Buffer.from([0, 128, 255]);

    await atomicWrite(target, bytes);

    expect(readFileSync(target)).toEqual(bytes);
    expect(readdirSync(tmpRoot)).toEqual(['new.bin']);
  });
});
