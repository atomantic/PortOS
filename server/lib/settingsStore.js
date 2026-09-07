/**
 * File-backed settings document with shipped defaults.
 *
 * One owner for the `read → merge defaults → PATCH → write back` shape every
 * per-feature settings file shares (`journal-settings.json`,
 * `youtube-ingest-settings.json`, `activity-digest-settings.json`,
 * `goal-scorecard-settings.json`, `model-personality/settings.json`). Five
 * services hand-rolled it, and the #4115 strict-read fix reached exactly one of
 * them — the other four kept reading a corrupt file as the shipped defaults and
 * writing those defaults over the user's settings on the next PATCH. Owning the
 * shape here means the posture cannot drift copy by copy again.
 *
 * Contract:
 *   - `get()` reads STRICT: a present-but-unreadable or non-object file rejects
 *     with `Unreadable JSON file: <path>` instead of reading as the defaults. A
 *     genuinely absent file (ENOENT) is a trustworthy first-run empty and yields
 *     the defaults. The stored object is merged OVER `defaults` (shallow — these
 *     documents are flat), then passed through `normalize` when given.
 *   - `update(patch)` is `get → apply patch → atomicWrite`, serialized on one
 *     tail so two concurrent PATCHes cannot interleave and drop each other's
 *     keys. `undefined` values in `patch` are ABSENT (the key is left alone);
 *     `null` is an explicit clear and is written. Because it starts from `get()`,
 *     an unreadable file makes `update` reject before any byte is written — the
 *     file survives intact for the user to repair.
 *   - Which keys a client may set is the caller's policy: filter the request
 *     body before calling `update` (`goalScorecard`'s `CLIENT_SETTABLE` pick),
 *     so server-managed fields stay writable by the service itself.
 *
 * `filePath` may be a function so a store can resolve `PATHS` lazily (test
 * suites re-root `PATHS.data` after module load; see `modelPersonality.js`).
 *
 * For a mutable document that is cached and edited in place (accounts, feeds,
 * schedules) use `createCachedStore` (`jsonIo.js`); for a per-record collection
 * use `createCollectionStore` (`collectionStore.js`).
 */

import { atomicWrite, readJSONFile } from './fileUtils.js';
import { createFileWriteQueue } from './fileWriteQueue.js';
import { isPlainObject } from './objects.js';

/**
 * @template T
 * @param {string | (() => string)} filePath - Settings file, or a resolver for it.
 * @param {T} defaults - Shipped defaults (flat object); the stored file is merged over it.
 * @param {{ normalize?: (settings: T) => T }} [options]
 *   `normalize` runs on every read after the defaults merge — the place to
 *   repair a hand-edited value that would otherwise corrupt a consumer.
 * @returns {{ get: () => Promise<T>, update: (patch?: Partial<T>) => Promise<T>, path: () => string }}
 */
export function createSettingsStore(filePath, defaults, { normalize = null } = {}) {
  const path = typeof filePath === 'function' ? filePath : () => filePath;
  const queueWrite = createFileWriteQueue();

  async function get() {
    // Strict (#4115): `update` writes this value back, so a swallowed unreadable
    // file would become the shipped defaults on disk. `allowArray: false` makes
    // an array-shaped file an unreadable one — we cannot merge it, so we must
    // not replace it either.
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
