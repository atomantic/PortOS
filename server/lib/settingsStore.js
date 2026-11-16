/**
 * File-backed settings document with shipped defaults.
 *
 * one owner for the `read → merge defaults → PATCH → write back` shape every per-feature settings file shares (`journal-settings.json`, `youtube-ingest-settings.json`, `activity-digest-settings.json`, `goal-scorecard-settings.json`, `model-personality/settings.json`). Five services hand-rolled it and the #4115 strict-read fix reached one: the others read a corrupt file as the defaults and wrote those over the user's settings on the next PATCH. - `get()` reads STRICT: a present-but-unreadable or non-object file rejects with `Unreadable JSON file: <path>` instead of reading as defaults; an absent file (ENOENT) is a trustworthy first-run empty yielding the defaults. The stored object is merged OVER `defaults` (shallow; these are flat) then passed through `normalize`. - `update(patch)` is `get → apply patch → atomicWrite`, serialized on one tail so concurrent PATCHes can't drop each other's keys. `undefined` is ABSENT (key untouched); `null` is an explicit clear. Starting from `get()`, an unreadable file makes `update` reject before any byte is written, so the file survives for the user to repair. - Which keys a client may set is the caller's policy: filter the body before `update` (`goalScorecard`'s `CLIENT_SETTABLE` pick) so server-managed fields stay service-writable. `filePath` may be a function so a store resolves `PATHS` lazily (suites re-root `PATHS.data` after load; see `modelPersonality.js`). For a cached, edited-in-place document use `createCachedStore` (`jsonIo.js`); for a per-record collection `createCollectionStore` (`collectionStore.js`).
 */

import { atomicWrite, readJSONFile } from './fileUtils.js';
import { createFileWriteQueue } from './fileWriteQueue.js';
import { isPlainObject } from './objects.js';

/**
 * @template T
 * @param {string | (() => string)} filePath - Settings file, or a resolver for it.
 * @param {T} defaults - Shipped defaults (flat object); the stored file is merged over it.
 * @param {{ normalize?: (settings: T) => T }} [options] `normalize` runs on every read after the defaults merge (repairs a hand-edited value that would corrupt a consumer).
 * @returns {{ get: () => Promise<T>, update: (patch?: Partial<T>) => Promise<T>, path: () => string }}
 */
export function createSettingsStore(filePath, defaults, { normalize = null } = {}) {
  const path = typeof filePath === 'function' ? filePath : () => filePath;
  const queueWrite = createFileWriteQueue();

  async function get() {
    // Strict (#4115): `update` writes this value back, so a swallowed unreadable file would become the shipped defaults on disk; `allowArray: false` makes an array-shaped file unreadable (can't merge it, so must not replace it).
    const stored = await readJSONFile(path(), null, { allowArray: false, strict: true });
    const merged = { ...defaults, ...(isPlainObject(stored) ? stored : {}) };
    return normalize ? normalize(merged) : merged;
  }

  function update(patch = {}) {
    return queueWrite(async () => {
      const next = { ...(await get()) };
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) next[key] = value;
      }
      await atomicWrite(path(), next);
      return next;
    });
  }

  return { get, update, path };
}
