/**
 * Collection Store — per-type, per-record JSON storage with explicit
 * `schemaVersion` stamping.
 *
 * Layout on disk:
 *
 *     {dir}/
 *     ├── index.json          // { schemaVersion, type, updatedAt, config: {…} }
 *     ├── <id-1>/
 *     │   └── index.json      // the record itself
 *     └── <id-2>/
 *         └── index.json
 *
 * Replaces the legacy "one big JSON file per type" pattern once a collection
 * has outgrown it (prior art: `data/runs/`).
 *
 * The `config` slot: the type index's `config` object holds cross-record state
 * that belongs to the collection as a whole (see the `TypeIndexConfig` typedef).
 * `runs?: []` is the established append-mostly history log, capped by its
 * consumer (universeBuilder keeps 200); consumers MAY add keys, documented next to
 * the owner. Values should be objects or arrays so the merge stays predictable.
 *
 *   Merge: `saveTypeIndex({ config })` shallow-merges at the TOP level of
 *   `config`, so a patch setting `runs` REPLACES the whole array. A
 *   read-modify-write of an array slot must load, mutate a copy and write the
 *   full replacement (see `recordRun` in universeBuilder).
 *
 *   Write-fence: all `config` writes share ONE file (`index.json`), so a
 *   read-modify-write on a slot must run inside `queueTypeIndexWrite(fn)`. Use
 *   `saveTypeIndex` for a simple patch (it queues internally).
 *   `defaultTypeIndexConfig` seeds the slot on a fresh index (or when `config` is
 *   missing or not a plain object); it is NOT re-applied on later writes.
 *
 * Two versioning concerns coexist:
 *   - The TYPE-LEVEL `schemaVersion` (this file): describes the on-disk
 *     storage layout. Bumped by a migration that changes layout (e.g. a split
 *     from a monolithic JSON to per-record dirs).
 *   - The RECORD-LEVEL `schemaVersion` (carried inside each record by some
 *     services, e.g. universeBuilder): describes the shape of one record's
 *     fields. Bumped by in-memory sanitizers when fields move/rename.
 *
 * These are distinct: a per-record sanitizer can mature without ever bumping
 * the type-level version, and a layout change can stamp a new type-level
 * version while record shape stays at v4.
 *
 * Concurrency model:
 *   - `queueRecordWrite(id, fn)` tail-chains per-id: read-modify-write cycles on
 *     the SAME record serialize, different records run in parallel.
 *   - `queueTypeIndexWrite(fn)` single-tail-chains writes to the type-level
 *     `index.json`.
 *   - `saveOne` already queues. Wrap a custom RMW cycle in `queueRecordWrite`
 *     when an external read spans load/save, then call `saveOneNow` inside it so
 *     the queued function does not wait on itself.
 */

import { join } from 'path';
import { readdir, rm } from 'fs/promises';
import { atomicWrite, readJSONFile, readJSONFileStrict, unreadableStoreError, ensureDir } from './fileUtils.js';
import { createFileWriteQueue, createRecordWriteQueue } from './fileWriteQueue.js';
import { isPlainObject, POLLUTING_KEYS } from './objects.js';
import { isVitestRunner } from './runtimeEnv.js';

/**
 * The type-index `config` slot — cross-record state owned by the collection as
 * a whole (see the header). All keys are optional.
 *
 * @typedef {object} TypeIndexConfig
 * @property {Array<object>} [runs]
 *   Append-mostly cross-record history/audit log. The consumer caps growth and
 *   sanitizes each entry.
 */

/**
 * Create a per-type collection store.
 *
 * @param {object} opts
 * @param {string} opts.dir
 *   Absolute path to the type's root directory, e.g. `${PATHS.data}/universes`.
 * @param {string} opts.type
 *   Stable type label (e.g. `'universes'`). Persisted in the type-level index;
 *   used in error/log messages so a misregistered store is obvious.
 * @param {number} opts.schemaVersion
 *   The layout version the code currently expects. `verifySchemaVersion()`
 *   asserts the on-disk type index matches this.
 * @param {(record: any) => any} [opts.sanitizeRecord]
 *   Optional record-level normalizer. Called on every `loadOne` result. Return
 *   `null` to treat the on-disk record as invalid (loadOne returns `null`).
 * @param {TypeIndexConfig} [opts.defaultTypeIndexConfig]
 *   Initial `config` for a fresh type index (and the fallback when an on-disk
 *   index has a missing/non-object `config`). Defaults to `{}`; NOT re-applied
 *   on later `saveTypeIndex` writes.
 * @param {(work: () => Promise<any>) => Promise<any>} [opts.withWrite]
 *   Optional outer fence shared by this collection’s write queues.
 * @param {RegExp} [opts.idPattern]
 *   Allowlist for record-directory names. Defaults to a permissive pattern
 *   (`/^[A-Za-z0-9_-]{1,128}$/`) — services with stricter id rules should pass
 *   their own (e.g. UUID-only) so `listIds()` doesn't surface stray files.
 */
export function createCollectionStore({
  dir,
  type,
  schemaVersion,
  sanitizeRecord = null,
  defaultTypeIndexConfig = {},
  withWrite = work => work(),
  idPattern = /^[A-Za-z0-9_-]{1,128}$/,
} = {}) {
  if (typeof dir !== 'string' || !dir) {
    throw new Error('createCollectionStore: `dir` is required');
  }
  if (typeof type !== 'string' || !type) {
    throw new Error('createCollectionStore: `type` is required');
  }
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new Error('createCollectionStore: `schemaVersion` must be a positive integer');
  }

  const typeIndexPath = () => join(dir, 'index.json');
  const recordDir = (id) => join(dir, id);
  const recordPath = (id) => join(dir, id, 'index.json');
  // Fallback for tests that mock fileUtils without a real directory tree;
  // production listIds uses readdir whenever the collection dir exists.
  const knownIds = new Set();

  // Reject prototype-polluting names even when they pass the id pattern.
  const isValidId = (id) => typeof id === 'string' && idPattern.test(id) && !POLLUTING_KEYS.has(id);

  // Per-record write queue; the assert throws synchronously on a bad id before
  // anything is enqueued.
  const queueRecord = createRecordWriteQueue((id) => {
    if (!isValidId(id)) {
      throw new Error(`collectionStore[${type}]: invalid record id "${id}" — must match ${idPattern}`);
    }
  });

  const queueRecordWrite = (id, work) => queueRecord(id, () => withWrite(work));

  // Type-index single-tail queue; also the write-fence for config-slot updates.
  const queueTypeIndex = createFileWriteQueue();
  const queueTypeIndexWrite = work => queueTypeIndex(() => withWrite(work));

  const buildEmptyTypeIndex = () => ({
    schemaVersion,
    type,
    updatedAt: new Date().toISOString(),
    config: { ...defaultTypeIndexConfig },
  });

  /**
   * Load the type-level index.json. Returns the default shape when the file is
   * ABSENT; does NOT write to disk.
   *
   * Strict: every `config`-slot writer writes this read back, so a swallowed
   * present-but-unreadable index would persist the defaults over real user state
   * AND stamp the current `schemaVersion` over an old on-disk layout. Throwing
   * rejects writers before any byte is written; request paths surface a 5xx
   * (`unreadableStoreError`). Same posture as `settingsStore.get()`.
   */
  async function loadTypeIndex() {
    const { ok, value: raw } = await readJSONFileStrict(typeIndexPath(), null, { allowArray: false });
    if (!ok) throw unreadableStoreError(typeIndexPath());
    if (!isPlainObject(raw)) return buildEmptyTypeIndex();
    return {
      schemaVersion: Number.isInteger(raw.schemaVersion) ? raw.schemaVersion : schemaVersion,
      type: typeof raw.type === 'string' && raw.type ? raw.type : type,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
      config: isPlainObject(raw.config) ? raw.config : { ...defaultTypeIndexConfig },
    };
  }

  /**
   * Persist a patch into the type-level index. `schemaVersion` / `type` are
   * replaced only when the patch supplies a valid value; `config` is SHALLOW-merged
   * one level deep (see header); `updatedAt` is restamped. Serialized through
   * `queueTypeIndexWrite`. A read-modify-write on a slot (e.g. appending to
   * `runs`) must load and write together inside one `queueTypeIndexWrite(fn)`.
   *
   * @param {{ schemaVersion?: number, type?: string, config?: TypeIndexConfig }} [patch]
   */
  function saveTypeIndex(patch = {}) {
    return queueTypeIndexWrite(async () => {
      await ensureDir(dir);
      const current = await loadTypeIndex();
      const next = {
        schemaVersion: Number.isInteger(patch.schemaVersion) ? patch.schemaVersion : current.schemaVersion,
        type: typeof patch.type === 'string' && patch.type ? patch.type : current.type,
        config: isPlainObject(patch.config) ? { ...current.config, ...patch.config } : current.config,
        updatedAt: new Date().toISOString(),
      };
      await atomicWrite(typeIndexPath(), next);
      return next;
    });
  }

  /**
   * List the on-disk record ids. Source of truth is `readdir(dir)`, not a
   * manifest. Filters out the type-level `index.json`, hidden entries, and
   * anything that doesn't match `idPattern` or isn't a directory.
   */
  async function listIds() {
    const entries = await readdir(dir, { withFileTypes: true }).catch((err) => {
      if (err?.code === 'ENOENT') return null;
      throw err;
    });
    if (entries === null) return [...knownIds].filter(isValidId);
    // Dirent types exclude symlinks without an explicit lstat per record.
    return entries.filter((entry) =>
      entry.name !== 'index.json'
      && !entry.name.startsWith('.')
      && isValidId(entry.name)
      && entry.isDirectory()
    ).map((entry) => entry.name);
  }

  /**
   * Load one record by id. Returns `null` when the record dir is missing or
   * the on-disk JSON fails to parse; runs the configured `sanitizeRecord` on
   * the parsed payload (sanitizer can also return `null` to reject).
   *
   * Non-strict by design (unlike `loadTypeIndex`): a per-record read is not a
   * read-modify-write of shared state, and a corrupt single record must not take
   * down a collection-wide load. Callers that must tell "absent" from "corrupt"
   * use `loadAllResult`.
   */
  async function loadOne(id) {
    if (!isValidId(id)) return null;
    const parsed = await readJSONFile(recordPath(id), null, { allowArray: false, logError: false });
    if (!isPlainObject(parsed)) return null;
    if (typeof sanitizeRecord === 'function') {
      return sanitizeRecord(parsed);
    }
    return parsed;
  }

  /**
   * Load one record WITHOUT running `sanitizeRecord`, for callers that compare
   * the raw on-disk shape to the sanitized one (e.g. sanitize mints ids it does
   * not persist). Non-strict for the same reason as `loadOne`.
   */
  async function loadOneRaw(id) {
    if (!isValidId(id)) return null;
    const parsed = await readJSONFile(recordPath(id), null, { allowArray: false, logError: false });
    return isPlainObject(parsed) ? parsed : null;
  }

  /**
   * Load every record in parallel, keeping the "which ids failed to load" signal
   * that `loadAll` throws away: an id from `listIds()` whose `loadOne` resolves
   * to `null` is a corrupt/rejected record. Callers reasoning over the whole set
   * need "N-of-M, K corrupt" so a silent undercount can't masquerade as complete.
   *
   * @returns {Promise<{ records: any[], failedIds: string[] }>}
   *   `records` — the successfully-loaded, sanitized records (nulls dropped).
   *   `failedIds` — the ids `listIds()` surfaced that failed to load (empty when
   *   every record loaded cleanly).
   */
  async function loadAllResult() {
    const ids = await listIds();
    const loaded = await Promise.all(ids.map((id) => loadOne(id)));
    const records = [];
    const failedIds = [];
    ids.forEach((id, i) => {
      if (loaded[i] != null) records.push(loaded[i]);
      else failedIds.push(id);
    });
    return { records, failedIds };
  }

  /**
   * Load every record in parallel (O(N); for very large collections prefer
   * `listIds` + `loadOne`). Silently drops corrupt records; use `loadAllResult`
   * to tell a partial set apart.
   */
  async function loadAll() {
    return (await loadAllResult()).records;
  }

  /**
   * Persist a record WITHOUT the per-id queue (see `saveOne`). Throws on
   * missing/invalid id; the sanitizer is NOT applied on write (callers
   * pre-sanitize).
   */
  async function saveOneNow(id, record) {
    if (!isValidId(id)) {
      throw new Error(`collectionStore[${type}]: invalid record id "${id}" — must match ${idPattern}`);
    }
    if (!isPlainObject(record)) {
      throw new Error(`collectionStore[${type}]: record must be a plain object`);
    }
    await ensureDir(recordDir(id));
    await atomicWrite(recordPath(id), record);
    knownIds.add(id);
    return record;
  }

  function saveOne(id, record) {
    if (!isValidId(id)) {
      throw new Error(`collectionStore[${type}]: invalid record id "${id}" — must match ${idPattern}`);
    }
    if (!isPlainObject(record)) {
      throw new Error(`collectionStore[${type}]: record must be a plain object`);
    }
    return queueRecordWrite(id, async () => {
      return saveOneNow(id, record);
    });
  }

  /**
   * Hard-delete a record WITHOUT the per-id queue: removes the `{dir}/{id}/`
   * subtree and drops the id from `knownIds`. The delete-side counterpart to
   * `saveOneNow`: call it INSIDE `queueRecordWrite(id, …)` when a recheck must
   * span load→delete (e.g. tombstone GC). Idempotent. Otherwise prefer `deleteOne`.
   */
  async function deleteOneNow(id) {
    if (!isValidId(id)) {
      throw new Error(`collectionStore[${type}]: invalid record id "${id}" — must match ${idPattern}`);
    }
    // A recursive delete takes the same data-root guard as the write primitives;
    // loaded lazily for the same import-budget reason as fileCore.js.
    if (isVitestRunner()) {
      const { assertNotRealDataWrite } = await import('./testDataIsolation.js');
      assertNotRealDataWrite(recordDir(id), 'collectionStore delete');
    }
    await rm(recordDir(id), { recursive: true, force: true });
    knownIds.delete(id);
  }

  /**
   * Hard-delete a record. Removes the entire `{dir}/{id}/` subtree so any
   * sidecar files (per-record images, derived assets) go with it. Serialized
   * on the per-record queue so a delete can't race with an in-flight write.
   * Idempotent — missing dir is a no-op.
   */
  function deleteOne(id) {
    if (!isValidId(id)) {
      throw new Error(`collectionStore[${type}]: invalid record id "${id}" — must match ${idPattern}`);
    }
    return queueRecordWrite(id, () => deleteOneNow(id));
  }

  /**
   * Boot-time verifier — confirms the on-disk type index matches the code's
   * expected `schemaVersion`. Returns a status object rather than throwing so
   * `server/index.js` can log all collections in one pass.
   *
   *   ok=true   — version matches (`'match'`), or the index is ABSENT
   *               (`'missing'`, a fresh install; the next write stamps it).
   *   ok=false  — on-disk version is older (`'older'`: a migration didn't run) or
   *               newer (`'newer'`: code rolled back below a forward-only
   *               migration), OR the file is present but unreadable
   *               (`'unreadable'`, `onDisk: null`).
   *
   * `unreadable` matters because this is the ONE boot-time check that catches a
   * skipped storage migration; calling it "fresh install" would silence that
   * alarm and the next write would stamp the current version over the old layout.
   */
  async function verifySchemaVersion() {
    const { ok: readable, value: raw } = await readJSONFileStrict(typeIndexPath(), null, { allowArray: false, logError: false });
    if (!readable) {
      return {
        ok: false,
        onDisk: null,
        expected: schemaVersion,
        type,
        reason: 'unreadable',
        message: `collection "${type}": index.json at ${typeIndexPath()} exists but could not be read or parsed — repair or delete it and restart. Until then the storage-version check for this collection cannot run.`,
      };
    }
    if (!isPlainObject(raw) || raw.schemaVersion == null) {
      return {
        ok: true,
        onDisk: null,
        expected: schemaVersion,
        type,
        reason: 'missing',
        message: `collection "${type}": no index.json (fresh install) — first write will stamp schemaVersion=${schemaVersion}`,
      };
    }
    const onDisk = Number.isInteger(raw.schemaVersion) ? raw.schemaVersion : null;
    if (onDisk === schemaVersion) {
      return { ok: true, onDisk, expected: schemaVersion, type, reason: 'match', message: `collection "${type}" @ v${schemaVersion}` };
    }
    if (onDisk != null && onDisk < schemaVersion) {
      return {
        ok: false,
        onDisk,
        expected: schemaVersion,
        type,
        reason: 'older',
        message: `collection "${type}": on-disk v${onDisk}, code expects v${schemaVersion} — a migration didn't run. Check scripts/migrations/ and run \`npm run migrations\`.`,
      };
    }
    return {
      ok: false,
      onDisk,
      expected: schemaVersion,
      type,
      reason: 'newer',
      message: `collection "${type}": on-disk v${onDisk}, code expects v${schemaVersion} — code rolled back below a forward-only migration. Roll forward or restore from a backup.`,
    };
  }

  return {
    // Paths (mostly for tests + migration scripts)
    dir,
    type,
    schemaVersion,
    isValidId,
    typeIndexPath,
    recordDir,
    recordPath,
    // Type-level index
    loadTypeIndex,
    saveTypeIndex,
    // Per-record CRUD
    listIds,
    loadOne,
    loadOneRaw,
    loadAll,
    loadAllResult,
    saveOneNow,
    saveOne,
    deleteOneNow,
    deleteOne,
    // Concurrency primitives
    queueRecordWrite,
    queueTypeIndexWrite,
    // Boot-time verifier
    verifySchemaVersion,
  };
}

/**
 * Walk a list of stores, run `verifySchemaVersion()` on each, log the result,
 * and return the per-store status array. Used at server boot AFTER migrations
 * run so a missed migration produces a loud, single-line log per collection.
 *
 * PortOS is single-user — a hard exit on mismatch is worse than a noisy log,
 * so this never throws (the caller decides whether to keep booting).
 */
export async function verifyCollectionVersions(stores = []) {
  const statuses = [];
  for (const store of stores) {
    const status = await store.verifySchemaVersion();
    if (status.ok) {
      console.log(`📋 ${status.message}`);
    } else {
      console.error(`❌ ${status.message}`);
    }
    statuses.push(status);
  }
  return statuses;
}
