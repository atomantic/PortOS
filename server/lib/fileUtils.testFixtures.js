/**
 * Shared fs/promises mock helpers for the per-leaf file utility suites. Each suite installs the
 * delegating `vi.mock('fs/promises')` itself (vi.mock is hoisted per file); these helpers restore it.
 */
import { vi } from 'vitest';
import * as fsPromises from 'fs/promises';

/** The unmocked fs/promises, filled in by `loadRealFsPromises` so tests can bypass the mocks. */
export const realFsPromises = {};

export const loadRealFsPromises = async () => {
  Object.assign(realFsPromises, await vi.importActual('fs/promises'));
};

export const restoreFsMocks = () => {
  for (const name of ['readFile', 'rename', 'readdir', 'mkdir', 'stat', 'writeFile', 'chmod', 'open']) {
    fsPromises[name].mockReset();
    fsPromises[name].mockImplementation((...args) => realFsPromises[name](...args));
  }
};

/**
 * Run `fn` with EVERY `readFile` attempt rejected by `err`, then restore the
 * delegating mock.
 *
 * A single `mockRejectedValueOnce` is not enough since #4095: on win32
 * `readJSONFileStrict` retries a transient lock, so the first attempt would
 * consume the queued rejection and the retry would read the real file. A test
 * pinning "an unreadable file is not an empty one" has to keep it unreadable —
 * which is also the contract that actually survives the retries.
 */
export const withUnreadableFile = async (err, fn) => {
  fsPromises.readFile.mockImplementation(() => Promise.reject(err));
  try {
    return await fn();
  } finally {
    restoreFsMocks();
  }
};
