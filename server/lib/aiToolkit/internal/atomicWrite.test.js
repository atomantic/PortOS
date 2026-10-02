import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fsPromises from 'fs/promises';
import { pinPlatform } from '../../testHelper.js';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    rename: vi.fn((...args) => actual.rename(...args)),
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
  restorePlatform = pinPlatform('win32');
  fsPromises.rename.mockClear();
  fsPromises.rename.mockImplementation((...args) => realFsPromises.rename(...args));
});

afterEach(() => {
  restorePlatform();
  restorePlatform = () => {};
  fsPromises.rename.mockReset();
  fsPromises.rename.mockImplementation((...args) => realFsPromises.rename(...args));
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('AI Toolkit atomicWrite Windows lock retries', () => {
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
